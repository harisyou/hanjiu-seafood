import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import pg from 'pg';

const url=process.env.F0065_DATABASE_URL;
const enabled=Boolean(url);
const migration=name=>readFileSync(new URL(`../../supabase/${name}`,import.meta.url),'utf8');
const product='10000000-0000-4000-8000-000000000002';
const variant='20000000-0000-4000-8000-000000000001';
const hash=value=>value.repeat(64);

async function setup(){
  const db=new pg.Client({connectionString:url}); await db.connect();
  await db.query(`
    do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;end$$;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select '80000000-0000-4000-8000-000000000001'::uuid$$;
    create function public.is_hanjiu_admin() returns boolean language sql stable as $$select true$$;
    create table customers(id uuid primary key default gen_random_uuid(),name text,phone text,email text);
    create table products(id uuid primary key,name text,status text,processing_enabled boolean default false,updated_at timestamptz default now());
    create table product_variants(id uuid primary key,product_id uuid references products(id),name text,price integer,active boolean,inventory integer,preorder_enabled boolean default false);
    create table orders(id uuid primary key default gen_random_uuid(),customer_id uuid,customer_name text,phone text,email text,line_id text,fulfillment text,processing text,note text,status text default 'new',payment_status text default 'unpaid',fish_request_id uuid,subtotal integer default 0,shipping_fee integer default 0,discount_amount integer default 0,total_amount integer default 0,checkout_idempotency_key uuid,checkout_request_fingerprint text,created_at timestamptz default now());
    create unique index orders_checkout_idempotency_key_unique_idx on orders(checkout_idempotency_key) where checkout_idempotency_key is not null;
    create table order_items(id uuid primary key default gen_random_uuid(),order_id uuid references orders(id),product_id uuid references products(id),product_name text,variant_id uuid references product_variants(id),variant_name text,price integer,quantity integer,supply_type text default 'in_stock',processing_preset_id text,processing_preset_name text,processing_option_ids text[] default '{}',processing_option_names text[] default '{}',processing_note text);
    create table inventory_movements(id uuid primary key default gen_random_uuid(),variant_id uuid,product_id uuid,inventory_delta integer,quantity_before integer,quantity_after integer,movement_type text,order_id uuid,fish_request_id uuid,actor_id uuid,created_at timestamptz default now());
    create table order_payments(id uuid primary key default gen_random_uuid(),order_id uuid,amount integer,payment_method text,actor_id uuid,attempt_number integer default 1,idempotency_key uuid);
    create table order_payment_reversals(id uuid primary key default gen_random_uuid(),payment_id uuid,order_id uuid,amount integer,reason text,actor_id uuid);
    create table product_images(id uuid primary key,product_id uuid references products(id));
    create table processing_options(id text primary key,name text,active boolean);
    create table processing_presets(id text primary key,name text,active boolean);
    create table processing_preset_options(preset_id text,processing_option_id text);
    create table product_processing_options(product_id uuid,processing_option_id text,active boolean,sort_order integer);
    create table product_processing_presets(product_id uuid,preset_id text,active boolean);
    create table storage.buckets(id text primary key); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    insert into storage.buckets values('product-images');
    insert into products(id,name,status) values('${product}','規格魚','available');
    insert into product_variants values('${variant}','${product}','規格',100,true,20,false);
    create function public.find_or_create_customer(p_name text,p_phone text,p_email text,p_line text) returns uuid language plpgsql as $$declare x uuid;begin insert into customers(name,phone,email) values(p_name,p_phone,p_email) returning id into x;return x;end$$;
    create function public.enforce_order_cancellation_flow() returns trigger language plpgsql as $$begin if new.status='cancelled' and current_setting('app.order_cancellation_authorized',true) is distinct from 'true' then raise exception 'order_cancellation_rpc_required';end if;return new;end$$;
    create trigger orders_cancellation_guard before update of status on orders for each row execute function enforce_order_cancellation_flow();
    create function public.log_inventory_movement() returns trigger language plpgsql as $$declare t text:=current_setting('app.inventory_movement_type',true);o uuid:=nullif(current_setting('app.inventory_movement_order_id',true),'')::uuid;begin if tg_op='UPDATE' and new.inventory<>old.inventory then insert into inventory_movements(variant_id,product_id,inventory_delta,quantity_before,quantity_after,movement_type,order_id) values(new.id,new.product_id,new.inventory-old.inventory,old.inventory,new.inventory,t,o);end if;return new;end$$;
    create trigger inventory_variant_movement_ledger after update of inventory on product_variants for each row execute function log_inventory_movement();
    create function public.enforce_order_item_variant_availability() returns trigger language plpgsql as $$begin return new;end$$;
    create trigger order_items_enforce_variant_availability before insert on order_items for each row execute function enforce_order_item_variant_availability();
    create function public.enforce_order_item_supply_type_snapshot() returns trigger language plpgsql as $$begin if new.supply_type is distinct from old.supply_type then raise exception 'order_item_supply_type_immutable';end if;return new;end$$;
    create trigger order_items_supply_type_snapshot_guard before update of supply_type on order_items for each row execute function enforce_order_item_supply_type_snapshot();
    create function public.enforce_order_payment_flow() returns trigger language plpgsql as $$begin if new.payment_status is distinct from old.payment_status and current_setting('app.order_payment_authorized',true) is distinct from 'true' then raise exception 'order_payment_rpc_required';end if;return new;end$$;
    create trigger orders_payment_guard before update of payment_status on orders for each row execute function enforce_order_payment_flow();
    create function public.admin_record_order_payment(uuid,integer,text) returns order_payments language sql as $$select null::order_payments$$;
  `);
  await db.query(`create or replace function public.create_checkout_order(p_customer_name text,p_phone text,p_fulfillment text,p_note text,p_items jsonb,p_email text,p_idempotency_key uuid)
    returns uuid language plpgsql security definer set search_path=public,pg_temp as $$declare oid uuid;it jsonb;v record;cid uuid;begin
      cid:=find_or_create_customer(p_customer_name,p_phone,p_email,null);insert into orders(customer_id,customer_name,phone,email,fulfillment,processing,note,checkout_idempotency_key,checkout_request_fingerprint) values(cid,p_customer_name,p_phone,p_email,p_fulfillment,'依品項',p_note,p_idempotency_key,md5(p_items::text)) returning id into oid;
      perform set_config('app.inventory_movement_type','checkout_sale',true);perform set_config('app.inventory_movement_order_id',oid::text,true);
      for it in select value from jsonb_array_elements(p_items) loop select pv.*,p.name product_name into v from product_variants pv join products p on p.id=pv.product_id where pv.id=(it->>'variant_id')::uuid for update of pv;if v.inventory<(it->>'quantity')::integer then raise exception 'variant_unavailable';end if;update product_variants set inventory=inventory-(it->>'quantity')::integer where id=v.id;insert into order_items(order_id,product_id,product_name,variant_id,variant_name,price,quantity,supply_type) values(oid,v.product_id,v.product_name,v.id,v.name,v.price,(it->>'quantity')::integer,'in_stock');end loop;return oid;end$$;`);
  for(const file of ['f003-14-order-totals.sql','f003-17-paid-financial-integrity.sql','f003-18-repayment-lifecycle.sql','f006-1-phase2-pr-a-database-foundation.sql','f006-2-phase2-pr-b-weighted-quick-entry.sql','f006-3-phase2-weighted-stock-availability-actions.sql','f006-4-phase2-weighted-checkout-foundation.sql','f006-5-phase2-payment-lifecycle-foundation.sql']) await db.query(migration(file));
  await db.end();
}

async function call(client,{phone,key,token}){
  return client.query(`select phase2_create_checkout_order_with_access($1,$2,'永春市場自取','',$3::jsonb,'[]'::jsonb,'buyer@example.com',$4,$5) id`,
    ['王小明',phone,JSON.stringify([{variant_id:variant,quantity:1,processing_option_ids:[]}]),key,token]);
}

test('F006-5 real PostgreSQL multi-session races', {skip:!enabled}, async()=>{
  await setup();
  const a=new pg.Client({connectionString:url}),b=new pg.Client({connectionString:url}); await Promise.all([a.connect(),b.connect()]);
  try{
    const samePhone=await Promise.allSettled([
      call(a,{phone:'0912-345-678',key:crypto.randomUUID(),token:hash('a')}),
      call(b,{phone:'+886 912 345 678',key:crypto.randomUUID(),token:hash('b')})
    ]);
    assert.equal(samePhone.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(samePhone));
    assert.equal(samePhone.filter(x=>x.status==='rejected'&&/phone_has_unfinished_payment_order|orders_one_unfinished_payment_per_phone_uidx/.test(x.reason.message)).length,1,JSON.stringify(samePhone));

    const winner=await a.query("select id from orders where checkout_phone_normalized='0912345678'");
    const firstId=winner.rows[0].id;
    const firstToken=(await a.query('select token_hash from order_customer_access_tokens where order_id=$1',[firstId])).rows[0].token_hash;
    await a.query('select phase2_customer_cancel_order($1,$2)',[firstToken,crypto.randomUUID()]);

    const raced=await call(a,{phone:'0922222222',key:crypto.randomUUID(),token:hash('c')});
    const raceId=raced.rows[0].id;
    const raceReport=crypto.randomUUID();
    const reportSql='select (phase2_submit_payment_report($1,$2,$3,$4)).id id';
    const releaseSql="select (phase2_release_expired_checkout_hold($1,(select weighted_hold_expires_at+interval '1 second' from orders where id=$1))).id id";
    const reportRelease=await Promise.allSettled([
      a.query(reportSql,[hash('c'),'12345',100,raceReport]),b.query(releaseSql,[raceId])
    ]);
    assert.equal(reportRelease.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(reportRelease));
    assert.equal(reportRelease.filter(x=>x.status==='rejected').length,1,JSON.stringify(reportRelease));
    const raceState=(await a.query('select status,payment_report_status from orders where id=$1',[raceId])).rows[0];
    assert.ok((raceState.status==='cancelled'&&raceState.payment_report_status===null)||(raceState.status==='new'&&raceState.payment_report_status==='pending'),JSON.stringify(raceState));

    if(raceState.payment_report_status==='pending'){
      const reportId=(await a.query('select current_payment_report_id from orders where id=$1',[raceId])).rows[0].current_payment_report_id;
      const confirmCancel=await Promise.allSettled([
        a.query('select admin_confirm_reported_order_payment($1,$2,$3)',[raceId,reportId,crypto.randomUUID()]),
        b.query("select admin_cancel_reported_order($1,$2,'manual review',$3)",[raceId,reportId,crypto.randomUUID()])
      ]);
      assert.equal(confirmCancel.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(confirmCancel));
      assert.equal(confirmCancel.filter(x=>x.status==='rejected').length,1,JSON.stringify(confirmCancel));
    }
    const duplicateRestores=(await a.query("select order_id,count(*) from inventory_movements where movement_type='order_cancel_restore' group by order_id having count(*)>1")).rows;
    assert.equal(duplicateRestores.length,0,JSON.stringify(duplicateRestores));
  }finally{await Promise.all([a.end(),b.end()]);}
});

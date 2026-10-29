import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const f0061=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-database-foundation.sql',import.meta.url),'utf8');
const f0062=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-weighted-quick-entry.sql',import.meta.url),'utf8');
const f0063=readFileSync(new URL('../supabase/f006-3-phase2-weighted-stock-availability-actions.sql',import.meta.url),'utf8');
const f0064=readFileSync(new URL('../supabase/f006-4-phase2-weighted-checkout-foundation.sql',import.meta.url),'utf8');
const preflight=readFileSync(new URL('../supabase/f006-4-phase2-weighted-checkout-preflight.sql',import.meta.url),'utf8');
const postVerify=readFileSync(new URL('../supabase/f006-4-phase2-weighted-checkout-post-verify.sql',import.meta.url),'utf8');
const product='10000000-0000-4000-8000-000000000001';
const variantProduct='10000000-0000-4000-8000-000000000002';
const variant='20000000-0000-4000-8000-000000000001';
const q=(db,sql,params)=>db.query(sql,params).then(result=>result.rows);

async function fixture(){
  const db=new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select '80000000-0000-4000-8000-000000000001'::uuid$$;
    create function public.is_hanjiu_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
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
    insert into products(id,name,status) values('${product}','測試魚','available'),('${variantProduct}','規格魚','available');
    insert into product_variants values('${variant}','${variantProduct}','規格',100,true,5,false);
    create function public.find_or_create_customer(p_name text,p_phone text,p_email text,p_line text) returns uuid language plpgsql as $$declare x uuid;begin insert into customers(name,phone,email) values(p_name,p_phone,p_email) returning id into x;return x;end$$;
    create function public.enforce_order_cancellation_flow() returns trigger language plpgsql as $$begin if new.status='cancelled' and current_setting('app.order_cancellation_authorized',true) is distinct from 'true' then raise exception 'order_cancellation_rpc_required';end if;return new;end$$;
    create trigger orders_cancellation_guard before update of status on orders for each row execute function enforce_order_cancellation_flow();
    create function public.recalculate_order_totals_from_items() returns trigger language plpgsql as $$begin update orders set subtotal=(select coalesce(sum(price*quantity),0) from order_items where order_id=new.order_id),total_amount=(select coalesce(sum(price*quantity),0) from order_items where order_id=new.order_id) where id=new.order_id;return new;end$$;
    create trigger order_items_recalculate_totals after insert on order_items for each row execute function recalculate_order_totals_from_items();
    create function public.log_inventory_movement() returns trigger language plpgsql as $$declare t text:=current_setting('app.inventory_movement_type',true);o uuid:=nullif(current_setting('app.inventory_movement_order_id',true),'')::uuid;begin if tg_op='UPDATE' and new.inventory<>old.inventory then insert into inventory_movements(variant_id,product_id,inventory_delta,quantity_before,quantity_after,movement_type,order_id) values(new.id,new.product_id,new.inventory-old.inventory,old.inventory,new.inventory,t,o);end if;return new;end$$;
    create trigger inventory_variant_movement_ledger after update of inventory on product_variants for each row execute function log_inventory_movement();
    create function public.enforce_order_item_variant_availability() returns trigger language plpgsql as $$begin return new;end$$;
    create trigger order_items_enforce_variant_availability before insert on order_items for each row execute function enforce_order_item_variant_availability();
    create function public.enforce_order_item_supply_type_snapshot() returns trigger language plpgsql as $$begin if new.supply_type is distinct from old.supply_type then raise exception 'order_item_supply_type_immutable';end if;return new;end$$;
    create trigger order_items_supply_type_snapshot_guard before update of supply_type on order_items for each row execute function enforce_order_item_supply_type_snapshot();
    create function public.enforce_order_payment_flow() returns trigger language plpgsql as $$begin if new.payment_status is distinct from old.payment_status and current_setting('app.order_payment_authorized',true) is distinct from 'true' then raise exception 'order_payment_rpc_required';end if;return new;end$$;
    create trigger orders_payment_guard before update of payment_status on orders for each row execute function enforce_order_payment_flow();
    create function public.enforce_paid_order_financial_lock() returns trigger language plpgsql as $$begin return new;end$$;
    create trigger orders_paid_financial_guard before update of subtotal,shipping_fee,discount_amount,total_amount on orders for each row execute function enforce_paid_order_financial_lock();
    create function public.admin_audit_order_financial_integrity() returns setof text language sql as $$select null::text where false$$;
    create function public.admin_cancel_order(uuid) returns orders language sql as $$select null::orders$$;
    create function public.admin_record_order_payment(uuid,integer,text,uuid) returns order_payments language sql as $$select null::order_payments$$;
    create function public.admin_reverse_order_payment(uuid,text) returns order_payment_reversals language sql as $$select null::order_payment_reversals$$;
  `);
  await db.exec(`create or replace function public.create_checkout_order(p_customer_name text,p_phone text,p_fulfillment text,p_note text,p_items jsonb,p_email text,p_idempotency_key uuid)
    returns uuid language plpgsql security definer set search_path=public,pg_temp as $$declare oid uuid;it jsonb;v record;cid uuid;begin
      cid:=find_or_create_customer(p_customer_name,p_phone,p_email,null);insert into orders(customer_id,customer_name,phone,email,fulfillment,processing,note,checkout_idempotency_key,checkout_request_fingerprint) values(cid,p_customer_name,p_phone,p_email,p_fulfillment,'依品項',p_note,p_idempotency_key,md5(p_items::text)) returning id into oid;
      perform set_config('app.inventory_movement_type','checkout_sale',true);perform set_config('app.inventory_movement_order_id',oid::text,true);
      for it in select value from jsonb_array_elements(p_items) loop select pv.*,p.name product_name into v from product_variants pv join products p on p.id=pv.product_id where pv.id=(it->>'variant_id')::uuid for update of pv;if v.inventory<(it->>'quantity')::integer then raise exception 'variant_unavailable';end if;update product_variants set inventory=inventory-(it->>'quantity')::integer where id=v.id;insert into order_items(order_id,product_id,product_name,variant_id,variant_name,price,quantity,supply_type) values(oid,v.product_id,v.product_name,v.id,v.name,v.price,(it->>'quantity')::integer,'in_stock');end loop;return oid;end$$;`);
  await db.exec(f0061); await db.exec(f0062); await db.exec(f0063);
  await db.exec("set test.admin='true';set app.phase2_reason='setup'");
  const [{updated_at}]=await q(db,'select updated_at from products where id=$1',[product]);
  await q(db,'select admin_update_weighted_product_settings($1,$2,$3,$4,$5,$6)',[product,updated_at,'SINGLE_WEIGHTED',250,900,'setup']);
  await q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,300,800,600,0,true,'setup']);
  await db.exec(preflight);
  await db.exec(f0064);
  const [{version}]=await q(db,'select version from phase2_freshness_policy where id=1');
  const [{today}]=await q(db,"select (now() at time zone 'Asia/Taipei')::date::text today");
  const [{id:tierId}]=await q(db,'select id from phase2_weight_pricing_tiers where product_id=$1 and enabled order by sort_order limit 1',[product]);
  const submission=crypto.randomUUID();
  const [batch]=await q(db,'select (admin_create_weighted_stock_batch($1,$2,$3)).*',[submission,[{product_id:product,raw_weight_g:420,fish_date:today,expected_tier_id:tierId,expected_system_base_price:420}],version]);
  const stocks=await q(db,'select * from phase2_weighted_stock where batch_id=$1 order by id',[batch.id]);
  return {db,today,stocks};
}

const weightedItem=id=>[{weighted_stock_id:id,processing_option_ids:[]}];
const identity=()=>['王小明','0912345678','永春市場自取','',[],null,crypto.randomUUID()];

test('F006-4 migration creates a browser-closed weighted checkout foundation',async()=>{
  const {db,stocks}=await fixture();
  try{
    await db.exec(postVerify);
    const [name,phone,fulfillment,note,variants,email,key]=identity();
    const [{id}]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    const [order]=await q(db,'select * from orders where id=$1',[id]);
    const [item]=await q(db,'select * from order_items where order_id=$1',[id]);
    const [stock]=await q(db,'select * from phase2_weighted_stock where id=$1',[stocks[0].id]);
    assert.equal(stock.status,'reserved'); assert.equal(stock.order_id,id); assert.equal(item.weighted_raw_weight_g,420);
    assert.equal(item.price,420); assert.ok(order.weighted_hold_expires_at);
    const [replay]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    assert.equal(replay.id,id); assert.equal((await q(db,'select count(*)::int n from orders'))[0].n,1);
    await assert.rejects(q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8)',[name,phone,fulfillment,note,variants,[{...weightedItem(stocks[0].id)[0],processing_note:'changed'}],email,key]),/checkout_idempotency_conflict/);
    const privileges=await q(db,"select has_function_privilege('anon','public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)','execute') anon,has_function_privilege('authenticated','public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)','execute') authenticated");
    assert.deepEqual(privileges[0],{anon:false,authenticated:false});
  }finally{await db.close();}
});

test('mixed checkout is atomic and expiry restores both inventory models once',async()=>{
  const {db,stocks}=await fixture();
  try{
    const [name,phone,fulfillment,note,,email,key]=identity();
    const variants=[{variant_id:variant,quantity:2,processing_option_ids:[]}];
    const [{id}]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    assert.equal((await q(db,'select inventory from product_variants where id=$1',[variant]))[0].inventory,3);
    await q(db,"select phase2_release_expired_checkout_hold($1,weighted_hold_expires_at+interval '1 second') from orders where id=$1",[id]);
    assert.equal((await q(db,'select inventory from product_variants where id=$1',[variant]))[0].inventory,5);
    assert.equal((await q(db,'select status from phase2_weighted_stock where id=$1',[stocks[0].id]))[0].status,'sellable');
    const before=(await q(db,"select count(*)::int n from phase2_audit_events where entity_id=$1 and action='weighted_stock_hold_released'",[stocks[0].id]))[0].n;
    await q(db,"select phase2_release_expired_checkout_hold($1,weighted_hold_expires_at+interval '2 seconds') from orders where id=$1",[id]);
    assert.equal((await q(db,'select inventory from product_variants where id=$1',[variant]))[0].inventory,5);
    assert.equal((await q(db,"select count(*)::int n from phase2_audit_events where entity_id=$1 and action='weighted_stock_hold_released'",[stocks[0].id]))[0].n,before);
  }finally{await db.close();}
});

test('payment atomically marks reserved weighted stock sold and expired payment loses the race',async()=>{
  const {db,stocks}=await fixture();
  try{
    const [name,phone,fulfillment,note,variants,email,key]=identity();
    const [{id}]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    await db.exec("set app.order_payment_authorized='true'");
    await q(db,"update orders set payment_status='paid' where id=$1",[id]);
    assert.equal((await q(db,'select status from phase2_weighted_stock where id=$1',[stocks[0].id]))[0].status,'sold');
    await assert.rejects(q(db,"select phase2_release_expired_checkout_hold($1,weighted_hold_expires_at+interval '1 second') from orders where id=$1",[id]),/paid_order_hold_not_releasable/);
  }finally{await db.close();}
});

test('failed multi-stock checkout rolls back every required fact',async()=>{
  const {db,stocks}=await fixture();
  try{
    const [name,phone,fulfillment,note,variants,email,key]=identity();
    const missing=crypto.randomUUID();
    await assert.rejects(q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8)',[name,phone,fulfillment,note,variants,[...weightedItem(stocks[0].id),...weightedItem(missing)],email,key]),/weighted_stock_unavailable/);
    assert.equal((await q(db,'select count(*)::int n from orders'))[0].n,0);
    assert.equal((await q(db,'select status from phase2_weighted_stock where id=$1',[stocks[0].id]))[0].status,'sellable');
  }finally{await db.close();}
});

test('reserved stock rejects admin unlist and every direct status/link mutation',async()=>{
  const {db,stocks}=await fixture();
  try{
    const [name,phone,fulfillment,note,variants,email,key]=identity();
    const [{id}]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    const [stock]=await q(db,'select * from phase2_weighted_stock where id=$1',[stocks[0].id]);
    await assert.rejects(q(db,"select admin_unlist_weighted_stock($1,$2,'race')",[stock.id,stock.version]),/weighted_stock_unlist_invalid_status/);
    await assert.rejects(q(db,"update phase2_weighted_stock set status='sold' where id=$1",[stock.id]),/weighted_stock_action_or_correction_required/);
    await assert.rejects(q(db,"update phase2_weighted_stock set order_id=null where id=$1",[stock.id]),/weighted_stock_action_or_correction_required/);
    assert.equal((await q(db,'select status from phase2_weighted_stock where id=$1',[stock.id]))[0].status,'reserved');
    assert.equal((await q(db,'select status from orders where id=$1',[id]))[0].status,'new');
  }finally{await db.close();}
});

test('expiry revalidates current freshness and cannot revive an old fish',async()=>{
  const {db,stocks}=await fixture();
  try{
    const [name,phone,fulfillment,note,variants,email,key]=identity();
    const [{id}]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    await q(db,"select phase2_release_expired_checkout_hold($1,weighted_hold_expires_at+interval '4 days') from orders where id=$1",[id]);
    const [stock]=await q(db,'select status,order_id,order_item_id from phase2_weighted_stock where id=$1',[stocks[0].id]);
    assert.deepEqual(stock,{status:'expired',order_id:null,order_item_id:null});
  }finally{await db.close();}
});

test('payment reversal followed by existing admin cancellation safely releases sold weighted stock',async()=>{
  const {db,stocks}=await fixture();
  try{
    const [name,phone,fulfillment,note,variants,email,key]=identity();
    const [{id}]=await q(db,'select phase2_create_checkout_order($1,$2,$3,$4,$5,$6,$7,$8) id',[name,phone,fulfillment,note,variants,weightedItem(stocks[0].id),email,key]);
    await db.exec("set app.order_payment_authorized='true'");
    await q(db,"update orders set payment_status='paid' where id=$1",[id]);
    await q(db,"update orders set payment_status='unpaid' where id=$1",[id]);
    await q(db,'select admin_cancel_order($1)',[id]);
    assert.equal((await q(db,'select status from orders where id=$1',[id]))[0].status,'cancelled');
    const [stock]=await q(db,'select status,order_id,order_item_id from phase2_weighted_stock where id=$1',[stocks[0].id]);
    assert.deepEqual(stock,{status:'sellable',order_id:null,order_item_id:null});
  }finally{await db.close();}
});

test('F006-4 preflight and post-verify remain read-only',()=>{
  for(const sql of [preflight,postVerify]){
    const body=sql.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,"''").trim();
    assert.equal(/\b(create|alter|drop|insert|update|delete|truncate|grant|revoke|call|do)\b/i.test(body),false);
    assert.equal(body.split(';').filter(part=>part.trim()).every(part=>/^\s*(with\b|select\b)/i.test(part)),true);
  }
});

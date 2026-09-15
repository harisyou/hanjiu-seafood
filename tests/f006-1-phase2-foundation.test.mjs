import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const migration=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-database-foundation.sql',import.meta.url),'utf8');
const product='10000000-0000-4000-8000-000000000001';
const tier='20000000-0000-4000-8000-000000000001';
const q=(db,sql,params)=>db.query(sql,params).then(r=>r.rows);

test('PR-A migration preserves legacy columns and enforces pricing, snapshots, freshness, mode and RLS',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;
      create function public.is_hanjiu_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
      create table public.products(id uuid primary key,name text,status text,updated_at timestamptz default now());
      create table public.product_variants(id uuid primary key,product_id uuid references products(id),active boolean,inventory integer);
      create table public.orders(id uuid primary key,status text,checkout_idempotency_key uuid,checkout_request_fingerprint text);
      create unique index orders_checkout_idempotency_key_unique_idx on orders(checkout_idempotency_key) where checkout_idempotency_key is not null;
      create table public.order_items(id uuid primary key,order_id uuid references orders(id),product_id uuid references products(id),price integer,quantity integer,supply_type text,processing_preset_name text);
      create table public.inventory_movements(id uuid primary key,variant_id uuid,order_id uuid,inventory_delta integer,movement_type text);
      create table public.order_payments(id uuid primary key,order_id uuid,amount integer,attempt_number integer);
      create table public.order_payment_reversals(id uuid primary key,payment_id uuid,amount integer);
      create table public.product_images(id uuid primary key,product_id uuid references products(id));
      insert into products values('${product}','馬頭魚','available',now());
      insert into orders values('30000000-0000-4000-8000-000000000001','completed',null,null);
      insert into order_items values('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','${product}',499,1,'in_stock','不處理');
      insert into inventory_movements values('50000000-0000-4000-8000-000000000001',null,'30000000-0000-4000-8000-000000000001',-1,'checkout_sale');
      insert into order_payments values('60000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',499,1);
      insert into order_payment_reversals values('70000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',499);`);
    const before=await q(db,`select (select row_to_json(x) from (select * from orders) x) orders,
      (select row_to_json(x) from (select * from order_items) x) item,
      (select row_to_json(x) from (select * from inventory_movements) x) movement,
      (select row_to_json(x) from (select * from order_payments) x) payment,
      (select row_to_json(x) from (select * from order_payment_reversals) x) reversal`);
    await db.exec(migration);
    const after=await q(db,`select (select row_to_json(x) from (select * from orders) x) orders,
      (select row_to_json(x) from (select * from order_items) x) item,
      (select row_to_json(x) from (select * from inventory_movements) x) movement,
      (select row_to_json(x) from (select * from order_payments) x) payment,
      (select row_to_json(x) from (select * from order_payment_reversals) x) reversal`);
    assert.deepEqual(after,before);
    assert.equal((await q(db,'select inventory_mode from products'))[0].inventory_mode,null);
    await db.exec(`set app.phase2_reason='initial reviewed pricing configuration';
      update products set inventory_mode='SINGLE_WEIGHTED' where id='${product}';
      insert into phase2_weight_pricing_tiers(id,product_id,lower_bound_g,upper_bound_g,price_per_jin)
      values('${tier}','${product}',200,400,600);
      insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin)
      values('${product}',500,700,600);`);
    await assert.rejects(db.query('insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin) values($1,300,450,600)',[product]),/weight_pricing_tier_overlap/);
    await assert.rejects(db.query('insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin) values($1,400,550,600)',[product]),/weight_pricing_tier_overlap/);
    await assert.rejects(db.query('insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin) values($1,700,800,0)',[product]),/check constraint/);
    await assert.rejects(db.query('update phase2_weight_pricing_tiers set product_id=$1 where id=$2',['10000000-0000-4000-8000-000000000099',tier]),/weight_pricing_tier_product_immutable/);
    await db.exec("set app.phase2_reason=''");
    await assert.rejects(db.query('insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin) values($1,900,950,600)',[product]),/phase2_change_reason_required/);
    await db.exec("set app.phase2_reason='reviewed additional tier'");
    // 400g is outside the first half-open tier; 400..500 is a deliberate gap.
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,400)',[product,'2026-09-10']),/weight_pricing_tier_not_found/);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g,status) values($1,$2,300,$3)',[product,'2026-09-10','sold']),/weighted_stock_initial_state_required/);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,0)',[product,'2026-09-10']),/invalid_raw_weight_g|check constraint/);
    const stock=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300) returning *',[product,'2026-09-10']))[0];
    assert.equal(stock.system_base_price,300);
    assert.equal(stock.t0_base_price,300);
    assert.match(stock.stock_code,/^F-260910-[0-9]{8}$/);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action='stock_created'"))[0].n,1);
    const lower=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,200) returning *',[product,'2026-09-10']))[0];
    assert.equal(lower.system_base_price,200);
    const upper=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,500) returning *',[product,'2026-09-10']))[0];
    assert.equal(upper.system_base_price,500);
    assert.notEqual(stock.stock_code,lower.stock_code);
    const exact600=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,600) returning *',[product,'2026-09-10']))[0];
    assert.equal(exact600.system_base_price,600);
    await db.exec(`insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin)
      values('${product}',701,900,601);`);
    const rounded=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,750) returning *',[product,'2026-09-10']))[0];
    assert.equal(rounded.system_base_price,751); // 750 * 601 / 600 = 751.25
    await db.exec(`set app.phase2_reason='rounding boundary price'; update phase2_weight_pricing_tiers set price_per_jin=601 where id='${tier}'`);
    const half=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300) returning *',[product,'2026-09-10']))[0];
    assert.equal(half.system_base_price,301);assert.equal(Math.round(300*601/600),301);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g,manual_base_price) values($1,$2,300,0)',[product,'2026-09-10']),/invalid_manual_base_price|check constraint/);
    const manual=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g,manual_base_price) values($1,$2,300,999) returning *',[product,'2026-09-10']))[0];
    assert.equal(manual.system_base_price,301);assert.equal(manual.t0_base_price,999);
    await db.exec("set app.phase2_reason=''");
    await assert.rejects(db.query(`update phase2_weight_pricing_tiers set price_per_jin=1200 where id='${tier}'`),/phase2_change_reason_required/);
    await db.exec(`set app.phase2_reason='reviewed tier correction'; update phase2_weight_pricing_tiers set price_per_jin=1200 where id='${tier}'`);
    const originalSnapshot=(await q(db,'select system_base_price,price_per_jin_snapshot,t0_base_price from phase2_weighted_stock where id=$1',[stock.id]))[0];
    assert.deepEqual(originalSnapshot,{system_base_price:300,price_per_jin_snapshot:600,t0_base_price:300});
    const newer=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300) returning *',[product,'2026-09-10']))[0];
    assert.equal(newer.system_base_price,600);
    const day=async(id,stamp)=>(await q(db,'select phase2_current_weighted_stock_price($1,$2) price',[id,stamp]))[0].price;
    assert.equal(await day(stock.id,'2026-09-10T15:59:59Z'),300); // Taiwan 23:59 T+0
    assert.equal(await day(stock.id,'2026-09-10T16:00:00Z'),285); // Taiwan 00:00 T+1
    assert.equal(await day(stock.id,'2026-09-11T16:00:00Z'),270); // T+2
    assert.equal(await day(stock.id,'2026-09-12T16:00:00Z'),null); // T+3
    assert.equal(await day(stock.id,'2026-09-09T15:59:59Z'),null); // before fish date
    assert.equal(await day(manual.id,'2026-09-10T16:00:00Z'),949); // 999*.95 = 949.05
    await assert.rejects(db.query('update phase2_freshness_days set multiplier=0 where day_offset=1'),/check constraint/);
    await assert.rejects(db.query('update phase2_freshness_days set multiplier=1.01 where day_offset=1'),/check constraint/);
    await db.exec('update phase2_freshness_days set multiplier=0.9 where day_offset=1');
    assert.equal(await day(stock.id,'2026-09-10T16:00:00Z'),270); // live policy edits affect unsold stock
    await db.exec('update phase2_freshness_policy set max_sale_day=1 where id=1');
    assert.equal((await q(db,'select version from phase2_freshness_policy where id=1'))[0].version,2);
    assert.equal(await day(stock.id,'2026-09-11T16:00:00Z'),null);
    await assert.rejects(db.query('update phase2_freshness_policy set max_sale_day=-1 where id=1'),/check constraint/);
    await db.exec('update phase2_freshness_policy set max_sale_day=3 where id=1');
    assert.equal(await day(stock.id,'2026-09-12T16:00:00Z'),null); // missing T+3 policy day fails closed
    await db.exec("set app.phase2_reason='reviewed extended freshness day'; insert into phase2_freshness_days(day_offset,multiplier) values(3,0.8)");
    assert.equal(await day(stock.id,'2026-09-12T16:00:00Z'),240);
    await assert.rejects(db.query('update phase2_weighted_stock set stock_code=$1 where id=$2',['changed',stock.id]),/weighted_stock_action_or_correction_required/);
    await assert.rejects(db.query('update phase2_weighted_stock set status=$1 where id=$2',['sold',stock.id]),/weighted_stock_action_or_correction_required/);
    await db.exec(`update phase2_weighted_stock set batch_reference='B-1' where id='${stock.id}'`);
    assert.equal((await q(db,'select version from phase2_weighted_stock where id=$1',[stock.id]))[0].version,2);
    await assert.rejects(db.query('update products set inventory_mode=$1 where id=$2',['QUANTITY_VARIANT',product]),/inventory_mode_active_weighted_stock/);
    await db.exec(`insert into products(id,name,status) values('10000000-0000-4000-8000-000000000002','legacy shrimp','available');
      insert into orders values('30000000-0000-4000-8000-000000000002','new',null,null);
      insert into order_items values('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002',600,1,'in_stock','不處理');`);
    await assert.rejects(db.query("update products set inventory_mode='SINGLE_WEIGHTED' where id='10000000-0000-4000-8000-000000000002'"),/inventory_mode_open_stock_order/);
    await assert.rejects(db.query('delete from phase2_audit_events'),/phase2_audit_append_only/);
    await assert.rejects(db.query('delete from phase2_weighted_stock where id=$1',[stock.id]),/phase2_foundation_delete_not_allowed/);
    await assert.rejects(db.query('delete from phase2_freshness_days where day_offset=2'),/phase2_foundation_delete_not_allowed/);
    const audit=await q(db,"select action,reason,old_value,new_value from phase2_audit_events where action='pricing_tier_update'");
    assert.equal(audit.length,2);
    assert.equal(audit.at(-1).reason,'reviewed tier correction');
    assert.equal(audit.at(-1).old_value.price_per_jin,601);assert.equal(audit.at(-1).new_value.price_per_jin,1200);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action like 'freshness_%_update'"))[0].n,3);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from phase2_weighted_stock'),/permission denied/);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300)',[product,'2026-09-10']),/permission denied/);
    await assert.rejects(db.query('select * from phase2_audit_events'),/permission denied/);
    await db.exec('reset role; set role authenticated');
    assert.equal((await q(db,'select * from phase2_weighted_stock')).length,0);
    await assert.rejects(db.query('select admin_create_weighted_stock($1,$2,$3)',[product,'2026-09-10',300]),/admin_required/);
    await assert.rejects(db.query('update phase2_freshness_days set multiplier=0.8'),/permission denied/);
    await db.exec("reset role; set test.admin='true'; set role authenticated");
    assert.ok((await q(db,'select * from phase2_weighted_stock')).length>0);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300)',[product,'2026-09-10']),/permission denied/);
    assert.ok((await q(db,'select admin_create_weighted_stock($1,$2,$3)',[product,'2026-09-10',300])).length===1);
  } finally {await db.close();}
});

test('foundation migration never replaces F004-1 checkout or rewrites ledger/payment tables',()=>{
  assert.doesNotMatch(migration,/create\s+or\s+replace\s+function\s+public\.create_checkout_order|alter\s+table\s+public\.(orders|order_items|inventory_movements|order_payments|order_payment_reversals)/i);
  assert.match(migration,/inventory_mode text/);
  assert.match(migration,/phase2_audit_events/);
});

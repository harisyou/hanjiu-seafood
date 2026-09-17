import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const f0061=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-database-foundation.sql',import.meta.url),'utf8');
const f0062=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-weighted-quick-entry.sql',import.meta.url),'utf8');
const preflight=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-preflight.sql',import.meta.url),'utf8');
const postVerify=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-post-verify.sql',import.meta.url),'utf8');
const product='10000000-0000-4000-8000-000000000001';
const q=(db,sql,params)=>db.query(sql,params).then(result=>result.rows);

test('F006-2 verification scripts are SELECT-only and require explicit saved baselines',()=>{
  for(const sql of [preflight,postVerify]){
    const body=sql.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,"''").trim();
    assert.equal(/\b(create|alter|drop|insert|update|delete|truncate|grant|revoke|call|do)\b/i.test(body),false);
    assert.equal(body.split(';').filter(part=>part.trim()).every(part=>/^\s*(with\b|select\b)/i.test(part)),true);
  }
  assert.match(preflight,/inventory_movements_rows_md5/);
  assert.match(postVerify,/PASTE_EXACT_PREFLIGHT_SIGNATURE/);
  assert.match(postVerify,/null::bigint/);
  assert.doesNotMatch(f0062,/\b(?:create\s+or\s+replace\s+function|alter\s+table|update|delete\s+from)\s+public\.(?:create_checkout_order|orders|order_items|inventory_movements|order_payments|order_payment_reversals)\b/i);
});

async function fixture(){
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select '80000000-0000-4000-8000-000000000001'::uuid$$;
    create function public.is_hanjiu_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
    create table products(id uuid primary key,name text,status text,updated_at timestamptz default now());
    create table product_variants(id uuid primary key,product_id uuid references products(id),active boolean,inventory integer);
    create table orders(id uuid primary key,status text);
    create table order_items(id uuid primary key,order_id uuid references orders(id),product_id uuid references products(id),supply_type text);
    create table inventory_movements(id uuid primary key,inventory_delta integer);
    create table order_payments(id uuid primary key);
    create table order_payment_reversals(id uuid primary key);
    create table product_images(id uuid primary key,product_id uuid references products(id));
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    insert into products values('${product}','赤棕','available',now());`);
  await db.exec(f0061);
  await db.exec(f0062);
  await db.exec("set test.admin='true'; set app.phase2_reason='initial setup'");
  const timestamp=(await q(db,'select updated_at from products where id=$1',[product]))[0].updated_at;
  await q(db,'select admin_update_weighted_product_settings($1,$2,$3,$4,$5,$6)',[product,timestamp,'SINGLE_WEIGHTED',250,900,'enable weighed stock']);
  await q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,300,500,480,0,true,'first tier']);
  await q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,600,800,520,1,true,'second tier']);
  const today=(await q(db,"select (now() at time zone 'Asia/Taipei')::date::text today"))[0].today;
  const freshnessVersion=(await q(db,'select version from phase2_freshness_policy where id=1'))[0].version;
  return {db,today,freshnessVersion};
}

function item(weight,date,manual=null,confirmed=false,tier=null,system=null){
  return {product_id:product,raw_weight_g:weight,fish_date:date,manual_base_price:manual,
    manual_price_confirmed:confirmed,expected_tier_id:tier,expected_system_base_price:system};
}

test('PR-B forward migration executes and batch creation is atomic, idempotent, and preserves legacy tables',async()=>{
  const {db,today,freshnessVersion}=await fixture();
  try {
    const tiers=await q(db,'select id,lower_bound_g from phase2_weight_pricing_tiers order by lower_bound_g');
    const first=tiers[0].id;
    const valid=item(420,today,null,false,first,336);
    const duplicate=item(420,today,null,false,first,336);
    const gap=item(550,today,450,true,null,null);
    const submission='90000000-0000-4000-8000-000000000001';
    await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3)',[submission,[valid,item(550,today)],freshnessVersion]),/weight_pricing_tier_not_found/);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,0);
    assert.equal((await q(db,'select count(*)::integer n from phase2_stock_batches'))[0].n,0);
    const batch=(await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3,$4,$5) batch) select (batch).* from created',[submission,[valid,duplicate,gap],freshnessVersion,'南方澳','今日魚貨']))[0];
    assert.equal(batch.stock_count,3);
    const stocks=await q(db,'select id,stock_code,raw_weight_g,pricing_tier_id,system_base_price,manual_base_price,t0_base_price,batch_id from phase2_weighted_stock order by stock_code');
    assert.equal(stocks.length,3);
    assert.equal(new Set(stocks.map(stock=>stock.id)).size,3);
    assert.equal(new Set(stocks.map(stock=>stock.stock_code)).size,3);
    assert.deepEqual(stocks.filter(stock=>stock.raw_weight_g===420).map(stock=>stock.system_base_price),[336,336]);
    assert.equal(stocks.find(stock=>stock.raw_weight_g===550).pricing_tier_id,null);
    assert.equal(stocks.find(stock=>stock.raw_weight_g===550).system_base_price,null);
    assert.equal(stocks.find(stock=>stock.raw_weight_g===550).t0_base_price,450);
    assert.ok(stocks.every(stock=>stock.batch_id===batch.id));
    const retry=(await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3,$4,$5) batch) select (batch).* from created',[submission,[valid,duplicate,gap],freshnessVersion,'南方澳','今日魚貨']))[0];
    assert.equal(retry.id,batch.id);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,3);
    await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3,$4,$5)',[submission,[gap,valid,duplicate],freshnessVersion,'南方澳','今日魚貨']),/quick_entry_idempotency_conflict/);
    assert.equal((await q(db,'select count(*)::integer n from inventory_movements'))[0].n,0);
  } finally {await db.close();}
});

test('tier overlap and re-enable guard, manual confirmation, old snapshot stability',async()=>{
  const {db,today,freshnessVersion}=await fixture();
  try {
    const [old]=await q(db,'select * from phase2_weight_pricing_tiers where lower_bound_g=300');
    await assert.rejects(q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,400,650,600,3,true,'overlap']),/overlap/);
    const [disabled]=await q(db,'with saved as materialized (select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7) tier) select (tier).* from saved',[product,400,650,600,3,false,'keep disabled']);
    await assert.rejects(q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7,$8,$9)',[product,400,650,600,3,true,'try enable',disabled.id,disabled.updated_at]),/overlap/);
    const valid=item(420,today,450,false,old.id,336);
    const [batch]=await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3) batch) select (batch).* from created',
      ['90000000-0000-4000-8000-000000000011',[valid],freshnessVersion]);
    const [stock]=await q(db,'select * from phase2_weighted_stock where batch_id=$1',[batch.id]);
    assert.equal(stock.system_base_price,336);assert.equal(stock.manual_base_price,450);assert.equal(stock.t0_base_price,450);
    await q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7,$8,$9)',[product,300,500,700,0,true,'rate change',old.id,old.updated_at]);
    const [after]=await q(db,'select * from phase2_weighted_stock where id=$1',[stock.id]);
    assert.equal(after.system_base_price,336);assert.equal(after.price_per_jin_snapshot,480);
    assert.equal((await q(db,"select phase2_current_weighted_stock_price($1,now()) as price",[stock.id]))[0].price,450);
  } finally {await db.close();}
});

test('fish-date guard, non-admin rejection, browser write privileges, and optional photo isolation',async()=>{
  const {db,today,freshnessVersion}=await fixture();
  try {
    const [tier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=300');
    const valid=item(420,today,null,false,tier.id,336);
    const [dates]=await q(db,"select ((now() at time zone 'Asia/Taipei')::date-3)::text expired, ((now() at time zone 'Asia/Taipei')::date+1)::text future");
    for(const date of [dates.expired,dates.future]){
      await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3)',[crypto.randomUUID(),[item(420,date,null,false,tier.id,336)],freshnessVersion]),/weighted_stock_/);
    }
    await db.exec("set test.admin='false'");
    await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3)',[crypto.randomUUID(),[valid],freshnessVersion]),/admin_required/);
    await assert.rejects(q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,900,1000,500,0,true,'attempt']),/admin_required/);
    const [rights]=await q(db,"select has_table_privilege('authenticated','public.phase2_weighted_stock','INSERT') stock_insert, has_table_privilege('authenticated','public.phase2_stock_batches','INSERT') batch_insert, has_table_privilege('authenticated','public.phase2_stock_photos','INSERT') photo_insert");
    assert.deepEqual(Object.values(rights),[false,false,false]);
    await db.exec("set test.admin='true'");
    const [batch]=await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3) batch) select (batch).* from created',
      [crypto.randomUUID(),[valid],freshnessVersion]);
    const [stock]=await q(db,'select id from phase2_weighted_stock where batch_id=$1',[batch.id]);
    const path=`weighted-stock/${stock.id}/90000000-0000-4000-8000-000000000099.webp`;
    await assert.rejects(q(db,'select admin_link_weighted_stock_photo($1,$2)',[stock.id,path]),/weighted_stock_photo_object_missing/);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,1);
    await q(db,"insert into storage.objects(bucket_id,name) values('product-images',$1)",[path]);
    const [linked]=await q(db,'with photo as materialized (select admin_link_weighted_stock_photo($1,$2) p) select (p).* from photo',[stock.id,path]);
    assert.equal(linked.storage_path,path);
    const [retried]=await q(db,'with photo as materialized (select admin_link_weighted_stock_photo($1,$2) p) select (p).* from photo',[stock.id,path]);
    assert.equal(retried.stock_id,stock.id);
    assert.equal((await q(db,'select count(*)::integer n from phase2_stock_photos'))[0].n,1);
  } finally {await db.close();}
});

test('server freshness uses each past fish date and policy-enforced manual confirmation',async()=>{
  const {db,freshnessVersion}=await fixture();
  try {
    const [dates]=await q(db,"select ((now() at time zone 'Asia/Taipei')::date)::text d0, ((now() at time zone 'Asia/Taipei')::date-1)::text d1, ((now() at time zone 'Asia/Taipei')::date-2)::text d2");
    const [tier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=300');
    const items=[dates.d0,dates.d1,dates.d2].map(date=>item(420,date,null,false,tier.id,336));
    const [batch]=await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3) batch) select (batch).* from created',
      [crypto.randomUUID(),items,freshnessVersion]);
    const priced=await q(db,'select fish_date::text,phase2_current_weighted_stock_price(id,now()) price from phase2_weighted_stock where batch_id=$1 order by fish_date desc',[batch.id]);
    assert.deepEqual(priced.map(row=>row.price),[336,319,302]);
    await q(db,'update phase2_manual_price_confirmation_policy set max_unconfirmed_deviation_ratio=$1 where id=1',[.05]);
    const manual=item(420,dates.d0,450,false,tier.id,336);
    await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3)',[crypto.randomUUID(),[manual],freshnessVersion]),/manual_price_confirmation_required/);
    manual.manual_price_confirmed=true;
    const [manualBatch]=await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3) batch) select (batch).* from created',
      [crypto.randomUUID(),[manual],freshnessVersion]);
    const [saved]=await q(db,'select system_base_price,manual_base_price,t0_base_price from phase2_weighted_stock where batch_id=$1',[manualBatch.id]);
    assert.equal(saved.system_base_price,336);assert.equal(saved.manual_base_price,450);assert.equal(saved.t0_base_price,450);
  } finally {await db.close();}
});

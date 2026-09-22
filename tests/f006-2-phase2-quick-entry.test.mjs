import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const f0061=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-database-foundation.sql',import.meta.url),'utf8');
const f0062=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-weighted-quick-entry.sql',import.meta.url),'utf8');
const preflight=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-preflight.sql',import.meta.url),'utf8');
const postVerify=readFileSync(new URL('../supabase/f006-2-phase2-pr-b-post-verify.sql',import.meta.url),'utf8');
const preflightStockDigestSql=preflight.match(/select count\(\*\)::bigint weighted_stock_baseline_count,[\s\S]*?from public\.phase2_weighted_stock s;/)[0];
const postStockDigestTemplate=postVerify.match(/with baseline\(expected_count,expected_md5\) as \(values \(null::bigint,null::text\)\),[\s\S]*?from baseline cross join actual;/)[0];
const product='10000000-0000-4000-8000-000000000001';
const q=(db,sql,params)=>db.query(sql,params).then(result=>result.rows);

test('F006-2 verification scripts are SELECT-only and require explicit saved baselines',()=>{
  for(const sql of [preflight,postVerify]){
    const body=sql.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,"''").trim();
    assert.equal(/\b(create|alter|drop|insert|update|delete|truncate|grant|revoke|call|do)\b/i.test(body),false);
    assert.equal(body.split(';').filter(part=>part.trim()).every(part=>/^\s*(with\b|select\b)/i.test(part)),true);
  }
  assert.match(preflight,/inventory_movements_rows_md5/);
  assert.match(postVerify,/expected_md5_by_signature/);
  assert.match(postVerify,/null::bigint/);
  assert.doesNotMatch(preflight+postVerify,/p\.proname\s*~/);
  const signatures=sql=>[...sql.matchAll(/protected_function\(signature\) as \(values([\s\S]*?)\n\)/g)]
    .map(match=>[...match[1].matchAll(/'([^']+)'/g)].map(item=>item[1]));
  const [catalogSignatures,preflightSignatures]=signatures(preflight);
  const [postSignatures]=signatures(postVerify);
  assert.equal(catalogSignatures.length,28);
  assert.deepEqual(preflightSignatures,catalogSignatures);
  assert.deepEqual(postSignatures,catalogSignatures);
  for(const signature of [
    'create_checkout_order(text,text,text,text,jsonb)',
    'create_checkout_order(text,text,text,text,jsonb,text)',
    'create_checkout_order(text,text,text,text,jsonb,text,uuid)',
    'is_hanjiu_admin()','admin_cancel_order(uuid)',
    'admin_record_order_payment(uuid,integer,text)',
    'admin_record_order_payment(uuid,integer,text,uuid)',
    'admin_reverse_order_payment(uuid,text)','enforce_order_cancellation_flow()',
    'enforce_order_payment_flow()','enforce_paid_order_financial_lock()',
    'admin_audit_order_financial_integrity()','log_inventory_movement()',
    'phase2_current_weighted_stock_price(uuid,timestamp with time zone)',
    'phase2_manual_price_requires_confirmation(integer,integer)',
    'admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)',
    'phase2_guard_inventory_mode()','phase2_guard_tier_overlap()'
  ])assert.ok(catalogSignatures.includes(signature),signature);
  const legacyExpression=sql=>{
    const match=sql.match(/md5\(coalesce\(string_agg\(s\.id::text\|\|':'\|\|md5\(jsonb_build_array\(([\s\S]*?)\)::text\)/);
    assert.ok(match);
    return match[1];
  };
  const legacyColumns=sql=>[...new Set([...legacyExpression(sql).matchAll(/s\.([a-z_]+)/g)].map(item=>item[1]))];
  assert.equal(legacyColumns(preflight).length,19);
  assert.deepEqual(legacyColumns(postVerify),legacyColumns(preflight));
  assert.equal(legacyExpression(postVerify).replace(/\s+/g,''),legacyExpression(preflight).replace(/\s+/g,''));
  assert.doesNotMatch(f0062,/\b(?:create\s+or\s+replace\s+function|alter\s+table|update|delete\s+from)\s+public\.(?:create_checkout_order|orders|order_items|inventory_movements|order_payments|order_payment_reversals)\b/i);
});

async function fixture({priorStock=false,stopAtF0061=false}={}){
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
    create table storage.buckets(id text primary key);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));
    insert into storage.buckets values('product-images');
    insert into products values('${product}','赤棕','available',now());`);
  await db.exec(f0061);
  if(stopAtF0061)return {db};
  let historicalId=null;let weightedBaseline=null;
  if(priorStock){
    await db.exec("set test.admin='true'; set app.phase2_reason='PR-A historical fixture'");
    await q(db,'update products set inventory_mode=$1 where id=$2',['SINGLE_WEIGHTED',product]);
    await q(db,'insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin,sort_order,enabled) values($1,300,500,480,0,true)',[product]);
    const [date]=await q(db,"select (now() at time zone 'Asia/Taipei')::date::text today");
    const [historical]=await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,420) returning id',[product,date.today]);
    historicalId=historical.id;
    weightedBaseline=(await q(db,preflightStockDigestSql))[0];
  }
  await db.exec(f0062);
  await db.exec("set test.admin='true'; set app.phase2_reason='initial setup'");
  const timestamp=(await q(db,'select updated_at from products where id=$1',[product]))[0].updated_at;
  await q(db,'select admin_update_weighted_product_settings($1,$2,$3,$4,$5,$6)',[product,timestamp,'SINGLE_WEIGHTED',250,900,'enable weighed stock']);
  if(!priorStock)await q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,300,500,480,0,true,'first tier']);
  await q(db,'select admin_save_weight_pricing_tier($1,$2,$3,$4,$5,$6,$7)',[product,600,800,520,1,true,'second tier']);
  const today=(await q(db,"select (now() at time zone 'Asia/Taipei')::date::text today"))[0].today;
  const freshnessVersion=(await q(db,'select version from phase2_freshness_policy where id=1'))[0].version;
  return {db,today,freshnessVersion,historicalId,weightedBaseline};
}

test('preflight fingerprints the exact F006-1 helpers that F006-2 will replace',async()=>{
  const {db}=await fixture({stopAtF0061:true});
  try {
    for(const [signature,expected] of [
      ['phase2_initialize_weighted_stock()','a41e2ff5cfd1176e11e6766113ee67d1'],
      ['phase2_guard_weighted_stock_update()','33e277b593304198a358bc7483c071b2']
    ]){
      const [definition]=await q(db,"select md5(regexp_replace(prosrc,E'\\r\\n?',E'\\n','g')) body_md5 from pg_proc where oid=$1::regprocedure",[`public.${signature}`]);
      assert.equal(definition.body_md5,expected,signature);
      assert.match(preflight,new RegExp(expected));
    }
    const catalogSql=preflight.slice(0,preflight.indexOf('from checks;')+'from checks;'.length);
    const [catalog]=await q(db,catalogSql);
    assert.doesNotMatch(catalog.reasons,/F006-1 weighted stock|F006-1 stock-code sequence/);
    await db.exec('alter table phase2_weighted_stock alter column raw_weight_g drop not null');
    assert.match((await q(db,catalogSql))[0].reasons,/F006-1 weighted stock column\/type\/nullability mismatch: raw_weight_g/);
  } finally {await db.close();}
});

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
    assert.equal((await q(db,'select phase2_current_weighted_stock_price($1,now()) price',[stocks.find(stock=>stock.raw_weight_g===550).id]))[0].price,450);
    assert.ok(stocks.every(stock=>stock.batch_id===batch.id));
    const retry=(await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3,$4,$5) batch) select (batch).* from created',[submission,[valid,duplicate,gap],freshnessVersion,'南方澳','今日魚貨']))[0];
    assert.equal(retry.id,batch.id);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,3);
    await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3,$4,$5)',[submission,[gap,valid,duplicate],freshnessVersion,'南方澳','今日魚貨']),/quick_entry_idempotency_conflict/);
    assert.equal((await q(db,'select count(*)::integer n from inventory_movements'))[0].n,0);
  } finally {await db.close();}
});

async function quickEntryPersistenceSnapshot(db){
  const [batchCount]=await q(db,'select count(*)::integer n from phase2_stock_batches');
  const stocks=await q(db,'select id,stock_code,batch_id from phase2_weighted_stock order by id');
  const [sequence]=await q(db,'select last_value,is_called from phase2_stock_code_seq');
  return {batchCount:batchCount.n,stocks,sequence};
}

test('database idempotent replay returns the original batch without stock or stock-code sequence consumption',async()=>{
  const {db,today,freshnessVersion}=await fixture();
  try {
    const [tier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=300');
    const rows=[item(420,today,null,false,tier.id,336),item(430,today,null,false,tier.id,344)];
    const submission=crypto.randomUUID();
    const sql='with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3,$4,$5) batch) select (batch).* from created';
    const params=[submission,rows,freshnessVersion,'南方澳','今日魚貨'];
    const [first]=await q(db,sql,params);
    const before=await quickEntryPersistenceSnapshot(db);
    assert.equal(before.batchCount,1);
    assert.equal(before.stocks.length,2);
    assert.ok(before.stocks.every(stock=>stock.batch_id===first.id));

    const [replay]=await q(db,sql,params);
    const after=await quickEntryPersistenceSnapshot(db);
    assert.deepEqual(replay,first);
    assert.deepEqual(after,before);
  } finally {await db.close();}
});

test('database submission conflict creates no batch or stock and consumes no stock-code sequence value',async()=>{
  const {db,today,freshnessVersion}=await fixture();
  try {
    const [tier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=300');
    const rows=[item(420,today,null,false,tier.id,336)];
    const submission=crypto.randomUUID();
    const sql='select admin_create_weighted_stock_batch($1,$2,$3,$4,$5)';
    await q(db,sql,[submission,rows,freshnessVersion,'南方澳','今日魚貨']);
    const before=await quickEntryPersistenceSnapshot(db);
    assert.equal(before.batchCount,1);
    assert.equal(before.stocks.length,1);

    const changedRows=[item(430,today,null,false,tier.id,344)];
    await assert.rejects(q(db,sql,[submission,changedRows,freshnessVersion,'南方澳','今日魚貨']),
      /quick_entry_idempotency_conflict/);
    const after=await quickEntryPersistenceSnapshot(db);
    assert.deepEqual(after,before);
  } finally {await db.close();}
});

test('server canonical payload accepts representation-only retries but preserves row and value identity',async()=>{
  const {db,today,freshnessVersion}=await fixture();
  try {
    const [tier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=300');
    const rows=[item(420,today,null,false,tier.id,336),item(430,today,null,false,tier.id,344)];
    const submission=crypto.randomUUID();
    const [first]=await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3,$4,$5) batch) select (batch).* from created',
      [submission,rows,freshnessVersion,' 南方澳 ',' 今日 ']);
    const equivalent=[
      {expected_system_base_price:'336.0',manual_price_confirmed:'false',fish_date:today,
        expected_tier_id:tier.id.toUpperCase(),raw_weight_g:' 420.00 ',product_id:product.toUpperCase(),manual_base_price:''},
      {fish_date:today,product_id:product,raw_weight_g:430.0,
        expected_tier_id:tier.id,expected_system_base_price:344,manual_base_price:null}
    ];
    const [retry]=await q(db,'with created as materialized (select admin_create_weighted_stock_batch($1,$2,$3,$4,$5) batch) select (batch).* from created',
      [submission,equivalent,freshnessVersion,'南方澳','今日']);
    assert.equal(retry.id,first.id);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock where batch_id=$1',[first.id]))[0].n,2);
    for(const [changedRows,source,note] of [
      [[rows[1],rows[0]],'南方澳','今日'],
      [[{...rows[0],manual_base_price:450},rows[1]],'南方澳','今日'],
      [[{...rows[0],expected_system_base_price:337},rows[1]],'南方澳','今日'],
      [rows,'其他來源','今日'],[rows,'南方澳','真正不同備註']
    ]){
      await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3,$4,$5)',
        [submission,changedRows,freshnessVersion,source,note]),/quick_entry_idempotency_conflict/);
    }
    await assert.rejects(q(db,'select admin_create_weighted_stock_batch($1,$2,$3)',
      [crypto.randomUUID(),[{...rows[0],unexpected_field:1}],freshnessVersion]),/quick_entry_unknown_item_field/);
    assert.equal((await q(db,'select count(*)::integer n from phase2_stock_batches'))[0].n,1);
  } finally {await db.close();}
});

test('F006-1 historical stock survives migration and price-origin constraints reject every half-state',async()=>{
  const {db,historicalId,today,weightedBaseline}=await fixture({priorStock:true});
  try {
    assert.equal(weightedBaseline.weighted_stock_baseline_count,1);
    const postStockDigestSql=postStockDigestTemplate.replace('null::bigint,null::text',
      `${weightedBaseline.weighted_stock_baseline_count}::bigint,'${weightedBaseline.weighted_stock_f0061_business_md5}'::text`);
    assert.equal((await q(db,postStockDigestSql))[0].weighted_stock_baseline_summary,'PASS');
    await db.exec("set time zone 'Asia/Taipei'");
    assert.equal((await q(db,postStockDigestSql))[0].weighted_stock_baseline_summary,'PASS');
    const [tier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=300');
    const [historical]=await q(db,'select pricing_tier_id,price_per_jin_snapshot,system_base_price,manual_base_price,t0_base_price,version from phase2_weighted_stock where id=$1',[historicalId]);
    assert.equal(historical.pricing_tier_id,tier.id);
    assert.equal(historical.price_per_jin_snapshot,480);
    assert.equal(historical.system_base_price,336);
    assert.equal(historical.manual_base_price,null);
    assert.equal(historical.t0_base_price,336);
    assert.equal(historical.version,1);
    assert.equal((await q(db,"select convalidated from pg_constraint where conrelid='public.phase2_weighted_stock'::regclass and conname='phase2_stock_price_origin_check'"))[0].convalidated,true);
    await db.exec('alter table phase2_weighted_stock disable trigger phase2_stock_initialize');
    const sql=`insert into phase2_weighted_stock(product_id,stock_code,fish_date,raw_weight_g,
      pricing_tier_id,price_per_jin_snapshot,system_base_price,manual_base_price,manual_price_confirmed,t0_base_price)
      values($1,$2,$3,420,$4,$5,$6,$7,$8,$9)`;
    const insert=(code,tierId,perJin,system,manual,confirmed,t0)=>q(db,sql,[product,code,today,tierId,perJin,system,manual,confirmed,t0]);
    await insert('TEST-MANUAL-OK',null,null,null,450,true,450);
    const cases=[
      ['TEST-NULL-ALL',null,null,null,null,false,450],
      ['TEST-TIER-ONLY',tier.id,null,null,null,false,450],
      ['TEST-MIXED',null,480,336,450,true,450],
      ['TEST-MANUAL-NOT-CONFIRMED',null,null,null,450,false,450],
      ['TEST-MANUAL-ZERO',null,null,null,0,true,450],
      ['TEST-MANUAL-WRONG-T0',null,null,null,450,true,451],
      ['TEST-TIER-WRONG-T0',tier.id,480,336,null,false,337],
      ['TEST-TIER-ZERO-SNAPSHOT',tier.id,0,336,null,false,336]
    ];
    for(const values of cases)await assert.rejects(insert(...values),/violates check constraint/);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,2);
  } finally {await db.close();}
});

test('weighted-stock post-verify detects old-row batch assignment and business-row tampering',async()=>{
  const {db,historicalId,today,weightedBaseline}=await fixture({priorStock:true});
  try {
    const postStockDigestSql=postStockDigestTemplate.replace('null::bigint,null::text',
      `${weightedBaseline.weighted_stock_baseline_count}::bigint,'${weightedBaseline.weighted_stock_f0061_business_md5}'::text`);
    assert.equal((await q(db,postStockDigestSql))[0].weighted_stock_baseline_summary,'PASS');
    await db.exec('alter table phase2_weighted_stock disable trigger phase2_stock_update_guard');
    const [batch]=await q(db,"insert into phase2_stock_batches(submission_id,payload_hash,batch_date,name) values($1,md5('test'),$2,'test') returning id",[crypto.randomUUID(),today]);
    await q(db,'update phase2_weighted_stock set batch_id=$1,batch_line_no=1 where id=$2',[batch.id,historicalId]);
    assert.equal((await q(db,postStockDigestSql))[0].weighted_stock_baseline_summary,'BLOCKER: old stock acquired batch data');
    await q(db,'update phase2_weighted_stock set raw_weight_g=421 where id=$1',[historicalId]);
    assert.equal((await q(db,postStockDigestSql))[0].weighted_stock_baseline_summary,'BLOCKER: F006-1 business row changed');
    await db.exec('alter table phase2_weighted_stock disable trigger phase2_stock_no_delete');
    await q(db,'delete from phase2_weighted_stock where id=$1',[historicalId]);
    assert.equal((await q(db,postStockDigestSql))[0].weighted_stock_baseline_summary,'BLOCKER: stock count changed');
  } finally {await db.close();}
});

test('explicit protected-function baseline detects changed definitions by exact signature',async()=>{
  const {db}=await fixture();
  try {
    const preStart=preflight.lastIndexOf('with protected_function(signature) as (values');
    const preSql=preflight.slice(preStart,preflight.indexOf(';',preStart)+1);
    const [saved]=await q(db,preSql);
    const map=saved.protected_function_definition_md5_by_signature;
    assert.equal(Object.keys(map).length,28);
    assert.ok(map['phase2_guard_tier_overlap()']);
    const postStart=postVerify.indexOf('with baseline(expected_md5_by_signature)');
    const postSql=postVerify.slice(postStart,postVerify.indexOf('from comparison order by signature;',postStart)+'from comparison order by signature;'.length)
      .replace('null::jsonb',`'${JSON.stringify(map)}'::jsonb`);
    const before=await q(db,postSql);
    assert.equal(before.find(row=>row.signature==='phase2_guard_tier_overlap()').result,'PASS');
    assert.equal(before.find(row=>row.signature==='create_checkout_order(text,text,text,text,jsonb,text,uuid)').result,'BLOCKER: paste this signature MD5');
    await db.exec('create or replace function public.phase2_guard_tier_overlap() returns trigger language plpgsql as $$begin return new; end$$');
    const after=await q(db,postSql);
    assert.equal(after.find(row=>row.signature==='phase2_guard_tier_overlap()').result,'BLOCKER: definition changed');
  } finally {await db.close();}
});

test('replacement initializer retains F006-1 creation guards and adds only PR-B eligibility',async()=>{
  const {db,today}=await fixture();
  try {
    for(const [signature,expected] of [
      ['phase2_initialize_weighted_stock()','78cebd75b5c8871e4361f8c1e8c44af7'],
      ['phase2_guard_weighted_stock_update()','24766cd7f78bd591e439f29bc388039f'],
      ['phase2_normalize_weighted_batch_items(jsonb)','5f6776c66069cd6788ddfd4b69d08738'],
      ['admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text)','92e430c6416e1b59f36734e1e288651b']
    ]){
      const [definition]=await q(db,"select md5(regexp_replace(prosrc,E'\\r\\n?',E'\\n','g')) body_md5 from pg_proc where oid=$1::regprocedure",[`public.${signature}`]);
      assert.equal(definition.body_md5,expected,signature);
    }
    const sql=`insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g,manual_base_price,
      manual_price_confirmed,stock_code,status,representative_image_id,version,t0_base_price,
      pricing_tier_id,price_per_jin_snapshot,system_base_price,order_id,order_item_id)
      values($1,$2,$3,$4,$5,$6,coalesce($7,'sellable'),$8,coalesce($9,1),$10,$11,$12,$13,$14,$15) returning *`;
    const create=(overrides={})=>q(db,sql,[overrides.productId||product,overrides.fishDate||today,
      overrides.weight??420,overrides.manual??null,overrides.confirmed??false,
      overrides.stockCode??null,overrides.status??null,overrides.imageId??null,
      overrides.version??1,overrides.t0??336,overrides.tierId??null,
      overrides.perJin??null,overrides.system??null,overrides.orderId??null,overrides.orderItemId??null]);
    await assert.rejects(create({weight:0}),/invalid_raw_weight_g/);
    await assert.rejects(create({manual:0}),/invalid_manual_base_price/);
    await assert.rejects(create({stockCode:'CLIENT-CODE'}),/stock_code_server_generated/);
    await assert.rejects(create({status:'reserved'}),/weighted_stock_initial_state_required/);
    const orderId='30000000-0000-4000-8000-000000000001';
    const orderItemId='40000000-0000-4000-8000-000000000001';
    await q(db,"insert into orders(id,status) values($1,'new')",[orderId]);
    await q(db,"insert into order_items(id,order_id,product_id,supply_type) values($1,$2,$3,'in_stock')",[orderItemId,orderId,product]);
    await assert.rejects(create({orderId}),/weighted_stock_initial_state_required/);
    await assert.rejects(create({orderId,orderItemId}),/weighted_stock_initial_state_required/);
    await q(db,"update orders set status='completed' where id=$1",[orderId]);
    await assert.rejects(create({manual:450,confirmed:false,weight:550}),/manual_price_confirmation_required/);
    await assert.rejects(create({confirmed:true}),/manual_price_confirmation_without_override/);
    await assert.rejects(create({weight:550}),/weight_pricing_tier_not_found/);
    const [dates]=await q(db,"select ((now() at time zone 'Asia/Taipei')::date+1)::text future, ((now() at time zone 'Asia/Taipei')::date-3)::text expired");
    await assert.rejects(create({fishDate:dates.future}),/weighted_stock_future_fish_date/);
    await assert.rejects(create({fishDate:dates.expired}),/weighted_stock_freshness_not_sellable/);
    const second='10000000-0000-4000-8000-000000000002';
    const image='20000000-0000-4000-8000-000000000002';
    await q(db,"insert into products(id,name,status) values($1,'另一商品','available')",[second]);
    await q(db,'insert into product_images(id,product_id) values($1,$2)',[image,second]);
    await assert.rejects(create({imageId:image}),/representative_image_product_mismatch/);
    await q(db,"update products set inventory_mode='QUANTITY_VARIANT' where id=$1",[product]);
    await assert.rejects(create(),/weighted_inventory_mode_required/);
    await q(db,"update products set inventory_mode='SINGLE_WEIGHTED',status='hidden' where id=$1",[product]);
    await assert.rejects(create(),/weighted_product_not_available/);
    await q(db,"update products set status='available' where id=$1",[product]);
    const [wrongTier]=await q(db,'select id from phase2_weight_pricing_tiers where lower_bound_g=600');
    const [stock]=await create({weight:421,version:99,t0:999,tierId:wrongTier.id,perJin:999,system:999});
    assert.match(stock.stock_code,/^F-\d{6}-\d{8}$/);
    assert.notEqual(stock.pricing_tier_id,wrongTier.id);
    assert.equal(stock.price_per_jin_snapshot,480);
    assert.equal(stock.system_base_price,337);
    assert.equal(stock.t0_base_price,337);
    assert.equal(stock.version,1);
  } finally {await db.close();}
});

test('post-verify catalog accepts the reviewed migration and catches the deliberately absent checkout fixture',async()=>{
  const {db}=await fixture();
  try {
    const catalogSql=postVerify.slice(0,postVerify.indexOf('from checks;')+'from checks;'.length);
    const [result]=await q(db,catalogSql);
    assert.equal(result.catalog_summary,'BLOCKER');
    assert.equal(result.reasons,'F004-1 canonical checkout missing');
    await db.exec('alter table phase2_weighted_stock alter column pricing_tier_id set not null');
    assert.match((await q(db,catalogSql))[0].reasons,/F006-2 weighted stock column\/type\/nullability mismatch: pricing_tier_id/);
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
    const [rights]=await q(db,"select has_table_privilege('authenticated','public.phase2_weighted_stock','INSERT') stock_insert, has_table_privilege('authenticated','public.phase2_stock_batches','INSERT') batch_insert, has_table_privilege('authenticated','public.phase2_stock_photos','INSERT') photo_insert, has_function_privilege('authenticated','public.phase2_normalize_weighted_batch_items(jsonb)','EXECUTE') normalizer_execute");
    assert.deepEqual(Object.values(rights),[false,false,false,false]);
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

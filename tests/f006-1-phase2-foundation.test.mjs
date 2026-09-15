import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const migration=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-database-foundation.sql',import.meta.url),'utf8');
const preflight=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-preflight.sql',import.meta.url),'utf8');
const postVerify=readFileSync(new URL('../supabase/f006-1-phase2-pr-a-post-verify.sql',import.meta.url),'utf8');
const product='10000000-0000-4000-8000-000000000001';
const tier='20000000-0000-4000-8000-000000000001';
const q=(db,sql,params)=>db.query(sql,params).then(r=>r.rows);

test('PR-A migration preserves legacy columns and enforces pricing, snapshots, freshness, mode and RLS',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
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
    const preflightResults=await db.exec(preflight);
    assert.equal(preflightResults[0].rows.find(row=>row.check_name==='required_table:products').status,'PASS');
    assert.equal(preflightResults[0].rows.find(row=>row.check_name==='canonical_checkout_7_arg').status,'BLOCKER');
    assert.equal(preflightResults[0].rows.find(row=>row.check_name==='SUMMARY').status,'BLOCKER');
    await db.exec(migration);
    const postResults=await db.exec(postVerify);
    assert.deepEqual(postResults[0].rows.filter(row=>row.check_name.startsWith('phase2_')&&row.status==='BLOCKER'),[]);
    assert.equal(postResults[0].rows.find(row=>row.check_name==='phase2_function:admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)').status,'PASS');
    assert.equal(postResults[0].rows.find(row=>row.check_name==='phase2_trigger:phase2_manual_price_policy_change_audit').status,'PASS');
    assert.equal(postResults[0].rows.find(row=>row.check_name==='no_client_direct_write:phase2_manual_price_confirmation_policy').status,'PASS');
    assert.equal(postResults[1].rows.find(row=>row.check_name==='DEFAULTS_SUMMARY').status,'PASS');
    assert.equal(postResults[2].rows.find(row=>row.check_name==='BASELINE_SUMMARY').status,'BLOCKER');
    // Disposable DB proof that copied preflight values, not self-comparison,
    // make unchanged protected facts pass after the migration.
    let filledPost=postVerify;
    for (const row of preflightResults[4].rows) {
      filledPost=filledPost.replace(`('${row.entity}',null::bigint)`,
        `('${row.entity}',${row.row_count}::bigint)`);
    }
    const quoted=value=>`'${String(value).replaceAll("'","''")}'`;
    filledPost=filledPost.replace('(null::text,null::text)',
      preflightResults[1].rows.map(row=>`(${quoted(row.function_key)},${quoted(row.definition_md5)})`).join(','));
    filledPost=filledPost.replace('from (values (null::text)) v(before_rows_md5)',
      `from (values (${quoted(preflightResults[5].rows[0].rows_md5)})) v(before_rows_md5)`);
    filledPost=filledPost.replace('from (values (null::text)) v(before_schema_md5)',
      `from (values (${quoted(preflightResults[2].rows[0].schema_md5)})) v(before_schema_md5)`);
    filledPost=filledPost.replace('from (values (null::text)) v(before_index_md5)',
      `from (values (${quoted(preflightResults[3].rows[0].index_definition_md5)})) v(before_index_md5)`);
    const filledResults=await db.exec(filledPost);
    assert.equal(filledResults[2].rows.find(row=>row.check_name==='BASELINE_SUMMARY').status,'PASS');
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
    await db.exec(`set app.phase2_reason='retire old tier'; update phase2_weight_pricing_tiers set enabled=false where id='${tier}'`);
    const replacement=(await q(db,'insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin) values($1,200,400,900) returning id',[product]))[0];
    assert.ok(replacement.id); // same bounds as disabled old tier are allowed
    const disabled=(await q(db,'insert into phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin,enabled) values($1,200,400,700,false) returning id',[product]))[0];
    await db.exec(`update phase2_weight_pricing_tiers set lower_bound_g=210,upper_bound_g=390 where id='${disabled.id}'`); // disabled update may overlap
    await assert.rejects(db.query('update phase2_weight_pricing_tiers set enabled=true where id=$1',[tier]),/weight_pricing_tier_overlap/);
    assert.equal((await q(db,'select enabled from phase2_weight_pricing_tiers where id=$1',[tier]))[0].enabled,false);
    const replacementStock=(await q(db,'insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300) returning *',[product,'2026-09-10']))[0];
    assert.equal(replacementStock.system_base_price,450);
    assert.equal(replacementStock.pricing_tier_id,replacement.id);
    assert.deepEqual((await q(db,'select system_base_price,price_per_jin_snapshot,t0_base_price from phase2_weighted_stock where id=$1',[stock.id]))[0],originalSnapshot);
    assert.deepEqual((await q(db,'select system_base_price,price_per_jin_snapshot,t0_base_price from phase2_weighted_stock where id=$1',[newer.id]))[0],
      {system_base_price:600,price_per_jin_snapshot:1200,t0_base_price:600});
    const day=async(id,stamp)=>(await q(db,'select phase2_current_weighted_stock_price($1,$2) price',[id,stamp]))[0].price;
    assert.equal(await day(stock.id,'2026-09-10T15:59:59Z'),300); // Taiwan 23:59 T+0
    assert.equal(await day(newer.id,'2026-09-10T15:59:59Z'),600); // disabled old tier did not reprice stock
    assert.equal(await day(replacementStock.id,'2026-09-10T15:59:59Z'),450);
    assert.equal(await day(stock.id,'2026-09-10T16:00:00Z'),285); // Taiwan 00:00 T+1
    assert.equal(await day(stock.id,'2026-09-11T16:00:00Z'),270); // T+2
    assert.equal(await day(stock.id,'2026-09-12T16:00:00Z'),null); // T+3
    assert.equal(await day(stock.id,'2026-09-09T15:59:59Z'),null); // before fish date
    assert.equal(await day(manual.id,'2026-09-10T16:00:00Z'),949); // 999*.95 = 949.05
    const freshnessVersion=async()=>(await q(db,'select version from phase2_freshness_policy where id=1'))[0].version;
    const freshnessAudit=async(action)=>(await q(db,'select count(*)::integer n from phase2_audit_events where action=$1',[action]))[0].n;
    assert.equal(await freshnessVersion(),1);
    await assert.rejects(db.query('update phase2_freshness_days set multiplier=0 where day_offset=1'),/check constraint/);
    await assert.rejects(db.query('update phase2_freshness_days set multiplier=1.01 where day_offset=1'),/check constraint/);
    assert.equal(await freshnessVersion(),1);
    const dayUpdatesBefore=await freshnessAudit('freshness_day_update');
    const policyUpdatesBefore=await freshnessAudit('freshness_policy_update');
    await db.exec('update phase2_freshness_days set multiplier=0.9 where day_offset=1');
    assert.equal(await freshnessVersion(),2); // T+1 95% -> 90% advances global configuration
    assert.equal(await day(stock.id,'2026-09-10T16:00:00Z'),270); // current price changes with version
    assert.equal(await freshnessAudit('freshness_day_update'),dayUpdatesBefore+1);
    assert.equal(await freshnessAudit('freshness_policy_update'),policyUpdatesBefore); // no duplicate audit
    await db.exec('update phase2_freshness_days set multiplier=0.9 where day_offset=1');
    assert.equal(await freshnessVersion(),2); // no-op is not a new configuration
    assert.equal(await freshnessAudit('freshness_day_update'),dayUpdatesBefore+1);
    await db.exec('update phase2_freshness_policy set max_sale_day=1 where id=1');
    assert.equal(await freshnessVersion(),3);
    assert.equal(await freshnessAudit('freshness_policy_update'),policyUpdatesBefore+1); // context restored
    assert.equal(await day(stock.id,'2026-09-11T16:00:00Z'),null);
    await assert.rejects(db.query('update phase2_freshness_policy set max_sale_day=-1 where id=1'),/check constraint/);
    await db.exec('update phase2_freshness_policy set max_sale_day=3 where id=1');
    assert.equal(await day(stock.id,'2026-09-12T16:00:00Z'),null); // missing T+3 policy day fails closed
    const dayInsertsBefore=await freshnessAudit('freshness_day_insert');
    const policyUpdatesBeforeInsert=await freshnessAudit('freshness_policy_update');
    const versionBeforeInsert=await freshnessVersion();
    await db.exec("set app.phase2_reason='reviewed extended freshness day'; insert into phase2_freshness_days(day_offset,multiplier) values(3,0.8)");
    assert.equal(await freshnessVersion(),versionBeforeInsert+1);
    assert.equal(await freshnessAudit('freshness_day_insert'),dayInsertsBefore+1);
    assert.equal(await freshnessAudit('freshness_policy_update'),policyUpdatesBeforeInsert);
    assert.equal(await day(stock.id,'2026-09-12T16:00:00Z'),240);
    await assert.rejects(db.query('update phase2_weighted_stock set stock_code=$1 where id=$2',['changed',stock.id]),/weighted_stock_action_or_correction_required/);
    await assert.rejects(db.query('update phase2_weighted_stock set manual_price_confirmed=true where id=$1',[stock.id]),/weighted_stock_action_or_correction_required/);
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
    const correction=audit.find(row=>row.reason==='reviewed tier correction');
    assert.ok(correction);
    assert.equal(correction.old_value.price_per_jin,601);assert.equal(correction.new_value.price_per_jin,1200);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action like 'freshness_%_update'"))[0].n,3);
    // Test-only configured ratio; PR-A deliberately ships NULL, not a business threshold.
    assert.equal((await q(db,'select max_unconfirmed_deviation_ratio from phase2_manual_price_confirmation_policy where id=1'))[0].max_unconfirmed_deviation_ratio,null);
    const tierAuditCountBefore=(await q(db,"select count(*)::integer n from phase2_audit_events where action='pricing_tier_update'"))[0].n;
    const freshnessAuditCountBefore=(await q(db,"select count(*)::integer n from phase2_audit_events where action like 'freshness_%'"))[0].n;
    await db.exec("set app.phase2_reason='   '");
    await assert.rejects(db.query('update phase2_manual_price_confirmation_policy set max_unconfirmed_deviation_ratio=0.5 where id=1'),/phase2_change_reason_required/);
    assert.equal((await q(db,'select max_unconfirmed_deviation_ratio from phase2_manual_price_confirmation_policy where id=1'))[0].max_unconfirmed_deviation_ratio,null);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action='manual_price_policy_update'"))[0].n,0);
    await db.exec("set test.actor='80000000-0000-4000-8000-000000000001'; set app.phase2_reason='reviewed test-only manual price ratio'");
    await db.exec('update phase2_manual_price_confirmation_policy set max_unconfirmed_deviation_ratio=0.5 where id=1');
    const manualPolicyAudit=await q(db,"select actor_id,old_value,new_value,reason,created_at from phase2_audit_events where action='manual_price_policy_update'");
    assert.equal(manualPolicyAudit.length,1);
    assert.equal(manualPolicyAudit[0].actor_id,'80000000-0000-4000-8000-000000000001');
    assert.equal(manualPolicyAudit[0].old_value.max_unconfirmed_deviation_ratio,null);
    assert.equal(Number(manualPolicyAudit[0].new_value.max_unconfirmed_deviation_ratio),0.5);
    assert.equal(manualPolicyAudit[0].reason,'reviewed test-only manual price ratio');
    assert.ok(Number.isFinite(Date.parse(manualPolicyAudit[0].created_at)));
    await db.exec("set app.phase2_reason=''");
    await db.exec('update phase2_manual_price_confirmation_policy set max_unconfirmed_deviation_ratio=0.5 where id=1');
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action='manual_price_policy_update'"))[0].n,1);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action='pricing_tier_update'"))[0].n,tierAuditCountBefore);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action like 'freshness_%'"))[0].n,freshnessAuditCountBefore);
    assert.equal((await q(db,'select phase2_manual_price_requires_confirmation(450,460) required'))[0].required,false);
    assert.equal((await q(db,'select phase2_manual_price_requires_confirmation(450,999) required'))[0].required,true);
    assert.equal((await q(db,'select phase2_manual_price_requires_confirmation(450,null) required'))[0].required,false);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from phase2_weighted_stock'),/permission denied/);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300)',[product,'2026-09-10']),/permission denied/);
    await assert.rejects(db.query('select * from phase2_audit_events'),/permission denied/);
    await assert.rejects(db.query('select phase2_manual_price_requires_confirmation(450,999)'),/permission denied/);
    await db.exec('reset role; set role authenticated');
    assert.equal((await q(db,'select * from phase2_weighted_stock')).length,0);
    await assert.rejects(db.query('select admin_create_weighted_stock($1,$2,$3)',[product,'2026-09-10',300]),/admin_required/);
    await assert.rejects(db.query('update phase2_freshness_days set multiplier=0.8'),/permission denied/);
    await db.exec("reset role; set test.admin='true'; set role authenticated");
    assert.ok((await q(db,'select * from phase2_weighted_stock')).length>0);
    await assert.rejects(db.query('insert into phase2_weighted_stock(product_id,fish_date,raw_weight_g) values($1,$2,300)',[product,'2026-09-10']),/permission denied/);
    await assert.rejects(db.query('update phase2_manual_price_confirmation_policy set max_unconfirmed_deviation_ratio=0'),/permission denied/);
    assert.ok((await q(db,'select admin_create_weighted_stock($1,$2,$3)',[product,'2026-09-10',300])).length===1);
    const stockCountBefore=(await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n;
    const auditCountBefore=(await q(db,"select count(*)::integer n from phase2_audit_events where action='stock_created'"))[0].n;
    await assert.rejects(db.query('select admin_create_weighted_stock($1,$2,$3,null,null,$4,false)',[product,'2026-09-10',300,999]),/manual_price_confirmation_required/);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,stockCountBefore);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action='stock_created'"))[0].n,auditCountBefore);
    const normal=(await q(db,'with created as materialized (select admin_create_weighted_stock($1,$2,$3,null,null,$4,false) stock) select (stock).* from created',[product,'2026-09-10',300,460]))[0];
    assert.equal(normal.system_base_price,450);
    assert.equal(normal.t0_base_price,460);
    assert.equal(normal.manual_price_confirmed,false);
    const confirmed=(await q(db,'with created as materialized (select admin_create_weighted_stock($1,$2,$3,null,null,$4,true) stock) select (stock).* from created',[product,'2026-09-10',300,999]))[0];
    assert.equal(confirmed.t0_base_price,999);
    assert.equal(confirmed.manual_price_confirmed,true);
    assert.equal((await q(db,'select count(*)::integer n from phase2_weighted_stock'))[0].n,stockCountBefore+2);
    assert.equal((await q(db,"select count(*)::integer n from phase2_audit_events where action='stock_created'"))[0].n,auditCountBefore+2);
  } finally {await db.close();}
});

test('foundation migration never replaces F004-1 checkout or rewrites ledger/payment tables',()=>{
  assert.doesNotMatch(migration,/create\s+or\s+replace\s+function\s+public\.create_checkout_order|alter\s+table\s+public\.(orders|order_items|inventory_movements|order_payments|order_payment_reversals)/i);
  assert.match(migration,/inventory_mode text/);
  assert.match(migration,/phase2_audit_events/);
});

test('F006-1 preflight and post verification files contain only read-only statements',()=>{
  for (const sql of [preflight,postVerify]) {
    const executable=sql.replace(/--[^\n]*/g,'').replace(/'(?:''|[^'])*'/g,"''");
    assert.doesNotMatch(executable,/\b(create|alter|drop|insert|update|delete|truncate|grant|revoke|do|call)\b/i);
    assert.ok(executable.split(';').every(statement=>!statement.trim()||/^(with|select)\b/i.test(statement.trim())));
  }
  for (const [,name] of migration.matchAll(/^create trigger\s+(\w+)/gmi)) {
    assert.match(preflight,new RegExp(`\\('${name}'\\)`));
    assert.match(postVerify,new RegExp(`'${name}'`));
  }
  for (const [,name] of migration.matchAll(/^create (?:or replace )?function public\.(\w+)/gmi)) {
    assert.match(preflight,new RegExp(`'${name}'`));
    assert.match(postVerify,new RegExp(name));
  }
});

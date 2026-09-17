-- F006-2 post-migration verification: READ ONLY. Owner runs after F006-2.
-- Paste deployment-time preflight outputs into the placeholders below; NULL =
-- BLOCKER. Keep admin writes paused between preflight and post-verify so counts
-- and fingerprints are comparable. Do not guess historical baseline values.

with required_rel(name) as (values
  ('phase2_stock_batch_daily_counters'),('phase2_stock_batches'),('phase2_stock_photos')
), stock_f0062_col(name,type_name,not_null) as (values
  ('id','uuid',true),('product_id','uuid',true),('stock_code','text',true),
  ('fish_date','date',true),('batch_reference','text',false),('raw_weight_g','integer',true),
  ('status','text',true),('representative_image_id','uuid',false),
  ('order_id','uuid',false),('order_item_id','uuid',false),
  ('pricing_tier_id','uuid',false),('price_per_jin_snapshot','integer',false),
  ('system_base_price','integer',false),('manual_base_price','integer',false),
  ('manual_price_confirmed','boolean',true),('t0_base_price','integer',true),
  ('version','integer',true),('created_at','timestamp with time zone',true),
  ('updated_at','timestamp with time zone',true),('batch_id','uuid',false),
  ('batch_line_no','integer',false)
), stock_f0062_default(col,expression) as (values
  ('id','gen_random_uuid()'),('status','''sellable''::text'),
  ('manual_price_confirmed','false'),('version','1'),
  ('created_at','now()'),('updated_at','now()')
), stock_f0062_trigger(name,signature) as (values
  ('phase2_stock_initialize','phase2_initialize_weighted_stock()'),
  ('phase2_stock_update_guard','phase2_guard_weighted_stock_update()'),
  ('phase2_stock_no_delete','phase2_no_foundation_delete()'),
  ('phase2_stock_creation_audit','phase2_audit_stock_insert()')
), required_col(rel,col) as (values
  ('products','common_weight_min_g'),('products','common_weight_max_g'),
  ('phase2_weighted_stock','batch_id'),('phase2_weighted_stock','batch_line_no')
), required_fn(signature) as (values
  ('admin_update_weighted_product_settings(uuid,timestamp with time zone,text,integer,integer,text)'),
  ('admin_save_weight_pricing_tier(uuid,integer,integer,integer,integer,boolean,text,uuid,timestamp with time zone)'),
  ('admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text)'),
  ('admin_link_weighted_stock_photo(uuid,text)'),
  ('phase2_normalize_weighted_batch_items(jsonb)'),
  ('phase2_initialize_weighted_stock()'),('phase2_guard_weighted_stock_update()'),
  ('phase2_guard_weighted_product_settings()'),('phase2_audit_weighted_product_settings()')
), required_trigger(rel,name) as (values
  ('products','phase2_weighted_product_settings_guard'),
  ('products','phase2_weighted_product_settings_audit'),
  ('phase2_weighted_stock','phase2_stock_initialize'),
  ('phase2_weighted_stock','phase2_stock_update_guard'),
  ('phase2_weighted_stock','phase2_stock_no_delete'),
  ('phase2_weighted_stock','phase2_stock_creation_audit')
), checks as (
  select 'missing F006-2 table: '||name reason from required_rel where to_regclass('public.'||name) is null
  union all select 'missing F006-2 column: '||rel||'.'||col from required_col c where not exists (
    select 1 from information_schema.columns x where x.table_schema='public' and x.table_name=c.rel and x.column_name=c.col)
  union all select 'F006-2 weighted stock column/type/nullability mismatch: '||e.name
    from stock_f0062_col e left join pg_attribute a
      on a.attrelid=to_regclass('public.phase2_weighted_stock') and a.attname=e.name and a.attnum>0 and not a.attisdropped
    where a.attnum is null or format_type(a.atttypid,a.atttypmod)<>e.type_name or a.attnotnull<>e.not_null
  union all select 'unexpected F006-2 weighted stock column: '||a.attname
    from pg_attribute a where a.attrelid=to_regclass('public.phase2_weighted_stock')
      and a.attnum>0 and not a.attisdropped and not exists(select 1 from stock_f0062_col e where e.name=a.attname)
  union all select 'F006-2 weighted stock default mismatch: '||e.col from stock_f0062_default e
    where not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=to_regclass('public.phase2_weighted_stock') and a.attname=e.col
        and pg_get_expr(d.adbin,d.adrelid)=e.expression)
  union all select 'unexpected F006-2 weighted stock default: '||a.attname
    from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=to_regclass('public.phase2_weighted_stock') and a.attnum>0 and not a.attisdropped
      and not exists(select 1 from stock_f0062_default e where e.col=a.attname)
  union all select 'F006-2 weighted stock trigger missing or rewired: '||e.name from stock_f0062_trigger e
    where not exists(select 1 from pg_trigger g
      where g.tgrelid=to_regclass('public.phase2_weighted_stock') and g.tgname=e.name and g.tgenabled<>'D'
        and g.tgfoid=to_regprocedure('public.'||e.signature))
  union all select 'F006-2 weighted stock noninternal trigger count differs from reviewed four' where (
    select count(*) from pg_trigger g
    where g.tgrelid=to_regclass('public.phase2_weighted_stock') and not g.tgisinternal)<>4
  union all select 'F006-2 weighted stock constraint set/count differs from reviewed 23' where (
    select count(*) from pg_constraint c
    where c.conrelid=to_regclass('public.phase2_weighted_stock'))<>23
  union all select 'missing function: '||signature from required_fn where to_regprocedure('public.'||signature) is null
  union all select 'missing trigger: '||rel||'.'||name from required_trigger t where not exists (
    select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=t.rel and g.tgname=t.name and g.tgenabled<>'D')
  union all select 'RLS disabled: '||name from required_rel r where exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=r.name and not c.relrowsecurity)
  union all select 'missing admin read policy: '||rel from (values
    ('phase2_stock_batches','phase2_admin_batches_read'),
    ('phase2_stock_photos','phase2_admin_stock_photos_read')) p(rel,policy)
    where not exists(select 1 from pg_policies x where x.schemaname='public' and x.tablename=p.rel and x.policyname=p.policy and x.cmd='SELECT')
  union all select 'browser direct write privilege: '||name from required_rel r where
    has_table_privilege('anon','public.'||name,'INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.'||name,'INSERT,UPDATE,DELETE')
  union all select 'browser direct write privilege: phase2_weighted_stock' where
    has_table_privilege('anon','public.phase2_weighted_stock','INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.phase2_weighted_stock','INSERT,UPDATE,DELETE')
  union all select 'unexpected phase2 stock origin nullability' where exists (
    select 1 from pg_attribute where attrelid='public.phase2_weighted_stock'::regclass
      and attname in ('pricing_tier_id','price_per_jin_snapshot','system_base_price') and attnotnull)
  union all select 'missing price origin constraint' where not exists (
    select 1 from pg_constraint where conrelid='public.phase2_weighted_stock'::regclass
      and conname='phase2_stock_price_origin_check' and convalidated)
  union all select 'missing F006-2 stock batch constraint: '||name from (values
    ('phase2_stock_batch_line_pair_check'),('phase2_stock_batch_line_unique'),
    ('phase2_stock_price_origin_check')) expected(name)
    where not exists(select 1 from pg_constraint c
      where c.conrelid=to_regclass('public.phase2_weighted_stock')
        and c.conname=expected.name and c.convalidated)
  union all select 'missing F006-2 batch FK' where not exists (
    select 1 from pg_constraint c join pg_attribute a
      on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    where c.conrelid=to_regclass('public.phase2_weighted_stock') and c.contype='f'
      and c.convalidated and c.confrelid=to_regclass('public.phase2_stock_batches')
      and c.confdeltype='r'
      and array_length(c.conkey,1)=1 and a.attname='batch_id')
  union all select 'price origin constraint body differs from reviewed two-branch invariant' where not exists (
    select 1 from pg_constraint c where c.conrelid='public.phase2_weighted_stock'::regclass
      and c.conname='phase2_stock_price_origin_check' and c.convalidated
      and pg_get_constraintdef(c.oid) ~* 'pricing_tier_id IS NOT NULL.*price_per_jin_snapshot IS NOT NULL.*system_base_price IS NOT NULL.*pricing_tier_id IS NULL.*price_per_jin_snapshot IS NULL.*system_base_price IS NULL.*manual_base_price IS NOT NULL.*manual_price_confirmed')
  union all select 'missing validated F006-1 positive check: '||column_name from (values
    ('raw_weight_g'),('price_per_jin_snapshot'),('system_base_price'),
    ('manual_base_price'),('t0_base_price')) required(column_name)
    where not exists(select 1 from pg_constraint c
      where c.conrelid='public.phase2_weighted_stock'::regclass and c.contype='c' and c.convalidated
        and pg_get_constraintdef(c.oid) ~* (column_name||'[[:space:]]*>[[:space:]]*0'))
  union all select 'missing validated F006-1 T+0 source check' where not exists (
    select 1 from pg_constraint c where c.conrelid='public.phase2_weighted_stock'::regclass
      and c.contype='c' and c.convalidated
      and pg_get_constraintdef(c.oid) ~* 't0_base_price[[:space:]]*=[[:space:]]*coalesce')
  union all select 'missing mandatory stock column NOT NULL: '||column_name from (values
    ('raw_weight_g'),('fish_date'),('t0_base_price'),('manual_price_confirmed'),('version')) required(column_name)
    where not exists(select 1 from pg_attribute a where a.attrelid='public.phase2_weighted_stock'::regclass
      and a.attname=required.column_name and a.attnotnull and not a.attisdropped)
  union all select 'reviewed F006-2 function body mismatch: '||signature from (values
    ('phase2_initialize_weighted_stock()','78cebd75b5c8871e4361f8c1e8c44af7'),
    ('phase2_guard_weighted_stock_update()','24766cd7f78bd591e439f29bc388039f'),
    ('phase2_normalize_weighted_batch_items(jsonb)','5f6776c66069cd6788ddfd4b69d08738'),
    ('admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text)','92e430c6416e1b59f36734e1e288651b')
  ) expected(signature,body_md5) where not exists (
    select 1 from pg_proc p where p.oid=to_regprocedure('public.'||expected.signature)
      and md5(regexp_replace(p.prosrc,E'\r\n?',E'\n','g'))=expected.body_md5)
  union all select 'existing or newly created stock violates price origin/T+0' where exists (
    select 1 from public.phase2_weighted_stock s where not (
      (s.pricing_tier_id is not null and s.price_per_jin_snapshot is not null
       and s.system_base_price is not null and s.price_per_jin_snapshot > 0 and s.system_base_price > 0)
      or (s.pricing_tier_id is null and s.price_per_jin_snapshot is null and s.system_base_price is null
          and s.manual_base_price is not null and s.manual_base_price > 0
          and s.manual_price_confirmed is true)
    ) or s.t0_base_price is distinct from coalesce(s.manual_base_price,s.system_base_price)
      or s.t0_base_price <= 0)
  union all select 'F004-1 canonical checkout missing' where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='create_checkout_order' and p.pronargs=7)
)
select case when exists(select 1 from checks) then 'BLOCKER' else 'PASS' end catalog_summary,
       coalesce(string_agg(reason,E'\n' order by reason),'F006-2 objects, RLS, grants and protected checkout present') reasons
from checks;

-- Replace ONLY the NULL baseline_count values with the preflight numbers.
with baseline(object_name,baseline_count) as (values
  ('products',null::bigint),('product_variants',null::bigint),('orders',null::bigint),
  ('order_items',null::bigint),('inventory_movements',null::bigint),
  ('order_payments',null::bigint),('order_payment_reversals',null::bigint),
  ('product_images',null::bigint),('phase2_weight_pricing_tiers',null::bigint),
  ('phase2_weighted_stock',null::bigint),('phase2_audit_events',null::bigint)
), actual(object_name,actual_count) as (
  select 'products',count(*) from public.products
  union all select 'product_variants',count(*) from public.product_variants
  union all select 'orders',count(*) from public.orders
  union all select 'order_items',count(*) from public.order_items
  union all select 'inventory_movements',count(*) from public.inventory_movements
  union all select 'order_payments',count(*) from public.order_payments
  union all select 'order_payment_reversals',count(*) from public.order_payment_reversals
  union all select 'product_images',count(*) from public.product_images
  union all select 'phase2_weight_pricing_tiers',count(*) from public.phase2_weight_pricing_tiers
  union all select 'phase2_weighted_stock',count(*) from public.phase2_weighted_stock
  union all select 'phase2_audit_events',count(*) from public.phase2_audit_events
)
select b.object_name,b.baseline_count,a.actual_count,
       case when b.baseline_count is null then 'BLOCKER: paste baseline'
            when b.baseline_count=a.actual_count then 'PASS' else 'BLOCKER: count changed' end result
from baseline b join actual a using(object_name) order by b.object_name;

-- Paste the exact weighted_stock_baseline_count and
-- weighted_stock_f0061_business_md5 from preflight. The 19 F006-1 business
-- columns and UUID ordering below are IDENTICAL to preflight; do not add the
-- new batch columns to the digest. They must instead remain NULL for every
-- pre-existing row. NULL placeholders are BLOCKERs even when count is zero.
with baseline(expected_count,expected_md5) as (values (null::bigint,null::text)),
actual as (
  select count(*)::bigint actual_count,
    md5(coalesce(string_agg(s.id::text||':'||md5(jsonb_build_array(
      s.id,s.product_id,s.stock_code,
      case when isfinite(s.fish_date) then to_char(s.fish_date,'YYYY-MM-DD') else s.fish_date::text end,
      s.batch_reference,s.raw_weight_g,
      s.status,s.representative_image_id,s.order_id,s.order_item_id,
      s.pricing_tier_id,s.price_per_jin_snapshot,s.system_base_price,
      s.manual_base_price,s.manual_price_confirmed,s.t0_base_price,s.version,
      case when isfinite(s.created_at) then to_char(s.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') else s.created_at::text end,
      case when isfinite(s.updated_at) then to_char(s.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') else s.updated_at::text end
    )::text),E'\n' order by s.id::text),'')) actual_md5,
    count(*) filter (where s.batch_id is not null or s.batch_line_no is not null)::bigint
      preexisting_rows_with_batch_values
  from public.phase2_weighted_stock s
)
select baseline.expected_count,actual.actual_count,baseline.expected_md5,actual.actual_md5,
       actual.preexisting_rows_with_batch_values,
       case when baseline.expected_count is null or baseline.expected_md5 is null then 'BLOCKER: paste baseline'
            when baseline.expected_count<>actual.actual_count then 'BLOCKER: stock count changed'
            when baseline.expected_md5<>actual.actual_md5 then 'BLOCKER: F006-1 business row changed'
            when actual.preexisting_rows_with_batch_values<>0 then 'BLOCKER: old stock acquired batch data'
            else 'PASS' end weighted_stock_baseline_summary
from baseline cross join actual;

-- Paste the ONE JSONB map protected_function_definition_md5_by_signature from
-- preflight in place of NULL. Every expected exact signature must have a saved
-- MD5 and still resolve to the same definition. The two deliberately replaced
-- stock trigger helpers are checked by reviewed F006-2 body hashes above.
with baseline(expected_md5_by_signature) as (values (null::jsonb)),
protected_function(signature) as (values
  ('create_checkout_order(text,text,text,text,jsonb)'),
  ('create_checkout_order(text,text,text,text,jsonb,text)'),
  ('create_checkout_order(text,text,text,text,jsonb,text,uuid)'),
  ('is_hanjiu_admin()'),('admin_cancel_order(uuid)'),
  ('admin_record_order_payment(uuid,integer,text)'),
  ('admin_record_order_payment(uuid,integer,text,uuid)'),
  ('admin_reverse_order_payment(uuid,text)'),
  ('enforce_order_cancellation_flow()'),('enforce_order_payment_flow()'),
  ('enforce_paid_order_financial_lock()'),('admin_audit_order_financial_integrity()'),
  ('log_inventory_movement()'),('initialize_order_totals()'),
  ('recalculate_order_totals_from_items()'),('admin_update_order_totals(uuid,integer,integer)'),
  ('enforce_order_item_supply_type_snapshot()'),
  ('phase2_current_weighted_stock_price(uuid,timestamp with time zone)'),
  ('phase2_manual_price_requires_confirmation(integer,integer)'),
  ('admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)'),
  ('phase2_guard_inventory_mode()'),('phase2_guard_tier_overlap()'),
  ('phase2_touch_freshness_configuration()'),('phase2_no_foundation_delete()'),
  ('phase2_audit_immutable()'),('phase2_audit_stock_insert()'),
  ('phase2_audit_foundation_change()'),('phase2_advance_freshness_version_from_day()')
), comparison as (
  select e.signature,b.expected_md5_by_signature->>e.signature baseline_md5,
         md5(pg_get_functiondef(p.oid)) actual_md5
  from protected_function e cross join baseline b
  left join pg_proc p on p.oid=to_regprocedure('public.'||e.signature)
)
select signature,baseline_md5,actual_md5,
       case when baseline_md5 is null then 'BLOCKER: paste this signature MD5'
            when actual_md5 is null then 'BLOCKER: function missing'
            when baseline_md5<>actual_md5 then 'BLOCKER: definition changed'
            else 'PASS' end result,
       case when bool_and(baseline_md5 is not null and actual_md5 is not null
         and baseline_md5=actual_md5) over () then 'PASS' else 'BLOCKER' end protected_functions_summary
from comparison order by signature;

-- Paste both preflight digest outputs below. This catches historical ledger
-- rewrites even if row counts remain equal.
with baseline(schema_md5,rows_md5) as (values (null::text,null::text)),
actual as (select
  (select md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,
    '|' order by a.attnum)) from pg_attribute a where a.attrelid='public.inventory_movements'::regclass
    and a.attnum>0 and not a.attisdropped) schema_md5,
  (select md5(coalesce(string_agg(to_jsonb(m)::text,'|' order by m.id::text),''))
   from public.inventory_movements m) rows_md5)
select baseline.schema_md5,actual.schema_md5 current_schema_md5,
       baseline.rows_md5,actual.rows_md5 current_rows_md5,
       case when baseline.schema_md5=actual.schema_md5 and baseline.rows_md5=actual.rows_md5
         then 'PASS' else 'BLOCKER' end ledger_summary from baseline cross join actual;

-- Paste the preflight phase2_configuration_md5 in place of NULL.
with baseline(expected_md5) as (values (null::text)), actual as (
  select md5(jsonb_build_object(
    'freshness_policy',(select to_jsonb(p) from public.phase2_freshness_policy p where p.id=1),
    'freshness_days',(select jsonb_agg(to_jsonb(d) order by d.day_offset) from public.phase2_freshness_days d),
    'manual_policy',(select to_jsonb(m) from public.phase2_manual_price_confirmation_policy m where m.id=1)
  )::text) current_md5
)
select expected_md5,current_md5,
       case when expected_md5=current_md5 then 'PASS' else 'BLOCKER' end phase2_configuration_summary
from baseline cross join actual;

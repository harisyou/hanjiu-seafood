-- F006-2 post-migration verification: READ ONLY. Owner runs after F006-2.
-- Paste deployment-time preflight outputs into the placeholders below; NULL =
-- BLOCKER. Keep admin writes paused between preflight and post-verify so counts
-- and fingerprints are comparable. Do not guess historical baseline values.

with required_rel(name) as (values
  ('phase2_stock_batch_daily_counters'),('phase2_stock_batches'),('phase2_stock_photos')
), required_col(rel,col) as (values
  ('products','common_weight_min_g'),('products','common_weight_max_g'),
  ('phase2_weighted_stock','batch_id'),('phase2_weighted_stock','batch_line_no')
), required_fn(signature) as (values
  ('admin_update_weighted_product_settings(uuid,timestamp with time zone,text,integer,integer,text)'),
  ('admin_save_weight_pricing_tier(uuid,integer,integer,integer,integer,boolean,text,uuid,timestamp with time zone)'),
  ('admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text)'),
  ('admin_link_weighted_stock_photo(uuid,text)'),
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
    select 1 from pg_constraint where conrelid='public.phase2_weighted_stock'::regclass and conname='phase2_stock_price_origin_check')
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

-- Paste every preflight signature/hash into baseline. A missing signature or a
-- changed definition is a BLOCKER. Trigger helpers deliberately replaced by
-- F006-2 are excluded from this protected-function comparison.
with baseline(signature,definition_md5) as (values
  ('PASTE_EXACT_PREFLIGHT_SIGNATURE'::text,null::text)
), actual as (
  select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' signature,
         md5(pg_get_functiondef(p.oid)) definition_md5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and (p.proname='create_checkout_order' or p.proname='is_hanjiu_admin'
    or p.proname in ('phase2_current_weighted_stock_price','phase2_manual_price_requires_confirmation',
      'admin_create_weighted_stock','phase2_guard_inventory_mode','phase2_guard_tier_overlap')
    or p.proname ~ '(cancel|restock|payment|refund)')
), comparison as (
  select coalesce(b.signature,a.signature) signature,b.definition_md5 baseline_md5,a.definition_md5 actual_md5
  from baseline b full join actual a using(signature)
)
select signature,baseline_md5,actual_md5,
       case when baseline_md5 is null or actual_md5 is null or baseline_md5<>actual_md5
         then 'BLOCKER' else 'PASS' end result from comparison order by signature;

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

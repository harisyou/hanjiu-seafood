-- F006-1 post-migration verification. READ-ONLY. Run only AFTER owner deployment.
-- First run the catalog section. Then paste the exact PRE-FLIGHT output into
-- baseline_counts, baseline_functions, and the three digest placeholders below.
-- Do not invent baseline values. CATALOG_SUMMARY, DEFAULTS_SUMMARY and
-- BASELINE_SUMMARY must ALL be PASS. NULL placeholders block until filled.
-- This file does not run F006-1 or call a business RPC.

with phase2_tables(name) as (values
  ('phase2_weight_pricing_tiers'),('phase2_freshness_policy'),
  ('phase2_freshness_days'),('phase2_manual_price_confirmation_policy'),
  ('phase2_weighted_stock'),('phase2_audit_events')
), phase2_policies(table_name,policy_name) as (values
  ('phase2_weight_pricing_tiers','phase2_admin_tiers_read'),
  ('phase2_freshness_policy','phase2_admin_policy_read'),
  ('phase2_freshness_days','phase2_admin_days_read'),
  ('phase2_manual_price_confirmation_policy','phase2_admin_manual_price_policy_read'),
  ('phase2_weighted_stock','phase2_admin_stock_read'),
  ('phase2_audit_events','phase2_admin_audit_read')
), phase2_functions(signature) as (values
  ('phase2_guard_inventory_mode()'),('phase2_guard_tier_overlap()'),
  ('phase2_touch_freshness_configuration()'),
  ('phase2_manual_price_requires_confirmation(integer,integer)'),
  ('phase2_initialize_weighted_stock()'),('phase2_guard_weighted_stock_update()'),
  ('phase2_no_foundation_delete()'),('phase2_audit_immutable()'),
  ('phase2_audit_stock_insert()'),('phase2_audit_foundation_change()'),
  ('phase2_advance_freshness_version_from_day()'),
  ('phase2_current_weighted_stock_price(uuid,timestamp with time zone)'),
  ('admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)')
), phase2_indexes(name) as (values
  ('phase2_tier_product_bounds_idx'),('phase2_stock_product_status_idx'),
  ('phase2_stock_order_idx'),('phase2_audit_entity_idx')
), phase2_triggers(table_name,trigger_name,function_name) as (values
  ('products','phase2_inventory_mode_guard','phase2_guard_inventory_mode'),
  ('phase2_weight_pricing_tiers','phase2_tier_overlap','phase2_guard_tier_overlap'),
  ('phase2_freshness_policy','phase2_policy_touch','phase2_touch_freshness_configuration'),
  ('phase2_freshness_days','phase2_day_touch','phase2_touch_freshness_configuration'),
  ('phase2_weighted_stock','phase2_stock_initialize','phase2_initialize_weighted_stock'),
  ('phase2_weighted_stock','phase2_stock_update_guard','phase2_guard_weighted_stock_update'),
  ('phase2_weighted_stock','phase2_stock_no_delete','phase2_no_foundation_delete'),
  ('phase2_weight_pricing_tiers','phase2_tier_no_delete','phase2_no_foundation_delete'),
  ('phase2_freshness_policy','phase2_policy_no_delete','phase2_no_foundation_delete'),
  ('phase2_freshness_days','phase2_days_no_delete','phase2_no_foundation_delete'),
  ('phase2_manual_price_confirmation_policy','phase2_manual_price_policy_no_delete','phase2_no_foundation_delete'),
  ('phase2_audit_events','phase2_audit_no_update_delete','phase2_audit_immutable'),
  ('phase2_weighted_stock','phase2_stock_creation_audit','phase2_audit_stock_insert'),
  ('phase2_weight_pricing_tiers','phase2_tier_change_audit','phase2_audit_foundation_change'),
  ('phase2_freshness_policy','phase2_policy_change_audit','phase2_audit_foundation_change'),
  ('phase2_freshness_days','phase2_day_change_audit','phase2_audit_foundation_change'),
  ('phase2_manual_price_confirmation_policy','phase2_manual_price_policy_change_audit','phase2_audit_foundation_change'),
  ('phase2_freshness_days','phase2_day_version_advance','phase2_advance_freshness_version_from_day')
), legacy_tables(name) as (values
  ('products'),('product_variants'),('orders'),('order_items'),
  ('inventory_movements'),('order_payments'),('order_payment_reversals'),('product_images')
), checks as (
  select 'phase2_table:'||t.name check_name,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=t.name and c.relkind in ('r','p')) ok,
    'missing public.'||t.name reason from phase2_tables t
  union all
  select 'legacy_table:'||t.name,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=t.name and c.relkind in ('r','p')),
    'protected legacy table missing: '||t.name from legacy_tables t
  union all
  select 'products_inventory_mode_text_nullable',
    exists(select 1 from pg_attribute a
      where a.attrelid=to_regclass('public.products') and a.attname='inventory_mode'
        and a.attnum>0 and not a.attisdropped and a.atttypid='text'::regtype
        and not a.attnotnull),
    'products.inventory_mode missing/wrong type/nonnullable'
  union all
  select 'products_inventory_mode_check',
    exists(select 1 from pg_constraint k
      where k.conrelid=to_regclass('public.products')
        and k.conname='products_inventory_mode_check' and k.contype='c'
        and pg_get_constraintdef(k.oid) like '%SINGLE_WEIGHTED%'
        and pg_get_constraintdef(k.oid) like '%QUANTITY_VARIANT%'),
    'inventory mode allowed-value check missing or incompatible'
  union all
  select 'products_inventory_mode_no_default',
    not exists(select 1 from pg_attrdef d join pg_attribute a
      on a.attrelid=d.adrelid and a.attnum=d.adnum
      where d.adrelid=to_regclass('public.products') and a.attname='inventory_mode'),
    'inventory_mode should have no non-NULL default in PR-A'
  union all
  select 'phase2_stock_code_seq',
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='phase2_stock_code_seq' and c.relkind='S'),
    'stock code sequence missing'
  union all
  select 'phase2_index:'||ix.name,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_index i on i.indexrelid=c.oid
      where n.nspname='public' and c.relname=ix.name and c.relkind='i'
        and i.indisvalid and i.indisready),
    'missing or invalid PR-A index: '||ix.name from phase2_indexes ix
  union all
  select 'phase2_rls:'||t.name,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=t.name and c.relrowsecurity),
    'RLS not enabled on '||t.name from phase2_tables t
  union all
  select 'phase2_admin_read_policy:'||p.table_name,
    exists(select 1 from pg_policies pol where pol.schemaname='public'
      and pol.tablename=p.table_name and pol.policyname=p.policy_name
      and pol.cmd='SELECT' and 'authenticated'=any(pol.roles)
      and pol.qual like '%is_hanjiu_admin%'),
    'expected admin SELECT policy missing or incompatible: '||p.policy_name
    from phase2_policies p
  union all
  select 'no_client_write_policy:'||t.name,
    not exists(select 1 from pg_policies pol where pol.schemaname='public'
      and pol.tablename=t.name and pol.cmd in ('INSERT','UPDATE','DELETE','ALL')
      and ('anon'=any(pol.roles) or 'authenticated'=any(pol.roles)
        or 'public'=any(pol.roles))),
    'unexpected anon/authenticated/PUBLIC write policy on '||t.name
    from phase2_tables t
  union all
  select 'no_client_direct_write:'||t.name,
    not (has_table_privilege('anon',to_regclass('public.'||t.name),'INSERT')
      or has_table_privilege('anon',to_regclass('public.'||t.name),'UPDATE')
      or has_table_privilege('anon',to_regclass('public.'||t.name),'DELETE')
      or has_table_privilege('authenticated',to_regclass('public.'||t.name),'INSERT')
      or has_table_privilege('authenticated',to_regclass('public.'||t.name),'UPDATE')
      or has_table_privilege('authenticated',to_regclass('public.'||t.name),'DELETE')),
    'anon/authenticated has direct table write privileges on '||t.name
    from phase2_tables t
  union all
  select 'admin_select_grant:'||t.name,
    has_table_privilege('authenticated',to_regclass('public.'||t.name),'SELECT')
      and not has_table_privilege('anon',to_regclass('public.'||t.name),'SELECT'),
    'expected authenticated-only SELECT grant missing/mis-scoped on '||t.name
    from phase2_tables t
  union all
  select 'phase2_function:'||f.signature,
    to_regprocedure('public.'||f.signature) is not null,
    'expected PR-A function missing: '||f.signature from phase2_functions f
  union all
  select 'admin_creation_rpc_execute_roles',
    has_function_privilege('authenticated',
      to_regprocedure('public.admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)'),
      'EXECUTE')
    and not has_function_privilege('anon',
      to_regprocedure('public.admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)'),
      'EXECUTE'),
    'admin creation RPC execute grant must be authenticated-only'
  union all
  select 'manual_price_helper_not_browser_executable',
    not has_function_privilege('anon',
      to_regprocedure('public.phase2_manual_price_requires_confirmation(integer,integer)'),
      'EXECUTE')
    and not has_function_privilege('authenticated',
      to_regprocedure('public.phase2_manual_price_requires_confirmation(integer,integer)'),
      'EXECUTE'),
    'manual-price internal helper unexpectedly browser-executable'
  union all
  select 'phase2_trigger:'||t.trigger_name,
    exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      join pg_proc p on p.oid=g.tgfoid
      where n.nspname='public' and c.relname=t.table_name
        and g.tgname=t.trigger_name and not g.tgisinternal
        and g.tgenabled in ('O','A') and p.proname=t.function_name),
    'expected enabled trigger/function missing: '||t.trigger_name from phase2_triggers t
  union all
  select 'canonical_checkout_7_arg_preserved',
    to_regprocedure('public.create_checkout_order(text,text,text,text,jsonb,text,uuid)') is not null,
    'canonical checkout seven-argument function missing'
  union all
  select 'orders_checkout_columns_preserved',
    exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.orders')
      and a.attname='checkout_idempotency_key' and a.atttypid='uuid'::regtype
      and a.attnum>0 and not a.attisdropped)
    and exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.orders')
      and a.attname='checkout_request_fingerprint' and a.atttypid='text'::regtype
      and a.attnum>0 and not a.attisdropped),
    'F004-1 checkout columns missing or incompatible'
  union all
  select 'inventory_movements_delta_preserved',
    exists(select 1 from pg_attribute a where a.attrelid=to_regclass('public.inventory_movements')
      and a.attname='inventory_delta' and a.atttypid='integer'::regtype
      and a.attnum>0 and not a.attisdropped),
    'inventory_movements.inventory_delta missing or incompatible'
  union all
  select 'checkout_idempotency_unique_protection',
    exists(select 1 from pg_class t join pg_namespace n on n.oid=t.relnamespace
      join pg_attribute a on a.attrelid=t.oid and a.attname='checkout_idempotency_key'
      join pg_index i on i.indrelid=t.oid and i.indisunique and i.indisvalid
        and i.indisready and i.indnkeyatts=1 and i.indkey[0]=a.attnum
      join pg_class ix on ix.oid=i.indexrelid
      where n.nspname='public' and t.relname='orders'
        and ix.relname='orders_checkout_idempotency_key_unique_idx'
        and (i.indpred is null or
          pg_get_expr(i.indpred,i.indrelid) like '%checkout_idempotency_key IS NOT NULL%')),
    'canonical checkout unique index absent/invalid'
)
select check_name,case when ok then 'PASS' else 'BLOCKER' end status,
       case when ok then null else reason end blocker_reason
from checks
union all
select 'CATALOG_SUMMARY',case when bool_and(ok) then 'PASS' else 'BLOCKER' end,
       string_agg(reason,'; ' order by check_name) filter (where not ok)
from checks
order by check_name;

-- Run this data-default section only when CATALOG_SUMMARY confirms all six
-- Phase 2 tables exist. Its static table references cannot resolve otherwise.
with checks as (
  select 'legacy_products_modes_remain_null' check_name,
    not exists(select 1 from public.products where inventory_mode is not null) ok,
    'F006-1 must not assign an inventory mode to historical products' reason
  union all
  select 'default_freshness_policy' check_name,
    exists(select 1 from public.phase2_freshness_policy p
      where p.id=1 and p.max_sale_day=2 and p.version=1)
      and (select count(*) from public.phase2_freshness_policy)=1 ok,
    'max_sale_day/version default is not 2/1 or policy is not singleton' reason
  union all
  select 'default_freshness_days',
    (select count(*) from public.phase2_freshness_days)=3
      and exists(select 1 from public.phase2_freshness_days where day_offset=0 and multiplier=1)
      and exists(select 1 from public.phase2_freshness_days where day_offset=1 and multiplier=0.95)
      and exists(select 1 from public.phase2_freshness_days where day_offset=2 and multiplier=0.90),
    'T+0/1/2 default multipliers are not 1/0.95/0.90 or extra days exist'
  union all
  select 'manual_confirmation_ratio_unconfigured',
    exists(select 1 from public.phase2_manual_price_confirmation_policy
      where id=1 and max_unconfirmed_deviation_ratio is null)
      and (select count(*) from public.phase2_manual_price_confirmation_policy)=1,
    'manual price confirmation threshold should be NULL after PR-A'
)
select check_name,case when ok then 'PASS' else 'BLOCKER' end status,
       case when ok then null else reason end blocker_reason from checks
union all
select 'DEFAULTS_SUMMARY',case when bool_and(ok) then 'PASS' else 'BLOCKER' end,
       string_agg(reason,'; ' order by check_name) filter (where not ok)
from checks
order by check_name;

-- Paste exact row_count values from the preflight baseline output, without
-- changing entity names. NULL means no baseline supplied and blocks PASS.
with baseline_counts(entity,before_count) as (values
  ('products',null::bigint),('product_variants',null::bigint),
  ('orders',null::bigint),('order_items',null::bigint),
  ('inventory_movements',null::bigint),('order_payments',null::bigint),
  ('order_payment_reversals',null::bigint),('product_images',null::bigint)
), actual_counts(entity,after_count) as (
  select 'products',count(*)::bigint from public.products
  union all select 'product_variants',count(*) from public.product_variants
  union all select 'orders',count(*) from public.orders
  union all select 'order_items',count(*) from public.order_items
  union all select 'inventory_movements',count(*) from public.inventory_movements
  union all select 'order_payments',count(*) from public.order_payments
  union all select 'order_payment_reversals',count(*) from public.order_payment_reversals
  union all select 'product_images',count(*) from public.product_images
), baseline_functions(function_key,before_md5) as (values
  -- Replace this placeholder with EVERY function_key + definition_md5 row from
  -- preflight (all checkout overloads and the cancellation/restock/payment set).
  (null::text,null::text)
), actual_functions as (
  select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' function_key,
         md5(pg_get_functiondef(p.oid)) after_md5
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in
    ('create_checkout_order','is_hanjiu_admin','admin_cancel_order',
     'admin_reverse_order_payment','admin_record_order_payment','log_inventory_movement',
     'enforce_order_cancellation_flow','enforce_order_payment_flow',
     'enforce_paid_order_financial_lock','admin_audit_order_financial_integrity')
), actual_inventory as (
  select count(*)::bigint after_count,
         md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' order by m.id::text),'')) after_rows_md5
  from public.inventory_movements m
), actual_inventory_schema as (
  select md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull,
          '|' order by a.attnum)) after_schema_md5
  from pg_attribute a where a.attrelid=to_regclass('public.inventory_movements')
    and a.attnum>0 and not a.attisdropped
), actual_checkout_index as (
  select md5(pg_get_indexdef(i.indexrelid)) after_index_md5
  from pg_index i join pg_class ix on ix.oid=i.indexrelid
  where i.indrelid=to_regclass('public.orders')
    and ix.relname='orders_checkout_idempotency_key_unique_idx'
), checks as (
  select 'legacy_count:'||b.entity check_name,
    b.before_count is not null and b.before_count=a.after_count ok,
    case when b.before_count is null then 'paste preflight row_count for '||b.entity
         else 'row count changed: before='||b.before_count||', after='||a.after_count end reason
    from baseline_counts b join actual_counts a using(entity)
  union all
  select 'protected_function:'||a.function_key,
    b.before_md5 is not null and b.before_md5=a.after_md5,
    case when b.before_md5 is null then 'paste preflight MD5 for '||a.function_key
         else 'protected function definition changed: '||a.function_key end
    from actual_functions a left join baseline_functions b using(function_key)
  union all
  select 'preflight_function_still_present:'||b.function_key,
    a.function_key is not null,
    'preflight protected function disappeared: '||b.function_key
    from baseline_functions b left join actual_functions a using(function_key)
    where b.function_key is not null
  union all
  select 'inventory_movements_full_row_md5',
    v.before_rows_md5 is not null and v.before_rows_md5=a.after_rows_md5,
    case when v.before_rows_md5 is null then 'paste preflight inventory rows_md5'
         else 'inventory_movements historical rows changed' end
    from (values (null::text)) v(before_rows_md5) cross join actual_inventory a
  union all
  select 'inventory_movements_schema_md5',
    v.before_schema_md5 is not null and v.before_schema_md5=a.after_schema_md5,
    case when v.before_schema_md5 is null then 'paste preflight inventory schema_md5'
         else 'inventory_movements column schema changed' end
    from (values (null::text)) v(before_schema_md5) cross join actual_inventory_schema a
  union all
  select 'checkout_idempotency_index_definition_md5',
    v.before_index_md5 is not null and v.before_index_md5=a.after_index_md5,
    case when v.before_index_md5 is null then 'paste preflight index_definition_md5'
         else 'checkout idempotency index definition changed' end
    from (values (null::text)) v(before_index_md5) cross join actual_checkout_index a
  union all
  select 'inventory_movements_digest_count_matches',
    c.before_count is not null and c.before_count=a.after_count,
    'inventory ledger digest count differs from preflight count'
    from baseline_counts c cross join actual_inventory a
    where c.entity='inventory_movements'
)
select check_name,case when ok then 'PASS' else 'BLOCKER' end status,
       case when ok then null else reason end blocker_reason
from checks
union all
select 'BASELINE_SUMMARY',case when bool_and(ok) then 'PASS' else 'BLOCKER' end,
       string_agg(reason,'; ' order by check_name) filter (where not ok)
from checks
order by check_name;

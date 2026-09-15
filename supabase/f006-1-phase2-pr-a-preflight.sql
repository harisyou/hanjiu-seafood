-- F006-1 Production preflight. READ-ONLY. Run BEFORE the owner applies F006-1.
-- Run the catalog/blocker section first. Run the exact baseline-count section only
-- when required legacy tables are present; a missing relation cannot be counted
-- with a static SELECT. Save every result, especially counts and MD5 fingerprints.
-- This file does not run F006-1 and does not call any business RPC.

with required_tables(name) as (values
  ('products'),('product_variants'),('orders'),('order_items'),
  ('product_images'),('inventory_movements'),('order_payments'),('order_payment_reversals')
), required_columns(table_name,column_name,type_name) as (values
  ('products','id','uuid'),('products','updated_at','timestamptz'),
  ('product_variants','product_id','uuid'),('product_variants','active','boolean'),
  ('product_variants','inventory','integer'),
  ('orders','id','uuid'),('orders','status','text'),
  ('orders','checkout_idempotency_key','uuid'),('orders','checkout_request_fingerprint','text'),
  ('order_items','id','uuid'),('order_items','order_id','uuid'),
  ('order_items','product_id','uuid'),('order_items','supply_type','text'),
  ('product_images','id','uuid'),('product_images','product_id','uuid'),
  ('inventory_movements','id','uuid'),('inventory_movements','inventory_delta','integer')
), referenced_keys(name) as (values
  ('products'),('orders'),('order_items'),('product_images')
), new_relations(name) as (values
  ('phase2_weight_pricing_tiers'),('phase2_freshness_policy'),
  ('phase2_freshness_days'),('phase2_manual_price_confirmation_policy'),
  ('phase2_weighted_stock'),('phase2_audit_events'),('phase2_stock_code_seq'),
  ('phase2_tier_product_bounds_idx'),('phase2_stock_product_status_idx'),
  ('phase2_stock_order_idx'),('phase2_audit_entity_idx')
), new_functions(name) as (values
  ('phase2_guard_inventory_mode'),('phase2_guard_tier_overlap'),
  ('phase2_touch_freshness_configuration'),('phase2_manual_price_requires_confirmation'),
  ('phase2_initialize_weighted_stock'),('phase2_guard_weighted_stock_update'),
  ('phase2_no_foundation_delete'),('phase2_audit_immutable'),
  ('phase2_audit_stock_insert'),('phase2_audit_foundation_change'),
  ('phase2_advance_freshness_version_from_day'),('phase2_current_weighted_stock_price'),
  ('admin_create_weighted_stock')
), new_triggers(name) as (values
  ('phase2_inventory_mode_guard'),('phase2_tier_overlap'),('phase2_policy_touch'),
  ('phase2_day_touch'),('phase2_stock_initialize'),('phase2_stock_update_guard'),
  ('phase2_stock_no_delete'),('phase2_tier_no_delete'),('phase2_policy_no_delete'),
  ('phase2_days_no_delete'),('phase2_manual_price_policy_no_delete'),
  ('phase2_audit_no_update_delete'),('phase2_stock_creation_audit'),
  ('phase2_tier_change_audit'),('phase2_policy_change_audit'),
  ('phase2_day_change_audit'),('phase2_manual_price_policy_change_audit'),
  ('phase2_day_version_advance')
), checks as (
  select 'required_table:'||r.name check_name,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname=r.name and c.relkind in ('r','p')) ok,
    'missing or non-table public.'||r.name reason from required_tables r
  union all
  select 'required_column:'||r.table_name||'.'||r.column_name,
    exists(select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid
           join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname=r.table_name
             and a.attname=r.column_name and a.attnum>0 and not a.attisdropped
             and a.atttypid=r.type_name::regtype),
    'missing or incompatible '||r.table_name||'.'||r.column_name||' (expected '||r.type_name||')'
    from required_columns r
  union all
  select 'referenced_id_primary_key:'||r.name,
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
           join pg_index i on i.indrelid=c.oid
           join pg_attribute a on a.attrelid=c.oid and a.attnum=i.indkey[0]
           where n.nspname='public' and c.relname=r.name and i.indisprimary
             and i.indisvalid and i.indnkeyatts=1 and a.attname='id'),
    'F006-1 foreign key target lacks a valid single-column id primary key: '||r.name
    from referenced_keys r
  union all
  select 'products_inventory_mode_absent',
    not exists(select 1 from pg_attribute a
      where a.attrelid=to_regclass('public.products') and a.attname='inventory_mode'
        and a.attnum>0 and not a.attisdropped),
    'products.inventory_mode already exists; do not rerun F006-1'
  union all
  select 'products_inventory_mode_constraint_absent',
    not exists(select 1 from pg_constraint
      where conrelid=to_regclass('public.products') and conname='products_inventory_mode_check'),
    'products_inventory_mode_check already exists'
  union all
  select 'products_alter_owner_or_superuser',
    exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_roles r on r.rolname=current_user
      where n.nspname='public' and c.relname='products' and c.relkind in ('r','p')
        and (r.rolsuper or pg_has_role(current_user,c.relowner,'MEMBER'))),
    'SQL Editor executor is not products owner/member/superuser; ALTER TABLE may fail'
  union all
  select 'is_hanjiu_admin_boolean_zero_arg',
    exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='is_hanjiu_admin'
        and p.pronargs=0 and p.prorettype='boolean'::regtype),
    'public.is_hanjiu_admin() missing or not boolean'
  union all
  select 'gen_random_uuid_available',
    exists(select 1 from pg_proc p where p.oid=to_regprocedure('gen_random_uuid()')
      and p.prorettype='uuid'::regtype and has_function_privilege(current_user,p.oid,'EXECUTE')),
    'gen_random_uuid() not resolvable/executable as UUID in this session'
  union all
  select 'asia_taipei_fixed_timestamp',
    ('2026-01-01 16:00:00+00'::timestamptz at time zone 'Asia/Taipei')
      = '2026-01-02 00:00:00'::timestamp,
    'Asia/Taipei fixed UTC-to-local conversion differs from expected midnight'
  union all
  select 'canonical_checkout_7_arg',
    to_regprocedure('public.create_checkout_order(text,text,text,text,jsonb,text,uuid)') is not null,
    'F004-1 canonical seven-argument checkout function missing'
  union all
  select 'checkout_idempotency_unique_index',
    exists(select 1 from pg_class t join pg_namespace n on n.oid=t.relnamespace
      join pg_attribute a on a.attrelid=t.oid and a.attname='checkout_idempotency_key'
      join pg_index i on i.indrelid=t.oid and i.indisunique and i.indisvalid
        and i.indisready and i.indnkeyatts=1 and i.indkey[0]=a.attnum
      join pg_class ix on ix.oid=i.indexrelid
      where n.nspname='public' and t.relname='orders'
        and ix.relname='orders_checkout_idempotency_key_unique_idx'
        and (i.indpred is null or
          pg_get_expr(i.indpred,i.indrelid) like '%checkout_idempotency_key IS NOT NULL%')),
    'canonical single-key checkout idempotency unique index absent/invalid'
  union all
  select 'new_relation_absent:'||r.name,
    to_regclass('public.'||r.name) is null,
    'public.'||r.name||' already exists; F006-1 is not rerunnable' from new_relations r
  union all
  select 'new_function_absent:'||f.name,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=f.name),
    'public.'||f.name||' already exists; review collision before F006-1' from new_functions f
  union all
  select 'new_trigger_absent:'||t.name,
    not exists(select 1 from pg_trigger g join pg_class c on c.oid=g.tgrelid
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and not g.tgisinternal and g.tgname=t.name),
    'PR-A trigger '||t.name||' already exists; review collision before F006-1' from new_triggers t
)
select check_name,case when ok then 'PASS' else 'BLOCKER' end status,
       case when ok then null else reason end blocker_reason
from checks
union all
select 'SUMMARY',case when bool_and(ok) then 'PASS' else 'BLOCKER' end,
       string_agg(reason,'; ' order by check_name) filter (where not ok)
from checks
order by check_name;

-- Baseline metadata/fingerprints. Save function_key + definition_md5 verbatim.
select n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' function_key,
       pg_get_function_result(p.oid) return_type,
       case when p.prosecdef then 'DEFINER' else 'INVOKER' end security_mode,
       md5(pg_get_functiondef(p.oid)) definition_md5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
  ('create_checkout_order','is_hanjiu_admin','admin_cancel_order',
   'admin_reverse_order_payment','admin_record_order_payment','log_inventory_movement',
   'enforce_order_cancellation_flow','enforce_order_payment_flow',
   'enforce_paid_order_financial_lock','admin_audit_order_financial_integrity')
order by function_key;

select c.relname table_name,a.attnum ordinal_position,a.attname column_name,
       format_type(a.atttypid,a.atttypmod) data_type,a.attnotnull not_null,
       (select md5(string_agg(b.attname||':'||format_type(b.atttypid,b.atttypmod)||':'||b.attnotnull,
                   '|' order by b.attnum))
        from pg_attribute b where b.attrelid=c.oid and b.attnum>0 and not b.attisdropped) schema_md5
from pg_class c join pg_namespace n on n.oid=c.relnamespace
join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
where n.nspname='public' and c.relname='inventory_movements'
order by a.attnum;

select ix.relname index_name,i.indisunique,i.indisvalid,i.indisready,
       pg_get_indexdef(i.indexrelid) index_definition,
       md5(pg_get_indexdef(i.indexrelid)) index_definition_md5
from pg_index i join pg_class ix on ix.oid=i.indexrelid
where i.indrelid=to_regclass('public.orders')
  and ix.relname='orders_checkout_idempotency_key_unique_idx';

-- Exact baseline section: run only if the catalog SUMMARY above is PASS.
-- A missing legacy table makes a static count query fail; this is deliberately
-- separate from the catalog checks so all blockers can be collected first.
select 'products' entity,count(*)::bigint row_count from public.products
union all select 'product_variants',count(*) from public.product_variants
union all select 'orders',count(*) from public.orders
union all select 'order_items',count(*) from public.order_items
union all select 'inventory_movements',count(*) from public.inventory_movements
union all select 'order_payments',count(*) from public.order_payments
union all select 'order_payment_reversals',count(*) from public.order_payment_reversals
union all select 'product_images',count(*) from public.product_images
order by entity;

-- Exact, deterministic full-row digest of the historical ledger. Save both
-- row_count and rows_md5 for post-migration comparison; no ledger rows are touched.
select count(*)::bigint row_count,
       md5(coalesce(string_agg(md5(to_jsonb(m)::text),'' order by m.id::text),'')) rows_md5
from public.inventory_movements m;

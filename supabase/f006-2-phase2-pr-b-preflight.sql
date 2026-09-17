-- F006-2 Production preflight: READ ONLY. Run in SQL Editor before F006-2.
-- Do not run F005-1, F005-1a, or F006-1 again. Save all output for post-verify.
-- Section 1 is catalog-only and reports all blockers in one result.
with required_rel(name) as (values
  ('products'),('product_variants'),('orders'),('order_items'),('inventory_movements'),
  ('order_payments'),('order_payment_reversals'),('product_images'),
  ('phase2_weight_pricing_tiers'),('phase2_freshness_policy'),('phase2_freshness_days'),
  ('phase2_manual_price_confirmation_policy'),('phase2_weighted_stock'),('phase2_audit_events')
), required_col(rel,col) as (values
  ('products','id'),('products','updated_at'),('products','inventory_mode'),('products','status'),
  ('product_variants','product_id'),('product_variants','inventory'),
  ('orders','checkout_idempotency_key'),('orders','checkout_request_fingerprint'),
  ('order_items','order_id'),('order_items','product_id'),
  ('inventory_movements','inventory_delta'),('product_images','id'),('product_images','product_id'),
  ('phase2_weighted_stock','pricing_tier_id'),('phase2_weighted_stock','system_base_price'),
  ('phase2_weighted_stock','manual_base_price'),('phase2_weighted_stock','t0_base_price')
), new_rel(name) as (values
  ('phase2_stock_batch_daily_counters'),('phase2_stock_batches'),('phase2_stock_photos')
), new_col(rel,col) as (values
  ('products','common_weight_min_g'),('products','common_weight_max_g'),
  ('phase2_weighted_stock','batch_id'),('phase2_weighted_stock','batch_line_no')
), new_fn(signature) as (values
  ('phase2_guard_weighted_product_settings()'),('phase2_audit_weighted_product_settings()'),
  ('phase2_normalize_weighted_batch_items(jsonb)'),
  ('admin_update_weighted_product_settings(uuid,timestamp with time zone,text,integer,integer,text)'),
  ('admin_save_weight_pricing_tier(uuid,integer,integer,integer,integer,boolean,text,uuid,timestamp with time zone)'),
  ('admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text)'),
  ('admin_link_weighted_stock_photo(uuid,text)')
), new_trigger(name) as (values
  ('phase2_weighted_product_settings_guard'),('phase2_weighted_product_settings_audit')
), checks as (
  select 'missing relation public.'||name reason from required_rel where to_regclass('public.'||name) is null
  union all select 'missing column '||rel||'.'||col from required_col c where not exists (
    select 1 from information_schema.columns x where x.table_schema='public' and x.table_name=c.rel and x.column_name=c.col)
  union all select 'F006-2 relation already exists: '||name from new_rel where to_regclass('public.'||name) is not null
  union all select 'F006-2 column already exists: '||rel||'.'||col from new_col c where exists (
    select 1 from information_schema.columns x where x.table_schema='public' and x.table_name=c.rel and x.column_name=c.col)
  union all select 'F006-2 function already exists: '||signature from new_fn where to_regprocedure('public.'||signature) is not null
  union all select 'F006-2 trigger already exists: '||name from new_trigger t where exists (
    select 1 from pg_trigger where tgname=t.name and not tgisinternal)
  union all select 'missing F006-1 function: '||signature from (values
    ('phase2_initialize_weighted_stock()'),('phase2_guard_weighted_stock_update()'),
    ('phase2_manual_price_requires_confirmation(integer,integer)'),
    ('phase2_current_weighted_stock_price(uuid,timestamp with time zone)'),
    ('admin_create_weighted_stock(uuid,date,integer,text,uuid,integer,boolean)'),
    ('is_hanjiu_admin()')) f(signature) where to_regprocedure('public.'||signature) is null
  union all select 'F006-1 replaced helper differs from reviewed PR-A: '||signature from (values
    ('phase2_initialize_weighted_stock()','a41e2ff5cfd1176e11e6766113ee67d1'),
    ('phase2_guard_weighted_stock_update()','33e277b593304198a358bc7483c071b2')
  ) expected(signature,body_md5) where not exists (
    select 1 from pg_proc p where p.oid=to_regprocedure('public.'||expected.signature)
      and md5(regexp_replace(p.prosrc,E'\r\n?',E'\n','g'))=expected.body_md5)
  union all select 'canonical F004-1 seven-argument checkout missing' where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='create_checkout_order' and p.pronargs=7)
  union all select 'checkout idempotency unique index missing' where not exists (
    select 1 from pg_index i join pg_class t on t.oid=i.indrelid
    join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=t.oid
    where n.nspname='public' and t.relname='orders' and a.attname='checkout_idempotency_key'
      and a.attnum=any(i.indkey) and i.indisunique)
  union all select 'F006-1 default policy missing' where to_regclass('public.phase2_freshness_policy') is not null
    and not exists(select 1 from public.phase2_freshness_policy where id=1)
  union all select 'F006-1 audit/stock RLS disabled' where exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('phase2_weighted_stock','phase2_audit_events') and not c.relrowsecurity)
  union all select 'product-images Storage bucket absent' where not exists (
    select 1 from storage.buckets where id='product-images')
)
select case when exists(select 1 from checks) then 'BLOCKER' else 'PASS' end as preflight_summary,
       coalesce(string_agg(reason,E'\n' order by reason),'F006-1 foundation and F006-2 prerequisites present') as reasons
from checks;

-- Section 2: run when Section 1 is PASS. Save exact counts and fingerprints.
-- No business RPCs or data-changing functions are called.
select 'products' object_name,count(*)::bigint row_count from public.products
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
order by object_name;

-- Snapshot protected pre-existing functions. F006-2 intentionally REPLACES the
-- two stock trigger helpers; compare those against reviewed F006-2 definitions,
-- not their preflight hashes. Every function in this output must stay identical.
select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' signature,
       md5(pg_get_functiondef(p.oid)) definition_md5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and (
  p.proname='create_checkout_order' or p.proname='is_hanjiu_admin'
  or p.proname in ('phase2_current_weighted_stock_price','phase2_manual_price_requires_confirmation',
    'admin_create_weighted_stock','phase2_guard_inventory_mode','phase2_guard_tier_overlap')
  or p.proname ~ '(cancel|restock|payment|refund)')
order by signature;

select md5(string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text,
  '|' order by a.attnum)) inventory_movements_schema_md5
from pg_attribute a where a.attrelid='public.inventory_movements'::regclass and a.attnum>0 and not a.attisdropped;

-- Identical digest query is repeated in post-verify. Counts alone cannot detect
-- a rewrite that leaves row count unchanged.
select md5(coalesce(string_agg(to_jsonb(m)::text,'|' order by m.id::text),'')) inventory_movements_rows_md5
from public.inventory_movements m;

-- Preserve deployed F006-1 policy/day configuration, including any approved
-- owner changes since PR-A. Paste this hash into post-verify as well.
select md5(jsonb_build_object(
  'freshness_policy',(select to_jsonb(p) from public.phase2_freshness_policy p where p.id=1),
  'freshness_days',(select jsonb_agg(to_jsonb(d) order by d.day_offset) from public.phase2_freshness_days d),
  'manual_policy',(select to_jsonb(m) from public.phase2_manual_price_confirmation_policy m where m.id=1)
)::text) phase2_configuration_md5;

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
), stock_f0061_col(name,type_name,not_null) as (values
  ('id','uuid',true),('product_id','uuid',true),('stock_code','text',true),
  ('fish_date','date',true),('batch_reference','text',false),('raw_weight_g','integer',true),
  ('status','text',true),('representative_image_id','uuid',false),
  ('order_id','uuid',false),('order_item_id','uuid',false),
  ('pricing_tier_id','uuid',true),('price_per_jin_snapshot','integer',true),
  ('system_base_price','integer',true),('manual_base_price','integer',false),
  ('manual_price_confirmed','boolean',true),('t0_base_price','integer',true),
  ('version','integer',true),('created_at','timestamp with time zone',true),
  ('updated_at','timestamp with time zone',true)
), stock_f0061_fk(col,ref_table,delete_action) as (values
  ('product_id','products','r'),('representative_image_id','product_images','n'),
  ('order_id','orders','r'),('order_item_id','order_items','r'),
  ('pricing_tier_id','phase2_weight_pricing_tiers','r')
), stock_f0061_default(col,expression) as (values
  ('id','gen_random_uuid()'),('status','''sellable''::text'),
  ('manual_price_confirmed','false'),('version','1'),
  ('created_at','now()'),('updated_at','now()')
), stock_f0061_check(pattern) as (values
  ('batch_reference.*char_length'),('raw_weight_g[[:space:]]*>[[:space:]]*0'),
  ('status.*sellable.*reserved.*sold.*manually_unlisted.*externally_sold.*expired.*unavailable.*needs_manual_review'),
  ('price_per_jin_snapshot[[:space:]]*>[[:space:]]*0'),
  ('system_base_price[[:space:]]*>[[:space:]]*0'),
  ('manual_base_price.*manual_base_price[[:space:]]*>[[:space:]]*0'),
  ('t0_base_price[[:space:]]*>[[:space:]]*0'),('version[[:space:]]*>[[:space:]]*0'),
  ('t0_base_price[[:space:]]*=[[:space:]]*coalesce'),
  ('order_item_id IS NULL.*order_id IS NOT NULL')
), stock_f0061_trigger(name,signature) as (values
  ('phase2_stock_initialize','phase2_initialize_weighted_stock()'),
  ('phase2_stock_update_guard','phase2_guard_weighted_stock_update()'),
  ('phase2_stock_no_delete','phase2_no_foundation_delete()'),
  ('phase2_stock_creation_audit','phase2_audit_stock_insert()')
), protected_function(signature) as (values
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
), new_rel(name) as (values
  ('phase2_stock_batch_daily_counters'),('phase2_stock_batches'),('phase2_stock_photos'),
  ('phase2_batches_created_idx'),('phase2_stock_batch_idx')
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
  union all select 'F006-1 weighted stock column/type/nullability mismatch: '||e.name
    from stock_f0061_col e left join pg_attribute a
      on a.attrelid=to_regclass('public.phase2_weighted_stock') and a.attname=e.name and a.attnum>0 and not a.attisdropped
    where a.attnum is null or format_type(a.atttypid,a.atttypmod)<>e.type_name or a.attnotnull<>e.not_null
  union all select 'unexpected F006-1 weighted stock column: '||a.attname
    from pg_attribute a where a.attrelid=to_regclass('public.phase2_weighted_stock')
      and a.attnum>0 and not a.attisdropped and not exists(select 1 from stock_f0061_col e where e.name=a.attname)
  union all select 'F006-1 weighted stock default mismatch: '||e.col from stock_f0061_default e
    where not exists(select 1 from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=to_regclass('public.phase2_weighted_stock') and a.attname=e.col
        and pg_get_expr(d.adbin,d.adrelid)=e.expression)
  union all select 'unexpected F006-1 weighted stock default: '||a.attname
    from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=to_regclass('public.phase2_weighted_stock') and a.attnum>0 and not a.attisdropped
      and not exists(select 1 from stock_f0061_default e where e.col=a.attname)
  union all select 'missing F006-1 weighted stock key: '||key_name from (values
    ('id','p'),('stock_code','u'),('order_item_id','u')) k(key_name,kind)
    where not exists(select 1 from pg_constraint c join pg_attribute a
      on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
      where c.conrelid=to_regclass('public.phase2_weighted_stock') and c.contype=k.kind::"char"
        and c.convalidated and array_length(c.conkey,1)=1 and a.attname=k.key_name)
  union all select 'missing F006-1 weighted stock FK: '||f.col from stock_f0061_fk f
    where not exists(select 1 from pg_constraint c join pg_attribute a
      on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
      where c.conrelid=to_regclass('public.phase2_weighted_stock') and c.contype='f'
        and c.convalidated and c.confrelid=to_regclass('public.'||f.ref_table)
        and c.confdeltype=f.delete_action::"char"
        and array_length(c.conkey,1)=1 and a.attname=f.col)
  union all select 'missing validated F006-1 weighted stock CHECK: '||pattern from stock_f0061_check e
    where not exists(select 1 from pg_constraint c
      where c.conrelid=to_regclass('public.phase2_weighted_stock') and c.contype='c' and c.convalidated
        and pg_get_constraintdef(c.oid) ~* e.pattern)
  union all select 'F006-1 weighted stock constraint set/count differs from reviewed 18' where (
    select count(*) from pg_constraint c
    where c.conrelid=to_regclass('public.phase2_weighted_stock'))<>18
  union all select 'F006-1 weighted stock trigger missing or rewired: '||e.name from stock_f0061_trigger e
    where not exists(select 1 from pg_trigger g
      where g.tgrelid=to_regclass('public.phase2_weighted_stock') and g.tgname=e.name and g.tgenabled<>'D'
        and g.tgfoid=to_regprocedure('public.'||e.signature))
  union all select 'F006-1 weighted stock noninternal trigger count differs from reviewed four' where (
    select count(*) from pg_trigger g
    where g.tgrelid=to_regclass('public.phase2_weighted_stock') and not g.tgisinternal)<>4
  union all select 'F006-1 stock-code sequence missing' where to_regclass('public.phase2_stock_code_seq') is null
  union all select 'F006-1 weighted stock browser direct write privilege' where
    has_table_privilege('anon','public.phase2_weighted_stock','INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.phase2_weighted_stock','INSERT,UPDATE,DELETE')
  union all select 'protected function missing: '||signature from protected_function
    where to_regprocedure('public.'||signature) is null
  union all select 'checkout overload count differs from reviewed three' where (
    select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='create_checkout_order')<>3
  union all select 'F006-2 relation already exists: '||name from new_rel where to_regclass('public.'||name) is not null
  union all select 'F006-2 product range constraint already exists' where exists (
    select 1 from pg_constraint c where c.conrelid=to_regclass('public.products')
      and c.conname='products_common_weight_range_check')
  union all select 'F006-2 column already exists: '||rel||'.'||col from new_col c where exists (
    select 1 from information_schema.columns x where x.table_schema='public' and x.table_name=c.rel and x.column_name=c.col)
  union all select 'F006-2 function already exists: '||signature from new_fn where to_regprocedure('public.'||signature) is not null
  union all select 'F006-2 trigger already exists: '||name from new_trigger t where exists (
    select 1 from pg_trigger where tgname=t.name and not tgisinternal)
  union all select 'missing F006-1 function: '||signature from (values
    ('phase2_initialize_weighted_stock()'),('phase2_guard_weighted_stock_update()')) f(signature)
    where to_regprocedure('public.'||signature) is null
  union all select 'F006-1 replaced helper differs from reviewed PR-A: '||signature from (values
    ('phase2_initialize_weighted_stock()','a41e2ff5cfd1176e11e6766113ee67d1'),
    ('phase2_guard_weighted_stock_update()','33e277b593304198a358bc7483c071b2')
  ) expected(signature,body_md5) where not exists (
    select 1 from pg_proc p where p.oid=to_regprocedure('public.'||expected.signature)
      and md5(regexp_replace(p.prosrc,E'\r\n?',E'\n','g'))=expected.body_md5)
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

-- F006-1 business-row digest. This exact 19-column array/order is repeated in
-- post-verify; F006-2's new nullable batch columns are deliberately excluded.
-- Per-row hashes include the UUID and are aggregated in UUID order, so row
-- swaps, snapshot edits, links, timestamps, deletions and replacements change
-- the result even when total row count stays unchanged. Works for nonzero rows.
select count(*)::bigint weighted_stock_baseline_count,
  md5(coalesce(string_agg(s.id::text||':'||md5(jsonb_build_array(
    s.id,s.product_id,s.stock_code,
    case when isfinite(s.fish_date) then to_char(s.fish_date,'YYYY-MM-DD') else s.fish_date::text end,
    s.batch_reference,s.raw_weight_g,
    s.status,s.representative_image_id,s.order_id,s.order_item_id,
    s.pricing_tier_id,s.price_per_jin_snapshot,s.system_base_price,
    s.manual_base_price,s.manual_price_confirmed,s.t0_base_price,s.version,
    case when isfinite(s.created_at) then to_char(s.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') else s.created_at::text end,
    case when isfinite(s.updated_at) then to_char(s.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') else s.updated_at::text end
  )::text),E'\n' order by s.id::text),'')) weighted_stock_f0061_business_md5
from public.phase2_weighted_stock s;

-- Copy this one-row JSONB map into post-verify's protected-function baseline.
-- Explicit type-only signatures avoid name/regex discovery and include all
-- three checkout and both payment-recording overloads. Missing entries are
-- already BLOCKERs in Section 1; a NULL hash is never accepted after deploy.
with protected_function(signature) as (values
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
)
select jsonb_object_agg(e.signature,md5(pg_get_functiondef(p.oid)) order by e.signature)
  protected_function_definition_md5_by_signature
from protected_function e left join pg_proc p on p.oid=to_regprocedure('public.'||e.signature);

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

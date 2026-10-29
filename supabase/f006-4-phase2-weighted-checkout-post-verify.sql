-- F006-4 / PR-C1 post-migration verification. READ ONLY.
with checks(check_name,result,detail) as (
  select 'hold_columns',case when
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='weighted_hold_expires_at' and data_type='timestamp with time zone')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='weighted_hold_released_at' and data_type='timestamp with time zone')
    then 'PASS' else 'BLOCKER' end,'database-owned payment-hold timestamps'
  union all
  select 'weighted_item_snapshots',case when (select count(*) from information_schema.columns where table_schema='public' and table_name='order_items' and column_name in
    ('weighted_stock_id','weighted_stock_code','weighted_raw_weight_g','weighted_t0_base_price','weighted_freshness_day','weighted_freshness_multiplier','weighted_freshness_version'))=7
    then 'PASS' else 'BLOCKER' end,'all seven weighted purchase snapshots exist'
  union all
  select 'foundation_functions',case when
    to_regprocedure('public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)') is not null
    and to_regprocedure('public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)') is not null
    and to_regprocedure('public.phase2_transition_weighted_stock(uuid,text,text,uuid,uuid,uuid,uuid,text,text,uuid)') is not null
    then 'PASS' else 'BLOCKER' end,'C1 transaction primitives exist'
  union all
  select 'browser_foundation_closed',case when
    not coalesce(has_function_privilege('anon','public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)','execute'),false)
    and not coalesce(has_function_privilege('anon','public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)','execute'),false)
    then 'PASS' else 'BLOCKER' end,'PR-C1 must not enable customer weighted checkout'
  union all
  select 'legacy_checkout_still_public',case when
    coalesce(has_function_privilege('anon','public.create_checkout_order(text,text,text,text,jsonb,text,uuid)','execute'),false)
    and coalesce(has_function_privilege('authenticated','public.create_checkout_order(text,text,text,text,jsonb,text,uuid)','execute'),false)
    then 'PASS' else 'BLOCKER' end,'F004-1/F004-3.3 seven-argument checkout grant preserved'
  union all
  select 'weighted_payment_trigger',case when exists(select 1 from pg_trigger where tgrelid='public.orders'::regclass
    and tgname='orders_finalize_weighted_hold_after_payment' and not tgisinternal and tgenabled<>'D') then 'PASS' else 'BLOCKER' end,
    'payment completion must be transaction-coupled to the order update'
  union all
  select 'browser_direct_writes_denied',case when
    not coalesce(has_table_privilege('anon','public.phase2_weighted_stock','UPDATE'),false)
    and not coalesce(has_table_privilege('authenticated','public.phase2_weighted_stock','UPDATE'),false)
    and not coalesce(has_table_privilege('anon','public.order_items','INSERT'),false)
    and not coalesce(has_table_privilege('authenticated','public.order_items','INSERT'),false)
    then 'PASS' else 'BLOCKER' end,'sensitive rows remain RPC-only'
  union all
  select 'no_partial_reservations',case when not exists(select 1 from public.phase2_weighted_stock s where
    (s.status='reserved' and (s.order_id is null or s.order_item_id is null))
    or (s.status='sellable' and (s.order_id is not null or s.order_item_id is not null)))
    then 'PASS' else 'BLOCKER' end,'stock linkage agrees with availability state'
  union all
  select 'weighted_snapshot_links_valid',case when not exists(select 1 from public.order_items i left join public.phase2_weighted_stock s on s.id=i.weighted_stock_id
    where i.weighted_stock_id is not null and (s.id is null or i.quantity<>1 or i.variant_id is not null or i.price<=0 or i.weighted_raw_weight_g<=0))
    then 'PASS' else 'BLOCKER' end,'weighted item snapshots are structurally valid'
)
select * from (
  select check_name,result,detail,1 sort_key from checks
  union all select 'SUMMARY',case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER') then 'resolve every blocker before application rollout' else 'F006-4 catalog and security checks passed' end,2
) output order by sort_key,check_name;

-- Paste the exact preflight values here. NULL means UNVERIFIED, never PASS.
with baseline(products_count,product_variants_count,orders_count,order_items_count,inventory_movements_count,order_payments_count,order_payment_reversals_count,weighted_stock_count) as
  (values(null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint)),
actual as (select
  (select count(*) from public.products) products_count,(select count(*) from public.product_variants) product_variants_count,
  (select count(*) from public.orders) orders_count,(select count(*) from public.order_items) order_items_count,
  (select count(*) from public.inventory_movements) inventory_movements_count,(select count(*) from public.order_payments) order_payments_count,
  (select count(*) from public.order_payment_reversals) order_payment_reversals_count,(select count(*) from public.phase2_weighted_stock) weighted_stock_count)
select case when baseline.products_count is null or baseline.product_variants_count is null or baseline.orders_count is null
    or baseline.order_items_count is null or baseline.inventory_movements_count is null or baseline.order_payments_count is null
    or baseline.order_payment_reversals_count is null or baseline.weighted_stock_count is null then 'UNVERIFIED'
  when baseline.products_count=actual.products_count and baseline.product_variants_count=actual.product_variants_count
    and baseline.orders_count=actual.orders_count and baseline.order_items_count=actual.order_items_count
    and baseline.inventory_movements_count=actual.inventory_movements_count and baseline.order_payments_count=actual.order_payments_count
    and baseline.order_payment_reversals_count=actual.order_payment_reversals_count and baseline.weighted_stock_count=actual.weighted_stock_count
  then 'PASS' else 'BLOCKER' end baseline_result,baseline,actual from baseline,actual;

-- Paste the three exact preflight digests. F006-4 adds nullable columns only and
-- must not rewrite any pre-existing order, item, or stock business row.
with expected(orders_md5,items_md5,stocks_md5) as (values(null::text,null::text,null::text)),actual as (
 select
  (select md5(coalesce(string_agg(o.id::text||':'||md5(jsonb_build_array(o.status,o.payment_status,o.subtotal,o.shipping_fee,o.discount_amount,o.total_amount,o.checkout_idempotency_key,o.checkout_request_fingerprint,o.created_at)::text),'' order by o.id),'')) from public.orders o) orders_md5,
  (select md5(coalesce(string_agg(i.id::text||':'||md5(jsonb_build_array(i.order_id,i.product_id,i.product_name,i.variant_id,i.variant_name,i.price,i.quantity,i.supply_type,i.processing_preset_id,i.processing_preset_name,i.processing_option_ids,i.processing_option_names,i.processing_note)::text),'' order by i.id),'')) from public.order_items i) items_md5,
  (select md5(coalesce(string_agg(s.id::text||':'||md5(jsonb_build_array(s.product_id,s.stock_code,s.fish_date,s.raw_weight_g,s.status,s.order_id,s.order_item_id,s.pricing_tier_id,s.price_per_jin_snapshot,s.system_base_price,s.manual_base_price,s.manual_price_confirmed,s.t0_base_price,s.version,s.created_at,s.updated_at,s.batch_id,s.batch_line_no)::text),'' order by s.id),'')) from public.phase2_weighted_stock s) stocks_md5
)
select case when expected.orders_md5 is null or expected.items_md5 is null or expected.stocks_md5 is null then 'UNVERIFIED'
  when expected.orders_md5=actual.orders_md5 and expected.items_md5=actual.items_md5 and expected.stocks_md5=actual.stocks_md5
  then 'PASS' else 'BLOCKER' end business_row_digest_result,expected,actual from expected,actual;

-- Paste the preflight MD5 map for unchanged protected functions.
with expected(signature,expected_md5) as (values
 ('create_checkout_order(text,text,text,text,jsonb,text,uuid)',null::text),
 ('admin_record_order_payment(uuid,integer,text,uuid)',null::text),('admin_reverse_order_payment(uuid,text)',null::text),
 ('enforce_order_payment_flow()',null::text),('enforce_order_cancellation_flow()',null::text),
 ('log_inventory_movement()',null::text),('phase2_current_weighted_stock_price(uuid,timestamp with time zone)',null::text),
 ('admin_unlist_weighted_stock(uuid,integer,text)',null::text),('admin_relist_weighted_stock(uuid,integer,text)',null::text)
)
select signature,case when expected_md5 is null then 'UNVERIFIED'
  when to_regprocedure('public.'||signature) is null then 'BLOCKER'
  when md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=expected_md5 then 'PASS' else 'BLOCKER' end result,
  expected_md5,case when to_regprocedure('public.'||signature) is null then null else md5(pg_get_functiondef(to_regprocedure('public.'||signature))) end actual_md5
from expected order by signature;

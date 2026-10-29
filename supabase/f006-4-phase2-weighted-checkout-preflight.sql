-- F006-4 / PR-C1 Production preflight. READ ONLY. Save every BASELINE row.
with checks(check_name,result,detail) as (
  select 'f0064_objects_absent',case when
    not exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name in ('weighted_hold_expires_at','weighted_hold_released_at'))
    and not exists(select 1 from information_schema.columns where table_schema='public' and table_name='order_items' and column_name='weighted_stock_id')
    and to_regprocedure('public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)') is null
    and to_regprocedure('public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)') is null
    then 'PASS' else 'BLOCKER' end,'F006-4 is forward-only and must not be rerun'
  union all
  select 'f0063_action_token_table',case when to_regclass('public.phase2_weighted_stock_action_tokens') is not null then 'PASS' else 'BLOCKER' end,'F006-3 prerequisite'
  union all
  select 'weighted_stock_link_columns',case when
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='phase2_weighted_stock' and column_name='order_id' and data_type='uuid')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='phase2_weighted_stock' and column_name='order_item_id' and data_type='uuid')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='phase2_weighted_stock' and column_name='version' and data_type='integer')
    then 'PASS' else 'BLOCKER' end,'reviewed F006-1/F006-3 stock linkage and concurrency columns'
  union all
  select 'checkout_idempotency',case when
    exists(select 1 from pg_indexes where schemaname='public' and tablename='orders' and indexname='orders_checkout_idempotency_key_unique_idx' and indexdef ilike '%unique%')
    and to_regprocedure('public.create_checkout_order(text,text,text,text,jsonb,text,uuid)') is not null
    then 'PASS' else 'BLOCKER' end,'F004-1 key plus canonical seven-argument checkout'
  union all
  select 'payment_and_cancel_rpc',case when
    to_regprocedure('public.admin_record_order_payment(uuid,integer,text,uuid)') is not null
    and to_regprocedure('public.admin_reverse_order_payment(uuid,text)') is not null
    and to_regprocedure('public.admin_cancel_order(uuid)') is not null
    then 'PASS' else 'BLOCKER' end,'latest payment lifecycle and cancellation dependencies'
  union all
  select 'order_amount_automation',case when
    to_regprocedure('public.recalculate_order_totals_from_items()') is not null
    and exists(select 1 from pg_trigger where tgrelid='public.order_items'::regclass
      and tgname='order_items_recalculate_totals' and not tgisinternal and tgenabled<>'D')
    and to_regprocedure('public.admin_update_order_totals(uuid,integer,integer)') is not null
    then 'PASS' else 'BLOCKER' end,'item inserts must recalculate subtotal/total; shipping and discount remain controlled'
  union all
  select 'existing_order_amount_consistency',case when not exists(
    select 1 from public.orders o where
      (o.subtotal is not null and o.subtotal is distinct from
        (select coalesce(sum(i.price*i.quantity),0)::integer from public.order_items i where i.order_id=o.id))
      or (o.subtotal is not null and o.shipping_fee is not null and o.discount_amount is not null
        and o.total_amount is distinct from greatest(o.subtotal+o.shipping_fee-o.discount_amount,0))
    ) then 'PASS' else 'BLOCKER' end,'non-null legacy totals must agree with item snapshots and adjustments'
  union all
  select 'phase2_current_price',case when to_regprocedure('public.phase2_current_weighted_stock_price(uuid,timestamp with time zone)') is not null
    and exists(select 1 from public.phase2_freshness_policy where id=1)
    then 'PASS' else 'BLOCKER' end,'freshness policy and price helper required'
  union all
  select 'no_inconsistent_existing_stock_links',case when not exists(
    select 1 from public.phase2_weighted_stock s where
      (s.status='reserved' and (s.order_id is null or s.order_item_id is null))
      or (s.status='sellable' and (s.order_id is not null or s.order_item_id is not null))
    ) then 'PASS' else 'BLOCKER' end,'existing stock must not contain partial reservation linkage'
  union all
  select 'browser_has_no_weighted_write',case when
    not coalesce(has_table_privilege('anon','public.phase2_weighted_stock','UPDATE'),false)
    and not coalesce(has_table_privilege('authenticated','public.phase2_weighted_stock','UPDATE'),false)
    then 'PASS' else 'BLOCKER' end,'browser roles must not directly mutate weighted stock'
)
select * from (
  select check_name,result,detail,1 sort_key from checks
  union all select 'SUMMARY',case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER') then 'resolve every blocker before F006-4' else 'F006-4 prerequisites satisfied' end,2
) output order by sort_key,check_name;

-- BASELINE: copy this result beside the post-verification placeholders.
select
  (select count(*) from public.products) products_count,
  (select count(*) from public.product_variants) product_variants_count,
  (select count(*) from public.orders) orders_count,
  (select count(*) from public.order_items) order_items_count,
  (select count(*) from public.inventory_movements) inventory_movements_count,
  (select count(*) from public.order_payments) order_payments_count,
  (select count(*) from public.order_payment_reversals) order_payment_reversals_count,
  (select count(*) from public.phase2_weighted_stock) weighted_stock_count,
  (select count(*) from public.phase2_audit_events) phase2_audit_count;

-- BASELINE: existing business-row digests. New nullable columns are intentionally excluded.
select
  md5(coalesce(string_agg(o.id::text||':'||md5(jsonb_build_array(o.status,o.payment_status,o.subtotal,o.shipping_fee,o.discount_amount,o.total_amount,o.checkout_idempotency_key,o.checkout_request_fingerprint,o.created_at)::text),'' order by o.id),'')) orders_business_md5
from public.orders o;
select
  md5(coalesce(string_agg(i.id::text||':'||md5(jsonb_build_array(i.order_id,i.product_id,i.product_name,i.variant_id,i.variant_name,i.price,i.quantity,i.supply_type,i.processing_preset_id,i.processing_preset_name,i.processing_option_ids,i.processing_option_names,i.processing_note)::text),'' order by i.id),'')) order_items_business_md5
from public.order_items i;
select
  md5(coalesce(string_agg(s.id::text||':'||md5(jsonb_build_array(s.product_id,s.stock_code,s.fish_date,s.raw_weight_g,s.status,s.order_id,s.order_item_id,s.pricing_tier_id,s.price_per_jin_snapshot,s.system_base_price,s.manual_base_price,s.manual_price_confirmed,s.t0_base_price,s.version,s.created_at,s.updated_at,s.batch_id,s.batch_line_no)::text),'' order by s.id),'')) weighted_stock_business_md5
from public.phase2_weighted_stock s;

-- BASELINE: exact protected definitions. F006-4 intentionally replaces only the
-- weighted guard and admin_cancel_order; save their source separately for review.
with expected(signature) as (values
 ('create_checkout_order(text,text,text,text,jsonb,text,uuid)'),
 ('admin_record_order_payment(uuid,integer,text,uuid)'),('admin_reverse_order_payment(uuid,text)'),
 ('recalculate_order_totals_from_items()'),('admin_update_order_totals(uuid,integer,integer)'),
 ('enforce_order_payment_flow()'),('enforce_order_cancellation_flow()'),
 ('log_inventory_movement()'),('phase2_current_weighted_stock_price(uuid,timestamp with time zone)'),
 ('admin_unlist_weighted_stock(uuid,integer,text)'),('admin_relist_weighted_stock(uuid,integer,text)')
)
select signature,md5(pg_get_functiondef(to_regprocedure('public.'||signature))) definition_md5
from expected order by signature;
select 'phase2_guard_weighted_stock_update()' signature,md5(pg_get_functiondef('public.phase2_guard_weighted_stock_update()'::regprocedure)) definition_md5
union all
select 'admin_cancel_order(uuid)',md5(pg_get_functiondef('public.admin_cancel_order(uuid)'::regprocedure));

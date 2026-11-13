-- F006-5 / PR-C2.1 Production preflight. 100% READ ONLY.
-- Save every BASELINE and function fingerprint before owner-run deployment.
with checks(check_name,result,detail) as (
  select 'f0065_objects_absent',case when
    not exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders'
      and column_name in ('payment_reporting_required','payment_slot_active','payment_report_status','checkout_phone_normalized'))
    and to_regclass('public.order_customer_access_tokens') is null
    and to_regclass('public.order_payment_reports') is null
    and to_regclass('public.notification_outbox') is null
    and to_regprocedure('public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text)') is null
    then 'PASS' else 'BLOCKER' end,'F006-5 is forward-only and must not be rerun'
  union all
  select 'f0064_columns',case when
    exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='weighted_hold_expires_at' and data_type='timestamp with time zone')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='weighted_hold_released_at' and data_type='timestamp with time zone')
    and exists(select 1 from information_schema.columns where table_schema='public' and table_name='order_items' and column_name='weighted_stock_id' and data_type='uuid')
    then 'PASS' else 'BLOCKER' end,'F006-4 hold and weighted snapshot columns are required'
  union all
  select 'f0064_functions',case when
    to_regprocedure('public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)') is not null
    and to_regprocedure('public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)') is not null
    and to_regprocedure('public.phase2_finalize_weighted_hold_on_payment()') is not null
    and to_regprocedure('public.admin_record_order_payment(uuid,integer,text,uuid)') is not null
    and to_regprocedure('public.admin_cancel_order(uuid)') is not null
    then 'PASS' else 'BLOCKER' end,'reviewed F006-4 and payment lifecycle functions must exist'
  union all
  select 'f0064_browser_closed',case when
    not coalesce(has_function_privilege('anon','public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)','execute'),false)
    and not coalesce(has_function_privilege('anon','public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_release_expired_checkout_hold(uuid,timestamp with time zone)','execute'),false)
    then 'PASS' else 'BLOCKER' end,'internal checkout and release RPCs must remain browser-closed'
  union all
  select 'checkout_idempotency',case when
    exists(select 1 from pg_indexes where schemaname='public' and tablename='orders'
      and indexname='orders_checkout_idempotency_key_unique_idx' and indexdef ilike '%unique%')
    and not exists(select 1 from public.orders where checkout_idempotency_key is not null
      group by checkout_idempotency_key having count(*)>1)
    then 'PASS' else 'BLOCKER' end,'F004-1 idempotency must be intact'
  union all
  select 'order_amount_consistency',case when not exists(select 1 from public.orders o where
    (o.subtotal is not null and o.subtotal is distinct from
      (select coalesce(sum(i.price*i.quantity),0)::integer from public.order_items i where i.order_id=o.id))
    or (o.subtotal is not null and o.shipping_fee is not null and o.discount_amount is not null
      and o.total_amount is distinct from greatest(o.subtotal+o.shipping_fee-o.discount_amount,0)))
    then 'PASS' else 'BLOCKER' end,'existing amount snapshots must be internally consistent'
  union all
  select 'active_weighted_links',case when not exists(select 1 from public.phase2_weighted_stock s where
    (s.status='reserved' and (s.order_id is null or s.order_item_id is null))
    or (s.status in ('sellable','manual_unlisted','expired') and (s.order_id is not null or s.order_item_id is not null)))
    then 'PASS' else 'BLOCKER' end,'existing weighted state/linkage must be consistent'
  union all
  select 'legacy_payment_integrity',case when not exists(select 1 from public.orders o where
    (o.payment_status='paid' and not exists(select 1 from public.order_payments p where p.order_id=o.id
      and not exists(select 1 from public.order_payment_reversals r where r.payment_id=p.id)))
    or (o.payment_status='unpaid' and exists(select 1 from public.order_payments p where p.order_id=o.id
      and not exists(select 1 from public.order_payment_reversals r where r.payment_id=p.id))))
    then 'PASS' else 'BLOCKER' end,'existing payment fact and order status must agree'
)
select check_name,result,detail from (
  select check_name,result,detail,1 sort_key from checks
  union all select 'SUMMARY',case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER') then 'resolve every blocker before F006-5' else 'F006-5 prerequisites satisfied' end,2
) output order by sort_key,check_name;

-- BASELINE counts. F006-5 must not create, delete, or rewrite historical business facts.
select
  (select count(*) from public.orders) orders_count,
  (select count(*) from public.order_items) order_items_count,
  (select count(*) from public.inventory_movements) inventory_movements_count,
  (select count(*) from public.order_payments) order_payments_count,
  (select count(*) from public.order_payment_reversals) order_payment_reversals_count,
  (select count(*) from public.phase2_weighted_stock) weighted_stock_count,
  (select count(*) from public.phase2_audit_events) phase2_audit_count;

-- BASELINE deterministic business-row digests; F006-5's new nullable/default columns are excluded.
select md5(coalesce(string_agg(o.id::text||':'||md5(jsonb_build_array(
  o.customer_id,o.customer_name,o.phone,o.email,o.fulfillment,o.note,o.status,o.payment_status,
  o.subtotal,o.shipping_fee,o.discount_amount,o.total_amount,o.checkout_idempotency_key,
  o.checkout_request_fingerprint,o.weighted_hold_expires_at,o.weighted_hold_released_at,o.created_at)::text),'' order by o.id),'')) orders_business_md5
from public.orders o;
select md5(coalesce(string_agg(i.id::text||':'||md5(jsonb_build_array(
  i.order_id,i.product_id,i.product_name,i.variant_id,i.variant_name,i.price,i.quantity,i.supply_type,
  i.processing_preset_id,i.processing_preset_name,i.processing_option_ids,i.processing_option_names,i.processing_note,
  i.weighted_stock_id,i.weighted_stock_code,i.weighted_raw_weight_g,i.weighted_t0_base_price,
  i.weighted_freshness_day,i.weighted_freshness_multiplier,i.weighted_freshness_version)::text),'' order by i.id),'')) order_items_business_md5
from public.order_items i;
select md5(coalesce(string_agg(s.id::text||':'||md5(jsonb_build_array(
  s.product_id,s.stock_code,s.fish_date,s.raw_weight_g,s.status,s.order_id,s.order_item_id,
  s.pricing_tier_id,s.price_per_jin_snapshot,s.system_base_price,s.manual_base_price,
  s.manual_price_confirmed,s.t0_base_price,s.version,s.batch_id,s.batch_line_no,s.created_at,s.updated_at)::text),'' order by s.id),'')) weighted_stock_business_md5
from public.phase2_weighted_stock s;

-- Save exact definitions. The three marked F006-5 replacements intentionally change.
with expected(signature,replacement) as (values
 ('create_checkout_order(text,text,text,text,jsonb,text,uuid)',false),
 ('admin_reverse_order_payment(uuid,text)',false),('admin_cancel_order(uuid)',false),
 ('admin_update_order_totals(uuid,integer,integer)',false),('log_inventory_movement()',false),
 ('phase2_transition_weighted_stock(uuid,text,text,uuid,uuid,uuid,uuid,text,text,uuid)',false),
 ('phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)',false),
 ('admin_record_order_payment(uuid,integer,text,uuid)',true),
 ('phase2_finalize_weighted_hold_on_payment()',true),
 ('phase2_release_expired_checkout_hold(uuid,timestamp with time zone)',true)
)
select signature,replacement,case when to_regprocedure('public.'||signature) is null then null
  else md5(pg_get_functiondef(to_regprocedure('public.'||signature))) end definition_md5
from expected order by signature;

-- F006-5 / PR-C2.1 post-migration verification. 100% READ ONLY.
with checks(check_name,result,detail) as (
  select 'schema_objects',case when
    to_regclass('public.order_customer_access_tokens') is not null
    and to_regclass('public.order_payment_reports') is not null
    and to_regclass('public.order_customer_contact_revisions') is not null
    and to_regclass('public.order_lifecycle_events') is not null
    and to_regclass('public.notification_outbox') is not null
    and to_regclass('public.phase2_order_action_tokens') is not null
    then 'PASS' else 'BLOCKER' end,'all F006-5 tables exist'
  union all
  select 'order_columns',case when (select count(*) from information_schema.columns
    where table_schema='public' and table_name='orders' and column_name in
      ('payment_reporting_required','payment_slot_active','payment_report_status','payment_reported_at','current_payment_report_id',
       'payment_review_updated_at','checkout_phone_normalized','customer_email_revision','customer_email_changed_at'))=9
    then 'PASS' else 'BLOCKER' end,'all lifecycle columns exist'
  union all
  select 'one_unfinished_order_index',case when exists(select 1 from pg_indexes where schemaname='public'
    and tablename='orders' and indexname='orders_one_unfinished_payment_per_phone_uidx'
    and indexdef ilike '%unique%' and indexdef ilike '%payment_slot_active%')
    then 'PASS' else 'BLOCKER' end,'database constraint is the final same-phone concurrency defense'
  union all
  select 'functions',case when
    to_regprocedure('public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text)') is not null
    and to_regprocedure('public.phase2_submit_payment_report(text,text,integer,uuid)') is not null
    and to_regprocedure('public.phase2_amend_payment_report(text,text,uuid)') is not null
    and to_regprocedure('public.phase2_customer_cancel_order(text,uuid)') is not null
    and to_regprocedure('public.admin_confirm_reported_order_payment(uuid,uuid,uuid)') is not null
    and to_regprocedure('public.admin_mark_payment_report_exception(uuid,uuid,text,uuid)') is not null
    and to_regprocedure('public.admin_cancel_reported_order(uuid,uuid,text,uuid)') is not null
    and to_regprocedure('public.phase2_claim_notification_outbox(integer,uuid,timestamp with time zone)') is not null
    and to_regprocedure('public.phase2_complete_notification_outbox(uuid,uuid,text,timestamp with time zone)') is not null
    and to_regprocedure('public.phase2_fail_notification_outbox(uuid,uuid,text,timestamp with time zone,boolean)') is not null
    then 'PASS' else 'BLOCKER' end,'customer lifecycle and admin review RPCs exist'
  union all
  select 'browser_internal_rpc_closed',case when
    not coalesce(has_function_privilege('anon','public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text)','execute'),false)
    and not coalesce(has_function_privilege('anon','public.phase2_submit_payment_report(text,text,integer,uuid)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_submit_payment_report(text,text,integer,uuid)','execute'),false)
    and not coalesce(has_function_privilege('anon','public.phase2_customer_cancel_order(text,uuid)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','public.phase2_customer_cancel_order(text,uuid)','execute'),false)
    then 'PASS' else 'BLOCKER' end,'server-bound customer/internal RPCs have no browser grant'
  union all
  select 'admin_rpc_permissions',case when
    coalesce(has_function_privilege('authenticated','public.admin_confirm_reported_order_payment(uuid,uuid,uuid)','execute'),false)
    and coalesce(has_function_privilege('authenticated','public.admin_mark_payment_report_exception(uuid,uuid,text,uuid)','execute'),false)
    and coalesce(has_function_privilege('authenticated','public.admin_cancel_reported_order(uuid,uuid,text,uuid)','execute'),false)
    and not coalesce(has_function_privilege('anon','public.admin_confirm_reported_order_payment(uuid,uuid,uuid)','execute'),false)
    then 'PASS' else 'BLOCKER' end,'only authenticated admins can reach review RPCs; functions re-check is_hanjiu_admin'
  union all
  select 'direct_writes_closed',case when
    not coalesce(has_table_privilege('anon','public.order_payment_reports','INSERT'),false)
    and not coalesce(has_table_privilege('authenticated','public.order_payment_reports','INSERT'),false)
    and not coalesce(has_table_privilege('anon','public.notification_outbox','UPDATE'),false)
    and not coalesce(has_table_privilege('authenticated','public.notification_outbox','UPDATE'),false)
    and not coalesce(has_table_privilege('authenticated','public.order_customer_access_tokens','SELECT'),false)
    then 'PASS' else 'BLOCKER' end,'reports, token hashes, audit, and outbox are not browser-writable'
  union all
  select 'rls_enabled',case when not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ('order_customer_access_tokens','order_payment_reports',
      'order_customer_contact_revisions','order_lifecycle_events','notification_outbox','phase2_order_action_tokens')
      and not c.relrowsecurity) then 'PASS' else 'BLOCKER' end,'RLS is enabled on every F006-5 table'
  union all
  select 'no_raw_tokens',case when not exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='order_customer_access_tokens' and column_name in ('token','raw_token','access_token'))
    then 'PASS' else 'BLOCKER' end,'only a validated SHA-256 hex hash column exists'
  union all
  select 'historical_defaults',case when not exists(select 1 from public.orders where
    payment_reporting_required or payment_slot_active or payment_report_status is not null or payment_reported_at is not null
    or current_payment_report_id is not null or checkout_phone_normalized is not null
    or customer_email_revision<>0 or customer_email_changed_at is not null)
    then 'PASS' else 'BLOCKER' end,'migration must not enroll or rewrite historical orders'
  union all
  select 'no_new_business_facts',case when
    not exists(select 1 from public.order_customer_access_tokens)
    and not exists(select 1 from public.order_payment_reports)
    and not exists(select 1 from public.order_customer_contact_revisions)
    and not exists(select 1 from public.order_lifecycle_events)
    and not exists(select 1 from public.notification_outbox)
    and not exists(select 1 from public.phase2_order_action_tokens)
    then 'PASS' else 'BLOCKER' end,'migration itself creates no customer, payment, audit, notification, or capability rows'
)
select check_name,result,detail from (
  select check_name,result,detail,1 sort_key from checks
  union all select 'SUMMARY',case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER') then 'resolve every blocker before PR-C2 application rollout' else 'F006-5 schema and privileges verified' end,2
) output order by sort_key,check_name;

-- Paste exact preflight values. NULL is UNVERIFIED, never PASS.
with baseline(orders_count,order_items_count,inventory_movements_count,order_payments_count,
  order_payment_reversals_count,weighted_stock_count,phase2_audit_count) as
  (values(null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint)),
actual as (select
  (select count(*) from public.orders),(select count(*) from public.order_items),
  (select count(*) from public.inventory_movements),(select count(*) from public.order_payments),
  (select count(*) from public.order_payment_reversals),(select count(*) from public.phase2_weighted_stock),
  (select count(*) from public.phase2_audit_events))
select case when baseline.orders_count is null or baseline.order_items_count is null
    or baseline.inventory_movements_count is null or baseline.order_payments_count is null
    or baseline.order_payment_reversals_count is null or baseline.weighted_stock_count is null
    or baseline.phase2_audit_count is null then 'UNVERIFIED'
  when baseline=actual then 'PASS' else 'BLOCKER' end baseline_result,baseline,actual from baseline,actual;

-- Paste exact preflight digests. F006-5 adds columns/tables but must not rewrite historical business fields.
with expected(orders_md5,items_md5,stocks_md5) as (values(null::text,null::text,null::text)), actual as (select
  (select md5(coalesce(string_agg(o.id::text||':'||md5(jsonb_build_array(
    o.customer_id,o.customer_name,o.phone,o.email,o.fulfillment,o.note,o.status,o.payment_status,
    o.subtotal,o.shipping_fee,o.discount_amount,o.total_amount,o.checkout_idempotency_key,
    o.checkout_request_fingerprint,o.weighted_hold_expires_at,o.weighted_hold_released_at,o.created_at)::text),'' order by o.id),'')) from public.orders o),
  (select md5(coalesce(string_agg(i.id::text||':'||md5(jsonb_build_array(
    i.order_id,i.product_id,i.product_name,i.variant_id,i.variant_name,i.price,i.quantity,i.supply_type,
    i.processing_preset_id,i.processing_preset_name,i.processing_option_ids,i.processing_option_names,i.processing_note,
    i.weighted_stock_id,i.weighted_stock_code,i.weighted_raw_weight_g,i.weighted_t0_base_price,
    i.weighted_freshness_day,i.weighted_freshness_multiplier,i.weighted_freshness_version)::text),'' order by i.id),'')) from public.order_items i),
  (select md5(coalesce(string_agg(s.id::text||':'||md5(jsonb_build_array(
    s.product_id,s.stock_code,s.fish_date,s.raw_weight_g,s.status,s.order_id,s.order_item_id,
    s.pricing_tier_id,s.price_per_jin_snapshot,s.system_base_price,s.manual_base_price,
    s.manual_price_confirmed,s.t0_base_price,s.version,s.batch_id,s.batch_line_no,s.created_at,s.updated_at)::text),'' order by s.id),'')) from public.phase2_weighted_stock s)
)
select case when expected.orders_md5 is null or expected.items_md5 is null or expected.stocks_md5 is null then 'UNVERIFIED'
  when expected=actual then 'PASS' else 'BLOCKER' end business_digest_result,expected,actual from expected,actual;

-- Paste preflight MD5 values only for functions F006-5 promises not to replace.
with expected(signature,expected_md5) as (values
 ('create_checkout_order(text,text,text,text,jsonb,text,uuid)',null::text),
 ('admin_reverse_order_payment(uuid,text)',null::text),('admin_cancel_order(uuid)',null::text),
 ('admin_update_order_totals(uuid,integer,integer)',null::text),('log_inventory_movement()',null::text),
 ('phase2_transition_weighted_stock(uuid,text,text,uuid,uuid,uuid,uuid,text,text,uuid)',null::text),
 ('phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)',null::text)
)
select signature,case when expected_md5 is null then 'UNVERIFIED'
  when to_regprocedure('public.'||signature) is null then 'BLOCKER'
  when md5(pg_get_functiondef(to_regprocedure('public.'||signature)))=expected_md5 then 'PASS' else 'BLOCKER' end result,
  expected_md5,case when to_regprocedure('public.'||signature) is null then null
    else md5(pg_get_functiondef(to_regprocedure('public.'||signature))) end actual_md5
from expected order by signature;

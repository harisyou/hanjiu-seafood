-- F006-4a Production Maintenance Foundation post-verification. 100% READ ONLY.
with checks(check_name,result,detail) as (
  select 'foundation_objects',case when
    to_regclass('maintenance_private.maintenance_state') is not null
    and to_regclass('maintenance_private.maintenance_events') is not null
    and to_regclass('maintenance_private.protected_relations') is not null
    and to_regprocedure('maintenance_private.enforce_api_request()') is not null
    and to_regprocedure('maintenance_private.enable(uuid,bigint,text,integer,text,boolean,boolean,boolean)') is not null
    and to_regprocedure('maintenance_private.disable(uuid,bigint,text)') is not null
    then 'PASS' else 'BLOCKER' end,'state, audit, gate, enable and disable exist'
  union all
  select 'default_inactive',case when (select count(*)=1 and not bool_or(active) and max(version)=0
    from maintenance_private.maintenance_state) then 'PASS' else 'BLOCKER' end,
    'installation must never enable maintenance automatically'
  union all
  select 'no_install_audit',case when not exists(select 1 from maintenance_private.maintenance_events)
    then 'PASS' else 'BLOCKER' end,'installation is not an enable/disable event'
  union all
  select 'postgrest_hook',case when maintenance_private.configured_pre_request()='maintenance_private.enforce_api_request'
    then 'PASS' else 'BLOCKER' end,'authenticator is configured for the permanent composite gate'
  union all
  select 'protection_coverage',case when not exists(select 1 from maintenance_private.protection_gaps())
    then 'PASS' else 'BLOCKER' end,'every current public table has enabled write and truncate guards'
  union all
  select 'storage_trigger',case when exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass
    and tgname='hanjiu_maintenance_storage_guard' and not tgisinternal and tgenabled<>'D')
    then 'PASS' else 'BLOCKER' end,'product-images writes including service-role metadata writes hit the DB trigger'
  union all
  select 'storage_policy',case when exists(select 1 from pg_policies where schemaname='storage'
    and tablename='objects' and policyname='admin upload product images' and cmd='INSERT'
    and with_check like '%maintenance_private.is_active%')
    then 'PASS' else 'BLOCKER' end,'authenticated upload RLS also checks maintenance state'
  union all
  select 'browser_owner_controls_closed',case when
    not coalesce(has_function_privilege('anon','maintenance_private.enable(uuid,bigint,text,integer,text,boolean,boolean,boolean)','execute'),false)
    and not coalesce(has_function_privilege('authenticated','maintenance_private.enable(uuid,bigint,text,integer,text,boolean,boolean,boolean)','execute'),false)
    and not coalesce(has_function_privilege('service_role','maintenance_private.enable(uuid,bigint,text,integer,text,boolean,boolean,boolean)','execute'),false)
    and not coalesce(has_table_privilege('service_role','maintenance_private.maintenance_state','UPDATE'),false)
    then 'PASS' else 'BLOCKER' end,'browser and service roles cannot toggle state or use owner controls'
)
select check_name,result,detail from (
  select check_name,result,detail,1 sort_key from checks
  union all select 'SUMMARY',case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER') then 'keep application maintenance on and resolve blockers' else 'F006-4a foundation installed inactive' end,2
) output order by sort_key,check_name;

select * from maintenance_private.protection_gaps() order by schema_name,relation_name,reason;

select session_user,current_user,maintenance_private.database_owner_name() database_owner,
  maintenance_private.owner_bypass_verified() owner_bypass_verified,
  maintenance_private.configured_pre_request() configured_pre_request;

-- Paste the seven exact preflight counts. NULL is UNVERIFIED, never PASS.
with expected(orders_count,order_items_count,product_variants_count,inventory_movements_count,
  order_payments_count,payment_reversals_count,weighted_stock_count) as
  (values(null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint,null::bigint)),
actual as (select
  (select count(*) from public.orders),(select count(*) from public.order_items),
  (select count(*) from public.product_variants),(select count(*) from public.inventory_movements),
  (select count(*) from public.order_payments),(select count(*) from public.order_payment_reversals),
  (select count(*) from public.phase2_weighted_stock))
select case when expected.orders_count is null then 'UNVERIFIED'
  when row(expected.*) is not distinct from row(actual.*) then 'PASS' else 'BLOCKER' end result,
  expected.*,actual.* from expected cross join actual;

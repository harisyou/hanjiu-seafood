-- F006-4a Production Maintenance Foundation preflight. 100% READ ONLY.
-- Run from the exact SQL Editor/direct connection that will execute F006-4a.
with checks(check_name,result,detail) as (
  select 'f006_4_present',case when
    to_regprocedure('public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)') is not null
    then 'PASS' else 'BLOCKER' end,'F006-4 foundation exists'
  union all
  select 'f006_4a_absent',case when to_regclass('maintenance_private.maintenance_state') is null
    then 'PASS' else 'BLOCKER' end,'maintenance foundation is forward-only and must not be rerun'
  union all
  select 'f006_5_absent',case when
    to_regprocedure('public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text)') is null
    then 'PASS' else 'BLOCKER' end,'F006-4a must be installed before F006-5'
  union all
  select 'required_roles',case when not exists(
    select 1 from (values('authenticator'),('anon'),('authenticated'),('service_role')) expected(role_name)
    where not exists(select 1 from pg_roles r where r.rolname=expected.role_name))
    then 'PASS' else 'BLOCKER' end,'Supabase API roles exist'
  union all
  select 'owner_direct_identity',case when session_user=(select pg_get_userbyid(datdba) from pg_database where datname=current_database())
    and nullif(current_setting('request.method',true),'') is null
    and nullif(current_setting('request.jwt.claims',true),'') is null
    then 'PASS' else 'BLOCKER' end,
    concat('session_user=',session_user,', current_user=',current_user,', database_owner=',
      (select pg_get_userbyid(datdba) from pg_database where datname=current_database()))
  union all
  select 'storage_objects',case when to_regclass('storage.objects') is not null then 'PASS' else 'BLOCKER' end,
    'Storage metadata table exists; migration changes policy/trigger only, never object rows'
  union all
  select 'storage_upload_policy',case when exists(select 1 from pg_policies where schemaname='storage'
    and tablename='objects' and policyname='admin upload product images' and cmd='INSERT')
    then 'PASS' else 'BLOCKER' end,'reviewed product-images upload policy exists'
  union all
  select 'single_effective_pre_request',case when (
    select count(*) from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
    where r.rolname='authenticator'
      and s.setdatabase in (0,(select oid from pg_database where datname=current_database()))
      and exists(select 1 from unnest(coalesce(s.setconfig,'{}'::text[])) x where x like 'pgrst.db_pre_request=%'))<=1
    then 'PASS' else 'BLOCKER' end,'database-specific and global hook settings must not conflict'
  union all
  select 'existing_pre_request_review',case when not exists(
    select 1 from pg_db_role_setting s join pg_roles r on r.oid=s.setrole,
      lateral unnest(coalesce(s.setconfig,'{}'::text[])) x
    where r.rolname='authenticator'
      and s.setdatabase in (0,(select oid from pg_database where datname=current_database()))
      and x like 'pgrst.db_pre_request=%'
      and (nullif(split_part(x,'=',2),'') is null
        or to_regprocedure(split_part(x,'=',2)||'()') is null
        or not exists(select 1 from pg_proc p where p.oid=to_regprocedure(split_part(x,'=',2)||'()')
          and p.pronargs=0 and p.prorettype='void'::regtype)))
    then 'PASS' else 'BLOCKER' end,'an existing valid no-argument void hook will be chained, never overwritten silently'
  union all
  select 'no_prepared_transactions',case when not exists(select 1 from pg_prepared_xacts where database=current_database())
    then 'PASS' else 'BLOCKER' end,'prepared transactions would make bootstrap drain unverifiable'
)
select check_name,result,detail from (
  select check_name,result,detail,1 sort_key from checks
  union all select 'SUMMARY',case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER') then 'resolve all blockers before F006-4a' else 'bootstrap prerequisites satisfied' end,2
) output order by sort_key,check_name;

-- Review and save the exact existing PostgREST hook. NULL means none.
select r.rolname,s.setdatabase,x setting
from pg_db_role_setting s join pg_roles r on r.oid=s.setrole,
  lateral unnest(coalesce(s.setconfig,'{}'::text[])) x
where r.rolname='authenticator' and x like 'pgrst.db_pre_request=%';

-- Save Storage policy fingerprints.
select policyname,cmd,roles,md5(coalesce(qual,'')||'|'||coalesce(with_check,'')) definition_md5,
  qual,with_check
from pg_policies where schemaname='storage' and tablename='objects' order by policyname;

-- Save current public application tables; every row will receive write + truncate guards.
select c.oid::regclass relation_name,c.relkind,c.relispartition
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind in ('r','p') order by c.oid::regclass::text;

-- Bootstrap transaction blockers. Re-run immediately before migration.
select pid,usename,application_name,state,xact_start,query_start,wait_event_type,wait_event,left(query,200) query
from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
  and (xact_start is not null or state like 'idle in transaction%')
order by coalesce(xact_start,query_start),pid;

-- Baselines: F006-4a must not create or rewrite business rows.
select
  (select count(*) from public.orders) orders_count,
  (select count(*) from public.order_items) order_items_count,
  (select count(*) from public.product_variants) product_variants_count,
  (select count(*) from public.inventory_movements) inventory_movements_count,
  (select count(*) from public.order_payments) order_payments_count,
  (select count(*) from public.order_payment_reversals) payment_reversals_count,
  (select count(*) from public.phase2_weighted_stock) weighted_stock_count;

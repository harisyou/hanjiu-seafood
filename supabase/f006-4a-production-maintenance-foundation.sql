-- F006-4a / reusable Production maintenance foundation.
-- Forward-only after owner-applied F006-4 and before not-yet-applied F006-5.
-- The foundation is installed inactive. It never enables or disables itself.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

do $$
begin
  if to_regprocedure('public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid)') is null
    then raise exception 'f006_4_required'; end if;
  if to_regprocedure('public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text)') is not null
    then raise exception 'f006_5_must_not_precede_maintenance_foundation'; end if;
  if to_regclass('maintenance_private.maintenance_state') is not null
    then raise exception 'f006_4a_already_applied'; end if;
  if not exists(select 1 from pg_roles where rolname='authenticator')
    or not exists(select 1 from pg_roles where rolname='anon')
    or not exists(select 1 from pg_roles where rolname='authenticated')
    or not exists(select 1 from pg_roles where rolname='service_role')
    then raise exception 'required_supabase_roles_missing'; end if;
end $$;

-- Bootstrap safety: acquire every current application-table lock before changing
-- the API hook or triggers. A busy table fails the whole migration quickly.
do $$
declare v record;
begin
  for v in
    select c.oid::regclass relation_name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
    order by c.oid::regclass::text
  loop execute format('lock table %s in access exclusive mode',v.relation_name); end loop;
  if to_regclass('storage.objects') is not null then
    lock table storage.objects in access exclusive mode;
  else raise exception 'storage_objects_required'; end if;
end $$;

create schema maintenance_private;
revoke all on schema maintenance_private from public;

create table maintenance_private.maintenance_state(
  singleton boolean primary key default true check(singleton),
  active boolean not null default false,
  version bigint not null default 0 check(version>=0),
  enabled_operation_id uuid,
  enabled_at timestamptz,
  enabled_by text,
  reason text,
  retry_after_seconds integer not null default 1800 check(retry_after_seconds between 60 and 86400),
  application_revision text,
  application_maintenance_confirmed boolean not null default false,
  external_writers_confirmed_stopped boolean not null default false,
  storage_privileged_writers_confirmed_stopped boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  check ((active and enabled_operation_id is not null and enabled_at is not null and enabled_by is not null
    and reason is not null and btrim(reason)<>'' and application_revision is not null
    and application_maintenance_confirmed and external_writers_confirmed_stopped
    and storage_privileged_writers_confirmed_stopped)
    or (not active and enabled_operation_id is null and enabled_at is null and enabled_by is null
      and reason is null and application_revision is null and not application_maintenance_confirmed
      and not external_writers_confirmed_stopped and not storage_privileged_writers_confirmed_stopped))
);
insert into maintenance_private.maintenance_state(singleton) values(true);

create table maintenance_private.maintenance_events(
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique,
  action text not null check(action in ('enabled','disabled','recovered_fail_closed')),
  old_version bigint,
  new_version bigint not null,
  actor_session_user text not null,
  actor_current_user text not null,
  reason text not null check(btrim(reason)<>''),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp()
);

create table maintenance_private.protected_relations(
  relation_oid oid primary key,
  schema_name name not null,
  relation_name name not null,
  registered_at timestamptz not null default clock_timestamp(),
  unique(schema_name,relation_name)
);

create table maintenance_private.configuration(
  singleton boolean primary key default true check(singleton),
  previous_pre_request text,
  installed_at timestamptz not null default clock_timestamp()
);

do $$
declare v_settings text[]; v_hook text; v_proc regprocedure; v_setting_rows integer;
begin
  select count(*) into v_setting_rows
  from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
  where r.rolname='authenticator' and s.setdatabase in (0,(select oid from pg_database where datname=current_database()))
    and exists(select 1 from unnest(coalesce(s.setconfig,'{}'::text[])) x where x like 'pgrst.db_pre_request=%');
  if v_setting_rows>1 then raise exception 'multiple_pre_request_settings_require_manual_review'; end if;
  select s.setconfig into v_settings from pg_db_role_setting s join pg_roles r on r.oid=s.setrole
    where r.rolname='authenticator'
      and s.setdatabase in (0,(select oid from pg_database where datname=current_database()))
      and exists(select 1 from unnest(coalesce(s.setconfig,'{}'::text[])) x where x like 'pgrst.db_pre_request=%')
    order by (s.setdatabase<>0) desc limit 1;
  select split_part(x,'=',2) into v_hook from unnest(coalesce(v_settings,'{}'::text[])) x
    where x like 'pgrst.db_pre_request=%' limit 1;
  v_hook:=nullif(btrim(coalesce(v_hook,'')),'');
  if v_hook is not null then
    v_proc:=to_regprocedure(v_hook||'()');
    if v_proc is null or not exists(select 1 from pg_proc where oid=v_proc and pronargs=0 and prorettype='void'::regtype)
      then raise exception 'existing_pre_request_hook_requires_manual_review:%',v_hook; end if;
  end if;
  insert into maintenance_private.configuration(singleton,previous_pre_request) values(true,v_hook);
end $$;

create or replace function maintenance_private.database_owner_name()
returns name language sql stable security definer set search_path=pg_catalog as $$
  select pg_get_userbyid(datdba)::name from pg_database where datname=current_database()
$$;

create or replace function maintenance_private.owner_bypass_verified()
returns boolean language sql stable security definer set search_path=pg_catalog as $$
  select session_user=maintenance_private.database_owner_name()
    and nullif(current_setting('request.method',true),'') is null
    and nullif(current_setting('request.jwt.claims',true),'') is null
$$;

create or replace function maintenance_private.is_active()
returns boolean language plpgsql stable security definer set search_path=maintenance_private,pg_catalog as $$
declare v_active boolean; v_count integer;
begin
  select count(*),bool_or(active) into v_count,v_active from maintenance_private.maintenance_state;
  if v_count<>1 or v_active is null then raise exception 'maintenance_state_invalid'; end if;
  return v_active;
end $$;

create or replace function maintenance_private.require_owner_bypass()
returns void language plpgsql stable security definer set search_path=maintenance_private,pg_catalog as $$
begin
  if not maintenance_private.owner_bypass_verified() then raise exception 'database_owner_direct_session_required'; end if;
end $$;

create or replace function maintenance_private.write_guard()
returns trigger language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
begin
  if maintenance_private.is_active() and not maintenance_private.owner_bypass_verified()
    then raise exception 'maintenance_mode_active' using errcode='55000'; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;

create or replace function maintenance_private.audit_immutable_guard()
returns trigger language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
begin raise exception 'maintenance_audit_append_only'; end $$;
create trigger maintenance_events_immutable before update or delete on maintenance_private.maintenance_events
for each statement execute function maintenance_private.audit_immutable_guard();
create trigger maintenance_events_no_truncate before truncate on maintenance_private.maintenance_events
for each statement execute function maintenance_private.audit_immutable_guard();

create or replace function maintenance_private.storage_object_guard()
returns trigger language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
declare v_old_bucket text:=case when tg_op in ('UPDATE','DELETE') then old.bucket_id else null end;
        v_new_bucket text:=case when tg_op in ('INSERT','UPDATE') then new.bucket_id else null end;
begin
  if (v_old_bucket='product-images' or v_new_bucket='product-images')
     and maintenance_private.is_active() and not maintenance_private.owner_bypass_verified()
    then raise exception 'maintenance_mode_active' using errcode='55000'; end if;
  return case when tg_op='DELETE' then old else new end;
end $$;

create trigger hanjiu_maintenance_storage_guard before insert or update or delete on storage.objects
for each row execute function maintenance_private.storage_object_guard();

create or replace function maintenance_private.reconcile_protected_relations()
returns integer language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
declare v record; v_count integer:=0;
begin
  perform maintenance_private.require_owner_bypass();
  for v in
    select c.oid,n.nspname schema_name,c.relname relation_name
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
    order by n.nspname,c.relname
  loop
    insert into maintenance_private.protected_relations(relation_oid,schema_name,relation_name)
      values(v.oid,v.schema_name,v.relation_name)
      on conflict(relation_oid) do update set schema_name=excluded.schema_name,relation_name=excluded.relation_name;
    if not exists(select 1 from pg_trigger where tgrelid=v.oid and tgname='hanjiu_maintenance_write_guard' and not tgisinternal) then
      execute format('create trigger hanjiu_maintenance_write_guard before insert or update or delete on %I.%I for each statement execute function maintenance_private.write_guard()',v.schema_name,v.relation_name);
    end if;
    if not exists(select 1 from pg_trigger where tgrelid=v.oid and tgname='hanjiu_maintenance_truncate_guard' and not tgisinternal) then
      execute format('create trigger hanjiu_maintenance_truncate_guard before truncate on %I.%I for each statement execute function maintenance_private.write_guard()',v.schema_name,v.relation_name);
    end if;
    v_count:=v_count+1;
  end loop;
  delete from maintenance_private.protected_relations p where not exists(select 1 from pg_class c where c.oid=p.relation_oid);
  return v_count;
end $$;

create or replace function maintenance_private.protection_gaps()
returns table(schema_name name,relation_name name,reason text)
language sql stable security definer set search_path=maintenance_private,pg_catalog as $$
  with relations as (
    select c.oid,n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
  )
  select r.nspname::name,r.relname::name,'registry_missing' from relations r
    where not exists(select 1 from maintenance_private.protected_relations p where p.relation_oid=r.oid)
  union all
  select r.nspname::name,r.relname::name,'write_trigger_missing_or_disabled' from relations r
    where not exists(select 1 from pg_trigger t where t.tgrelid=r.oid and t.tgname='hanjiu_maintenance_write_guard'
      and not t.tgisinternal and t.tgenabled<>'D')
  union all
  select r.nspname::name,r.relname::name,'truncate_trigger_missing_or_disabled' from relations r
    where not exists(select 1 from pg_trigger t where t.tgrelid=r.oid and t.tgname='hanjiu_maintenance_truncate_guard'
      and not t.tgisinternal and t.tgenabled<>'D')
$$;

create or replace function maintenance_private.configured_pre_request()
returns text language sql stable security definer set search_path=pg_catalog as $$
  select split_part(x,'=',2) from pg_db_role_setting s join pg_roles r on r.oid=s.setrole,
    lateral unnest(coalesce(s.setconfig,'{}'::text[])) x
  where r.rolname='authenticator'
    and s.setdatabase in (0,(select oid from pg_database where datname=current_database()))
    and x like 'pgrst.db_pre_request=%'
  order by (s.setdatabase<>0) desc limit 1
$$;

create or replace function maintenance_private.previous_pre_request_name()
returns text language sql stable security definer set search_path=maintenance_private,pg_catalog as $$
  select previous_pre_request from maintenance_private.configuration where singleton
$$;

create or replace function maintenance_private.enforce_api_request()
returns void language plpgsql security invoker set search_path=maintenance_private,pg_catalog as $$
declare v_previous text; v_method text:=nullif(current_setting('request.method',true),'');
        v_claims text:=nullif(current_setting('request.jwt.claims',true),''); v_hook regprocedure;
begin
  -- Every Data API request participates in the maintenance synchronization lock.
  perform pg_advisory_xact_lock_shared(hashtextextended('hanjiu-production-maintenance',0));
  if v_method is null or v_claims is null then raise exception 'postgrest_request_context_required'; end if;
  if maintenance_private.is_active() then
    -- Fail closed for every method, including GET/HEAD RPCs and unknown methods.
    raise exception 'maintenance_mode_active' using errcode='55000';
  end if;
  v_previous:=maintenance_private.previous_pre_request_name();
  if v_previous is not null then
    v_hook:=to_regprocedure(v_previous||'()');
    if v_hook is null then raise exception 'previous_pre_request_hook_missing'; end if;
    execute 'select '||v_hook::text;
  end if;
end $$;

create or replace function maintenance_private.lock_protected_relations()
returns void language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
declare v record;
begin
  for v in select relation_oid::regclass relation_name from maintenance_private.protected_relations order by relation_oid::regclass::text
    loop execute format('lock table %s in access exclusive mode',v.relation_name); end loop;
  lock table storage.objects in access exclusive mode;
end $$;

create or replace function maintenance_private.enable(
  p_operation_id uuid,p_expected_version bigint,p_reason text,p_retry_after_seconds integer default 1800,
  p_application_revision text default null,p_application_maintenance_confirmed boolean default false,
  p_external_writers_stopped boolean default false,p_storage_privileged_writers_stopped boolean default false)
returns maintenance_private.maintenance_state language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
declare v_state maintenance_private.maintenance_state; v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
  perform maintenance_private.require_owner_bypass();
  if p_operation_id is null or v_reason is null or nullif(btrim(coalesce(p_application_revision,'')),'') is null
    then raise exception 'maintenance_enable_details_required'; end if;
  if not coalesce(p_application_maintenance_confirmed,false) or not coalesce(p_external_writers_stopped,false)
    or not coalesce(p_storage_privileged_writers_stopped,false) then raise exception 'maintenance_attestations_required'; end if;
  if p_retry_after_seconds not between 60 and 86400 then raise exception 'invalid_retry_after'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hanjiu-production-maintenance',0));
  select * into v_state from maintenance_private.maintenance_state where singleton for update;
  if exists(select 1 from maintenance_private.maintenance_events where operation_id=p_operation_id and action='enabled') then return v_state; end if;
  if v_state.active then raise exception 'maintenance_already_active'; end if;
  if v_state.version is distinct from p_expected_version then raise exception 'maintenance_version_conflict'; end if;
  if exists(select 1 from maintenance_private.protection_gaps()) then raise exception 'maintenance_protection_coverage_incomplete'; end if;
  if maintenance_private.configured_pre_request() is distinct from 'maintenance_private.enforce_api_request'
    then raise exception 'maintenance_postgrest_hook_not_configured'; end if;
  if not exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass
    and tgname='hanjiu_maintenance_storage_guard' and tgenabled<>'D') then raise exception 'maintenance_storage_guard_missing'; end if;
  perform maintenance_private.lock_protected_relations();
  update maintenance_private.maintenance_state set active=true,version=version+1,
    enabled_operation_id=p_operation_id,enabled_at=clock_timestamp(),enabled_by=session_user,
    reason=v_reason,retry_after_seconds=p_retry_after_seconds,application_revision=btrim(p_application_revision),
    application_maintenance_confirmed=true,external_writers_confirmed_stopped=true,
    storage_privileged_writers_confirmed_stopped=true,updated_at=clock_timestamp()
    where singleton returning * into v_state;
  insert into maintenance_private.maintenance_events(operation_id,action,old_version,new_version,
    actor_session_user,actor_current_user,reason,details)
  values(p_operation_id,'enabled',p_expected_version,v_state.version,session_user,current_user,v_reason,
    jsonb_build_object('retry_after_seconds',p_retry_after_seconds,'application_revision',btrim(p_application_revision)));
  return v_state;
end $$;

create or replace function maintenance_private.drain_blockers()
returns table(blocker_type text,identifier text,detail text)
language sql stable security definer set search_path=maintenance_private,pg_catalog as $$
  with state as (select * from maintenance_private.maintenance_state where singleton)
  select 'transaction',a.pid::text,concat(a.usename,':',a.state,':',a.xact_start,':',left(coalesce(a.query,''),120))
    from pg_stat_activity a,state s where s.active and a.datname=current_database() and a.pid<>pg_backend_pid()
      and a.xact_start is not null and a.xact_start<=s.enabled_at
  union all
  select 'idle_in_transaction',a.pid::text,concat(a.usename,':',a.xact_start)
    from pg_stat_activity a,state s where s.active and a.datname=current_database() and a.pid<>pg_backend_pid()
      and a.state like 'idle in transaction%' and a.xact_start is not null
  union all
  select 'prepared_transaction',p.gid,concat(p.owner,':',p.prepared)
    from pg_prepared_xacts p where p.database=current_database()
  union all
  select 'protected_relation_lock',l.pid::text,concat(l.relation::regclass::text,':',l.mode,':granted=',l.granted)
    from pg_locks l join maintenance_private.protected_relations p on p.relation_oid=l.relation
    where l.pid<>pg_backend_pid()
$$;

create or replace function maintenance_private.disable(
  p_operation_id uuid,p_expected_version bigint,p_reason text)
returns maintenance_private.maintenance_state language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
declare v_state maintenance_private.maintenance_state; v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
  perform maintenance_private.require_owner_bypass();
  if p_operation_id is null or v_reason is null then raise exception 'maintenance_disable_details_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hanjiu-production-maintenance',0));
  select * into v_state from maintenance_private.maintenance_state where singleton for update;
  if exists(select 1 from maintenance_private.maintenance_events where operation_id=p_operation_id and action='disabled') then return v_state; end if;
  if not v_state.active then raise exception 'maintenance_not_active'; end if;
  if v_state.version is distinct from p_expected_version then raise exception 'maintenance_version_conflict'; end if;
  if exists(select 1 from maintenance_private.protection_gaps()) then raise exception 'maintenance_protection_coverage_incomplete'; end if;
  if maintenance_private.configured_pre_request() is distinct from 'maintenance_private.enforce_api_request'
    then raise exception 'maintenance_postgrest_hook_not_configured'; end if;
  if exists(select 1 from maintenance_private.drain_blockers()) then raise exception 'maintenance_transaction_drain_incomplete'; end if;
  perform maintenance_private.lock_protected_relations();
  update maintenance_private.maintenance_state set active=false,version=version+1,
    enabled_operation_id=null,enabled_at=null,enabled_by=null,reason=null,application_revision=null,
    application_maintenance_confirmed=false,external_writers_confirmed_stopped=false,
    storage_privileged_writers_confirmed_stopped=false,updated_at=clock_timestamp()
    where singleton returning * into v_state;
  insert into maintenance_private.maintenance_events(operation_id,action,old_version,new_version,
    actor_session_user,actor_current_user,reason)
  values(p_operation_id,'disabled',p_expected_version,v_state.version,session_user,current_user,v_reason);
  return v_state;
end $$;

create or replace function maintenance_private.recover_fail_closed(
  p_operation_id uuid,p_expected_version bigint,p_reason text)
returns maintenance_private.maintenance_state language plpgsql security definer set search_path=maintenance_private,pg_catalog as $$
declare v_state maintenance_private.maintenance_state; v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
  perform maintenance_private.require_owner_bypass();
  if p_operation_id is null or v_reason is null then raise exception 'maintenance_recovery_details_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hanjiu-production-maintenance',0));
  select * into v_state from maintenance_private.maintenance_state where singleton for update;
  if exists(select 1 from maintenance_private.maintenance_events where operation_id=p_operation_id and action='recovered_fail_closed') then return v_state; end if;
  if v_state.version is distinct from p_expected_version then raise exception 'maintenance_version_conflict'; end if;
  if not v_state.active then raise exception 'recovery_must_not_enable_without_full_attestation'; end if;
  update maintenance_private.maintenance_state set version=version+1,updated_at=clock_timestamp()
    where singleton returning * into v_state;
  insert into maintenance_private.maintenance_events(operation_id,action,old_version,new_version,
    actor_session_user,actor_current_user,reason)
  values(p_operation_id,'recovered_fail_closed',p_expected_version,v_state.version,session_user,current_user,v_reason);
  return v_state;
end $$;

-- Register and guard every current application table while the bootstrap locks
-- are still held. Later migrations must reconcile before maintenance disable.
select maintenance_private.reconcile_protected_relations();

-- Storage RLS remains the normal authenticated boundary. The trigger above also
-- blocks service-role/signed/upsert metadata finalization for product-images.
drop policy if exists "admin upload product images" on storage.objects;
create policy "admin upload product images" on storage.objects for insert to authenticated
with check (bucket_id='product-images' and (select public.is_hanjiu_admin())
  and not maintenance_private.is_active());

revoke all on all tables in schema maintenance_private from public,anon,authenticated,service_role;
revoke all on all sequences in schema maintenance_private from public,anon,authenticated,service_role;
revoke all on all functions in schema maintenance_private from public,anon,authenticated,service_role;
grant usage on schema maintenance_private to anon,authenticated,service_role;
grant execute on function maintenance_private.enforce_api_request(),maintenance_private.is_active()
  to anon,authenticated,service_role;
grant execute on function maintenance_private.previous_pre_request_name()
  to anon,authenticated,service_role;

-- Database-scoped configuration avoids changing any other database that shares
-- the authenticator role. It also overrides (and chains) a reviewed global hook.
do $$begin
  execute format('alter role authenticator in database %I set pgrst.db_pre_request=%L',
    current_database(),'maintenance_private.enforce_api_request');
end$$;
notify pgrst,'reload config';

commit;

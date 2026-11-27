-- 100% READ ONLY. Maintenance is ready only when every result is PASS and gaps/blockers return zero rows.
with checks(check_name,result,detail) as (
  select 'state_active',case when maintenance_private.is_active() then 'PASS' else 'BLOCKER' end,'database maintenance gate is active'
  union all select 'state_singleton',case when (select count(*)=1 from maintenance_private.maintenance_state)
    then 'PASS' else 'BLOCKER' end,'exactly one state row exists'
  union all select 'postgrest_hook',case when maintenance_private.configured_pre_request()='maintenance_private.enforce_api_request'
    then 'PASS' else 'BLOCKER' end,'configured hook matches reviewed gate'
  union all select 'postgrest_runtime_probe',case when (select postgrest_runtime_confirmed
    from maintenance_private.maintenance_state where singleton) then 'PASS' else 'BLOCKER' end,
    'owner confirmed real GET/POST/PATCH/DELETE and RPC HTTP maintenance rejections after reload'
  union all select 'coverage',case when not exists(select 1 from maintenance_private.protection_gaps())
    then 'PASS' else 'BLOCKER' end,'all current application tables are guarded'
  union all select 'storage_guard',case when exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass
    and tgname='hanjiu_maintenance_storage_guard' and tgenabled<>'D') then 'PASS' else 'BLOCKER' end,
    'Storage DB trigger is enabled'
  union all select 'drained',case when not exists(select 1 from maintenance_private.drain_blockers())
    then 'PASS' else 'BLOCKER' end,'no old transaction, prepared transaction, or protected relation lock remains'
  union all select 'attestations',case when (select application_maintenance_confirmed
    and external_writers_confirmed_stopped and storage_privileged_writers_confirmed_stopped
    from maintenance_private.maintenance_state where singleton) then 'PASS' else 'BLOCKER' end,
    'Owner attestations were recorded during enable'
)
select * from checks order by check_name;
select * from maintenance_private.protection_gaps() order by schema_name,relation_name,reason;
select * from maintenance_private.drain_blockers() order by blocker_type,identifier;
select * from maintenance_private.maintenance_state;

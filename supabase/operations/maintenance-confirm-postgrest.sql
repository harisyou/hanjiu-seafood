-- OWNER WRITE OPERATION. Run only after real HTTP probes return maintenance_mode_active.
-- Catalog configuration alone is never sufficient evidence of PostgREST reload.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
select * from maintenance_private.confirm_postgrest_runtime_gate(
  nullif('REPLACE_CONFIRM_OPERATION_UUID','REPLACE_CONFIRM_OPERATION_UUID')::uuid,
  nullif('REPLACE_EXPECTED_VERSION','REPLACE_EXPECTED_VERSION')::bigint,
  nullif('REPLACE_HTTP_PROBE_EVIDENCE','REPLACE_HTTP_PROBE_EVIDENCE')
);
commit;

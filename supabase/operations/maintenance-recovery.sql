-- OWNER BREAK-GLASS WRITE OPERATION. This can only reassert an already-active fail-closed state.
-- It intentionally cannot turn maintenance off or recreate old ACL/policies.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
select * from maintenance_private.recover_fail_closed(
  nullif('REPLACE_RECOVERY_OPERATION_UUID','REPLACE_RECOVERY_OPERATION_UUID')::uuid,
  nullif('REPLACE_EXPECTED_VERSION','REPLACE_EXPECTED_VERSION')::bigint,
  nullif('REPLACE_REASON','REPLACE_REASON')
);
commit;

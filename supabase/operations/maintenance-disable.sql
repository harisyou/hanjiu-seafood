-- OWNER WRITE OPERATION. Disable refuses incomplete drain/coverage and never restores ACL snapshots.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
select maintenance_private.reconcile_protected_relations();
select * from maintenance_private.disable(
  nullif('REPLACE_DISABLE_OPERATION_UUID','REPLACE_DISABLE_OPERATION_UUID')::uuid,
  nullif('REPLACE_EXPECTED_VERSION','REPLACE_EXPECTED_VERSION')::bigint,
  nullif('REPLACE_REASON','REPLACE_REASON')
);
commit;

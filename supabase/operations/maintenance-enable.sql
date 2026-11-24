-- OWNER WRITE OPERATION. Review placeholders; never run as anon/authenticated/service_role.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
select * from maintenance_private.enable(
  nullif('REPLACE_ENABLE_OPERATION_UUID','REPLACE_ENABLE_OPERATION_UUID')::uuid,
  nullif('REPLACE_EXPECTED_VERSION','REPLACE_EXPECTED_VERSION')::bigint,
  nullif('REPLACE_REASON','REPLACE_REASON'),
  1800,
  nullif('REPLACE_VERCEL_COMMIT_SHA','REPLACE_VERCEL_COMMIT_SHA'),
  true, -- Owner attests the application maintenance deployment is live.
  true, -- Owner attests external/background writers are stopped.
  true  -- Owner attests privileged Storage writers are stopped.
);
commit;

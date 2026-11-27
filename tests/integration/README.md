# F004-1 PostgreSQL integration harness

The regular Node tests do not claim to prove PostgreSQL row locking or unique-index
wait semantics. The integration test must run only against a disposable local or
staging Supabase/PostgreSQL database that has the manifest baseline plus
`supabase/f004-1-checkout-idempotency.sql` applied.

Required environment:

```text
F004_1_TEST_DATABASE_URL=postgresql://.../hanjiu_f004_1_test
F004_1_ALLOW_DATABASE_TESTS=1
```

Run `node --test tests/integration/f004-1-postgres-harness.test.mjs`. The harness
refuses to run without both values and is intentionally skipped in ordinary local
test runs. It also requires `psql` on PATH. Never point it at Production.

Provision the test database with a disposable product/variant and set the three
`F004_1_TEST_*` fixture values described in the test file. The harness invokes two
concurrent RPC calls in separate `psql` sessions and then queries order, item,
inventory, and movement counts.

For the optional F004-3.3 case, also set `F004_3_3_ALLOW_DATABASE_TESTS=1`,
`F004_3_3_TEST_PREORDER_VARIANT_ID`, and optionally
`F004_3_3_TEST_PREORDER_QUANTITY`. The fixture must be active, preorder-enabled,
and the test quantity must be greater than its current inventory (zero inventory
is valid). The harness sends no `supply_type` and verifies PostgreSQL stores one
preorder item without changing inventory or creating a movement.

## F006-4 weighted checkout concurrency

`f006-4-postgres-harness.test.mjs` is opt-in and must target a disposable
PostgreSQL/Supabase database with F006-1 through F006-4 already applied and a
fresh sellable weighted-stock fixture. It never falls back to Production.

Set `F006_4_ENABLE_POSTGRES_TESTS=1`, `F006_4_TEST_DATABASE_URL`,
`F006_4_TEST_RACE_STOCK_ID`, `F006_4_TEST_REPLAY_STOCK_ID`, and
`F006_4_TEST_EXPIRING_ORDER_ID`. The two stock IDs must be distinct, fresh,
sellable fixtures so the cases are repeatable. The expiring order must be an
unpaid weighted hold whose database deadline has passed and must still link
exactly one reserved stock. The harness fails this prerequisite explicitly
instead of silently skipping or running against a missing order.

F006-4 uses independent `pg` clients for each contender, so every race executes
through real PostgreSQL server sessions. It does not require a globally installed
`psql` executable.
# Disposable Supabase maintenance-stack identity

`f006-4a-supabase-stack.test.mjs` is skipped unless every required value is
provided and `MAINTENANCE_CONFIRM_DISPOSABLE_SUPABASE` exactly equals
`I_CONFIRM_DISPOSABLE_SUPABASE_STACK`. It must never target Production.

Before running it, create the following marker only in the disposable database,
using values independently recorded for that stack. Remove the schema when the
test project is retired:

```sql
create schema maintenance_test_identity;
revoke all on schema maintenance_test_identity from public;
create table maintenance_test_identity.environment (
  singleton boolean primary key default true check (singleton),
  environment_id text not null,
  project_ref text not null,
  api_origin text not null,
  database_name text not null,
  database_system_identifier text not null,
  purpose text not null check (purpose = 'disposable_maintenance_integration'),
  allow_destructive boolean not null check (allow_destructive),
  expires_at timestamptz not null
);
```

Supply `MAINTENANCE_TEST_ENVIRONMENT_ID`, `MAINTENANCE_TEST_PROJECT_REF`,
`MAINTENANCE_TEST_DATABASE_SYSTEM_IDENTIFIER`, the isolated API URL/keys and the
isolated owner database URL. The harness compares the marker to live catalog
identity before any write and binds PostgREST to the same database with a random
nonce. It does not print secrets.

The direct PostgreSQL F006-4a and F006-5 harnesses likewise require an exact
confirmation phrase, the live `pg_control_system().system_identifier`, and a
database comment matching `hanjiu-disposable-maintenance-test:<environment-id>`.
They no longer trust a database name containing `test`.

## Owner-run Cloud initialization

Use the reviewed PR commit and an independently verified disposable identity
marker. Keep test credentials outside the checkout. In a fresh CMD session with
the test variables loaded, run:

```bat
node scripts\init-maintenance-disposable.mjs > "%TEMP%\maintenance-dry-run.json"
set "MAINTENANCE_INITIALIZE_CONFIRM=INITIALIZE_DISPOSABLE_DATABASE"
node scripts\init-maintenance-disposable.mjs --apply > "%TEMP%\maintenance-init.json" 2>&1
set "MAINTENANCE_INITIALIZE_CONFIRM="
```

Check each exit code before continuing. Dry-run checks target identity and
emptiness. Apply stops at F006-4a. If a stage fails, preserve the report and
inspect the last failed stage and preceding applied stages. Never rerun apply
on that database. Use a fresh disposable project or manually verify the committed
schema and resume from the first demonstrably unapplied file after owner review.
Keep the local rehearsal switch unset for Cloud.

After owner approval, run the Cloud harness with the separate destructive
confirmation from above. Save stdout outside Git. The JSON evidence contains
the operation ID for recovery. If cleanup fails, compare it with the active
operation, enable audit, and expected version before considering manual disable.

## Additional Storage validation on the disposable project

Use a fresh run prefix and establish a successful inactive control for each
operation. For signed uploads, create the token before enable and attempt the
upload while active. For TUS, test both a new upload and a paused upload started
before enable, then attempt finalization after enable. For the timeout case,
interrupt the client's wait, let server work settle, and inspect the same key
before retrying or deleting. For a privileged writer use test-only S3 credentials
and compare inactive and active writes, then revoke the credentials.

Capture maintenance-specific errors and verify metadata, API visibility and,
when available, S3 visibility separately. If the backend cannot be inspected
directly, physical absence remains UNVERIFIED even if the S3-compatible
endpoint reports no object. Treat unexpected successful writes or ambiguous
cleanup as blockers. This section is a manual test protocol.

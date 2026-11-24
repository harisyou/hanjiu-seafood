# Production Maintenance Runbook

This is the reusable maintenance boundary for 韓九嚴選生鮮. It is intentionally
independent of checkout, payment reporting, email delivery, and other business
features. Maintenance is installed **inactive**, never ends automatically, and
requires an owner-controlled database operation to disable.

## Architecture and limits

The application and database gates are independent, fail-closed layers:

1. `MAINTENANCE_MODE=on` makes Next.js return a self-contained branded `503`
   page for Storefront and Admin. It uses no Supabase data or external asset.
   `/api/healthz` and framework static assets remain available. The response has
   `Retry-After` (default 1800), `Cache-Control: no-store`, and no internal data.
2. PostgREST permanently uses `maintenance_private.enforce_api_request` as its
   composite pre-request hook. The previous valid hook is retained and invoked
   while maintenance is inactive. While active, **all** Data API methods are
   refused, including GET/HEAD RPC calls; method alone is not a read-only proof.
3. every `public` table has statement-level INSERT/UPDATE/DELETE and TRUNCATE
   guards. They cover direct DML, cascading statements, triggers, batches and
   SECURITY DEFINER functions. New tables require coverage reconciliation.
4. `storage.objects` has an additional product-images trigger and upload-policy
   predicate. This blocks Storage metadata finalization through Postgres,
   including service-role connections. Privileged external Storage workers,
   in-flight resumable uploads and any direct object-store credentials must also
   be stopped and attested before enable; RLS alone is not sufficient.

True read-only SQL remains possible through an owner-controlled direct database
session. The owner bypass is deliberately narrow: `session_user` must equal the
actual database owner and PostgREST request GUCs must be absent. `current_user`,
JWT role, `SET ROLE`, a user-set maintenance GUC, or a SECURITY DEFINER owner do
not grant bypass. If SQL Editor or a pooler does not satisfy the identity probe,
do not weaken this rule; use a verified direct owner connection.

Successful enable, disable and fail-closed recovery events are append-only.
PostgreSQL rolls back audit writes in a failed transaction, so failed attempts
are visible in database/server logs but are **not claimed to persist** in this
table.

## Environment variables

- `MAINTENANCE_MODE`: `on` or `off`; absent means off. An invalid value fails
  closed in Production.
- `MAINTENANCE_RETRY_AFTER_SECONDS`: 60–86400, default `1800`.
- `MAINTENANCE_LINE_URL`: optional HTTPS LINE contact URL. No URL is guessed.
- `VERCEL_GIT_COMMIT_SHA`: displayed only as a short opaque revision in health.

Vercel environment changes apply only to a new deployment. Old deployments keep
their old environment, so remove/disable old aliases and prevent access to old
deployment URLs during maintenance. Existing browser tabs can still call old
code, but the database gate blocks their writes after enable.

## One-time bootstrap installation

F006-4a must be installed after F006-4 and before F006-5. Because the gate does
not yet exist, bootstrap uses this separate procedure:

1. announce the window, stop Cron/background workers, Storage writers and all
   service-role jobs; close Admin editing sessions.
2. set application `MAINTENANCE_MODE=on`, deploy it, verify Storefront/Admin 503,
   health, Retry-After and no-store. Do not continue while any old deployment is
   reachable for writes.
3. take and record a fresh database backup. A backup without a restore drill is
   evidence, not a proven recovery.
4. run the read-only F006-4a preflight and save every result, hook fingerprint,
   table list, counts and transaction list. Confirm the execution session's
   `session_user` equals database owner and request GUCs are absent.
5. wait for in-flight HTTP, RPC and Storage operations to finish. Re-run the
   transaction query until there are no old, idle-in-transaction, prepared, or
   unknown background transactions. Do not broadly terminate connections.
6. review and run F006-4a once. It uses `lock_timeout=5s` and
   `statement_timeout=120s`, and obtains ACCESS EXCLUSIVE locks on current public
   tables and `storage.objects`. A busy lock causes the whole transaction to
   fail and roll back. Investigate and retry only after a fresh preflight.
7. hook setting, triggers, policy and state are installed atomically. PostgreSQL
   sends the PostgREST reload notification at commit. Keep app maintenance on
   until the read-only post-verify passes and a real Data API probe confirms the
   hook is active. Never assume catalog configuration alone proves reload.
8. run inactive smoke tests, then deliberately exercise enable/verify/disable in
   the isolated environment before Production use. Restore application service
   only after post-verification.

If installation fails, the transaction rolls back. Keep application maintenance
on, save the error, verify no partial foundation objects/settings exist, resolve
the lock or prerequisite and start again. Do not manually apply fragments.

## Enable maintenance

1. stop every external/Cron/service-role/Storage writer.
2. deploy application maintenance and verify it independently.
3. run `supabase/operations/maintenance-verify.sql`; verify owner identity, hook,
   storage guard and zero coverage gaps.
4. edit all placeholders in `maintenance-enable.sql`, using a new UUID, current
   version, reason, deployed revision and truthful attestations; run as owner.
5. call a normal read-only REST endpoint and GET RPC: both must fail with the
   maintenance error. Probe a write RPC and Storage upload: both must fail.
   Test GET, POST, PATCH and DELETE and save responses containing the exact
   `maintenance_mode_active` reason; an arbitrary 4xx is not evidence. Only
   after these real HTTP probes may the owner run
   `maintenance-confirm-postgrest.sql`. Until then `maintenance-verify.sql`
   reports `postgrest_runtime_probe` as BLOCKER even when catalog settings look
   correct.
6. run `maintenance-drain-verify.sql`. Maintenance Ready requires no blocker,
   no prepared transaction, no old snapshot/lock, and no unconfirmed external
   writer. Two equal counts or digests alone do not establish a drain.

Enable takes an exclusive advisory transaction lock while every Data API request
takes its shared counterpart, then locks protected relations. Transactions that
already touched those relations must finish before enable can commit; later
writes hit the guard. Never declare ready if App/DB states disagree.

## Migrations while active

Run only the reviewed migration. If it creates a `public` table, immediately run
`select maintenance_private.reconcile_protected_relations();` as the verified
owner before any disable. This does not restore ACL snapshots and therefore
cannot overwrite grants/revokes introduced by the migration. Review new RPC
grants separately; the PostgREST gate remains permanent.

## Disable and recovery

1. run feature post-verification and business baselines.
2. reconcile protection coverage and review all new tables/functions/ACLs.
3. verify external writers remain stopped and `drain_blockers()` is empty.
4. edit `maintenance-disable.sql` with a new UUID, current version and reason.
   Disable is rejected on stale version, gaps, hook drift or drain blockers.
5. verify the DB is inactive, audit contains exactly one event, Data API reads
   work, expected writes work, checkout/payment/admin/storage smoke tests pass.
6. deploy `MAINTENANCE_MODE=off`, verify the active alias, then restart schedulers
   and external writers one at a time.

Never disable automatically. If state is active but operational metadata needs a
safe checkpoint, `maintenance-recovery.sql` can only reassert the active state
and append a recovery event; it cannot enable or disable. If app is ON and DB is
OFF, keep app ON and re-enable DB only through the full attested enable flow. If
app is OFF and DB is ON, immediately deploy app ON; do not disable DB merely to
make the indicators match.

## Maintenance Ready blockers

Ready is forbidden when state is missing/invalid, hook reload is unproven,
Storage protection or registry coverage is incomplete, drain has blockers,
identity is unverified, external writers are unknown, or App and DB disagree.
Privileged direct object-store/S3 activity is outside PostgreSQL enforcement and
must be stopped operationally. In-flight uploads must finish or be abandoned
before readiness is attested.

## Disposable Supabase integration identity

The Supabase HTTP/Storage harness is destructive and refuses to run based on a
URL or database-name convention alone. Before use, an isolated stack owner must
create a short-lived `maintenance_test_identity.environment` marker containing a
random environment ID, explicit project ref and API origin, actual database name,
`pg_control_system().system_identifier`, purpose
`disposable_maintenance_integration`, `allow_destructive=true`, and an expiry.
The same values must be supplied through the documented test environment
variables plus the exact confirmation phrase. The harness performs this
read-only database comparison before its first write, then creates an HTTP probe
row and reads the nonce through PostgREST to bind the API origin to that database.
Missing, expired or mismatched identity refuses execution. Never install this
marker in Production.

The harness never logs keys or connection URLs. Its `finally` path opens a new
owner connection, disables maintenance if necessary, verifies state is inactive,
drops its probe table, reconciles coverage, and removes test objects. If cleanup
cannot prove inactive state, it fails and leaves the gate fail-closed for manual
recovery rather than claiming success.

## F006-5 order

The approved sequence is F006-4 → F006-4a → F006-5. Never rerun F006-1 through
F006-4. Before F006-5, run its read-only preflight. After it commits, reconcile
coverage so its lifecycle/outbox tables are guarded, run its read-only
post-verification with saved baselines, and verify new customer/internal RPC
grants exactly as reviewed. Do not restore old ACLs.


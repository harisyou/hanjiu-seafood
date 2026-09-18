# F006-2 / Phase 2 PR-B review and operator notes

PR-B starts from the merged F006-1 foundation. The owner reports F006-1 was
manually applied in Production and its three verification summaries passed.
Codex has not run Production SQL. Do not rerun F005-1, F005-1a, or F006-1.

## Scope and design

- `products.common_weight_min_g/max_g` are optional warnings, not hard sale
  limits. Mode changes remain subject to F006-1's guard. Controlled settings
  and tier actions require an admin, a reason, and a matching `updated_at` for
  edits. F006-1 tier overlap validation and audit remain authoritative.
- One quick-entry submission creates one batch and all its independent stock
  rows inside one DB transaction. The unique `submission_id` plus a hash of a
  **server-normalized** payload makes equivalent retries return the original
  batch; changed payloads conflict. A failed row rolls back the batch and all
  required rows.
- F006-1's stock code sequence and existing stock audit are reused. Existing
  stock price snapshots are not recalculated when tiers change. No new price
  source is persisted for T+N: current price is based on the saved effective
  T+0 base and today's Asia/Taipei day offset.
- A tier gap may be entered only with positive, explicitly confirmed manual
  T+0 pricing. Its tier, per-jin and computed system snapshots are NULL, never
  fabricated. Tier-backed manual prices preserve both system and manual values.
  The existing configurable confirmation policy is enforced in the DB. Its
  current NULL threshold means there is no invented percentage cutoff.
- One tai jin is 600 g; one liang is 37.5 g. The input UI rounds conversion to
  integer canonical grams; the server recalculates the NTD price with PostgreSQL
  `round(numeric)`. The UI never supplies an authoritative stock price.
- Optional single-stock photos upload to the existing `product-images` bucket
  under `weighted-stock/<stock_uuid>/<photo_uuid>.webp`. A separate admin-only
  metadata link points to the uploaded object. Stock creation commits before
  optional photo handling; failed upload/link can be retried without recreating
  stock. No new browser DELETE capability is introduced. Product image is the
  display fallback.
- New Phase 2 tables have RLS enabled, admin-only SELECT policies where
  needed, and no direct anon/authenticated write grants. Admin RPCs recheck
  `is_hanjiu_admin()`. No checkout, order, payment, cancellation, restock,
  inventory movement, or F004-1 function is changed by F006-2.

## Production deployment (owner only)

1. Pause admin writes for a short maintenance window. On the target Production
   DB, run only `supabase/f006-2-phase2-pr-b-preflight.sql`. It is read-only.
   Require `preflight_summary = PASS`; save every count and MD5 result,
   especially `weighted_stock_baseline_count`,
   `weighted_stock_f0061_business_md5`, and the single JSONB map
   `protected_function_definition_md5_by_signature`. Nonzero weighted-stock
   count is supported; do not assume the table is empty.
2. Review the F006-2 migration and its PR. The owner manually executes only
   `supabase/f006-2-phase2-pr-b-weighted-quick-entry.sql` once in Production
   SQL Editor. It is wrapped in one transaction.
3. Run `supabase/f006-2-phase2-pr-b-post-verify.sql` after pasting the exact
   preflight count/function/ledger baselines in the marked `NULL` placeholders.
   Paste the weighted-stock count/digest into its dedicated two-field baseline
   and the entire protected-function JSONB map into its one-field baseline.
   Require catalog PASS and every comparison PASS. Do not accept untouched
   placeholders as success. Then release the matching app build.

If preflight has any BLOCKER, do not run the migration. If migration execution
fails, PostgreSQL's transaction should leave no partial F006-2 schema; inspect
the SQL Editor result and rerun preflight before considering another attempt.
If post-verify fails, keep PR-B UI unavailable, preserve evidence, investigate
the specific mismatch and prepare a reviewed forward fix. Do not blindly rerun
F006-2 or reverse-drop tables/columns containing stock history. Uploaded photos
are optional and outside the inventory transaction; link/upload failure does
not justify reverting stock creation.

## Focused safety review: canonical payload and F006-1 compatibility

`phase2_normalize_weighted_batch_items()` creates a JSONB array containing
only the seven accepted item fields: product UUID, integer grams, ISO fish date,
nullable integer manual base, boolean confirmation, nullable expected tier UUID,
and nullable integer expected system base. Unknown item fields are rejected.
UUID case, integral numeric strings/numbers (including `420.0`), boolean
strings/booleans, and missing/null/empty optional fields normalize to the same
typed value. Nonintegral weights/prices are rejected, never rounded. Source and
note are trimmed; whitespace-only is NULL. Freshness version remains part of
the identity. **Array order remains part of identity** because it assigns
`batch_line_no`; changing row order is a conflict. The RPC executes the same
normalized rows it hashes, so representation-only changes cannot alter work.

F006-1's weighted-stock `raw_weight_g > 0`, snapshot-price `> 0`, optional
manual-price `> 0`, `t0_base_price > 0`, and
`t0_base_price = coalesce(manual_base_price, system_base_price)` checks remain
in place. F006-2 drops only the three NOT NULL markers needed for manual-only
rows and adds a validated price-origin CHECK. Tier-backed rows require all
three tier/system fields; manual-only rows require all three NULL plus positive
manual price and explicit confirmation. SQL CHECK null behavior cannot open a
half-state because this new origin expression uses explicit IS NULL/IS NOT NULL
tests and `manual_price_confirmed` is NOT NULL. Historical F006-1 tier-backed
rows satisfy the new condition without being rewritten. Regression tests apply
both migrations around a real F006-1 stock and attempt malformed inserts with
the initializer disabled in an isolated disposable database.

The replacement `phase2_initialize_weighted_stock()` retains F006-1's mode,
weight, manual-price, server stock-code, initial state, image ownership, enabled
tier match, numeric rounding, T+0 source, and version guards. PR-B adds the
available-product requirement, Taipei-date freshness eligibility, and the
explicit confirmed manual-only branch; it does not weaken the tier-backed
branch. Post-verify checks the enabled trigger's target, retained validated
constraints, current-row invariants, and line-ending-normalized `prosrc` MD5s
of the reviewed initializer, update guard, normalizer, and batch RPC. Preflight
first fingerprints the two F006-1 helpers that the migration will replace, so
an unreviewed Production drift is a BLOCKER before any write. A code-body
mismatch is a BLOCKER; do not approve a merely similar function name.

## Deployment-safety baselines

Preflight checks the exact F006-1 weighted-stock column set, types, NOT NULL
markers, defaults, keys, foreign keys, validated CHECKs, stock-code sequence,
and trigger wiring before F006-2 can ALTER that table. Post-verify checks the
expected F006-2 column set/nullability, new batch constraints and FK, retained
price checks, and reviewed trigger-function bodies. These schema checks are
intentionally *not* a pre/post schema-hash comparison: F006-2 legitimately
changes three NOT NULL markers and adds two nullable batch columns.

The weighted-stock business digest covers exactly the 19 F006-1 columns, with
per-row UUIDs and hashes aggregated in UUID order. Fish dates are formatted as
ISO dates and timestamps as UTC microseconds, so a different SQL Editor session
timezone does not change the digest. The same expression appears verbatim in
preflight and post-verify. Post-verify also compares row count and requires
`batch_id` / `batch_line_no` to remain NULL on all pre-existing rows. A count
of zero is still compared, but the isolated regression test additionally uses
an actual F006-1 stock row and proves that both old-data tampering and an
unexpected batch assignment become BLOCKERs.

The protected-function baseline is an explicit set of 28 type-only signatures,
not a name regex. It includes all three checkout overloads, both payment-record
overloads, cancellation/payment/restock/financial guards, and every unchanged
F006-1 helper. Preflight requires each signature and saves its definition MD5
in one JSONB map; post-verify requires each map entry and identical definition.
The two intentionally replaced stock trigger helpers are excluded from equality
comparison: preflight requires their reviewed F006-1 body fingerprints, while
post-verify requires their reviewed F006-2 body fingerprints.

## Production forensic note: inventory movement row digest

The owner reports that F006-2 ran successfully in Production. The pre/post
`inventory_movements` counts are both 47, the column-schema MD5 matches, the
current row digest is `a61bfb89fc7d93b4fbd04408f6b66461`, and the latest
observed movement predates deployment (2026-09-01). However, the original
preflight `inventory_movements_rows_md5` result was lost. **Pre-migration
row-digest evidence unavailable**; historical row equality is **unverified**, not
PASS. Never use the current digest as a fabricated pre-migration baseline or
change the post-verify comparison to force PASS. Matching counts, schema, and
latest timestamps do not prove every historical field is unchanged.

Source review finds no F006-2 statement that inserts, updates, deletes, or
rebuilds `public.inventory_movements` or writes `public.product_variants`.
F006-2's DDL changes `products` and `phase2_weighted_stock`, creates batch/photo
tables, and defines functions/triggers; creating or replacing a trigger
function does not execute it on historical rows. There is no top-level DML in
F006-2. The existing
`inventory_variant_movement_ledger` trigger is attached only to INSERT or
inventory UPDATE on `product_variants`, and its `log_inventory_movement()`
function only INSERTs ledger rows when that trigger fires. F006-2 does not
invoke a checkout, cancellation, restock, or payment RPC. Newly defined admin
RPCs likewise contain no ledger DML. This establishes no ledger rewrite path
in the reviewed repository migration/trigger chain, but cannot retroactively
prove the missing Production before/after digest equality or rule out unrelated
concurrent or database-local activity not represented in the repository.

The F006-2 preflight and post-verify ledger row expressions are the same:
`md5(coalesce(string_agg(to_jsonb(m)::text,'|' order by m.id::text),''))`.
Both read `public.inventory_movements`; the post-verify only wraps that
expression in its comparison CTE. One limitation is that `to_jsonb(m)` includes
the `created_at timestamptz` field, whose text representation can depend on
the SQL session timezone. Thus this full-row digest can differ across sessions
without a data change. The lost preflight value and its session context cannot
be reconstructed now. No additional read-only Production query can recover
that missing historical baseline; the current count, schema and recent-row
checks are corroborating evidence only.

## Explicitly deferred to PR-C

The management page is read-only by design. It does not offer fake controls for
external sale, relist, date correction, quality failure, or advanced batch
actions. Those require separately reviewed stock-action RPCs and audit rules.
Preorder, allocation, wallet, and mixed fulfillment are outside this PR.

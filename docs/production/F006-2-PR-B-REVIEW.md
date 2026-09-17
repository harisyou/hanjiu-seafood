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
  rows inside one DB transaction. The unique `submission_id` plus a JSONB
  payload hash makes identical retries return the original batch; changed
  payloads conflict. A failed row rolls back the batch and all required rows.
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
   Require `preflight_summary = PASS`; save every count and MD5 result.
2. Review the F006-2 migration and its PR. The owner manually executes only
   `supabase/f006-2-phase2-pr-b-weighted-quick-entry.sql` once in Production
   SQL Editor. It is wrapped in one transaction.
3. Run `supabase/f006-2-phase2-pr-b-post-verify.sql` after pasting the exact
   preflight count/function/ledger baselines in the marked `NULL` placeholders.
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

## Explicitly deferred to PR-C

The management page is read-only by design. It does not offer fake controls for
external sale, relist, date correction, quality failure, or advanced batch
actions. Those require separately reviewed stock-action RPCs and audit rules.
Preorder, allocation, wallet, and mixed fulfillment are outside this PR.

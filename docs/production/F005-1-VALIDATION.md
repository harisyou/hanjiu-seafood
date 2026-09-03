# Phase 1 validation record

## F005-1a forward-fix validation (after owner applied F005-1)

Production's reported `Allow authenticated delete` policy was not in the repo
baseline. F005-1 removed only `admin delete product images`; its previous Storage
verification was a listing/manual-review requirement, not a failing assertion.
The original minimal test fixture did not include the independently named policy.

- Added reproduction: authenticated DELETE succeeds before the fix and the new
  verification assertion fails. After F005-1a, ordinary authenticated, admin and
  anonymous DELETE affect zero product-images rows, and the objects remain.
- Admin INSERT/upload-policy behavior and public SELECT remain valid. Unrelated
  bucket DELETE still works and all unrelated policies compare unchanged.
- Unexpected same-named policy scope makes the migration fail without modifying
  policies. Already absent is a safe no-op.
- Existing full catalog SQL test now applies F005-1 then F005-1a before exercising
  gallery backfill/save/primary replacement/removal and metadata authorization.
- Full regression: **189 passed, 0 failed, 2 skipped** (191 total). The two external
  psql checkout tests still lack an explicitly configured disposable DB/psql.
- TypeScript: **pass**. Next.js 15.5.22 production build: **pass**, using a clean
  temporary export of the staged source to avoid the known OneDrive cache issue.
- No frontend, original F005-1 migration or transaction-system code changed.
  Codex executed no Production SQL. Owner must manually apply F005-1a and rerun
  the updated verification; do not rerun F005-1.

The assertions detect the two known policy names, not arbitrary SQL predicates.
Remaining DELETE/ALL policies must still be reviewed for PUBLIC/inherited roles
and product-images access. Tests use local in-memory PostgreSQL, not Storage API
deletion against Production.

## Original Phase 1 implementation validation

Baseline: `4c4b909fc2326fa6821105d564e8f25497f363b4` (main).
No Production SQL or Production writes were executed.

## Automated

- `node --test tests/*.test.mjs tests/integration/*.test.mjs`: **187 pass,
  0 fail, 2 skipped** (189 total).
- Existing 179 regression tests pass. Source-location assertions now read the
  shared shell; the revised weight notice and single catalog editor have updated
  expectations. Checkout/cart action blocks also have audited-main SHA-256 checks.
- New tests cover catalog summaries, stable gallery/FAQ ordering, optional FAQ,
  legacy cover fallback, public detail visibility/error/404 contracts, persistent
  layout, real component route updates and full remount restoration, price refresh,
  processing sanitization, same-variant merge/rejection, quantity/preorder boundaries,
  and actual checkout-handler transient retries with unchanged payload/key.
- Disposable in-memory PostgreSQL applies F005-1 and checks backfill, anonymous/
  non-admin writes, admin save, primary validation/replacement, atomic failure,
  stale-editor conflicts, hidden-image/FAQ visibility and duplicate-species creation.
- Existing psql integration tests skip because no explicit isolated database URL,
  opt-in flags, fixture IDs or psql executable were available. No fallback to Production.
- `node node_modules/typescript/bin/tsc --noEmit`: **pass**.
- `node node_modules/next/dist/bin/next build`: **pass**, Next.js 15.5.22.

Tests use Node 24. react-test-renderer emits its deprecation warning; simulated
transient-checkout errors are expected test output, not unhandled failures.
The lockfile pins the tested dependency graph; added dependencies are test-only.

## Browser: local read-only fixture API

Used the in-app browser, a local Next development server and the committed fixture
server. No live Supabase project was used.

- Homepage displays only browsing cards, primary cover, prices and legacy badges.
- Detail displays content, configured processing, optional FAQ and legacy controls.
- Gallery thumbnail 2 becomes selected; gallery remains internally scrollable.
- Product A added → homepage → product B added → drawer → `/#order`: both lines
  and correct subtotal retained. Full browser reload retained both lines.
- HTTP requests: hidden UUID **404**, nonexistent UUID **404**, sold_out UUID **200**.
- Measured document scrollWidth equals clientWidth at 320, 375, 390, 1024 and
  1440 viewport widths. OS scrollbar accounts for a 15px client-width difference.
- At 320px, NT$499 and NT$12,999 each have 209px available text width and no
  text overflow after the narrow-detail price/status stack correction.
- NT$12,999 also measured unclipped at 375px and 1440px. Existing responsive
  storefront CSS and cart rendering remain in use.

## Boundaries / remaining deployment verification

PGlite uses an explicit minimal catalog baseline: this is not an end-to-end proof
of Supabase Auth, Storage upload policies or the entire historical migration chain.
Component tests mock navigation/data; browser tests additionally cover real Next
route transitions. Real admin uploads/save through Supabase, live authorization
and real PostgreSQL checkout concurrency still require the isolated staging/manual
verification in `F005-1-CATALOG-DEPLOYMENT.md` before Production rollout.

Preview must point at a manually prepared database. Build success does not imply
F005-1 has been applied anywhere. Phase 2/3 stock/preorder domains remain deferred.

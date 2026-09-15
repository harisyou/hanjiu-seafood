# Phase 2 / PR-A — database foundation review

This PR generates `supabase/f006-1-phase2-pr-a-database-foundation.sql`. Codex did
**not** run any Production SQL or modify Production Supabase. The owner must review
the migration and target baseline before deciding whether/when to apply it manually.
`supabase/f006-1-phase2-pr-a-verify.sql` is a read-only, post-application checklist.

## Existing architecture found in the repo

- `products` is the canonical product table. Phase 1 added content, normalized
  gallery/FAQ tables, versioned admin save RPC, immutable Storage uploads and a
  follow-up deletion-policy lockdown. Its early `schema.sql` is not the current
  Production source of truth.
- `product_variants` holds legacy fixed price, available quantity and
  `preorder_enabled`; F004-3.3 derives supply per locked variant at checkout.
- `orders` carries F004-1 UUID checkout key and canonical request MD5 fingerprint.
  Its seven-argument `create_checkout_order` replays the same payload and rejects
  changed payload under the same key; this PR does not replace any overload.
- `order_items` stores legacy variant price/processing/supply snapshots. F003-14
  order totals are snapshots; historical missing totals may remain NULL.
- `inventory_movements` is a F003-12/13 append-only **variant quantity** ledger,
  with checkout, draft confirmation, admin adjustment and cancellation restoration
  events. Cancellation verifies original deduction provenance before restock.
  This PR neither changes that table/trigger nor fabricates weighted-stock movements.
- `order_payments` and `order_payment_reversals` are separate payment-attempt and
  reversal facts. Paid/cancelled transitions are guarded RPC workflows; F003-17/18
  financial audit functions are read-only checks, not a generic action-event table.
- Admin authorization uses `is_hanjiu_admin()` against trusted JWT
  `app_metadata.role`; privileged RPCs require the claim. New tables follow the
  admin-only SELECT/no direct browser mutation pattern.

## New model

`products.inventory_mode` is nullable. NULL means existing legacy behaviour; no
historical product is guessed or backfilled. Mode changes are guarded when either
sellable/reserved weighted stock or positive active legacy variant inventory is
present, or an unfinished in-stock legacy order still refers to the product.
Direct anon/authenticated mode edits are refused; future controlled admin
mode actions belong to PR-B.

`phase2_weight_pricing_tiers` stores product-specific positive integer
`price_per_jin`, enabled flag, order and half-open integer gram bounds. A trigger
serializes tier edits on the parent product and rejects overlap only among enabled
tiers. Disabled tiers may overlap, but re-enabling one revalidates its bounds against
all other enabled tiers. Gaps remain valid and yield no price. Tier deletion is
blocked; edits never
reprice already-created stock. Changes require a reason and append an audit event.

`phase2_weighted_stock` stores one UUID per physical fish, pre-processing
`raw_weight_g > 0`, fish date, optional batch reference/photo, eight safe status
states, nullable order/order-item links, timestamps and version. A server sequence
generates stable `F-YYMMDD-NNNNNNNN` codes; failed attempts may create harmless
sequence gaps. The creation trigger requires SINGLE_WEIGHTED mode and a matching
enabled tier, then snapshots tier ID, price-per-jin, system base, optional positive
manual base and effective T+0 base. Numeric PostgreSQL `round(weight_g * rate /
600)` is authoritative. Inputs are positive, so TypeScript `Math.round` agrees
at half-unit boundaries. Snapshot fields/code/weight/date/status/order links cannot
be edited by direct update, and stock cannot be deleted; future correction/action
RPCs must append audit records and check `version` rather than rewriting history.
The narrow admin creation RPC does not accept client-supplied status/code/system
price. Order links are structural only: **this PR does not claim checkout stock**.

Manual T+0 overrides are checked centrally by
`phase2_manual_price_requires_confirmation(system_base_price,manual_base_price)`
after the system price has been calculated in the stock creation trigger. The
singleton `phase2_manual_price_confirmation_policy.max_unconfirmed_deviation_ratio`
is **NULL by default**: PR-A does not invent or enforce an unapproved percentage,
so existing positive overrides still work. The helper compares absolute deviation
relative to the system base price only when a ratio is configured. The admin
creation RPC accepts an explicit `p_confirm_manual_price` (default false), and
the immutable stock row/audit snapshot records `manual_price_confirmed`. With a
configured ratio, a deviation beyond it is rejected by the database unless that
confirmation is true; frontend-only confirmation cannot bypass the trigger.
PR-B must obtain owner approval of the business threshold and boundary semantics,
add an audited/admin-controlled policy configuration action and a review/confirm
UI that displays both prices and passes the explicit RPC flag. Until that policy
is configured, PR-A makes no claim that abnormal-price confirmation is active.

`phase2_freshness_policy` has one global `max_sale_day` (default 2) and version;
`phase2_freshness_days` starts with 1.00/0.95/0.90 for T+0/1/2. Multipliers are
strictly >0 and <=1. The read helper calculates the Asia/Taipei calendar-day
difference at call time, applies the **live** global multiplier to the saved T+0
base and returns NULL for before-fish-day, missing policy day, non-sellable status,
T+3 or beyond max day. Nothing mutates stock prices at midnight. Policy changes
require a reason and append audit, affecting only later live quotations; order
price snapshots remain the job of a later checkout PR.
Changing a day multiplier or adding a day advances the same global freshness
configuration version as editing `max_sale_day`. The day change writes one day
audit record; the internal version advance does not create a duplicate policy
audit. A no-op multiplier update advances neither version nor audit.

`phase2_audit_events` is the minimal append-only actor/action/entity/old/new/reason/
time foundation. Stock creation and tier/policy edits write facts automatically;
unrelated historical audit/payment/ledger rows are untouched. Direct browser
inserts and updates/deletes are denied. Future weight/date/manual-price/status,
external-sale, batch and payment-decision actions will use controlled RPCs and
append new events in PR-B/C/D; no general admin dropdown is enabled here.

## Security and compatibility

RLS is enabled on all six new tables. Authenticated admins can SELECT via the
existing trusted helper; ordinary customers/anon cannot read stock/admin policy.
Neither anon nor authenticated has direct INSERT/UPDATE/DELETE privileges on new
tables or the stock-code sequence. `admin_create_weighted_stock` is the only new
browser-callable write RPC and checks the admin claim; its trigger derives price.
The price helper is admin-readable for now; a later customer quote/claim RPC must
perform its own authorization, locking and snapshot checks.

Existing orders, order items, payments, reversal, processing, supply and movement
facts are not changed or backfilled. No existing function signature changed. F004-1
key/fingerprint and seven-argument checkout remain untouched. This migration does
not claim to represent old variant movements as physical fish stock.

## Tests / rollout boundary

The PGlite test uses the existing repository DB test library with a disposable
minimal migration fixture, including representative legacy order/payment/ledger
facts before and after. It tests half-open bounds, overlap, gaps, prices/rounding,
manual base validation and configured confirmation (test-only ratio, not a
Production threshold), tier snapshot immutability, Taiwan midnight T+N, live
policy edits, max day, audit/immutability, mode guard, admin/anon privileges.
This is **not** a complete replay of all historical Supabase migrations or a live
Storage/Auth test. Existing checkout/ledger/payment suites remain the separate
contract regression checks.

Final local validation for this PR-A revision: `node --test tests/*.test.mjs`
**195 passed, 0 failed, 0 skipped**. Two opt-in external PostgreSQL tests were
**skipped** because no explicitly configured disposable server/psql was available;
Production was not substituted. `node node_modules/typescript/bin/tsc --noEmit`
**passed**. Next.js 15.5.22 production build **passed** in a clean staged-source
export, including its built-in type/lint phase and 14 static routes. The repo has
no separate `lint` script, so no standalone lint command was run.

Before manual Production execution, the owner should confirm F005-1a and the
current F004-1 checkout signature/unique index, inspect existing RLS/grants and
backup catalog/reference data. Apply F006-1 only once if approved. Run the
read-only verification SQL, record deployment commit/time/executor and inspect
new grants/policies, defaults and old transaction row counts. Do not deploy PR-B/C
consumer code before this migration has been reviewed and applied.

Deliberately deferred: inventory admin center/quick entry, mode-switch UI,
correction/status action RPCs, pricing-policy admin UI, checkout claim and order
item weighted snapshots, payment hold/declaration/workbench, schedulers, wallet,
preorder, delivery batch workflow, refund engine and processing state machine.

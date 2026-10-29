# F006-4 / Phase 2 PR-C1 weighted checkout transaction foundation

## Scope

PR-C1 adds a database-only transaction boundary for one-fish weighted stock. It
does not add storefront reads, cart UI, checkout calls, a scheduler, or any
browser grant for the new mixed-checkout RPC. PR-C2 must separately review the
public quote/read surface and explicitly grant an approved server boundary.

F006-1, F006-2 and F006-3 are Production history and are never edited or rerun.
F004-1's seven-argument `create_checkout_order` remains unchanged and remains the
public quantity-variant/preorder checkout. F006-4 calls it inside the same
transaction for the variant half of a mixed cart.

## Data model

- `orders.weighted_hold_expires_at` records the database-created 30-minute hold.
- `orders.weighted_hold_released_at` makes release idempotent.
- `order_items` receives weighted stock ID/code, raw grams, T+0 price, current
  T+N day/multiplier/policy-version and final integer price snapshots.
- Historical rows receive only NULL values. No existing business row is updated.
- A stock can appear in several historical order-item snapshots after an expired
  hold is released and later sold. The current relationship remains uniquely
  represented by `phase2_weighted_stock.order_item_id`.

## Transaction and lock order

`phase2_create_checkout_order(...)` accepts separate variant and weighted JSON
arrays, canonicalizes both, takes a transaction advisory lock on the existing
F004-1 idempotency UUID, and checks `orders.checkout_request_fingerprint` before
any inventory work. It uses the existing seven-argument checkout with an internal
key for the variant portion, then replaces that temporary key with the customer's
key inside the same transaction. Weighted rows are processed in UUID order and
locked `FOR UPDATE`.

For each weighted row the database, not the caller, verifies product mode/status,
stock status/linkage, Taipei calendar date, current max-sale-day and multiplier,
and derives the price from the immutable T+0 snapshot. Any item failure rolls back
the order, variant deductions, ledger rows, weighted links and audit rows.

## Order amount consistency

F006-4 does not manually patch order totals. Every weighted snapshot is inserted
into `order_items` with `quantity = 1` and its database-derived current price. The
existing F003-14 `order_items_recalculate_totals` trigger executes after each
insert and recomputes `orders.subtotal` from `sum(price * quantity)`; it preserves
the controlled shipping fee and discount and derives `total_amount` as
`greatest(subtotal + shipping_fee - discount_amount, 0)`. This applies to both a
weighted-only order and to the weighted rows appended after the canonical
seven-argument checkout creates the variant half of a mixed order.

The existing payment RPC still requires the recorded amount to equal the locked
order `total_amount`. The paid-order financial guard prevents later item/total
drift. Payment, reversal, cancellation and expiry retain item and amount
snapshots; they only transition payment/order/stock availability and restore
eligible inventory. A failure anywhere inside mixed checkout rolls back the
order, items, trigger-produced totals, variant ledger rows and weighted links in
the same PostgreSQL transaction.

The new RPC and expiry RPC are revoked from `public`, `anon` and `authenticated`.
PR-C1 cannot be used by the storefront.

## State transitions

| Event | From | To | Current link |
| --- | --- | --- | --- |
| Checkout reservation | `sellable` | `reserved` | order + order item |
| Payment recorded | `reserved` | `sold` | retained |
| Hold expires, still fresh | `reserved` | `sellable` | cleared |
| Hold expires, no longer eligible | `reserved` | `expired` | cleared |
| Unpaid admin cancellation | `reserved` | `sellable`/`expired` | cleared |
| Reversed payment then cancellation | `sold` | `sellable`/`expired` | cleared |

Every transition uses the F006-3 transaction/backend/stock-scoped capability
table, increments stock version through the existing guard, and appends a Phase 2
audit event. Direct status or order-link updates continue to fail.

## Payment, expiry and cancellation

The existing payment RPC still locks the order first. An `AFTER UPDATE OF
payment_status` trigger transitions reserved fish to sold in that same transaction.
If database time has reached the hold deadline, the trigger raises and the payment
insert/status update roll back together.

`phase2_release_expired_checkout_hold` also locks the order first. Payment and
release therefore serialize on the same row. Release restores only legacy
`in_stock` item deductions, using the existing inventory provenance and
`order_cancel_restore` ledger semantics; preorder lines were never deducted.
Weighted rows are released only after re-evaluating current freshness and product
eligibility. The whole mixed order becomes cancelled atomically. A second release
returns the already released order without another stock or ledger mutation.

`admin_cancel_order` is replaced with the reviewed current body plus weighted-item
awareness. Legacy in-stock and preorder behavior remains unchanged. A paid order
still requires payment reversal first.

## Deployment (owner only)

1. Confirm F006-1, F006-2 and F006-3 are already applied. Do not rerun them.
2. Pause checkout, payment, cancellation and weighted-stock admin actions.
3. Run `supabase/f006-4-phase2-weighted-checkout-preflight.sql` read-only. Save all
   counts, three business-row digests, and protected-function MD5 values. Every
   prerequisite and SUMMARY must be PASS.
4. Back up `orders`, `order_items`, weighted stock and audit facts.
5. Manually review and run
   `supabase/f006-4-phase2-weighted-checkout-foundation.sql` once. Codex never runs
   Production SQL.
6. Paste the saved baseline values into
   `supabase/f006-4-phase2-weighted-checkout-post-verify.sql` and run it read-only.
   No result may remain UNVERIFIED or BLOCKER.
7. Resume existing traffic. Do not grant or call the C1 mixed-checkout RPC from a
   browser. PR-C2 is required before customer weighted purchases.

## Failure and rollback strategy

The migration is one transaction: an execution error before `commit` leaves the
schema unchanged. After commit, do not drop snapshot columns, audit history or
reservation links. Roll back application callers (there are none in C1) and use a
reviewed forward fix. If a live hold exists, do not manually rewrite stock rows;
use a reviewed controlled release/cancellation path.

There is deliberately no automatic scheduler in C1. The release RPC is the safe
worker primitive; production scheduling, authentication and observability require
a separately reviewed deployment decision.

## Verification and known limits

PGlite executes the real F003-14, F003-17, F003-18 and F006-1 through F006-4 SQL
and verifies weighted-only and mixed item sums, shipping/discount derivation,
exact payment validation, paid-total locking, preserved cancellation/expiry
snapshots, and full rollback of orders/items/totals/variant ledger/weighted state.
It also verifies reservation,
idempotent replay/conflict, mixed-cart rollback/restoration, payment, expiry,
freshness recheck, direct-write guards, audit idempotency and cancellation after
reversal. The full historical test suite protects legacy checkout, preorder,
payment, reversal, cancellation and ledger behavior.

Real PostgreSQL concurrency is verified separately from PGlite. The opt-in
`tests/integration/f006-4-postgres-harness.test.mjs` uses independent `pg` client
sessions for same/different-key races and payment-versus-expiry. It requires an
explicit disposable database URL, two fresh stocks and a real expired unpaid
reservation; missing fixture data cannot silently skip the expiry case once the
harness is enabled.

Local validation on the PR head: focused F006-4 tests **8/8 passed**; full Node
suite **231/231 passed**; TypeScript `tsc --noEmit` passed; Next.js 15.5.22
production build passed. A disposable localhost PostgreSQL 18.4 cluster then ran
the three F006-4 multi-session races: **3/3 passed, 0 skipped**. Different keys
created exactly one order/item/reservation; same-key calls returned one order;
and payment-versus-expiry produced exactly one winner with no deadlock, payment
fact leak or double stock outcome. The expired fixture was asserted to be unpaid,
past its database deadline and linked to exactly one reserved stock before the
race. No Production database was used.

## Manual acceptance after owner-run SQL

No customer purchase UI exists in this PR. In a disposable staging environment:

1. Execute the integration harness with fresh sellable fish fixtures.
2. Confirm the legacy storefront can still complete variant and preorder orders.
3. Confirm admin payment, reversal and cancellation behavior for a legacy order.
4. Using a privileged SQL test session only, create a weighted-only and mixed hold;
   inspect snapshots, audit and 30-minute deadline.
5. Exercise payment before expiry and release after expiry; verify exactly one
   outcome, correct legacy ledger restoration, and no partial stock state.

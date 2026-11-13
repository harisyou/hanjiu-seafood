# F006-5 / Phase 2 PR-C2.1 database lifecycle foundation

## Scope

F006-5 is a forward-only migration after owner-applied F006-1 through F006-4.
It adds database foundations only. It does not add a storefront caller, API
route, email provider, cron schedule, browser EXECUTE grant, or feature enablement.
Codex does not execute Production SQL.

## Data model

- New order columns opt only PR-C2 orders into payment reporting. Historical
  orders retain `payment_reporting_required=false` and otherwise NULL/zero defaults.
- `order_customer_access_tokens` stores only a validated lowercase 64-character
  SHA-256 hex digest. The raw guest token never enters the database.
- `order_payment_reports` is append-only: version 1 is the timely report and
  version 2 is the single allowed last-five amendment.
- `order_customer_contact_revisions` preserves guest Email changes.
- `order_lifecycle_events` records customer, admin, and system lifecycle actions.
- `notification_outbox` is a provider-neutral transactional outbox. This PR
  enqueues work but never sends Email. Internal claim/complete/fail RPCs use
  bounded batches, `SKIP LOCKED`, scoped leases, retry timestamps, attempt counts,
  and terminal failure records for a later PR-C2.2 worker.
- `phase2_order_action_tokens` scopes exceptional after-deadline payment and
  reported-order cancellation authorization to one backend, transaction, order,
  action, and current report.

## Same-phone safety

`phase2_normalize_tw_mobile` accepts the canonical Taiwan mobile forms and stores
`09xxxxxxxx`. Checkout takes a transaction advisory lock on that value before
checking active orders. A partial unique index is the final race-safe constraint:
one PR-C2 order per normalized phone may own the active payment slot.
Expired but not yet released orders continue blocking until cancellation commits.
Paid or atomically cancelled orders free the phone for a new checkout.
The slot is not reactivated by the existing payment-reversal flow because reversal
does not restore inventory or reopen the original customer payment hold; explicit
admin cancellation remains required.

## Payment report and review

The first report locks the order, verifies the access-token digest, database hold
deadline, five ASCII digits, and exact database total. It sets `pending`, appends
audit, and inserts one outbox row in the same transaction. A single amendment can
change only the last five digits; it does not change the first report time, hold
deadline, amount, or reminder clock.

Admin confirmation requires the current report and an idempotency key. A scoped
action token allows F006-4's payment trigger to finalize a timely report after the
30-minute deadline. The existing immutable `order_payments` fact remains the sole
meaning of confirmed payment. Marking `exception` or cancelling a reported order
requires an admin RPC; both preserve audit, and cancellation requires a reason.

## Cancellation and inventory

`phase2_cancel_checkout_hold` centralizes PR-C2 cancellation. It locks the order
first, restores only proven legacy `in_stock` deductions through the existing
inventory ledger context, then releases each weighted reservation after current
freshness revalidation. Variant-only orders no longer incorrectly require a
weighted row. Customer cancellation is access-token protected and is allowed only
before a payment report. Replays do not restore inventory twice.

The expiry worker primitive now refuses `pending`, `exception`, or confirmed
reports. Payment and expiry still serialize on the order row. Payment reversal
does not restore inventory; the existing explicit cancellation step remains
required.

## Immutable checkout snapshot

PR-C2 orders reject order-item insert/update/delete and subtotal, shipping,
discount, or total changes after checkout construction. The opt-in flag is set
only after F006-4 finishes inserting and totaling all items, so checkout itself
continues to work. Historical/legacy orders keep their reviewed admin-total flow.

## Privileges

Customer and internal functions are revoked from `public`, `anon`, and
`authenticated`; PR-C2.2 must call them through a reviewed server boundary.
Authenticated users receive EXECUTE only on admin review RPCs, which also call
`is_hanjiu_admin()`. New tables have RLS enabled, no browser mutation grants, and
the token-hash table has no authenticated SELECT grant.

## Deployment (owner only)

1. Confirm F006-1 through F006-4 are already applied; never rerun them.
2. Pause checkout, payment, cancellation, and weighted availability actions.
3. Run `f006-5-phase2-payment-lifecycle-preflight.sql` read-only. Resolve every
   BLOCKER and save all counts, digests, and function MD5 values.
4. Back up orders, items, payments, inventory ledger, weighted stock, and audits.
5. Manually review and run `f006-5-phase2-payment-lifecycle-foundation.sql` once.
6. Paste the exact saved values into the read-only post-verify. No row may remain
   BLOCKER or UNVERIFIED.
7. Resume the existing application. Do not grant or expose the new customer RPCs.

## Rollback and stop strategy

An error before `commit` rolls the migration back. After commit, do not drop new
tables, columns, reports, audit, or outbox rows. Keep PR-C2 application features
disabled and prepare a reviewed forward fix. Existing checkout remains on its old
entry point, so F006-5 can remain dormant until PR-C2.2 is reviewed.

## PR-C2.2 dependencies

- Server-only Supabase client and secret isolation.
- Route every new storefront checkout through
  `phase2_create_checkout_order_with_access`. F006-5 intentionally does not
  revoke the legacy seven-argument `create_checkout_order` grants because the
  current storefront still depends on that entry point. Until PR-C2.2 performs
  that cutover and a separately reviewed privilege closure, callers using the
  legacy path do not participate in the new phone-slot restriction.
- Checkout API that hashes a 256-bit opaque guest token before the database call.
- Guest-order API that never logs or emails the raw token.
- Distributed API rate limits and owner-approved thresholds.
- Transactional outbox worker/provider integration.
- Scheduler selection and monitoring. No scheduler is created in F006-5.

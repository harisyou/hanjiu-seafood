# Production migration manifest

## Purpose

`supabase/schema.sql` is an early development bootstrap file, not a production
source of truth. Production changes must be applied as reviewed, ordered migration
files. This manifest is the canonical operator checklist for the currently shipped
incremental schema.

## Ordered production baseline

Apply only migrations that have not already been applied to the target database,
in this order. Do not rerun historical migrations merely because they appear here.

1. `supabase/admin-upgrade.sql`
2. `supabase/f001-product-variants.sql`
3. `supabase/f002-checkout-order-insert-policies.sql`
4. `supabase/hotfix-checkout-email.sql`
5. `supabase/f002-fish-processing-system.sql`
6. `supabase/f003-admin-order-management.sql`
7. `supabase/f003-2-fish-requests.sql`
8. `supabase/f003-3-customer-management.sql`
9. `supabase/f003-4-inventory-management.sql`
10. `supabase/f003-6-fish-catalog.sql`
11. `supabase/f003-7-arrival-notification-workflow.sql`
12. `supabase/f003-9-fish-request-order-draft.sql`
13. `supabase/f003-10-draft-order-confirmation.sql`
14. `supabase/f003-12a-inventory-ledger-compat.sql`
15. `supabase/f003-12c-inventory-direct-write-lockdown.sql` — run only after the
    F003-12 application deployment has been verified against Phase A.
16. `supabase/f003-13-order-cancellation-restock.sql`
17. `supabase/f003-14-order-totals.sql`
18. `supabase/f003-15-order-payments.sql`
19. `supabase/f003-16-payment-reversal.sql`
20. `supabase/f003-17-paid-financial-integrity.sql`
21. `supabase/f003-18-repayment-lifecycle.sql`
22. `supabase/f003-18-repayment-integrity.sql`
23. `supabase/f004-1-checkout-idempotency.sql`

## Operator rules

- Review each file and its feature PR before running it in Supabase SQL Editor.
- Record the filename, Git commit SHA, executor, timestamp, and SQL Editor result
  in the deployment log.
- Run the feature's read-only verification checklist immediately after SQL succeeds.
- Never run `schema.sql` over an existing production database.
- Do not run F003-12 Phase C until the deployed application has no direct
  `product_variants` insert/update call.

## Known baseline verification

Before a new migration, use read-only catalog queries to verify the expected
functions, constraints, policies, and privileges from the prior feature. If the
target baseline is uncertain, stop and reconcile it before applying another file.

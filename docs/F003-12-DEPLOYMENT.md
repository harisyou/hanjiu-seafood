# F003-12 Inventory Movement Ledger Deployment

Use this rollout in order. Do not run Phase C before the new application deployment has been verified.

## Phase A — compatibility migration

Run `supabase/f003-12a-inventory-ledger-compat.sql` in the Production Supabase SQL Editor.

The existing production UI remains supported in this phase: direct legacy variant writes continue to work and are recorded as `admin_adjustment` movements. Verify all of the following:

- Create a variant.
- Edit a variant inventory.
- Mark a variant sold out.
- Complete a normal checkout.
- Confirm a fish-request order draft.

For each inventory change, confirm exactly one ledger row with correct before, delta, and after values. Draft creation and draft metadata saves must create no ledger row.

If Phase A validation fails, stop before Phase B and Phase C. The legacy UI remains operational; do not delete ledger history as a rollback action.

## Phase B — application deployment

Deploy the application commit containing the F003-12 RPC-only admin paths.

Verify `/admin/inventory`, `/admin/inventory/[id]`, and `/admin/variants` can create, edit, sell out, and batch-save variants. Confirm the deployed application contains no direct `product_variants` insert/update calls. Repeat checkout and draft-confirmation smoke tests, then review the inventory movement list.

If this deployment fails, roll the application back. Phase A keeps the legacy UI working and continues to ledger its inventory mutations.

## Phase C — final permission lockdown

Only after Phase B succeeds, run `supabase/f003-12c-inventory-direct-write-lockdown.sql` in the Production Supabase SQL Editor.

Verify direct table privileges:

```sql
select role_name,
  has_table_privilege(role_name, 'public.product_variants', 'insert') as can_insert,
  has_table_privilege(role_name, 'public.product_variants', 'update') as can_update
from (values ('anon'::name), ('authenticated'::name)) as roles(role_name);
```

Both values must be `false` for both roles. Then complete one admin inventory smoke test through the deployed UI and confirm its ledger entry.

If Phase C fails before commit, roll back the SQL transaction. If an emergency rollback is necessary after completion, use a short-lived, audited privilege restore only until the deployed application is corrected; repeat Phase C immediately afterwards.

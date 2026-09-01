# Production migration manifest

This manifest records the ordered, manual Supabase SQL Editor rollout for features
that change public checkout or controlled inventory behaviour. It is intentionally a
small operational baseline, not a replacement for the historical migration files.

## Current checkout and inventory baseline

1. Apply the approved F003 migrations through F003-18, including the F003-12
   inventory ledger phases already used by production.
2. Apply `f004-1-checkout-idempotency.sql` before any storefront version that sends
   a checkout idempotency key.
3. Apply `f004-2-1-product-category-management.sql` and its separately reviewed
   corrective SQL before inventory product creation requires a category.
4. Apply `f004-3-3-in-stock-preorder-product-model.sql` before deploying the
   F004-3.3 application.

## F004-3.3 deployment checklist

1. Confirm the F004-1 seven-argument `create_checkout_order` function, the
   idempotency index, F003-12 inventory trigger, F003-13 cancellation RPC, and
   `product_categories` are present.
2. Run `f004-3-3-in-stock-preorder-product-model.sql` once in Supabase SQL Editor.
   It is transactional. Do not run it from the browser or application deployment.
3. Verify `product_variants.preorder_enabled` is `false` for existing variants and
   all historical `order_items.supply_type` values are `in_stock`.
4. Verify the checkout RPC accepts the existing seven-argument signature and the
   public checkout roles have only EXECUTE, not direct INSERT on `orders` or
   `order_items`.
5. Deploy the application branch. Test one in-stock checkout and one preorder
   checkout in a non-production environment first.

## Read-only production verification SQL

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name in ('product_variants', 'order_items')
  and column_name in ('preorder_enabled', 'supply_type')
order by table_name, column_name;

select supply_type, count(*)
from public.order_items
group by supply_type
order by supply_type;

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('create_checkout_order', 'admin_cancel_order',
                    'admin_update_inventory_variants',
                    'admin_create_inventory_product',
                    'admin_create_inventory_variant',
                    'admin_update_inventory_variant')
order by p.proname, arguments;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('orders', 'order_items')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;
```

## Forward-fix policy

Do not roll back this migration by deleting new columns or historical snapshots.
If a post-deployment defect is found, prepare a new forward-only migration that
preserves `order_items.supply_type`, inventory ledger facts, payments, and orders.

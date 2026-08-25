# F004-1 production rollout and verification

## Rollout order

1. Deploy no production SQL automatically.
2. In Supabase SQL Editor, manually run
   `supabase/f004-1-checkout-idempotency.sql` after reviewing it on the approved
   commit. The migration is one transaction.
3. Deploy the F004-1 application. New storefront checkout calls the seven-argument
   RPC with a browser-generated UUID.
4. Verify Preview first, then perform the same controlled verification in
   production.
5. Keep the six- and five-argument RPC overloads until every active old storefront
   deployment is retired. They generate a fresh UUID to preserve compatibility but
   cannot make an old client retry idempotent.

## Canonical checkout fingerprint

The database, not the browser, is authoritative. It computes an MD5 fingerprint
from canonical `jsonb` with these fields only:

- `customer_name`: trimmed, first 100 PostgreSQL text characters (not JavaScript
  UTF-16 code units).
- `phone`: digits only.
- `email`: trimmed, lower-cased, blank becomes `null`.
- `fulfillment`: the existing exact delivery-method value.
- `note`: outer-trimmed, blank becomes `null`.
- `items`: sorted by UUID `variant_id`; each item includes UUID `variant_id`, integer
  `quantity`, trimmed-or-null `processing_preset_id`, sorted/deduplicated
  `processing_option_ids`, and trimmed-or-null `processing_note` truncated to 500
  PostgreSQL text characters.

Duplicate `variant_id` inputs are rejected. JSON object key order and incoming item
or option array order therefore cannot make an equivalent checkout different.

The browser stores its canonical JSON string plus UUID in `sessionStorage`. It
reuses the UUID only when its current canonical request is identical. The database
still validates the key and fingerprint independently.

## Read-only verification SQL

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'orders'
  and column_name in ('checkout_idempotency_key', 'checkout_request_fingerprint')
order by column_name;

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'orders'
  and indexname = 'orders_checkout_idempotency_key_unique_idx';

select p.proname, pg_get_function_identity_arguments(p.oid) as arguments,
       p.prosecdef as security_definer, p.proconfig as function_config
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'create_checkout_order'
order by arguments;

select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name = 'create_checkout_order'
order by grantee, privilege_type;

select has_table_privilege('anon', 'public.orders', 'INSERT') as anon_can_insert_orders,
       has_table_privilege('authenticated', 'public.orders', 'INSERT') as authenticated_can_insert_orders,
       has_table_privilege('anon', 'public.order_items', 'INSERT') as anon_can_insert_order_items,
       has_table_privilege('authenticated', 'public.order_items', 'INSERT') as authenticated_can_insert_order_items;
```

Expected: both new columns exist and are nullable; the partial unique index exists;
the seven-argument function is `SECURITY DEFINER` with `search_path=public, pg_temp`;
anon/authenticated have RPC execute but no direct order/order_item INSERT.

## Behavioural verification

Use a disposable product variant with a known inventory. In a browser DevTools
network throttle scenario, submit once and resend the same request body with the
same `p_idempotency_key`. Verify the same UUID is returned; exactly one order,
one expected set of items, one `checkout_sale` inventory movement, and one stock
deduction exist. Then resend the same key with a changed quantity and verify
`checkout_idempotency_conflict`, unchanged stock, and unchanged order/item counts.

## Failure and forward-fix

If the migration transaction fails, PostgreSQL rolls back the entire F004-1 change;
do not deploy the new storefront. If application deployment fails after successful
migration, the old overloads remain usable. Do not drop the columns/index or edit
orders to recover. Forward-fix the application/RPC on a new reviewed migration,
then retry only on a disposable verification order.

# F004-1 PostgreSQL integration harness

The regular Node tests do not claim to prove PostgreSQL row locking or unique-index
wait semantics. The integration test must run only against a disposable local or
staging Supabase/PostgreSQL database that has the manifest baseline plus
`supabase/f004-1-checkout-idempotency.sql` applied.

Required environment:

```text
F004_1_TEST_DATABASE_URL=postgresql://.../hanjiu_f004_1_test
F004_1_ALLOW_DATABASE_TESTS=1
```

Run `node --test tests/integration/f004-1-postgres-harness.test.mjs`. The harness
refuses to run without both values and is intentionally skipped in ordinary local
test runs. It also requires `psql` on PATH. Never point it at Production.

Provision the test database with a disposable product/variant and set the three
`F004_1_TEST_*` fixture values described in the test file. The harness invokes two
concurrent RPC calls in separate `psql` sessions and then queries order, item,
inventory, and movement counts.

For the optional F004-3.3 case, also set `F004_3_3_ALLOW_DATABASE_TESTS=1`,
`F004_3_3_TEST_PREORDER_VARIANT_ID`, and optionally
`F004_3_3_TEST_PREORDER_QUANTITY`. The fixture must be active, preorder-enabled,
and the test quantity must be greater than its current inventory (zero inventory
is valid). The harness sends no `supply_type` and verifies PostgreSQL stores one
preorder item without changing inventory or creating a movement.

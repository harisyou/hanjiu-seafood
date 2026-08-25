import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f004-1-checkout-idempotency.sql", import.meta.url), "utf8");
const storefront = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

test("F004-1 adds nullable metadata and partial DB uniqueness without historical backfill", () => {
  assert.match(migration, /add column if not exists checkout_idempotency_key uuid/);
  assert.match(migration, /add column if not exists checkout_request_fingerprint text/);
  assert.match(migration, /create unique index if not exists orders_checkout_idempotency_key_unique_idx[\s\S]*where checkout_idempotency_key is not null/);
  assert.doesNotMatch(migration, /update public\.orders\s+set checkout_idempotency_key/i);
});

test("seven-argument checkout validates and serializes retries before inventory mutation", () => {
  assert.match(migration, /p_idempotency_key uuid/);
  assert.match(migration, /if p_idempotency_key is null then raise exception 'checkout_idempotency_key_required'/);
  assert.match(migration, /checkout_idempotency_conflict/);
  assert.match(migration, /where checkout_idempotency_key = p_idempotency_key[\s\S]*?return v_existing_order\.id/);
  assert.match(migration, /exception when unique_violation[\s\S]*?return v_existing_order\.id/);
  assert.ok(migration.indexOf("exception when unique_violation") < migration.indexOf("set_config('app.inventory_movement_type', 'checkout_sale'"));
  assert.match(migration, /duplicate_variant_item/);
  assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/);
});

test("legacy overloads preserve availability but new client sends a retry-safe key", () => {
  assert.match(migration, /p_items jsonb, p_email text[\s\S]*?return public\.create_checkout_order\([\s\S]*?gen_random_uuid\(\)/);
  assert.match(migration, /grant execute on function public\.create_checkout_order\(text, text, text, text, jsonb, text, uuid\) to anon, authenticated/);
  assert.match(storefront, /p_idempotency_key: idempotencyKey/);
  assert.match(storefront, /checkoutRetryKey\(retryFingerprint\)/);
  assert.match(storefront, /clearCheckoutRetryKey\(idempotencyKey\)/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/f003-4-inventory-management.sql", import.meta.url),
  "utf8"
);
const storefront = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

const atomicUpdate = /update public\.product_variants variant\s+set inventory = variant\.inventory - v_quantity\s+from public\.products product\s+where variant\.id = v_variant_id\s+and product\.id = variant\.product_id\s+and product\.status = 'available'\s+and variant\.active\s+and variant\.inventory >= v_quantity\s+returning[\s\S]+?into v_variant;\s+if not found then raise exception 'variant_unavailable';/i;

test("reserves inventory with one conditional UPDATE", () => {
  assert.match(migration, atomicUpdate);
  assert.doesNotMatch(migration, /set inventory = inventory - v_quantity[\s\S]+?where variant\.id = v_variant_id\s*;/i);
  assert.match(migration, /jsonb_array_elements\(p_items\)\s+order by value->>'variant_id'/i);
});

test("validates processing before the inventory side effect", () => {
  const processingValidation = migration.indexOf("raise exception 'processing_updated'");
  const inventoryUpdate = migration.indexOf("update public.product_variants variant");
  assert.ok(processingValidation > -1);
  assert.ok(inventoryUpdate > processingValidation);
});

test("preserves six-parameter RPC and five-parameter compatibility wrapper", () => {
  assert.match(migration, /create or replace function public\.create_checkout_order\(\s*p_customer_name text,\s*p_phone text,\s*p_fulfillment text,\s*p_note text,\s*p_items jsonb,\s*p_email text\s*\)/);
  assert.match(migration, /create or replace function public\.create_checkout_order\(\s*p_customer_name text,\s*p_phone text,\s*p_fulfillment text,\s*p_note text,\s*p_items jsonb\s*\)/);
  assert.match(migration, /p_customer_name, p_phone, p_fulfillment, p_note, p_items, null::text/);
});

test("preserves checkout validation and snapshots", () => {
  for (const contract of [
    "invalid_email",
    "invalid_fulfillment",
    "invalid_quantity",
    "processing_updated",
    "variant_unavailable",
    "processing_preset_id",
    "processing_option_ids",
    "processing_note",
    "product_name",
    "variant_name",
    "price",
    "quantity"
  ]) assert.ok(migration.includes(contract), `missing ${contract}`);
  assert.match(migration, /insert into public\.orders \(customer_id, customer_name, phone, email,/i);
  assert.match(migration, /values \(v_customer_id, btrim\(p_customer_name\), v_phone, v_email,/i);
});

test("keeps SECURITY DEFINER, fixed search_path, and execute-only public RPC access", () => {
  assert.match(migration, /create or replace function public\.create_checkout_order\([\s\S]+?security definer\s+set search_path = public, pg_temp/i);
  assert.match(migration, /revoke all on function public\.create_checkout_order\(text, text, text, text, jsonb, text\)\s+from public, anon, authenticated;/i);
  assert.match(migration, /grant execute on function public\.create_checkout_order\(text, text, text, text, jsonb, text\)\s+to anon, authenticated;/i);
  assert.match(migration, /revoke insert on public\.orders, public\.order_items from anon, authenticated;/i);
  assert.doesNotMatch(migration, /grant insert on public\.(orders|order_items) to (anon|authenticated)/i);
});

test("relies on transaction rollback without manual stock compensation", () => {
  assert.doesNotMatch(migration, /exception\s+when[\s\S]+?inventory\s*=\s*inventory\s*\+/i);
  assert.doesNotMatch(migration, /restore_inventory|compensat/i);
});

test("post-deduction trigger does not compare snapshots with remaining stock", () => {
  const triggerFunction = migration.slice(migration.indexOf("create or replace function public.enforce_order_item_variant_availability"));
  assert.match(triggerFunction, /not v_variant\.active or v_variant\.product_status <> 'available'/);
  assert.doesNotMatch(triggerFunction, /new\.quantity > v_variant\.inventory/);
});

test("does not redefine unrelated production RPCs or rewrite historical data", () => {
  assert.doesNotMatch(migration, /create or replace function public\.create_fish_request/i);
  assert.doesNotMatch(migration, /\b(delete from|truncate|drop table|drop column|update public\.(orders|order_items|customers|fish_requests))\b/i);
  assert.doesNotMatch(migration, /alter table public\.(orders|order_items|customers|fish_requests)\s+(add|drop|alter)\s+column/i);
});

test("keeps the storefront Checkout and persisted-cart API contract", () => {
  assert.match(storefront, /supabase\.rpc\("create_checkout_order",\s*\{/);
  for (const parameter of ["p_customer_name", "p_phone", "p_fulfillment", "p_note", "p_items", "p_email"])
    assert.ok(storefront.includes(parameter), `missing storefront RPC parameter ${parameter}`);
  assert.match(storefront, /localStorage\.setItem\(/);
  assert.match(storefront, /localStorage\.getItem\(/);
  assert.match(storefront, /variant_unavailable|訂單送出失敗/);
});

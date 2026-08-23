import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f003-14-order-totals.sql", import.meta.url), "utf8");
const detail = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");

test("totals schema is additive, nullable for history, and constrained for snapshots", () => {
  assert.match(migration, /^--[^]*?\bbegin;/i);
  for (const column of ["subtotal", "shipping_fee", "discount_amount", "total_amount"]) assert.match(migration, new RegExp(`add column if not exists ${column} integer`));
  assert.match(migration, /subtotal is null and shipping_fee is null and discount_amount is null and total_amount is null/);
  assert.match(migration, /total_amount = greatest\(subtotal \+ shipping_fee - discount_amount, 0\)/);
  assert.match(migration, /\bcommit;\s*$/i);
});

test("new checkout and draft items derive totals from stored item price snapshots", () => {
  assert.match(migration, /create trigger orders_initialize_totals before insert on public\.orders/);
  assert.match(migration, /create trigger order_items_recalculate_totals after insert or update of price, quantity or delete on public\.order_items/);
  assert.match(migration, /sum\(price \* quantity\)/);
  assert.doesNotMatch(migration, /product_variants\.price|create_checkout_order|inventory_movements/i);
});

test("only admins can adjust shipping and discount; total is database calculated", () => {
  const rpc = migration.slice(migration.indexOf("create or replace function public.admin_update_order_totals"));
  assert.match(rpc, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(rpc, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(rpc, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(rpc, /p_shipping_fee is null or p_shipping_fee < 0/);
  assert.match(rpc, /p_discount_amount is null or p_discount_amount < 0/);
  assert.match(rpc, /v_order\.status = 'cancelled'/);
  assert.match(rpc, /total_amount = greatest\(subtotal \+ p_shipping_fee - p_discount_amount, 0\)/);
  assert.doesNotMatch(rpc, /p_total_amount|set subtotal\s*=/);
  assert.match(migration, /revoke all on function public\.admin_update_order_totals\(uuid, integer, integer\) from public, anon, authenticated/);
});

test("admin detail displays snapshots and saves only shipping and discount through the RPC", () => {
  assert.match(detail, /商品小計/);
  assert.match(detail, /應收總額/);
  assert.match(detail, /admin_update_order_totals/);
  assert.match(detail, /此歷史訂單尚無 F003-14 金額 snapshot/);
  assert.match(detail, /isCancelled &&/);
});

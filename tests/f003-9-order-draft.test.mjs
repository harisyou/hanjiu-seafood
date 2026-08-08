import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canCreateOrderDraft, getDraftProducts, isDraftVariantAvailable, validateDraftQuantity } from "../lib/order-draft.ts";

const migration = readFileSync(new URL("../supabase/f003-9-fish-request-order-draft.sql", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/admin/matches/order-draft-workspace.tsx", import.meta.url), "utf8");
const contactWorkspace = readFileSync(new URL("../app/admin/matches/contact-workspace.tsx", import.meta.url), "utf8");
const orderList = readFileSync(new URL("../app/admin/orders/page.tsx", import.meta.url), "utf8");
const product = (overrides = {}) => ({ id: "p1", name: "馬頭魚", status: "available", fish_catalog_id: "fish-1", ...overrides });
const variant = (overrides = {}) => ({ id: "v1", product_id: "p1", name: "150g～200g", price: 180, inventory: 3, active: true, ...overrides });
const request = (overrides = {}) => ({ id: "r1", fish_name: "馬頭魚", fish_catalog_id: "fish-1", status: "waiting", ...overrides });

test("draft workspace only accepts waiting/contacted requests", () => {
  assert.equal(canCreateOrderDraft(request()), true);
  assert.equal(canCreateOrderDraft(request({ status: "contacted" })), true);
  assert.equal(canCreateOrderDraft(request({ status: "converted" })), false);
  assert.equal(canCreateOrderDraft(request({ status: "cancelled" })), false);
});

test("draft products use catalog-aware matching and sellable inventory", () => {
  assert.equal(getDraftProducts([product()], [variant()], request()).length, 1);
  assert.equal(getDraftProducts([product({ fish_catalog_id: "fish-2" })], [variant()], request()).length, 0);
  assert.equal(getDraftProducts([product()], [variant({ inventory: 0 })], request()).length, 0);
  assert.equal(getDraftProducts([product({ status: "hidden" })], [variant()], request()).length, 0);
  assert.equal(isDraftVariantAvailable(variant({ active: false })), false);
});

test("draft quantity must be an available positive integer", () => {
  assert.equal(validateDraftQuantity(1, 3), "");
  assert.match(validateDraftQuantity(0, 3), /至少 1/);
  assert.match(validateDraftQuantity(1.5, 3), /整數/);
  assert.match(validateDraftQuantity(4, 3), /最多/);
});

test("migration adds nullable source and one active draft per request", () => {
  assert.match(migration, /add column if not exists fish_request_id uuid/);
  assert.match(migration, /on delete set null not valid/);
  assert.match(migration, /create unique index if not exists orders_one_draft_per_fish_request_idx[\s\S]*where status = 'draft'/);
  assert.match(migration, /'draft', 'new', 'processing', 'ready', 'completed', 'cancelled',[\s\S]*'contacted', 'confirmed', 'paid', 'shipped'/);
});

test("admin RPC preserves security and never changes request or inventory", () => {
  assert.match(migration, /security definer\s+set search_path = public, pg_temp/);
  assert.match(migration, /if not public\.is_hanjiu_admin\(\)/);
  assert.match(migration, /revoke all on function public\.admin_create_fish_request_order_draft\(uuid, uuid, integer\)[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_create_fish_request_order_draft\(uuid, uuid, integer\)[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /update\s+public\.product_variants/i);
  assert.doesNotMatch(migration, /update\s+public\.fish_requests/i);
  assert.doesNotMatch(migration, /create_checkout_order/);
});

test("RPC validates authoritative product, matching, price and availability", () => {
  for (const code of ["fish_request_not_found", "fish_request_not_eligible", "fish_request_draft_exists", "variant_not_found", "variant_unavailable", "insufficient_inventory", "fish_request_product_mismatch", "invalid_quantity"]) assert.ok(migration.includes(code), code);
  assert.match(migration, /v_variant\.price, p_quantity/);
  assert.match(migration, /v_request\.status not in \('waiting', 'contacted'\)/);
  assert.match(migration, /exception when unique_violation[\s\S]*fish_request_draft_exists/);
});

test("workspace sends only IDs and quantity while explaining draft side effects", () => {
  assert.match(workspace, /admin_create_fish_request_order_draft/);
  assert.match(workspace, /p_request_id: request\.id, p_variant_id: selectedVariant\.id, p_quantity: quantity/);
  assert.match(workspace, /不保留庫存、不扣庫存，也不會將需求標記為已完成/);
  assert.doesNotMatch(workspace, /admin_update_fish_request_status/);
  assert.match(contactWorkspace, /canCreateOrderDraft\(request\)/);
});

test("formal today-order summary excludes drafts", () => {
  assert.match(orderList, /order\.status !== "draft"/);
});

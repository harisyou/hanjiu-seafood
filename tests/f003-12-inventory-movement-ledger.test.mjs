import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const phaseA = readFileSync(new URL("../supabase/f003-12a-inventory-ledger-compat.sql", import.meta.url), "utf8");
const phaseC = readFileSync(new URL("../supabase/f003-12c-inventory-direct-write-lockdown.sql", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8");
const variantsPage = readFileSync(new URL("../app/admin/variants/page.tsx", import.meta.url), "utf8");
const detailPage = readFileSync(new URL("../app/admin/inventory/[id]/page.tsx", import.meta.url), "utf8");

test("Phase A creates the ledger with RLS and append-only client permissions", () => {
  assert.match(phaseA, /create table if not exists public\.inventory_movements/);
  assert.match(phaseA, /check \(quantity_after - quantity_before = inventory_delta\)/);
  assert.match(phaseA, /alter table public\.inventory_movements enable row level security/);
  assert.match(phaseA, /admin read inventory movements[\s\S]*is_hanjiu_admin/);
  assert.match(phaseA, /revoke all on public\.inventory_movements from public, anon, authenticated/);
  assert.doesNotMatch(phaseA, /grant (insert|update|delete) on public\.inventory_movements/i);
});

test("one product_variants trigger uses authoritative OLD and NEW values for every movement", () => {
  assert.match(phaseA, /new\.inventory - old\.inventory, old\.inventory, new\.inventory/);
  assert.match(phaseA, /coalesce\(nullif\(current_setting\('app\.inventory_movement_type', true\), ''\), 'admin_adjustment'\)/);
  assert.match(phaseA, /create trigger inventory_variant_movement_ledger/);
  assert.doesNotMatch(phaseA, /create trigger checkout_order_item_movement_ledger/);
  assert.doesNotMatch(phaseA, /create trigger draft_confirmation_movement_ledger/);
  assert.match(phaseA, /drop trigger if exists checkout_order_item_movement_ledger/);
  assert.match(phaseA, /drop trigger if exists draft_confirmation_movement_ledger/);
});

test("checkout and draft confirmation set local context before the one atomic inventory update", () => {
  assert.match(phaseA, /set_config\('app\.inventory_movement_type', 'checkout_sale', true\)/);
  assert.match(phaseA, /set_config\('app\.inventory_movement_order_id', v_order_id::text, true\)/);
  assert.match(phaseA, /set_config\('app\.inventory_movement_type', 'fish_request_order_confirmation', true\)/);
  assert.match(phaseA, /set_config\('app\.inventory_movement_fish_request_id', v_request\.id::text, true\)/);
  assert.match(phaseA, /variant\.inventory >= v_quantity/);
  assert.match(phaseA, /variant\.inventory >= v_item\.quantity/);
});

test("Phase A leaves legacy direct product variant writes available while RPC paths are admin-only", () => {
  assert.doesNotMatch(phaseA, /revoke insert, update on public\.product_variants/);
  assert.match(phaseA, /admin_adjust_inventory_variant[\s\S]*is_hanjiu_admin/);
  assert.match(phaseA, /admin_create_inventory_variant[\s\S]*is_hanjiu_admin/);
  assert.match(phaseA, /admin_update_inventory_variant[\s\S]*is_hanjiu_admin/);
  assert.match(phaseA, /create or replace function public\.admin_update_inventory_variants[\s\S]*set_config\('app\.inventory_movement_type', 'admin_adjustment', true\)/);
  assert.match(phaseA, /create or replace function public\.admin_create_inventory_product[\s\S]*set_config\('app\.inventory_movement_type', 'admin_adjustment', true\)/);
  assert.match(phaseA, /security definer set search_path = public, pg_temp/);
});

test("Phase C is only the direct-write permission lockdown", () => {
  assert.match(phaseC, /revoke insert, update on public\.product_variants from anon, authenticated/);
  assert.match(phaseC, /revoke update \(name, price, inventory, active, sort_order\)/);
  assert.doesNotMatch(phaseC, /create table|create trigger|create or replace function|drop table/i);
});

test("deployed admin UI uses controlled RPCs and can read the ledger", () => {
  for (const source of [inventoryPage, variantsPage, detailPage]) assert.doesNotMatch(source, /from\("product_variants"\)\.(insert|update)/);
  assert.match(inventoryPage, /from\("inventory_movements"\)/);
  assert.match(inventoryPage, /admin_adjust_inventory_variant/);
  assert.match(variantsPage, /admin_create_inventory_variant/);
  assert.match(variantsPage, /admin_update_inventory_variant/);
  assert.match(detailPage, /admin_create_inventory_variant/);
});

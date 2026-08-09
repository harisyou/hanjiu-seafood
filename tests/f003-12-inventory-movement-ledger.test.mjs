import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL("../supabase/f003-12-inventory-movement-ledger.sql", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8");
const variantsPage = readFileSync(new URL("../app/admin/variants/page.tsx", import.meta.url), "utf8");
const detailPage = readFileSync(new URL("../app/admin/inventory/[id]/page.tsx", import.meta.url), "utf8");

test("ledger schema stores immutable before/delta/after audit data with safe references", () => {
  for (const column of ["variant_id", "product_id", "inventory_delta", "quantity_before", "quantity_after", "movement_type", "order_id", "fish_request_id", "actor_id", "created_at"]) assert.match(sql, new RegExp(`\\b${column}\\b`));
  assert.match(sql, /check \(quantity_after - quantity_before = inventory_delta\)/);
  assert.match(sql, /'checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment'/);
  assert.match(sql, /-- Run once after F003-11\. Historical inventory changes are intentionally not backfilled\./);
});

test("checkout and draft confirmation produce exactly their dedicated movement path", () => {
  assert.match(sql, /create trigger checkout_order_item_movement_ledger[\s\S]*after insert on public\.order_items/i);
  assert.match(sql, /'checkout_sale', new\.order_id, null/);
  assert.match(sql, /if not found or v_order_status = 'draft' then return new; end if;/);
  assert.match(sql, /create trigger draft_confirmation_movement_ledger[\s\S]*after update of status on public\.orders/i);
  assert.match(sql, /old\.status <> 'draft' or new\.status <> 'new'/);
  assert.match(sql, /'fish_request_order_confirmation', new\.id, new\.fish_request_id/);
});

test("admin adjustments are server-controlled and atomically ledgered", () => {
  assert.match(sql, /current_setting\('app\.inventory_ledger_admin_adjustment', true\) is distinct from 'true'/);
  assert.match(sql, /create or replace function public\.admin_update_inventory_variants/);
  assert.match(sql, /perform set_config\('app\.inventory_ledger_admin_adjustment', 'true', true\)/);
  assert.match(sql, /create or replace function public\.admin_adjust_inventory_variant/);
  assert.match(sql, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(sql, /revoke insert, update on public\.product_variants from anon, authenticated/);
  assert.match(sql, /revoke update \(name, price, inventory, active, sort_order\) on public\.product_variants from anon, authenticated/);
});

test("ledger writes roll back with their source mutation and cannot be forged by clients", () => {
  assert.match(sql, /security definer\s+set search_path = public, pg_temp/);
  assert.match(sql, /revoke all on public\.inventory_movements from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.write_inventory_movement/);
  assert.doesNotMatch(sql, /grant (insert|update|delete) on public\.inventory_movements/i);
  assert.match(sql, /if p_before < 0 or p_after < 0 then raise exception 'invalid_inventory'/);
});

test("draft creation and metadata edits do not create a movement", () => {
  assert.match(sql, /if not found or v_order_status = 'draft' then return new; end if;/);
  assert.match(sql, /old\.status <> 'draft' or new\.status <> 'new'/);
});

test("admin inventory UI uses RPCs and exposes a read-only movement ledger", () => {
  assert.match(inventoryPage, /from\("inventory_movements"\)\.select\("\*"\)/);
  assert.match(inventoryPage, /庫存異動紀錄/);
  assert.match(inventoryPage, /admin_adjust_inventory_variant/);
  assert.match(variantsPage, /admin_update_inventory_variant/);
  assert.match(variantsPage, /admin_create_inventory_variant/);
  assert.match(detailPage, /admin_create_inventory_variant/);
});

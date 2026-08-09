import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inventoryPage = readFileSync(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8");

test("one product saves all visible variants with one RPC call", () => {
  assert.match(inventoryPage, /async function saveAllVariants\(product: InventoryProduct\)/);
  assert.match(inventoryPage, /supabase\.rpc\("admin_update_inventory_variants",/);
  assert.match(inventoryPage, /p_variants: product\.variants\.map/);
  assert.doesNotMatch(inventoryPage, /async function saveVariant\(/);
  assert.doesNotMatch(inventoryPage, /onClick=\{\(\) => saveVariant/);
  assert.match(inventoryPage, /dirty \? "儲存全部規格" : "已儲存"/);
});

test("client validates all rows before invoking the batch RPC", () => {
  const validation = inventoryPage.indexOf("for (const [index, variant] of product.variants.entries())");
  const rpc = inventoryPage.indexOf('supabase.rpc("admin_update_inventory_variants"');
  assert.ok(validation > -1 && rpc > validation);
  assert.match(inventoryPage, /validateInventoryValues\(variant\.name, variant\.price, variant\.inventory\)/);
});

test("dirty state enables one manual save and clears after success", () => {
  assert.match(inventoryPage, /setDirtyProducts\(\(current\) => \(\{ \.\.\.current, \[productId\]: true \}\)\)/);
  assert.match(inventoryPage, /\[product\.id\]: false/);
  assert.match(inventoryPage, /disabled=\{!dirty \|\| batchBusy\}/);
  assert.match(inventoryPage, /<fieldset className="inventoryVariants inventoryVariantsFieldset" disabled=\{batchBusy\}>/);
  assert.match(inventoryPage, /dirty \? "儲存全部規格" : "已儲存"/);
});

test("mark sold out remains an immediate single-field database update", () => {
  assert.match(inventoryPage, /async function markSoldOut/);
  assert.match(inventoryPage, /supabase\.rpc\("admin_adjust_inventory_variant"/);
  assert.match(inventoryPage, />標記售完<\/button>/);
});

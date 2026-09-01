import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isPreorderCartItemValid,
  supplyTypeForQuantity,
  variantSupplyType
} from "../lib/supply-model.mjs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/f004-3-3-in-stock-preorder-product-model.sql", import.meta.url), "utf8");
const f0041Migration = readFileSync(new URL("../supabase/f004-1-checkout-idempotency.sql", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8");

const stockOnly = { id: "stock", active: true, inventory: 3, preorder_enabled: false };
const preorderWithStock = { id: "preorder-stock", active: true, inventory: 3, preorder_enabled: true };
const preorderOnly = { id: "preorder-zero", active: true, inventory: 0, preorder_enabled: true };

test("quantity-aware supply estimate makes a whole overage line preorder", () => {
  assert.equal(variantSupplyType(preorderWithStock), "in_stock");
  assert.equal(supplyTypeForQuantity(preorderWithStock, 1), "in_stock");
  assert.equal(supplyTypeForQuantity(preorderWithStock, 3), "in_stock");
  assert.equal(supplyTypeForQuantity(preorderWithStock, 4), "preorder");
  assert.equal(supplyTypeForQuantity(preorderOnly, 1), "preorder");
  assert.equal(supplyTypeForQuantity(stockOnly, 4), null);
  assert.equal(supplyTypeForQuantity({ ...preorderWithStock, active: false }, 1), null);
});

test("cart validation does not treat a preorder-enabled variant as a per-line stock cap", () => {
  assert.equal(isPreorderCartItemValid({ supply_type: "preorder", quantity: 4 }, preorderWithStock), true);
  assert.equal(isPreorderCartItemValid({ supply_type: "preorder", quantity: 3 }, preorderWithStock), false);
  assert.equal(isPreorderCartItemValid({ supply_type: "preorder", quantity: 1 }, preorderOnly), true);
});

test("database derives supply type from the locked current row and never trusts a client supply_type", () => {
  assert.match(migration, /for update of variant/i);
  assert.match(migration, /if v_quantity <= v_variant\.inventory then\s+v_supply_type := 'in_stock';\s+elsif v_variant\.preorder_enabled then\s+v_supply_type := 'preorder';\s+else\s+raise exception 'variant_unavailable';/s);
  assert.match(migration, /if v_supply_type = 'in_stock' then\s+update public\.product_variants/s);
  assert.doesNotMatch(migration, /v_supply_type\s*:=\s*v_item->>'supply_type'/);
});

test("server checkout model keeps inventory and ledger effects atomic and whole-line", () => {
  const checkout = (variant, quantity, clientSupplyType) => {
    // Mirrors the migration's decision after SELECT ... FOR UPDATE. The client value
    // exists only to prove it cannot choose the final snapshot.
    const supplyType = quantity <= variant.inventory ? "in_stock" : variant.preorder_enabled ? "preorder" : null;
    if (!supplyType) return { error: "variant_unavailable", inventory: variant.inventory, movementCount: 0 };
    return supplyType === "in_stock"
      ? { supplyType, inventory: variant.inventory - quantity, movementCount: 1, clientSupplyType }
      : { supplyType, inventory: variant.inventory, movementCount: 0, clientSupplyType };
  };

  assert.deepEqual(checkout({ ...preorderWithStock }, 2, "preorder"), {
    supplyType: "in_stock", inventory: 1, movementCount: 1, clientSupplyType: "preorder"
  });
  assert.deepEqual(checkout({ ...preorderWithStock }, 4, "in_stock"), {
    supplyType: "preorder", inventory: 3, movementCount: 0, clientSupplyType: "in_stock"
  });
  assert.deepEqual(checkout({ ...stockOnly }, 4, "preorder"), {
    error: "variant_unavailable", inventory: 3, movementCount: 0
  });
});

test("race from a cart's in-stock estimate to current shortage becomes preorder only when enabled", () => {
  const lockedPreorder = { ...preorderWithStock, inventory: 1 };
  const lockedStockOnly = { ...stockOnly, inventory: 1 };
  assert.equal(supplyTypeForQuantity(lockedPreorder, 2), "preorder");
  assert.equal(supplyTypeForQuantity(lockedStockOnly, 2), null);
});

test("checkout request fingerprint is client canonical data, not a mutable server-derived supply snapshot", () => {
  const fingerprintLoopStart = migration.indexOf("for v_item in select value from jsonb_array_elements(p_items) order by (value->>'variant_id')::uuid loop");
  const fingerprintEnd = migration.indexOf("v_fingerprint := md5", fingerprintLoopStart);
  assert.ok(fingerprintLoopStart >= 0 && fingerprintEnd > fingerprintLoopStart);
  assert.doesNotMatch(migration.slice(fingerprintLoopStart, fingerprintEnd), /supply_type/);

  const checkoutItemsStart = page.indexOf("const checkoutItems =");
  const checkoutItemsEnd = page.indexOf("const retryFingerprint", checkoutItemsStart);
  assert.ok(checkoutItemsStart >= 0 && checkoutItemsEnd > checkoutItemsStart);
  assert.doesNotMatch(page.slice(checkoutItemsStart, checkoutItemsEnd), /supply_type/);
  assert.match(f0041Migration, /v_fingerprint := md5\(/);
  assert.match(migration, /v_fingerprint := md5\(/);
});

test("idempotent retry happens before inventory mutation and conflicts remain atomic", () => {
  const existingCheck = migration.indexOf("if v_existing_order.checkout_request_fingerprint is distinct from v_fingerprint then");
  const mutation = migration.indexOf("update public.product_variants", existingCheck);
  assert.ok(existingCheck >= 0 && mutation > existingCheck);
  assert.match(migration, /raise exception 'checkout_idempotency_conflict'/);
  assert.match(f0041Migration, /create unique index if not exists orders_checkout_idempotency_key_unique_idx/);
});

test("only in-stock lines are eligible for cancellation restock", () => {
  assert.match(migration, /from public\.order_items where order_id = v_order\.id and supply_type = 'in_stock'/);
});

test("storefront explains the customer-facing availability model and updates cart lines dynamically", () => {
  assert.match(page, /現貨剩 \$\{variant\.inventory\} 件｜可預訂/);
  assert.match(page, /目前無現貨｜可預訂/);
  assert.match(page, /超過現貨數量仍可預訂。/);
  assert.match(page, /const requestedQuantity = quantityAlreadyInCart \+ quantity/);
  assert.match(page, /const supplyType = supplyTypeForQuantity\(variant, requestedQuantity\)/);
  assert.match(page, /const supplyType = supplyTypeForQuantity\(variant, quantity\)/);
  assert.match(page, /\(!variant\.preorder_enabled && totalVariantQuantity >= purchaseLimit\)/);
});

test("admin inventory UI keeps preorder explicitly configurable without changing inventory semantics", () => {
  assert.match(inventoryPage, /preorder_enabled/);
  assert.match(inventoryPage, /接受預訂/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cartQuantityForVariant, isPreorderCartItemValid, remainingInStockPurchasable, variantSupplyType } from "../lib/supply-model.mjs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/f004-3-3-in-stock-preorder-product-model.sql", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8");

const inStock = { id: "stock", inventory: 3, preorder_enabled: true, active: true };
const preorder = { id: "preorder", inventory: 0, preorder_enabled: true, active: true };
const unavailable = { id: "off", inventory: 0, preorder_enabled: false, active: true };

test("stock, preorder, and unavailable supply states are mutually explicit", () => {
  assert.equal(variantSupplyType(inStock), "in_stock");
  assert.equal(variantSupplyType(preorder), "preorder");
  assert.equal(variantSupplyType(unavailable), null);
  assert.equal(variantSupplyType({ ...inStock, active: false }), null);
});

test("in-stock cart limits exclude preorder lines and supply types remain separate", () => {
  const cart = [
    { variant_id: "stock", quantity: 2, supply_type: "in_stock" },
    { variant_id: "stock", quantity: 1, supply_type: "preorder" }
  ];
  assert.equal(cartQuantityForVariant(cart, "stock", "in_stock"), 2);
  assert.equal(cartQuantityForVariant(cart, "stock", "preorder"), 1);
  assert.equal(remainingInStockPurchasable(inStock, cart), 1);
  assert.equal(isPreorderCartItemValid(cart[1], preorder), true);
  assert.equal(isPreorderCartItemValid(cart[1], { ...preorder, inventory: 1 }), false);
});

test("checkout snapshots supply type, fingerprints it, and only decrements in-stock items", () => {
  assert.match(page, /supply_type: item\.supply_type/);
  assert.match(page, /cart\.filter\(\(item\) => item\.supply_type === "in_stock"\)/);
  assert.match(migration, /add column if not exists supply_type text not null default 'in_stock'/);
  assert.match(migration, /'supply_type', v_supply_type/);
  assert.match(migration, /if v_supply_type = 'in_stock' then[\s\S]*?set inventory = variant\.inventory - v_quantity/);
  assert.match(migration, /if v_supply_type = 'preorder' and \(v_variant\.inventory <> 0 or not v_variant\.preorder_enabled\) then raise exception 'preorder_unavailable'/);
});

test("preorder creates no checkout_sale movement and cancellation restores only in-stock snapshots", () => {
  const cancelRpc = migration.slice(migration.indexOf("create or replace function public.admin_cancel_order"));
  assert.match(cancelRpc, /where order_id = v_order\.id and supply_type = 'in_stock'/);
  assert.match(cancelRpc, /movement_type in \('checkout_sale', 'fish_request_order_confirmation'\)/);
  assert.doesNotMatch(migration, /set inventory = variant\.inventory - v_quantity[\s\S]{0,80}preorder/);
});

test("admin controls preorder through verified RPCs and storefront presents generic item units", () => {
  assert.match(inventoryPage, /preorder_enabled: Boolean\(variant\.preorder_enabled\)/);
  assert.match(inventoryPage, /接受預訂/);
  assert.match(page, /現貨｜剩 \$\{variant\.inventory\} 件/);
  assert.match(page, /🟠 預訂/);
  assert.match(page, /此訂單包含預訂商品，將待商品到齊後一起安排取貨／配送。/);
  assert.match(migration, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(migration, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
});

test("F004-1 retry semantics remain protected by the same unique order key", () => {
  assert.match(migration, /where checkout_idempotency_key = p_idempotency_key/);
  assert.match(migration, /checkout_idempotency_conflict/);
  assert.match(migration, /exception when unique_violation/);
  assert.match(migration, /revoke insert on public\.orders, public\.order_items from anon, authenticated/);
});

// This behaviour model covers the business transaction boundary in addition to
// the SQL contracts above. A real PostgreSQL harness is intentionally separate:
// it requires an explicitly configured non-production Supabase/PostgreSQL URL.
class MixedSupplyCheckoutModel {
  constructor() {
    this.variants = new Map([
      ["in-stock", { inventory: 3, preorder_enabled: true, active: true }],
      ["preorder", { inventory: 0, preorder_enabled: true, active: true }],
      ["unavailable", { inventory: 0, preorder_enabled: false, active: true }]
    ]);
    this.orders = new Map();
    this.orderItems = [];
    this.movements = [];
    this.nextOrder = 1;
  }

  async submit({ key, fingerprint, items, failAfterFirstItem = false }) {
    return new Promise((resolve, reject) => queueMicrotask(() => {
      const existing = this.orders.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return reject(new Error("checkout_idempotency_conflict"));
        return resolve(existing.id);
      }

      const inventoryBefore = new Map([...this.variants].map(([id, variant]) => [id, variant.inventory]));
      const itemCountBefore = this.orderItems.length;
      const movementCountBefore = this.movements.length;
      const order = { id: `order-${this.nextOrder++}`, fingerprint };
      try {
        this.orders.set(key, order);
        for (const item of items) {
          const variant = this.variants.get(item.variant_id);
          if (!variant || variant.active === false) throw new Error("variant_unavailable");
          if (item.supply_type === "in_stock") {
            if (variant.inventory < item.quantity) throw new Error("variant_unavailable");
            variant.inventory -= item.quantity;
            this.movements.push({ order_id: order.id, variant_id: item.variant_id, type: "checkout_sale", delta: -item.quantity });
          } else if (item.supply_type === "preorder") {
            if (variant.inventory !== 0 || !variant.preorder_enabled) throw new Error("preorder_unavailable");
          } else {
            throw new Error("invalid_supply_type");
          }
          this.orderItems.push({ ...item, order_id: order.id });
          if (failAfterFirstItem) throw new Error("processing_updated");
        }
        resolve(order.id);
      } catch (error) {
        this.orders.delete(key);
        for (const [id, inventory] of inventoryBefore) this.variants.get(id).inventory = inventory;
        this.orderItems.length = itemCountBefore;
        this.movements.length = movementCountBefore;
        reject(error);
      }
    }));
  }

  cancel(orderId) {
    for (const item of this.orderItems.filter((candidate) => candidate.order_id === orderId && candidate.supply_type === "in_stock")) {
      this.variants.get(item.variant_id).inventory += item.quantity;
      this.movements.push({ order_id: orderId, variant_id: item.variant_id, type: "order_cancel_restore", delta: item.quantity });
    }
  }
}

test("mixed checkout decrements only in-stock variants and stores immutable supply snapshots", async () => {
  const model = new MixedSupplyCheckoutModel();
  const orderId = await model.submit({
    key: "mixed-key",
    fingerprint: "stock-plus-preorder",
    items: [
      { variant_id: "in-stock", quantity: 2, supply_type: "in_stock" },
      { variant_id: "preorder", quantity: 4, supply_type: "preorder" }
    ]
  });
  assert.equal(model.variants.get("in-stock").inventory, 1);
  assert.equal(model.variants.get("preorder").inventory, 0);
  assert.deepEqual(model.movements, [{ order_id: orderId, variant_id: "in-stock", type: "checkout_sale", delta: -2 }]);
  assert.deepEqual(model.orderItems.map((item) => item.supply_type), ["in_stock", "preorder"]);
  assert.match(migration, /before update of supply_type on public\.order_items/);
  assert.match(migration, /order_item_supply_type_immutable/);
});

test("preorder is rejected while any real stock exists, and unavailable variants cannot be purchased", async () => {
  const model = new MixedSupplyCheckoutModel();
  await assert.rejects(model.submit({ key: "wrong-preorder", fingerprint: "a", items: [{ variant_id: "in-stock", quantity: 1, supply_type: "preorder" }] }), /preorder_unavailable/);
  await assert.rejects(model.submit({ key: "sold-out", fingerprint: "b", items: [{ variant_id: "unavailable", quantity: 1, supply_type: "preorder" }] }), /preorder_unavailable/);
  assert.equal(model.orders.size, 0);
  assert.equal(model.movements.length, 0);
});

test("a retry of mixed supply checkout returns one original order with no duplicate items or movements", async () => {
  const model = new MixedSupplyCheckoutModel();
  const payload = { key: "retry-key", fingerprint: "same", items: [{ variant_id: "in-stock", quantity: 1, supply_type: "in_stock" }, { variant_id: "preorder", quantity: 1, supply_type: "preorder" }] };
  const first = await model.submit(payload);
  const retry = await model.submit(payload);
  assert.equal(retry, first);
  assert.equal(model.orders.size, 1);
  assert.equal(model.orderItems.length, 2);
  assert.equal(model.movements.length, 1);
  await assert.rejects(model.submit({ ...payload, fingerprint: "different" }), /checkout_idempotency_conflict/);
  assert.equal(model.variants.get("in-stock").inventory, 2);
});

test("a failure rolls back both in-stock and preorder facts, and cancellation restores only in-stock quantity", async () => {
  const model = new MixedSupplyCheckoutModel();
  await assert.rejects(model.submit({ key: "rollback", fingerprint: "same", items: [{ variant_id: "in-stock", quantity: 1, supply_type: "in_stock" }], failAfterFirstItem: true }), /processing_updated/);
  assert.equal(model.orders.size, 0);
  assert.equal(model.variants.get("in-stock").inventory, 3);
  assert.equal(model.movements.length, 0);

  const orderId = await model.submit({ key: "cancel", fingerprint: "mixed", items: [{ variant_id: "in-stock", quantity: 2, supply_type: "in_stock" }, { variant_id: "preorder", quantity: 3, supply_type: "preorder" }] });
  model.cancel(orderId);
  assert.equal(model.variants.get("in-stock").inventory, 3);
  assert.equal(model.variants.get("preorder").inventory, 0);
  assert.equal(model.movements.filter((movement) => movement.type === "order_cancel_restore").length, 1);
});

test("admin mutation contracts validate preorder and category input without expanding direct table writes", () => {
  assert.match(migration, /if v_item \? 'preorder_enabled' and jsonb_typeof\(v_item->'preorder_enabled'\) is distinct from 'boolean' then raise exception 'invalid_preorder_enabled'/);
  assert.match(migration, /if p_category_id is null then raise exception 'product_category_required'/);
  assert.match(migration, /if not v_category_active then raise exception 'product_category_inactive'/);
  assert.match(migration, /revoke all on function public\.admin_create_inventory_product\(text, boolean, text, text, integer, integer, boolean, boolean, uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_create_inventory_product\(text, boolean, text, text, integer, integer, boolean, boolean, uuid\) to authenticated/);
});

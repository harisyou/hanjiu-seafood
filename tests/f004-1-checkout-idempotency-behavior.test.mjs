import assert from "node:assert/strict";
import test from "node:test";

// A behavioural model documents the transaction invariant independently of the
// SQL source contract. PostgreSQL integration coverage is in tests/integration
// and requires an explicitly provisioned non-production database.
class CheckoutTransactionModel {
  constructor(inventory = 3) {
    this.inventory = inventory;
    this.orders = new Map();
    this.movements = [];
    this.nextOrder = 1;
  }

  async submit({ key, fingerprint, quantity, failAfterOrder = false }) {
    const existing = this.orders.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("checkout_idempotency_conflict");
      return existing.id;
    }
    // This critical section models the DB partial-unique-index serialization.
    return new Promise((resolve, reject) => queueMicrotask(() => {
      const concurrent = this.orders.get(key);
      if (concurrent) {
        if (concurrent.fingerprint !== fingerprint) return reject(new Error("checkout_idempotency_conflict"));
        return resolve(concurrent.id);
      }
      if (quantity > this.inventory) return reject(new Error("variant_unavailable"));
      const originalInventory = this.inventory;
      const originalMovementCount = this.movements.length;
      const order = { id: `order-${this.nextOrder++}`, fingerprint, items: [{ quantity }] };
      try {
        this.orders.set(key, order);
        if (failAfterOrder) throw new Error("processing_updated");
        this.inventory -= quantity;
        this.movements.push({ type: "checkout_sale", quantity: -quantity, orderId: order.id });
        resolve(order.id);
      } catch (error) {
        this.orders.delete(key);
        this.inventory = originalInventory;
        this.movements.length = originalMovementCount;
        reject(error);
      }
    }));
  }
}

test("sequential same-key retry returns the original order without a second item or stock deduction", async () => {
  const model = new CheckoutTransactionModel(3);
  const first = await model.submit({ key: "key-1", fingerprint: "same", quantity: 1 });
  const retry = await model.submit({ key: "key-1", fingerprint: "same", quantity: 1 });
  assert.equal(retry, first);
  assert.equal(model.orders.size, 1);
  assert.equal(model.inventory, 2);
  assert.deepEqual(model.movements, [{ type: "checkout_sale", quantity: -1, orderId: first }]);
});

test("concurrent same-key submissions serialize to one order, one item set, and one movement", async () => {
  const model = new CheckoutTransactionModel(3);
  const ids = await Promise.all(Array.from({ length: 8 }, () => model.submit({ key: "key-1", fingerprint: "same", quantity: 1 })));
  assert.equal(new Set(ids).size, 1);
  assert.equal(model.orders.size, 1);
  assert.equal(model.orders.get("key-1").items.length, 1);
  assert.equal(model.inventory, 2);
  assert.equal(model.movements.length, 1);
});

test("same key with a different canonical payload conflicts without mutation", async () => {
  const model = new CheckoutTransactionModel(3);
  await model.submit({ key: "key-1", fingerprint: "quantity-1", quantity: 1 });
  await assert.rejects(model.submit({ key: "key-1", fingerprint: "quantity-2", quantity: 2 }), /checkout_idempotency_conflict/);
  assert.equal(model.inventory, 2);
  assert.equal(model.orders.size, 1);
  assert.equal(model.movements.length, 1);
});

test("a transaction failure leaves no idempotency residue and a safe retry can create exactly one order", async () => {
  const model = new CheckoutTransactionModel(3);
  await assert.rejects(model.submit({ key: "key-1", fingerprint: "same", quantity: 1, failAfterOrder: true }), /processing_updated/);
  assert.equal(model.orders.size, 0);
  assert.equal(model.inventory, 3);
  assert.equal(model.movements.length, 0);
  await model.submit({ key: "key-1", fingerprint: "same", quantity: 1 });
  assert.equal(model.orders.size, 1);
  assert.equal(model.inventory, 2);
});

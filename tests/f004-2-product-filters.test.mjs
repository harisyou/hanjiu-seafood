import assert from "node:assert/strict";
import test from "node:test";
import { filterProducts, hasPurchasableVariant, normalizeProductSearch, sortActiveProductCategories } from "../lib/product-filters.mjs";

const products = [
  { id: "fish", name: "馬頭魚", status: "available", category_id: "live" },
  { id: "shrimp", name: "白蝦", status: "available", category_id: "shrimp" },
  { id: "frozen", name: "冷凍干貝", status: "available", category_id: "frozen" },
  { id: "sold-out", name: "午仔魚", status: "sold_out", category_id: "live" }
];

const variants = [
  { id: "fish-ready", product_id: "fish", active: true, inventory: 2 },
  { id: "shrimp-empty", product_id: "shrimp", active: true, inventory: 0 },
  { id: "frozen-ready", product_id: "frozen", active: true, inventory: 1 },
  { id: "sold-out-ready", product_id: "sold-out", active: true, inventory: 4 }
];

test("normalizes product search text deterministically", () => {
  assert.equal(normalizeProductSearch("  馬頭　魚 "), "馬頭 魚");
});

test("sorts only active database-backed categories by sort order", () => {
  const categories = [
    { id: "other", name: "其他", sort_order: 500, active: true },
    { id: "hidden", name: "隱藏", sort_order: 1, active: false },
    { id: "live", name: "現流魚", sort_order: 100, active: true }
  ];
  assert.deepEqual(sortActiveProductCategories(categories).map((category) => category.id), ["live", "other"]);
});

test("filters by name, formal category reference, and purchasable variant together", () => {
  assert.deepEqual(filterProducts(products, variants, { query: "馬頭", category: "live", inStockOnly: true }).map((product) => product.id), ["fish"]);
  assert.deepEqual(filterProducts(products, variants, { query: "", category: "frozen", inStockOnly: true }).map((product) => product.id), ["frozen"]);
  assert.deepEqual(filterProducts(products, variants, { query: "", category: "all", inStockOnly: true }).map((product) => product.id), ["fish", "frozen"]);
});

test("out-of-stock mode respects product status and active variants", () => {
  assert.equal(hasPurchasableVariant(products[1], variants), false);
  assert.equal(hasPurchasableVariant(products[3], variants), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { filterProducts, hasPurchasableVariant, normalizeProductSearch, productCategory } from "../lib/product-filters.mjs";

const products = [
  { id: "fish", name: "馬頭魚", status: "available", fish_catalog_id: "catalog-fish" },
  { id: "shrimp", name: "白蝦", status: "available", fish_catalog_id: null },
  { id: "shellfish", name: "九孔鮑", status: "available", fish_catalog_id: null },
  { id: "frozen", name: "冷凍干貝", status: "available", fish_catalog_id: null },
  { id: "sold-out", name: "午仔魚", status: "sold_out", fish_catalog_id: "catalog-fish" }
];

const variants = [
  { id: "fish-ready", product_id: "fish", active: true, inventory: 2 },
  { id: "shrimp-empty", product_id: "shrimp", active: true, inventory: 0 },
  { id: "shellfish-inactive", product_id: "shellfish", active: false, inventory: 5 },
  { id: "frozen-ready", product_id: "frozen", active: true, inventory: 1 },
  { id: "sold-out-ready", product_id: "sold-out", active: true, inventory: 4 }
];

test("normalizes product search text deterministically", () => {
  assert.equal(normalizeProductSearch("  馬頭　魚 "), "馬頭 魚");
});

test("classifies products with the documented lightweight rule", () => {
  assert.equal(productCategory(products[0]), "live_fish");
  assert.equal(productCategory(products[1]), "shrimp_crab");
  assert.equal(productCategory(products[2]), "shellfish");
  assert.equal(productCategory(products[3]), "frozen");
});

test("filters by name, category, and purchasable variant together", () => {
  assert.deepEqual(filterProducts(products, variants, { query: "馬頭", category: "live_fish", inStockOnly: true }).map((product) => product.id), ["fish"]);
  assert.deepEqual(filterProducts(products, variants, { query: "", category: "frozen", inStockOnly: true }).map((product) => product.id), ["frozen"]);
  assert.deepEqual(filterProducts(products, variants, { query: "", category: "all", inStockOnly: true }).map((product) => product.id), ["fish", "frozen"]);
});

test("out-of-stock mode respects product status and active variants", () => {
  assert.equal(hasPurchasableVariant(products[1], variants), false);
  assert.equal(hasPurchasableVariant(products[2], variants), false);
  assert.equal(hasPurchasableVariant(products[4], variants), false);
});

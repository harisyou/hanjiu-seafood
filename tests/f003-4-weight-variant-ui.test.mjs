import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const storefront = readFileSync(new URL("../components/storefront-shell.tsx", import.meta.url), "utf8");
const inventoryPage = readFileSync(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8");
const inventoryDetail = readFileSync(new URL("../app/admin/inventory/[id]/page.tsx", import.meta.url), "utf8");
const variantsPage = readFileSync(new URL("../app/admin/variants/page.tsx", import.meta.url), "utf8");
const schema = readFileSync(new URL("../supabase/f001-product-variants.sql", import.meta.url), "utf8");
const supplyModel = readFileSync(new URL("../lib/supply-model.mjs", import.meta.url), "utf8");

test("existing variant schema supports range name, fixed price, and remaining fish count", () => {
  assert.match(schema, /name text not null/);
  assert.match(schema, /price integer not null check \(price >= 0\)/);
  assert.match(schema, /inventory integer not null default 0 check \(inventory >= 0\)/);
  assert.doesNotMatch(schema, /exact_weight|fish_unit|individual_fish/i);
});

test("storefront explains that ranges use pre-processing weight", () => {
  assert.ok(storefront.includes("※ 商品重量皆為處理前重量，處理後重量會依處理方式有所減少。"));
});

test("zero-inventory variant remains visible and only non-preorder variants are disabled", () => {
  assert.match(storefront, /displayVariants\.map/);
  assert.match(storefront, /variantSupplyType\(variant\)/);
  assert.match(supplyModel, /return variant\.preorder_enabled \? "preorder" : null/);
  assert.match(storefront, /<option value=\{variant\.id\} disabled=\{unavailable\}/);
  assert.match(storefront, /\{variant\.name\}｜\{formatPrice\(variant\.price\)\}<\/option>/);
  assert.match(storefront, /selectedVariant\.preorder_enabled \? selectedVariant\.inventory > 0 \? `現貨剩 \$\{selectedVariant\.inventory\} 件｜可預訂` : "目前無現貨｜可預訂"/);
  assert.match(storefront, /const soldOut = purchasableVariants\.length === 0/);
  assert.match(storefront, /if \(soldOut\) return <article className="catalogSoldOut"/);
  assert.match(storefront, /<button type="button" disabled>已售完<\/button>/);
});

test("one sold-out range does not change the product or sibling variants", () => {
  assert.doesNotMatch(storefront, /inventory\s*===?\s*0[\s\S]{0,120}status\s*:/);
  assert.match(storefront, /setCatalogRefresh\(\(current\) => current \+ 1\)/);
  assert.match(storefront, /The server may safely reclassify a cart line from in_stock to preorder/);
});

test("inventory admin consistently uses weight ranges and generic item units", () => {
  for (const source of [inventoryPage, inventoryDetail, variantsPage]) {
    assert.ok(source.includes("150g～200g"));
    assert.ok(source.includes("現貨件數"));
  }
  assert.ok(inventoryPage.includes("固定售價"));
  assert.ok(inventoryDetail.includes("處理前"));
});

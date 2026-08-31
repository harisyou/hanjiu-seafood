import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const adminProducts = fs.readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
const storefront = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const productFilters = fs.readFileSync(new URL("../lib/product-filters.mjs", import.meta.url), "utf8");

test("admin assignment loads database categories in sort order and saves the selected category_id", () => {
  assert.match(adminProducts, /from\("product_categories"\)\.select\("\*"\)\.order\("sort_order"\)\.order\("name"\)/);
  assert.match(adminProducts, /category_id: ""/);
  assert.match(adminProducts, /const payload = \{ \.\.\.form,/);
  assert.match(adminProducts, /請選擇有效的商品類別/);
  assert.match(adminProducts, /activeProductCategories\.map/);
});

test("new categories remain data-driven and inactive categories cannot be assigned to a new product", () => {
  assert.match(adminProducts, /const activeProductCategories = productCategories\.filter\(\(category\) => category\.active\)/);
  assert.doesNotMatch(adminProducts, /<option value="(?:live_fish|shrimp_crab|shellfish|frozen|other)"/);
  assert.match(adminProducts, /!form\.category_id \|\| !productCategories\.some\(\(category\) => category\.id === form\.category_id && category\.active\)/);
});

test("editing an item in a disabled category preserves and explains its current category until reassigned", () => {
  assert.match(adminProducts, /目前商品類別「\$\{category\.name\}」已停用；請改選啟用中的商品類別後再儲存/);
  assert.match(adminProducts, /selectedFormCategory && !selectedFormCategory\.active/);
  assert.match(adminProducts, /已停用，請重新選擇/);
  assert.match(adminProducts, /僅可指派啟用中的類別；選單依前台排序顯示/);
});

test("storefront continues to filter by the updated relational category_id", () => {
  assert.match(productFilters, /product\.category_id !== filters\.category/);
  assert.match(storefront, /from\("product_categories"\)/);
});

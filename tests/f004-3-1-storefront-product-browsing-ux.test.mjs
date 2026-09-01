import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const filters = readFileSync(new URL("../app/product-filters.css", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const categoryReadPolicy = readFileSync(new URL("../supabase/f004-3-1-storefront-product-categories-read-policy.sql", import.meta.url), "utf8");

test("storefront keeps database-backed category filtering and combined stock filtering", () => {
  assert.match(page, /sortActiveProductCategories\(productCategories\)/);
  assert.match(page, /filterProducts\(products, variants, \{ query: productSearch, category: selectedProductCategory, inStockOnly \}\)/);
  assert.doesNotMatch(page, /productCategory\(/);
});

test("browse controls provide accessible search, dynamic chips, stock toggle, and conditional reset", () => {
  assert.match(page, /placeholder="搜尋商品名稱，例如：馬頭"/);
  assert.match(page, /aria-label="清除商品搜尋"/);
  assert.match(page, /storefrontCategories\.map/);
  assert.match(page, /aria-label="商品分類"/);
  assert.match(page, /只看有貨/);
  assert.match(page, /filtersActive && <button[^>]*className="productFilterReset"/);
  assert.match(page, /const clearProductFilters = \(\) => \{/);
});

test("browse area has loading, retryable error, and filter-aware empty states", () => {
  assert.match(page, /catalogLoading/);
  assert.match(page, /商品載入中/);
  assert.match(page, /catalogError/);
  assert.match(page, /暫時無法載入今日海鮮/);
  assert.match(page, /重新載入/);
  assert.match(page, /目前沒有符合條件的商品/);
  assert.match(page, /今天的魚貨正在準備中/);
});

test("a category-only query failure does not hide otherwise available products", () => {
  assert.match(page, /const \[categoryLoadError, setCategoryLoadError\] = useState\(""\)/);
  assert.match(page, /if \(categoryResult\.error\) \{[\s\S]*?setCategoryLoadError\("商品類別暫時無法載入，已先顯示全部商品。"\)/);
  assert.match(page, /if \(productResult\.error \|\| variantResult\.error\) setCatalogError/);
  assert.doesNotMatch(page, /productResult\.error \|\| variantResult\.error \|\| categoryResult\.error\) setCatalogError/);
  assert.match(page, /重新載入類別/);
});

test("anonymous category reads never evaluate the admin authorization function", () => {
  const publicPolicy = categoryReadPolicy.match(/create policy "public read active product categories"[\s\S]*?using \(active\);/i)?.[0] || "";
  assert.match(categoryReadPolicy, /^begin;/mi);
  assert.match(categoryReadPolicy, /drop policy if exists "public read active product categories"/i);
  assert.match(publicPolicy, /to anon, authenticated[\s\S]*?using \(active\)/i);
  assert.doesNotMatch(publicPolicy, /is_hanjiu_admin/i);
  assert.match(categoryReadPolicy, /create policy "admin read all product categories"[\s\S]*?to authenticated[\s\S]*?using \(\(select public\.is_hanjiu_admin\(\)\)\)/i);
  assert.match(categoryReadPolicy, /commit;/i);
});

test("sold-out cards keep the status in their information area without obscuring the photo", () => {
  assert.match(page, /storefrontProductCard/);
  assert.doesNotMatch(page, /productAvailability/);
  assert.match(page, /<small>\{soldOut \? "已售完" : "今日供應"\}<\/small>/);
  assert.match(page, /product\.featured && <div className="productCardBadges"><b>本日精選<\/b><\/div>/);
  assert.match(page, /選擇規格/);
  assert.match(page, /本次可購買/);
  assert.match(page, /加入購物車/);
  assert.match(page, /disabled=\{unavailable\}/);
});

test("mobile browsing remains horizontally contained and reduced-motion users do not receive shimmer", () => {
  assert.match(filters, /\.productCategoryChips[\s\S]*?overflow-x: auto/);
  assert.match(filters, /@media \(max-width: 560px\)/);
  assert.match(filters, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.storefrontProductCard \.photo\{height:auto;aspect-ratio:4\/3/);
  assert.match(css, /@media\(max-width:700px\).*?\.storefrontProductCard \.photo\{aspect-ratio:16\/10/);
});

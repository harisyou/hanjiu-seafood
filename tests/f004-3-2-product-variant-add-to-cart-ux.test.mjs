import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("variant selector makes multi-price choice and the selected specification explicit", () => {
  assert.match(page, /const hasMultipleVariantPrices = new Set\(displayVariants\.map\(\(variant\) => variant\.price\)\)\.size > 1/);
  assert.match(page, /不同規格有不同價格，請選擇後查看確切價格。/);
  assert.match(page, /className="variantDetails variantSelectionSummary"/);
  assert.match(page, /已選規格/);
  assert.match(page, /className="variantSelectedPrice"/);
  assert.match(page, /供應狀態/);
});

test("unselected, stale, inactive, and sold-out variants cannot be added", () => {
  assert.match(page, /const staleSelectedVariant = Boolean\(selectedVariants\[product\.id\] && !selectedVariant\)/);
  assert.match(page, /此規格目前無法購買，請重新選擇。/);
  assert.match(page, /staleSelectedVariant[\s\S]*?"請重新選擇規格"/);
  assert.match(page, /const unavailable = product\.status !== "available" \|\| !supplyType/);
  assert.match(page, /disabled=\{unavailable\}/);
  assert.match(page, /disabled=\{soldOut \|\| !selectedVariant \|\| cartLimitReached/);
  assert.match(page, /\? "已售完"/);
});

test("the existing cart path still separates variants and immediately reports the successful add", () => {
  assert.match(page, /const cartKey = processingSignature\(variant\.id, supplyType, processingSelection\)/);
  assert.match(page, /item\.cart_key === found\.cart_key \? \{ \.\.\.item, cart_key: cartKey, quantity: requestedQuantity, supply_type: supplyType \}/);
  assert.match(page, /variant_id: variant\.id/);
  assert.match(page, /setCartToast\(successMessage\)/);
  assert.match(page, /setCartBounceKey\(\(current\) => current \+ 1\)/);
  assert.match(page, /supply_type: supplyType/);
});

test("variant controls remain mobile touch-sized, contained, and motion-safe", () => {
  assert.match(css, /\.storefrontProductCard \.variantSelector select\{[\s\S]*?min-height:52px/);
  assert.match(css, /\.storefrontProductCard \.variantQuantity button\{width:48px;height:48px/);
  assert.match(css, /\.storefrontProductCard \.addToCartButton\{min-height:52px/);
  assert.match(css, /@media\(max-width:700px\)\{[\s\S]*?\.storefrontProductCard \.variantSelector select\{min-height:54px/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
});

test("F004-3.1 inventory-aware filtering remains database-backed", () => {
  assert.match(page, /filterProducts\(products, variants, \{ query: productSearch, category: selectedProductCategory, inStockOnly \}\)/);
  assert.match(page, /sortActiveProductCategories\(productCategories\)/);
  assert.doesNotMatch(page, /productCategory\(/);
});

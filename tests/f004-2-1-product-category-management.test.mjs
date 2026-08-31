import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(new URL("../supabase/f004-2-1-product-category-management.sql", import.meta.url), "utf8");
const storefront = fs.readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const adminProducts = fs.readFileSync(new URL("../app/admin/page.tsx", import.meta.url), "utf8");
const adminCategories = fs.readFileSync(new URL("../app/admin/categories/page.tsx", import.meta.url), "utf8");

test("migration creates relational categories, seeds initial categories, and backfills only uncategorized products", () => {
  assert.match(migration, /create table if not exists public\.product_categories/i);
  for (const category of ["現流魚", "蝦蟹", "貝類", "冷凍", "其他"]) assert.match(migration, new RegExp(`'${category}'`));
  assert.match(migration, /alter table public\.products add column if not exists category_id uuid/i);
  assert.match(migration, /foreign key \(category_id\) references public\.product_categories\(id\) on delete restrict/i);
  assert.match(migration, /where product\.category_id is null/i);
  assert.match(migration, /alter table public\.products alter column category_id set not null/i);
});

test("one-time backfill keeps cephalopods out of the live-fish name rule so they fall back to 其他", () => {
  const liveFishRule = migration.match(/when product\.fish_catalog_id is not null or btrim\(coalesce\(product\.name, ''\)\) ~\* '([^']+)' then category_ids\.live_fish_id/i);
  assert.ok(liveFishRule, "live-fish backfill rule must exist");
  assert.match(liveFishRule[1], /魚|鯛|馬頭/);
  for (const cephalopod of ["透抽", "小卷", "花枝", "魷"]) assert.doesNotMatch(liveFishRule[1], new RegExp(cephalopod));
  assert.match(migration, /else category_ids\.other_id/i);
});

test("cephalopod backfill takes precedence over fish_catalog_id so catalog classification cannot force 現流魚", () => {
  const cephalopodRule = migration.indexOf("when btrim(coalesce(product.name, '')) ~* '透抽|小卷|花枝|魷' then category_ids.other_id");
  const catalogLiveFishRule = migration.indexOf("when product.fish_catalog_id is not null");
  assert.ok(cephalopodRule >= 0, "cephalopod rule must exist");
  assert.ok(catalogLiveFishRule >= 0, "fish_catalog_id live-fish rule must exist");
  assert.ok(cephalopodRule < catalogLiveFishRule, "cephalopods must be classified before fish_catalog_id is considered");
});

test("migration protects category integrity and delegates all writes to verified admin RPCs", () => {
  assert.match(migration, /product_categories_normalized_name_key/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /public read active product categories/i);
  assert.match(migration, /revoke all on table public\.product_categories from public, anon, authenticated/i);
  for (const fn of ["admin_create_product_category", "admin_update_product_category", "admin_delete_product_category"]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`, "i"));
    assert.match(migration, new RegExp(`revoke all on function public\\.${fn}`, "i"));
  }
  assert.match(migration, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/i);
  assert.match(migration, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /raise exception 'category_in_use'/i);
});

test("storefront reads active categories and filters by saved category reference, not name inference", () => {
  assert.match(storefront, /from\("product_categories"\)\.select\("id,name,sort_order,active"\)\.eq\("active", true\)/);
  assert.match(storefront, /sortActiveProductCategories\(productCategories\)/);
  assert.doesNotMatch(storefront, /PRODUCT_CATEGORIES|productCategory\(/);
});

test("admin product form requires an active category and category management uses controlled RPCs", () => {
  assert.match(adminProducts, /商品類別 \*/);
  assert.match(adminProducts, /請選擇有效的商品類別/);
  assert.match(adminCategories, /admin_create_product_category/);
  assert.match(adminCategories, /admin_update_product_category/);
  assert.match(adminCategories, /admin_delete_product_category/);
  assert.match(adminCategories, /此類別目前有 \$\{count\} 個商品使用中/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildFishMatches, fishIdentityMatches } from "../lib/fish-matching.ts";

const migrationUrl = new URL("../supabase/f003-6-fish-catalog.sql", import.meta.url);
const product = (overrides = {}) => ({ id: "p1", name: "馬頭魚商品", fish_catalog_id: "fish-1", status: "available", ...overrides });
const request = (overrides = {}) => ({ id: "r1", fish_name: "甘鯛", fish_catalog_id: "fish-1", status: "waiting", ...overrides });
const variant = (overrides = {}) => ({ id: "v1", product_id: "p1", active: true, inventory: 2, ...overrides });

test("catalog IDs take priority over names", () => {
  assert.equal(fishIdentityMatches(product(), request()), true);
  assert.equal(fishIdentityMatches(product(), request({ fish_catalog_id: "fish-2", fish_name: "馬頭魚商品" })), false);
  assert.equal(buildFishMatches([product()], [variant()], [request()])[0].requests.length, 1);
});

test("legacy rows fall back to normalized exact names only when either side is unclassified", () => {
  assert.equal(fishIdentityMatches(product({ fish_catalog_id: null, name: "　馬頭魚 " }), request({ fish_catalog_id: "fish-1", fish_name: "馬頭魚" })), true);
  assert.equal(fishIdentityMatches(product({ fish_catalog_id: null, name: "馬頭" }), request({ fish_catalog_id: null, fish_name: "馬頭魚" })), false);
});

test("migration creates independent catalog and globally unique normalized aliases", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists public\.fish_catalog/);
  assert.match(sql, /create table if not exists public\.fish_aliases/);
  assert.match(sql, /fish_aliases_normalized_alias_unique_idx/);
  assert.match(sql, /lower\(regexp_replace\(btrim\(alias\)/);
  assert.match(sql, /fish_catalog_id uuid not null references public\.fish_catalog\(id\) on delete cascade/);
});

test("migration preserves historical rows with nullable FKs and no destructive backfill", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /alter table public\.fish_requests add column if not exists fish_catalog_id uuid;/);
  assert.match(sql, /alter table public\.products add column if not exists fish_catalog_id uuid;/);
  assert.match(sql, /on delete set null not valid/);
  assert.doesNotMatch(sql, /update public\.(fish_requests|products) set fish_catalog_id/i);
});

test("new RPC trusts active catalog name while preserving the 11-parameter wrapper", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /where id = p_fish_catalog_id and active;/);
  assert.match(sql, /raise exception 'fish_catalog_unavailable'/);
  assert.match(sql, /p_preferred_notification_channel, null::uuid/);
  assert.match(sql, /p_wanted_by is not null and p_wanted_by < current_date/);
  assert.match(sql, /public\.find_or_create_customer/);
  assert.match(sql, /line_user_id, fish_catalog_id, fish_name/);
});

test("security exposes active catalog reads but protects all writes and aliases", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /public read active fish catalog[\s\S]*using \(active\)/);
  assert.match(sql, /admin (insert|update) fish catalog[\s\S]*public\.is_hanjiu_admin/);
  assert.match(sql, /admin (insert|delete) fish aliases[\s\S]*public\.is_hanjiu_admin/);
  assert.match(sql, /revoke all on public\.fish_catalog, public\.fish_aliases from public, anon, authenticated/);
  assert.doesNotMatch(sql, /grant (insert|update|delete) on public\.fish_catalog to anon/);
  assert.doesNotMatch(sql, /grant select on public\.fish_aliases to anon/);
});

test("request form uses the active catalog and supports an explicit other option", async () => {
  const source = await readFile(new URL("../app/fish-request-form.tsx", import.meta.url), "utf8");
  assert.match(source, /from\("fish_catalog"\)\.select\("id,name,sort_order"\)/);
  assert.match(source, /其他（選單沒有）/);
  assert.match(source, /請輸入想找的魚 \*/);
  assert.match(source, /p_fish_catalog_id/);
});

test("admin supports catalog maintenance, product classification, and request classification", async () => {
  const [catalogPage, inventoryPage, requestPage] = await Promise.all([
    readFile(new URL("../app/admin/fish-catalog/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/inventory/[id]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/requests/[id]/page.tsx", import.meta.url), "utf8")
  ]);
  assert.match(catalogPage, /搜尋魚種或別名/);
  assert.match(catalogPage, /等待需求/);
  assert.match(inventoryPage, /AdminCatalogEditor id=\{id\}/);
  const editor = await readFile(new URL("../components/admin-catalog-editor.tsx", import.meta.url), "utf8");
  assert.match(editor, /fish_catalog_id/);
  assert.match(editor, /既有重複資料仍可編輯/);
  assert.match(requestPage, /歸類魚種/);
  assert.match(requestPage, /原始輸入保持不變/);
});

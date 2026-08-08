import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildFishMatchGroups } from "../lib/fish-matching.ts";

const product = (id, overrides = {}) => ({ id, name: "馬頭魚", fish_catalog_id: "fish-1", status: "available", ...overrides });
const variant = (id, productId, overrides = {}) => ({ id, product_id: productId, active: true, inventory: 2, ...overrides });
const request = (overrides = {}) => ({ id: "request-1", fish_name: "馬頭魚", fish_catalog_id: "fish-1", status: "waiting", ...overrides });
const catalog = [{ id: "fish-1", name: "馬頭魚", active: true, sort_order: 1 }];

test("groups multiple available products by fish and deduplicates each request ID", () => {
  const groups = buildFishMatchGroups(
    [product("p1"), product("p2")],
    [variant("v1", "p1"), variant("v2", "p2")],
    [request()],
    catalog
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].products.length, 2);
  assert.equal(groups[0].availableVariants.length, 2);
  assert.equal(groups[0].requests.length, 1);
});

test("catalog ID matching and legacy exact-name fallback remain available", () => {
  assert.equal(buildFishMatchGroups([product("p1", { name: "不同商品名" })], [variant("v1", "p1")], [request({ fish_name: "不同需求名" })], catalog).length, 1);
  assert.equal(buildFishMatchGroups([product("p1", { fish_catalog_id: null })], [variant("v1", "p1")], [request({ fish_catalog_id: null })], catalog).length, 1);
  assert.equal(buildFishMatchGroups([product("p1", { fish_catalog_id: null, name: "馬頭" })], [variant("v1", "p1")], [request({ fish_catalog_id: null })], catalog).length, 0);
});

test("zero inventory, inactive variants, sold-out and hidden products do not match", () => {
  assert.equal(buildFishMatchGroups([product("p1")], [variant("v1", "p1", { inventory: 0 })], [request()], catalog).length, 0);
  assert.equal(buildFishMatchGroups([product("p1")], [variant("v1", "p1", { active: false })], [request()], catalog).length, 0);
  assert.equal(buildFishMatchGroups([product("p1", { status: "sold_out" })], [variant("v1", "p1")], [request()], catalog).length, 0);
  assert.equal(buildFishMatchGroups([product("p1", { status: "hidden" })], [variant("v1", "p1")], [request()], catalog).length, 0);
});

test("completed, cancelled, and legacy closed requests are excluded; waiting restores matching", () => {
  for (const status of ["converted", "cancelled", "closed"]) {
    assert.equal(buildFishMatchGroups([product("p1")], [variant("v1", "p1")], [request({ status })], catalog).length, 0);
  }
  assert.equal(buildFishMatchGroups([product("p1")], [variant("v1", "p1")], [request({ status: "waiting" })], catalog).length, 1);
});

test("status RPC is admin-only, validates request ID and never touches inventory", async () => {
  const sql = await readFile(new URL("../supabase/f003-7-arrival-notification-workflow.sql", import.meta.url), "utf8");
  assert.match(sql, /security definer[\s\S]*set search_path = public, pg_temp/);
  assert.match(sql, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(sql, /where id = p_request_id/);
  assert.match(sql, /if not found then raise exception 'fish_request_not_found'/);
  assert.match(sql, /revoke all on function public\.admin_update_fish_request_status\(uuid, text\)[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.admin_update_fish_request_status\(uuid, text\)[\s\S]*to authenticated/);
  assert.doesNotMatch(sql, /update public\.product_variants|\binventory\b\s*=/i);
});

test("migration preserves all historical statuses and both create_fish_request overloads", async () => {
  const [workflowSql, catalogSql] = await Promise.all([
    readFile(new URL("../supabase/f003-7-arrival-notification-workflow.sql", import.meta.url), "utf8"),
    readFile(new URL("../supabase/f003-6-fish-catalog.sql", import.meta.url), "utf8")
  ]);
  for (const status of ["waiting", "matched", "contacted", "converted", "closed", "cancelled"]) assert.match(workflowSql, new RegExp(`'${status}'`));
  assert.match(catalogSql, /text, text, text, text, text, text, text, date, text, text, text, uuid/);
  assert.match(catalogSql, /text, text, text, text, text, text, text, date, text, text, text\r?\n/);
  assert.doesNotMatch(workflowSql, /create_fish_request|create_checkout_order/);
});

test("matches UI exposes complete customer details, safe contacts and explicit workflow actions", async () => {
  const source = await readFile(new URL("../app/admin/matches/page.tsx", import.meta.url), "utf8");
  for (const text of ["數量需求", "尺寸偏好", "預算", "希望日期", "用途", "偏好通知", "備註"]) assert.match(source, new RegExp(text));
  assert.match(source, /href={`tel:/);
  assert.match(source, /href={`mailto:/);
  assert.match(source, /request\.line_user_id &&/);
  assert.doesNotMatch(source, /line\.me|api\.line|send.*line/i);
  assert.match(source, /admin_update_fish_request_status/);
  assert.match(source, /setRequests\(\(current\)/);
});

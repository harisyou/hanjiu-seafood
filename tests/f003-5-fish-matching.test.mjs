import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildFishMatches, normalizeFishName, requestHasAvailableMatch } from "../lib/fish-matching.ts";

const product = (overrides = {}) => ({ id: "product-1", name: "馬頭魚", status: "available", sort_order: 1, ...overrides });
const variant = (overrides = {}) => ({ id: "variant-1", product_id: "product-1", name: "150g～200g", price: 180, inventory: 3, active: true, sort_order: 1, ...overrides });
const request = (overrides = {}) => ({ id: "request-1", fish_name: "馬頭魚", status: "waiting", ...overrides });

test("normalizes case and full/half-width whitespace without fuzzy matching", () => {
  assert.equal(normalizeFishName("　 Tuna  Fish　"), "tuna fish");
  assert.notEqual(normalizeFishName("馬頭"), normalizeFishName("馬頭魚"));
});

test("matches an active request to an available product with sellable inventory", () => {
  const matches = buildFishMatches([product()], [variant()], [request({ fish_name: "　馬頭魚 " })]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].requests.length, 1);
  assert.equal(matches[0].availableVariants.length, 1);
  assert.equal(requestHasAvailableMatch(request(), matches), true);
});

test("excludes unavailable products and variants", () => {
  assert.equal(buildFishMatches([product({ status: "hidden" })], [variant()], [request()]).length, 0);
  assert.equal(buildFishMatches([product()], [variant({ active: false })], [request()]).length, 0);
  assert.equal(buildFishMatches([product()], [variant({ inventory: 0 })], [request()]).length, 0);
});

test("excludes completed request statuses while retaining operational active statuses", () => {
  assert.equal(buildFishMatches([product()], [variant()], [request({ status: "converted" }), request({ id: "closed", status: "closed" })]).length, 0);
  const matches = buildFishMatches([product()], [variant()], [request(), request({ id: "matched", status: "matched" }), request({ id: "contacted", status: "contacted" })]);
  assert.equal(matches[0].requests.length, 3);
});

test("keeps admin data protected by existing RLS and status-only update grant", async () => {
  const migration = await readFile(new URL("../supabase/f003-2-fish-requests.sql", import.meta.url), "utf8");
  assert.match(migration, /using \(\(select public\.is_hanjiu_admin\(\)\)\)/);
  assert.match(migration, /grant update \(status\) on public\.fish_requests to authenticated;/);
  assert.match(migration, /revoke all on public\.fish_requests from anon;/);
  assert.doesNotMatch(migration, /grant select on public\.fish_requests to anon;/);
});

test("admin pages expose match indicators without automatic notification behavior", async () => {
  const [matchesPage, inventoryPage, requestsPage] = await Promise.all([
    readFile(new URL("../app/admin/matches/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/inventory/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/requests/page.tsx", import.meta.url), "utf8")
  ]);
  assert.match(matchesPage, /只顯示目前有可售規格/);
  assert.match(matchesPage, /line_user_id/);
  assert.doesNotMatch(matchesPage, /supabase\.functions|sendNotification|通知客人/);
  assert.match(inventoryPage, /人正在等/);
  assert.match(requestsPage, /🐟 已到貨/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildArrivalContactMessage } from "../lib/arrival-contact.ts";
import { buildFishMatchGroups } from "../lib/fish-matching.ts";

test("deterministic message includes the correct fish without price or stock promises", () => {
  const message = buildArrivalContactMessage("王小姐", "馬頭魚");
  assert.match(message, /王小姐您好/);
  assert.match(message, /馬頭魚/);
  assert.doesNotMatch(message, /NT\$|價格|[0-9]+\s*(尾|份)|保證|一定.*保留/);
  assert.equal(message, buildArrivalContactMessage("王小姐", "馬頭魚"));
});

test("workspace displays complete request context and editable contact message", async () => {
  const source = await readFile(new URL("../app/admin/matches/contact-workspace.tsx", import.meta.url), "utf8");
  for (const text of ["客戶姓名", "正式魚種", "原始名稱快照", "電話", "Email", "LINE", "數量需求", "尺寸偏好", "預算", "希望日期", "用途", "備註", "偏好通知", "目前狀態"]) assert.match(source, new RegExp(text));
  assert.match(source, /<textarea/);
  assert.match(source, /navigator\.clipboard\.writeText\(message\)/);
  assert.match(source, /撥打電話/);
  assert.match(source, /開啟 Email/);
  assert.match(source, /需求詳情/);
});

test("opening the workspace changes local UI only and does not update status", async () => {
  const page = await readFile(new URL("../app/admin/matches/page.tsx", import.meta.url), "utf8");
  assert.match(page, /onClick=\{\(\) => setContactRequestId\(request\.id\)\}>聯絡客人/);
  assert.doesNotMatch(page, /onClick=\{\(\) => \{[^}]*setContactRequestId[^}]*updateStatus/s);
});

test("copy and contact workspace cannot modify inventory or create orders", async () => {
  const source = await readFile(new URL("../app/admin/matches/contact-workspace.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createClient|supabase|product_variants|inventory|create_checkout_order|orders/);
});

test("status actions still flow through the existing F003-7 admin RPC", async () => {
  const [page, workspace] = await Promise.all([
    readFile(new URL("../app/admin/matches/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/matches/contact-workspace.tsx", import.meta.url), "utf8")
  ]);
  assert.match(page, /supabase\.rpc\("admin_update_fish_request_status"/);
  assert.match(workspace, /arrivalWorkflowActions/);
  assert.match(workspace, /onUpdateStatus\(action\.status\)/);
});

test("LINE never creates a fake contact link", async () => {
  const source = await readFile(new URL("../app/admin/matches/contact-workspace.tsx", import.meta.url), "utf8");
  assert.match(source, /已綁定（目前無安全直達對話功能）/);
  assert.doesNotMatch(source, /line\.me|api\.line|href=\{[^}]*line_user_id/i);
});

test("completed, cancelled, and closed requests stay outside the workspace match set", () => {
  const products = [{ id: "p1", name: "馬頭魚", fish_catalog_id: "fish-1", status: "available" }];
  const variants = [{ id: "v1", product_id: "p1", active: true, inventory: 2 }];
  const catalog = [{ id: "fish-1", name: "馬頭魚", active: true, sort_order: 1 }];
  for (const status of ["converted", "cancelled", "closed"]) {
    const requests = [{ id: `r-${status}`, fish_name: "馬頭魚", fish_catalog_id: "fish-1", status }];
    assert.equal(buildFishMatchGroups(products, variants, requests, catalog).length, 0);
  }
});

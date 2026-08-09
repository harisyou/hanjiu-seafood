import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const requestList = readFileSync(new URL("../app/admin/requests/page.tsx", import.meta.url), "utf8");
const requestDetail = readFileSync(new URL("../app/admin/requests/[id]/page.tsx", import.meta.url), "utf8");
const orderList = readFileSync(new URL("../app/admin/orders/page.tsx", import.meta.url), "utf8");
const orderDetail = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");

test("request detail reads and renders all related orders with snapshot subtotals", () => {
  assert.match(requestDetail, /from\("orders"\)\.select\("\*,order_items\(\*\)"\)\.eq\("fish_request_id", params\.id\)/);
  assert.match(requestDetail, /目前沒有關聯訂單/);
  assert.match(requestDetail, /此需求已轉成訂單/);
  assert.match(requestDetail, /orderTotal\(order\)/);
  assert.match(requestDetail, /href=\{"\/admin\/orders\/" \+ order\.id\}/);
  assert.match(requestDetail, /a\.status === "draft" \? 1 : 0/);
});

test("request list maps related orders to a compact highest-stage indicator", () => {
  assert.match(requestList, /from\("orders"\)\.select\("id,fish_request_id,status"\)/);
  assert.match(requestList, /hasFormal = related\.some\(\(order\) => order\.status !== "draft"\)/);
  assert.match(requestList, /🧾 已轉訂單/);
  assert.match(requestList, /📝 訂單草稿/);
});

test("order detail displays source request only when a relation exists and is safe when missing", () => {
  assert.match(orderDetail, /if \(nextOrder\.fish_request_id\)/);
  assert.match(orderDetail, /from\("fish_requests"\)\.select\("\*"\)\.eq\("id", nextOrder\.fish_request_id\)\.maybeSingle\(\)/);
  assert.match(orderDetail, /來源魚貨需求/);
  assert.match(orderDetail, /來源需求目前無法讀取/);
  assert.match(orderDetail, /查看來源需求/);
  assert.match(orderDetail, /order\.fish_request_id && <section/);
});

test("order list marks fish-request-origin orders without changing existing filters or totals", () => {
  assert.match(orderList, /order\.fish_request_id && <small className="requestOrderOrigin">魚貨需求轉單<\/small>/);
  assert.match(orderList, /const todayOrders = orders\.filter\(\(order\) => order\.status !== "draft"/);
  assert.doesNotMatch(orderList, /update\(|insert\(|delete\(/);
});

test("linking pages only use existing admin queries and do not mutate inventory, requests, checkout, or orders", () => {
  const linkingSources = requestList + requestDetail + orderList + orderDetail;
  assert.doesNotMatch(linkingSources, /create_checkout_order/);
  assert.doesNotMatch(requestList + requestDetail, /product_variants"\)\.update/);
  assert.doesNotMatch(orderDetail, /product_variants"\)\.update/);
});

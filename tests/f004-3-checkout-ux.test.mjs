import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("pickup retains required exact date and time controls", () => {
  assert.match(page, /form\.fulfillment === "永春市場自取"[\s\S]*?取貨日期 \*[\s\S]*?type="date"[\s\S]*?取貨時間 \*[\s\S]*?type="time"/);
  assert.match(page, /if \(form\.fulfillment === "永春市場自取" && !form\.pickupTime\) return "請選擇取貨時間"/);
});

test("frozen and 7-11 delivery use a defaultable time slot, not an exact time", () => {
  assert.match(page, /deliveryTimeSlot: "不指定"/);
  assert.match(page, /const deliveryTimeSlots = \["不指定", "上午", "下午"\] as const/);
  assert.equal((page.match(/希望到貨時段<select/g) || []).length, 2);
  assert.equal((page.match(/實際到貨時間依物流配送狀況為準。/g) || []).length, 2);

  const frozenBlock = page.match(/\{form\.fulfillment === "冷凍宅配" && <>[\s\S]*?<\/>}/)[0];
  const sevenElevenBlock = page.match(/\{form\.fulfillment === "7-ELEVEN 冷凍交貨便" && <>[\s\S]*?<\/>}/)[0];
  assert.doesNotMatch(frozenBlock, /type="time"/);
  assert.doesNotMatch(sevenElevenBlock, /type="time"/);
});

test("delivery notes persist only the fields relevant to the selected method", () => {
  assert.match(page, /usesDeliveryTimeSlot\(form\.fulfillment\) && `希望到貨時段：\$\{form\.deliveryTimeSlot\}`/);
  assert.match(page, /form\.fulfillment === "7-ELEVEN 冷凍交貨便" && form\.preferredStoreName\.trim\(\)/);
  assert.match(page, /form\.fulfillment === "台北市配送" \|\| form\.fulfillment === "冷凍宅配"/);
});

test("checkout summary uses the established cart subtotal and keeps the protected RPC contract", () => {
  assert.match(page, /商品小計<\/span><strong>\{formatPrice\(total\)\}/);
  assert.match(page, /配送／運費<\/span><strong>\{formatPrice\(0\)\}/);
  assert.match(page, /應付總額<\/span><strong>\{formatPrice\(total\)\}/);
  assert.match(page, /p_idempotency_key: idempotencyKey/);
  assert.match(page, /checkoutRequestFingerprint\(\{/);
  assert.match(page, /supabase\.rpc\("create_checkout_order"/);
});

test("checkout controls remain touch-friendly and stack within the existing mobile breakpoint", () => {
  assert.match(css, /\.checkoutFields select\{width:100%;min-height:48px/);
  assert.match(css, /\.checkoutAmountSummary\{display:grid/);
  assert.match(css, /@media\(max-width:600px\)\{\.checkoutAmountSummary/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/f003-18-repayment-lifecycle.sql", "utf8");
const page = fs.readFileSync("app/admin/orders/[id]/page.tsx", "utf8");
const types = fs.readFileSync("lib/admin-orders.ts", "utf8");

test("F003-18 replaces lifetime payment uniqueness with attempt uniqueness", () => {
  assert.match(sql, /drop constraint if exists order_payments_order_id_key/i);
  assert.match(sql, /unique index if not exists order_payments_order_attempt_uidx[\s\S]*order_id, attempt_number/i);
  assert.match(sql, /attempt_number integer/i);
  assert.match(sql, /attempt_number > 0/i);
});

test("F003-18 payment record requires idempotency and serializes on order", () => {
  assert.match(sql, /admin_record_order_payment\([\s\S]*p_idempotency_key uuid/i);
  assert.match(sql, /payment_idempotency_key_required/i);
  assert.match(sql, /payment_idempotency_conflict/i);
  assert.match(sql, /where id = p_order_id[\s\S]*for update/i);
  assert.match(sql, /order_payments_order_idempotency_uidx/i);
});

test("F003-18 permits repayment only after every prior payment is reversed", () => {
  assert.match(sql, /not exists \([\s\S]*order_payment_reversals reversal[\s\S]*reversal\.payment_id = payment\.id/i);
  assert.match(sql, /active_payment_exists/i);
  assert.match(sql, /coalesce\(max\(payment\.attempt_number\), 0\) \+ 1/i);
});

test("F003-18 reversal targets the active payment attempt", () => {
  assert.match(sql, /admin_reverse_order_payment/i);
  assert.match(sql, /order by payment\.attempt_number desc[\s\S]*limit 1/i);
  assert.match(sql, /active_payment_not_found/i);
});

test("F003-18 cancellation rejects an unreversed payment fact", () => {
  assert.match(sql, /active_payment_requires_reversal/i);
  assert.match(sql, /movement_type = 'order_cancel_restore'/i);
});

test("F003-18 keeps payment facts append-only", () => {
  assert.doesNotMatch(sql, /delete\s+from\s+public\.order_payments/i);
  assert.doesNotMatch(sql, /update\s+public\.order_payments\s+set\s+(amount|payment_method|paid_at)/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.order_payment_reversals/i);
});

test("admin payment types expose attempt and reversal relationship", () => {
  assert.match(types, /attempt_number: number/);
  assert.match(types, /idempotency_key: string \| null/);
  assert.match(types, /payment_id: string/);
});

test("order UI supplies an idempotency key and supports payment history", () => {
  assert.match(page, /p_idempotency_key/);
  assert.match(page, /attempt_number/);
  assert.match(page, /order_payment_reversals/);
});

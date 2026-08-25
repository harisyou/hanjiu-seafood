import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const lifecycle = readFileSync(new URL("../supabase/f003-18-repayment-lifecycle.sql", import.meta.url), "utf8");
const integrity = readFileSync(new URL("../supabase/f003-18-repayment-integrity.sql", import.meta.url), "utf8");
const detail = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");

function functionDefinition(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  const end = sql.indexOf("\n$$;", start) + 4;
  return sql.slice(start, end);
}

const recordRpc = functionDefinition(lifecycle, "admin_record_order_payment");
const reverseRpc = functionDefinition(lifecycle, "admin_reverse_order_payment");
const cancelRpc = functionDefinition(lifecycle, "admin_cancel_order");

test("migration is transactional and safely backfills attempt metadata only", () => {
  assert.match(lifecycle, /^--[^]*?\bbegin;/i);
  assert.match(lifecycle, /\bcommit;\s*$/i);
  assert.match(lifecycle, /update public\.order_payments\s+set attempt_number = 1\s+where attempt_number is null/i);
  assert.doesNotMatch(lifecycle, /update public\.order_payments\s+set\s+(amount|payment_method|paid_at|actor_id|idempotency_key)/i);
  assert.doesNotMatch(lifecycle, /update public\.order_payment_reversals|delete\s+from\s+public\.(order_payments|order_payment_reversals)/i);
});

test("attempt identity replaces lifetime uniqueness without changing payment facts", () => {
  assert.match(lifecycle, /drop constraint if exists order_payments_order_id_key/i);
  assert.match(lifecycle, /add column if not exists attempt_number integer/i);
  assert.match(lifecycle, /attempt_number set not null/i);
  assert.match(lifecycle, /attempt_number > 0/i);
  assert.match(lifecycle, /order_payments_order_attempt_uidx[\s\S]*on public\.order_payments\(order_id, attempt_number\)/i);
  assert.match(lifecycle, /order_payments_order_idempotency_uidx[\s\S]*on public\.order_payments\(order_id, idempotency_key\)[\s\S]*where idempotency_key is not null/i);
});

test("recording uses one order lock, idempotency, exact totals, and append-only attempt creation", () => {
  assert.match(recordRpc, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(recordRpc, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(recordRpc, /p_idempotency_key uuid/);
  assert.match(recordRpc, /payment_idempotency_key_required/);
  assert.match(recordRpc, /select \* into v_order[\s\S]*where id = p_order_id[\s\S]*for update/i);
  assert.match(recordRpc, /payment_idempotency_conflict/);
  assert.match(recordRpc, /if v_order\.status = 'draft'/);
  assert.match(recordRpc, /if v_order\.status = 'cancelled'/);
  assert.match(recordRpc, /if v_order\.total_amount is null/);
  assert.match(recordRpc, /if p_amount <> v_order\.total_amount then raise exception 'payment_amount_mismatch'/);
  assert.match(recordRpc, /active_payment_exists/);
  assert.match(recordRpc, /coalesce\(max\(payment\.attempt_number\), 0\) \+ 1/);
  assert.match(recordRpc, /insert into public\.order_payments\([\s\S]*attempt_number, idempotency_key/);
  assert.match(recordRpc, /set payment_status = 'paid'/);
  assert.doesNotMatch(recordRpc, /commit;|rollback;|update public\.order_payments/i);
});

test("reversal and cancellation share the same order-row serialization boundary", () => {
  for (const rpc of [recordRpc, reverseRpc, cancelRpc]) {
    assert.match(rpc, /select \* into v_order[\s\S]*where id = p_order_id[\s\S]*for update/i);
  }
  assert.match(reverseRpc, /not exists \([\s\S]*order_payment_reversals reversal[\s\S]*reversal\.payment_id = payment\.id/);
  assert.match(reverseRpc, /order by payment\.attempt_number desc[\s\S]*limit 1/i);
  assert.match(reverseRpc, /active_payment_not_found/);
  assert.match(cancelRpc, /active_payment_requires_reversal/);
  assert.match(cancelRpc, /movement_type = 'order_cancel_restore'/);
});

test("the integrity audit accepts reversed Payment #1 plus active Payment #2 and flags true anomalies", () => {
  assert.match(integrity, /active_payments as \(\s*select \* from payment_facts where reversal_id is null/i);
  assert.match(integrity, /active_counts as \([\s\S]*count\(\*\)::integer as active_count/i);
  for (const issue of ["paid_without_active_payment", "unpaid_with_active_payment", "paid_active_payment_amount_mismatch", "multiple_active_payments", "cancelled_order_paid_or_active_payment", "reversal_order_mismatch"]) assert.match(integrity, new RegExp(issue));
  assert.doesNotMatch(integrity, /reversed_payment_order_still_paid/);
  assert.doesNotMatch(integrity, /\binsert\b|\bupdate\b|\bdelete\b/i);
});

test("order detail loads and renders every immutable payment attempt and its reversal", () => {
  assert.match(detail, /from\("order_payments"\)\.select\("id,amount,payment_method,paid_at,actor_id,attempt_number,idempotency_key"\)\.eq\("order_id", orderId\)\.order\("attempt_number", \{ ascending: false \}\)/);
  assert.match(detail, /from\("order_payment_reversals"\)\.select\("id,payment_id,amount,reason,reversed_at,actor_id"\)\.in\("payment_id", paymentIds\)/);
  assert.match(detail, /Payment #\{payment\.attempt_number\}/);
  assert.match(detail, /有效收款/);
  assert.match(detail, /已撤銷/);
  assert.match(detail, /撤銷原因/);
});

test("reversal re-exposes a protected next payment attempt with one generated idempotency key", () => {
  assert.match(detail, /const activePayment = paymentAttempts\.find\(\(attempt\) => !attempt\.reversal\) \|\| null/);
  assert.match(detail, /const canRecordPayment = !isDraft && !isCancelled && hasTotalsSnapshot && order\.payment_status === "unpaid" && !activePayment/);
  assert.match(detail, /setPaymentIdempotencyKey\(crypto\.randomUUID\(\)\)/);
  assert.match(detail, /p_idempotency_key: idempotencyKey/);
  assert.match(detail, /setPaymentIdempotencyKey\(null\)/);
  assert.match(detail, /確認後會建立新的不可修改收款 attempt/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f003-17-paid-financial-integrity.sql", import.meta.url), "utf8");
const totalsMigration = readFileSync(new URL("../supabase/f003-14-order-totals.sql", import.meta.url), "utf8");
const paymentsMigration = readFileSync(new URL("../supabase/f003-15-order-payments.sql", import.meta.url), "utf8");
const reversalsMigration = readFileSync(new URL("../supabase/f003-16-payment-reversal.sql", import.meta.url), "utf8");
const detail = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");
const totalsRpc = migration.slice(migration.indexOf("create or replace function public.admin_update_order_totals"), migration.indexOf("-- Client status updates"));
const auditRpc = migration.slice(migration.indexOf("create or replace function public.admin_audit_order_financial_integrity"));

function functionDefinition(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  const end = sql.indexOf("\n$$;", start) + 4;
  return sql.slice(start, end);
}

test("migration is transactional, dependency documented, and never mutates history", () => {
  assert.match(migration, /^-- F003-17:[\s\S]*Depends on F003-13 through F003-16[\s\S]*\bbegin;/);
  assert.match(migration, /\bcommit;\s*$/);
  assert.doesNotMatch(migration, /update public\.(order_payments|order_payment_reversals|inventory_movements)|delete from public\.(order_payments|order_payment_reversals|inventory_movements)|insert into public\.(order_payments|order_payment_reversals)/i);
  assert.match(paymentsMigration, /order_id uuid not null unique references public\.orders\(id\)/);
  assert.doesNotMatch(migration, /drop constraint|drop index/i);
});

test("database guard blocks all paid monetary snapshot changes without a bypass", () => {
  assert.match(migration, /before update of subtotal, shipping_fee, discount_amount, total_amount on public\.orders/);
  assert.match(migration, /old\.payment_status = 'paid'/);
  for (const field of ["subtotal", "shipping_fee", "discount_amount", "total_amount"]) assert.match(migration, new RegExp(`new\\.${field} is distinct from old\\.${field}`));
  assert.match(migration, /raise exception 'paid_order_totals_locked'/);
  assert.doesNotMatch(migration, /set_config\('app\..*totals.*authorized'/i);
});

test("totals RPC serializes on the order and allows only unpaid non-cancelled updates", () => {
  assert.match(totalsRpc, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(totalsRpc, /v_order\.status = 'cancelled'[\s\S]*cancelled_order_totals_locked/);
  assert.match(totalsRpc, /v_order\.payment_status = 'paid'[\s\S]*paid_order_totals_locked/);
  assert.ok(totalsRpc.indexOf("for update") < totalsRpc.indexOf("paid_order_totals_locked"));
  assert.match(totalsRpc, /total_amount = greatest\(subtotal \+ p_shipping_fee - p_discount_amount, 0\)/);
});

test("F003-17 totals RPC is latest F003-14 plus only the paid guard", () => {
  const guard = "  if v_order.payment_status = 'paid' then raise exception 'paid_order_totals_locked'; end if;\n";
  const latest = functionDefinition(totalsMigration, "admin_update_order_totals");
  const revised = functionDefinition(migration, "admin_update_order_totals");
  assert.equal(revised.replace(guard, ""), latest);
  assert.equal(revised.split(guard).length, 2);
});

test("record and reverse operations share the same order lock with totals updates", () => {
  assert.match(paymentsMigration, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(reversalsMigration, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(reversalsMigration, /create or replace function public\.admin_cancel_order[\s\S]*for update/);
  assert.match(paymentsMigration, /if p_amount <> v_order\.total_amount then raise exception 'payment_amount_mismatch'/);
  assert.ok(totalsRpc.indexOf("for update") < totalsRpc.indexOf("update public.orders"));
});

test("authenticated loses only direct payment-status mutation privilege", () => {
  assert.match(migration, /revoke update \(payment_status\) on public\.orders from anon, authenticated/);
  assert.doesNotMatch(migration, /revoke update \(status\)/);
  assert.match(paymentsMigration, /grant execute on function public\.admin_record_order_payment[\s\S]*to authenticated/);
  assert.match(reversalsMigration, /grant execute on function public\.admin_reverse_order_payment[\s\S]*to authenticated/);
});

test("read-only admin audit reports every approved lifecycle inconsistency", () => {
  assert.match(auditRpc, /security definer[\s\S]*set search_path = public, pg_temp[\s\S]*stable/);
  assert.match(auditRpc, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  for (const issue of ["paid_without_authoritative_payment", "unpaid_with_active_payment", "paid_active_payment_amount_mismatch", "reversed_payment_order_still_paid", "cancelled_order_paid_or_active_payment", "reversal_order_mismatch"]) assert.match(auditRpc, new RegExp(issue));
  assert.doesNotMatch(auditRpc, /\binsert\b|\bupdate\b|\bdelete\b/i);
  assert.match(migration, /revoke all on function public\.admin_audit_order_financial_integrity\(\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_audit_order_financial_integrity\(\) to authenticated/);
});

test("paid UI hides the totals editor and reversed unpaid UI naturally exposes it", () => {
  assert.match(detail, /order\.payment_status === "paid" \? <p className="notice">此訂單已記錄收款，金額已鎖定。若需修改運費或折扣，請先撤銷收款。<\/p> : !isCancelled && <div className="orderTotalsEditor">/);
  assert.match(reversalsMigration, /set payment_status = 'unpaid'/);
  assert.doesNotMatch(detail, /\{!isCancelled && <div className="orderTotalsEditor">/);
});

test("F003-14 through F003-16 authoritative and append-only behavior remains intact", () => {
  assert.match(totalsMigration, /orders_totals_snapshot_check/);
  assert.match(paymentsMigration, /revoke all on public\.order_payments from public, anon, authenticated/);
  assert.match(reversalsMigration, /revoke all on public\.order_payment_reversals from public, anon, authenticated/);
  assert.match(reversalsMigration, /payment_already_reversed/);
  assert.match(reversalsMigration, /movement_type = 'order_cancel_restore'[\s\S]*order_already_restored/);
});


import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f003-16-payment-reversal.sql", import.meta.url), "utf8");
const paymentMigration = readFileSync(new URL("../supabase/f003-15-order-payments.sql", import.meta.url), "utf8");
const cancellationMigration = readFileSync(new URL("../supabase/f003-13-order-cancellation-restock.sql", import.meta.url), "utf8");
const totalsMigration = readFileSync(new URL("../supabase/f003-14-order-totals.sql", import.meta.url), "utf8");
const detail = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");
const rpc = migration.slice(migration.indexOf("create or replace function public.admin_reverse_order_payment"), migration.indexOf("-- Preserve F003-13"));
const cancelRpc = migration.slice(migration.indexOf("create or replace function public.admin_cancel_order"));

function functionDefinition(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  const end = sql.indexOf("\n$$;", start) + 4;
  return sql.slice(start, end);
}

function normalizeSql(value) {
  return value.replace(/\r\n/g, "\n");
}

test("reversals are append-only authoritative facts protected from direct clients", () => {
  assert.match(migration, /create table if not exists public\.order_payment_reversals/);
  assert.match(migration, /payment_id uuid not null unique references public\.order_payments\(id\) on delete restrict/);
  assert.match(migration, /order_id uuid not null references public\.orders\(id\) on delete restrict/);
  assert.match(migration, /revoke all on public\.order_payment_reversals from public, anon, authenticated/);
  assert.match(migration, /alter table public\.order_payment_reversals enable row level security/);
  assert.match(migration, /grant select on public\.order_payment_reversals to authenticated/);
  assert.doesNotMatch(migration, /delete from public\.order_payments|update public\.order_payments/i);
});

test("admin RPC validates, locks, copies the full amount, and atomically marks unpaid", () => {
  assert.match(rpc, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(rpc, /if p_order_id is null then raise exception 'order_not_found'/);
  assert.match(rpc, /v_reason text := nullif\(btrim\(coalesce\(p_reason, ''\)\), ''\)/);
  assert.match(rpc, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(rpc, /v_order\.status = 'cancelled'/);
  assert.match(rpc, /select \* into v_payment from public\.order_payments where order_id = v_order\.id/);
  assert.match(rpc, /authoritative_payment_not_found/);
  assert.match(rpc, /payment_already_reversed/);
  assert.match(rpc, /v_order\.payment_status <> 'paid'/);
  assert.match(rpc, /values \(v_payment\.id, v_order\.id, v_payment\.amount, v_reason, auth\.uid\(\)\)/);
  assert.match(rpc, /set_config\('app\.order_payment_authorized', 'true', true\)/);
  assert.match(rpc, /set payment_status = 'unpaid'/);
  assert.doesNotMatch(rpc, /commit;|rollback;|p_amount/i);
});

test("concurrent reversals serialize on the order and retain a unique database backstop", () => {
  assert.ok(rpc.indexOf("for update") < rpc.indexOf("payment_already_reversed"));
  assert.match(paymentMigration, /order_id uuid not null unique references public\.orders\(id\)/);
  assert.match(migration, /payment_id uuid not null unique references public\.order_payments\(id\)/);
  assert.ok(rpc.indexOf("payment_already_reversed") < rpc.indexOf("insert into public.order_payment_reversals"));
});

test("permissions allow authenticated admins only through the RPC", () => {
  assert.match(migration, /revoke all on function public\.admin_reverse_order_payment\(uuid, text\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_reverse_order_payment\(uuid, text\) to authenticated/);
  assert.match(paymentMigration, /revoke all on public\.order_payments from public, anon, authenticated/);
});

test("paid unreversed orders must reverse before cancellation without changing restock semantics", () => {
  assert.match(cancelRpc, /if v_order\.payment_status = 'paid' then raise exception 'paid_order_requires_payment_reversal'/);
  assert.match(cancelRpc, /paid_order_requires_payment_reversal/);
  assert.match(cancelRpc, /movement_type in \('checkout_sale', 'fish_request_order_confirmation'\)/);
  assert.match(cancelRpc, /set inventory = variant\.inventory \+ v_item\.quantity/);
  assert.match(cancelRpc, /set status = 'cancelled'/);
  assert.match(cancellationMigration, /order_cancel_restore/);
  assert.match(totalsMigration, /total_amount = greatest\(subtotal \+ shipping_fee - discount_amount, 0\)/);
  assert.ok(cancelRpc.indexOf("paid_order_requires_payment_reversal") < cancelRpc.indexOf("app.inventory_movement_type"));
});

test("F003-16 cancellation is byte-for-byte latest F003-13 plus only the paid guard", () => {
  const guard = "  if v_order.payment_status = 'paid' then raise exception 'paid_order_requires_payment_reversal'; end if;\n";
  const latest = functionDefinition(cancellationMigration, "admin_cancel_order");
  const revised = functionDefinition(migration, "admin_cancel_order");
  assert.equal(normalizeSql(revised.replace(guard, "")), normalizeSql(latest));
  assert.equal(revised.split(guard).length, 2);
});

test("admin UI keeps the payment audit trail and requires explicit reason confirmation", () => {
  assert.match(detail, /from\("order_payment_reversals"\)\.select\("id,payment_id,amount,reason,reversed_at,actor_id"\)/);
  assert.match(detail, /admin_reverse_order_payment/);
  assert.match(detail, /撤銷原因 \*/);
  assert.match(detail, /確認撤銷收款/);
  assert.match(detail, /Payment #\{payment\.attempt_number\}/);
  assert.match(detail, /已撤銷/);
  assert.match(detail, /有效收款/);
  assert.match(detail, /實收金額/);
  assert.match(detail, /付款方式/);
  assert.match(detail, /付款時間/);
  assert.match(detail, /撤銷時間/);
  assert.match(detail, /此歷史訂單沒有可撤銷的正式收款紀錄/);
  assert.match(detail, /activePayment && !isCancelled/);
});

test("historical paid orders without an authoritative payment cannot reverse or cancel", () => {
  assert.match(rpc, /select \* into v_payment[\s\S]*if not found then raise exception 'authoritative_payment_not_found'/);
  assert.match(cancelRpc, /if v_order\.payment_status = 'paid' then raise exception 'paid_order_requires_payment_reversal'/);
});

test("one-payment unique model intentionally prevents collecting again after reversal", () => {
  assert.match(paymentMigration, /order_id uuid not null unique references public\.orders\(id\)/);
  assert.match(paymentMigration, /exists \(select 1 from public\.order_payments where order_id = v_order\.id\)/);
  assert.doesNotMatch(migration, /drop constraint|drop index/i);
});

test("full paid-to-reversed-to-cancelled flow preserves payment and restores inventory once", () => {
  const recordRpc = paymentMigration.slice(paymentMigration.indexOf("create or replace function public.admin_record_order_payment"));
  assert.match(recordRpc, /insert into public\.order_payments/);
  assert.match(recordRpc, /set payment_status = 'paid'/);
  assert.match(rpc, /insert into public\.order_payment_reversals/);
  assert.match(rpc, /set payment_status = 'unpaid'/);
  assert.doesNotMatch(rpc, /delete from public\.order_payments|update public\.order_payments/i);
  assert.match(cancelRpc, /movement_type = 'order_cancel_restore'[\s\S]*order_already_restored/);
  assert.match(cancelRpc, /set inventory = variant\.inventory \+ v_item\.quantity/);
});

test("a second reversal fails before insert or status mutation", () => {
  const duplicateCheck = rpc.indexOf("payment_already_reversed");
  assert.ok(duplicateCheck > rpc.indexOf("for update"));
  assert.ok(duplicateCheck < rpc.indexOf("insert into public.order_payment_reversals"));
  assert.ok(duplicateCheck < rpc.indexOf("set payment_status = 'unpaid'"));
});


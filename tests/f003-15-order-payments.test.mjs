import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f003-15-order-payments.sql", import.meta.url), "utf8");
const detailPage = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");

const paymentRpc = migration.slice(
  migration.indexOf("create or replace function public.admin_record_order_payment"),
  migration.indexOf("revoke all on function public.enforce_order_payment_flow")
);

test("payment records are additive, immutable to clients, and preserve historical orders", () => {
  assert.match(migration, /^--[^]*?\bbegin;/i);
  assert.match(migration, /create table if not exists public\.order_payments/);
  assert.match(migration, /order_id uuid not null unique references public\.orders\(id\) on delete restrict/);
  assert.match(migration, /amount integer not null check \(amount > 0\)/);
  assert.match(migration, /payment_method text not null check \(payment_method in \('cash', 'bank_transfer', 'other'\)\)/);
  assert.match(migration, /paid_at timestamptz not null default now\(\)/);
  assert.match(migration, /actor_id uuid/);
  assert.match(migration, /alter table public\.order_payments enable row level security/);
  assert.match(migration, /revoke all on public\.order_payments from public, anon, authenticated/);
  assert.doesNotMatch(migration, /insert into public\.order_payments[\s\S]*select/i);
  assert.doesNotMatch(migration, /update public\.orders[\s\S]*where payment_status = 'paid'/i);
  assert.match(migration, /\bcommit;\s*$/i);
});

test("only the atomic admin RPC can record a payment", () => {
  assert.match(paymentRpc, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(paymentRpc, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(paymentRpc, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(paymentRpc, /p_amount is null or p_amount <= 0/);
  assert.match(paymentRpc, /v_method not in \('cash', 'bank_transfer', 'other'\)/);
  assert.match(paymentRpc, /v_order\.status = 'draft'/);
  assert.match(paymentRpc, /v_order\.status = 'cancelled'/);
  assert.match(paymentRpc, /v_order\.total_amount is null/);
  assert.match(paymentRpc, /v_order\.payment_status = 'paid' or exists \(select 1 from public\.order_payments where order_id = v_order\.id\)/);
  assert.match(paymentRpc, /if p_amount <> v_order\.total_amount then raise exception 'payment_amount_mismatch'/);
  assert.match(paymentRpc, /insert into public\.order_payments\(order_id, amount, payment_method, actor_id\)/);
  assert.match(paymentRpc, /update public\.orders set payment_status = 'paid'/);
  assert.doesNotMatch(paymentRpc, /commit;|rollback;/i);
});

test("the database rejects direct payment-status changes outside the payment RPC", () => {
  assert.match(migration, /create trigger orders_payment_guard before update of payment_status on public\.orders/);
  assert.match(migration, /current_setting\('app\.order_payment_authorized', true\) is distinct from 'true'/);
  assert.match(migration, /raise exception 'order_payment_rpc_required'/);
  assert.match(paymentRpc, /set_config\('app\.order_payment_authorized', 'true', true\)/);
  assert.match(migration, /revoke all on function public\.admin_record_order_payment\(uuid, integer, text\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_record_order_payment\(uuid, integer, text\) to authenticated/);
});

test("admin detail independently reloads the authoritative payment record after a successful RPC", () => {
  assert.match(detailPage, /from\("order_payments"\)\.select\("id,amount,payment_method,paid_at"\)\.eq\("order_id", orderId\)\.maybeSingle\(\)/);
  assert.match(detailPage, /setPayment\(paymentResult\.error \|\| !paymentResult\.data \? null : paymentResult\.data as OrderPayment\)/);
  assert.doesNotMatch(detailPage, /order_payments\(\*\)/);
});

test("payment rendering prioritizes an authoritative record over all unpaid and historical states", () => {
  assert.match(detailPage, /\{payment \? <>\{paymentReversal/);
  assert.match(detailPage, /paymentReversal \? "未付款（原收款已撤銷）" : "已付款"/);
  assert.match(detailPage, /<\/> : canRecordPayment \? <>/);
  assert.match(detailPage, /const canRecordPayment = !isDraft && !isCancelled && hasTotalsSnapshot && order\.payment_status === "unpaid"/);
  assert.match(detailPage, /此歷史訂單尚無金額 snapshot，不能確認收款。/);
});

test("admin detail replaces direct payment-status editing with explicit payment confirmation", () => {
  assert.match(detailPage, /supabase\.rpc\("admin_record_order_payment", \{ p_order_id: order\.id, p_amount: orderTotal\(order\), p_payment_method: paymentMethod \}\)/);
  assert.match(detailPage, /確認後會記錄實收金額與付款方式，並將付款狀態改為已付款。/);
  assert.match(detailPage, /草稿訂單不能確認收款。/);
  assert.match(detailPage, /已取消訂單不能確認收款。/);
  assert.match(detailPage, /此歷史訂單尚無金額 snapshot，不能確認收款。/);
  assert.doesNotMatch(detailPage, /updateOrder\(\{ payment_status/);
});


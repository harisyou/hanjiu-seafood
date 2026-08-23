import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f003-13-order-cancellation-restock.sql", import.meta.url), "utf8");
const detailPage = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");

const cancelRpc = migration.slice(
  migration.indexOf("create or replace function public.admin_cancel_order"),
  migration.indexOf("revoke all on function public.enforce_order_cancellation_flow")
);
const ledgerFunction = migration.slice(migration.indexOf("create or replace function public.log_inventory_movement"), migration.indexOf("create or replace function public.enforce_order_cancellation_flow"));

test("migration extends the ledger only with the cancellation restoration movement", () => {
  assert.match(migration, /^--[^]*?\bbegin;/i);
  assert.match(migration, /inventory_movements_movement_type_check[\s\S]*'order_cancel_restore'/);
  assert.match(migration, /\bcommit;\s*$/i);
  assert.doesNotMatch(migration, /insert into public\.orders|update public\.order_items|delete from public\.(orders|order_items|fish_requests|product_variants)/i);
});

test("the single inventory trigger recognizes trusted cancellation context", () => {
  assert.match(ledgerFunction, /'checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment', 'order_cancel_restore'/);
  assert.match(ledgerFunction, /if v_type = 'order_cancel_restore' and v_order_id is null then raise exception 'inventory_movement_context_invalid'/);
  assert.match(ledgerFunction, /v_type not in \('fish_request_order_confirmation', 'order_cancel_restore'\)/);
  assert.doesNotMatch(migration, /create trigger .*inventory.*ledger/i);
});

test("cancellation is admin-only, transaction-safe, and cannot be called anonymously", () => {
  assert.match(cancelRpc, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(cancelRpc, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(cancelRpc, /select \* into v_order[\s\S]*where id = p_order_id[\s\S]*for update/);
  assert.match(migration, /revoke all on function public\.admin_cancel_order\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_cancel_order\(uuid\) to authenticated/);
});

test("drafts and already-cancelled orders never enter inventory restoration", () => {
  assert.match(cancelRpc, /if v_order\.status = 'draft' then raise exception 'order_not_cancellable_draft'/);
  assert.match(cancelRpc, /if v_order\.status = 'cancelled' then raise exception 'order_already_cancelled'/);
  assert.match(cancelRpc, /status not in \('new', 'processing', 'ready', 'completed', 'contacted', 'confirmed', 'paid', 'shipped'\)/);
  assert.match(migration, /order_cancelled_terminal/);
  assert.match(migration, /order_cancellation_rpc_required/);
});

test("restoration uses only stored item snapshots and proven prior deductions", () => {
  assert.match(cancelRpc, /from public\.order_items[\s\S]*group by variant_id, product_id[\s\S]*order by variant_id nulls first, product_id nulls first/);
  assert.match(cancelRpc, /if v_item\.variant_id is null or v_item\.product_id is null or v_item\.quantity is null or v_item\.quantity < 1 then[\s\S]*order_item_variant_unrestorable/);
  assert.match(cancelRpc, /from public\.inventory_movements[\s\S]*order_id = v_order\.id[\s\S]*movement_type in \('checkout_sale', 'fish_request_order_confirmation'\)/);
  assert.match(cancelRpc, /if v_deducted_quantity <> v_item\.quantity then[\s\S]*order_inventory_provenance_missing/);
  assert.match(cancelRpc, /movement_type = 'order_cancel_restore'[\s\S]*order_already_restored/);
  assert.match(cancelRpc, /set inventory = variant\.inventory \+ v_item\.quantity[\s\S]*variant\.id = v_item\.variant_id[\s\S]*variant\.product_id = v_item\.product_id/);
  assert.doesNotMatch(cancelRpc, /p_variant_id|p_quantity|p_inventory/);
});

test("all restored variants and the cancelled status share one RPC transaction", () => {
  assert.match(cancelRpc, /perform set_config\('app\.inventory_movement_type', 'order_cancel_restore', true\)/);
  assert.match(cancelRpc, /perform set_config\('app\.inventory_movement_order_id', v_order\.id::text, true\)/);
  assert.match(cancelRpc, /set status = 'cancelled'[\s\S]*where id = v_order\.id[\s\S]*status <> 'cancelled'/);
  assert.doesNotMatch(cancelRpc, /commit;|rollback;/i);
});

test("admin detail uses the cancellation RPC only after explicit confirmation", () => {
  assert.match(detailPage, /supabase\.rpc\("admin_cancel_order", \{ p_order_id: order\.id \}\)/);
  assert.match(detailPage, /確認取消並補回庫存/);
  assert.match(detailPage, /訂單已取消，庫存已補回，並已寫入庫存異動紀錄。/);
  assert.match(detailPage, /const canCancel = !isDraft && !isCancelled/);
  assert.match(detailPage, /if \(payload\.status === "cancelled"\) return/);
  assert.match(detailPage, /disabled=\{busy \|\| isDraft \|\| isCancelled\}/);
});

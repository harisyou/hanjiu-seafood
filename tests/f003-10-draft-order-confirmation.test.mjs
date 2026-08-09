import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/f003-10-draft-order-confirmation.sql", import.meta.url), "utf8");
const detailPage = readFileSync(new URL("../app/admin/orders/[id]/page.tsx", import.meta.url), "utf8");

test("save draft metadata is admin-only and cannot change the draft status", () => {
  assert.match(migration, /create or replace function public\.admin_save_fish_request_order_draft_metadata/);
  assert.match(migration, /security definer\s+set search_path = public, pg_temp/);
  assert.match(migration, /if not public\.is_hanjiu_admin\(\) then raise exception 'admin_required'/);
  assert.match(migration, /if v_order\.status <> 'draft' then raise exception 'order_not_draft'/);
  assert.match(migration, /set fulfillment = v_fulfillment,\s+processing = '依品項',\s+note = v_note/);
  assert.doesNotMatch(migration.slice(0, migration.indexOf("create or replace function public.admin_confirm_fish_request_order_draft")), /set status = 'new'/);
  assert.doesNotMatch(migration.slice(0, migration.indexOf("create or replace function public.admin_confirm_fish_request_order_draft")), /update public\.product_variants/i);
  assert.doesNotMatch(migration.slice(0, migration.indexOf("create or replace function public.admin_confirm_fish_request_order_draft")), /update public\.fish_requests/i);
});

test("save uses the existing processing configuration semantics", () => {
  assert.match(migration, /v_fulfillment is not null and v_fulfillment not in \('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便'\)/);
  assert.match(migration, /from public\.product_processing_presets config/);
  assert.match(migration, /join public\.product_processing_options option_config/);
  assert.match(migration, /if v_expected_count <> cardinality\(v_option_ids\) then raise exception 'processing_updated'/);
  assert.match(migration, /v_preset_id := 'none';\s+v_preset_name := '不處理'/);
});

test("confirmation locks and validates a single eligible draft and request", () => {
  const confirmRpc = migration.slice(migration.indexOf("create or replace function public.admin_confirm_fish_request_order_draft"));
  assert.match(confirmRpc, /select \* into v_order from public\.orders where id = p_order_id for update/);
  assert.match(confirmRpc, /if v_order\.status <> 'draft' then raise exception 'order_not_draft'/);
  assert.match(confirmRpc, /if v_order\.fish_request_id is null then raise exception 'fish_request_relation_missing'/);
  assert.match(confirmRpc, /if v_item_count <> 1 then raise exception 'invalid_draft_order'/);
  assert.match(confirmRpc, /select \* into v_request[\s\S]*for update/);
  assert.match(confirmRpc, /if v_request\.status not in \('waiting', 'contacted'\)/);
});

test("confirmation uses one conditional atomic inventory deduction and no compensation", () => {
  const confirmRpc = migration.slice(migration.indexOf("create or replace function public.admin_confirm_fish_request_order_draft"));
  assert.match(confirmRpc, /update public\.product_variants variant\s+set inventory = variant\.inventory - v_item\.quantity/);
  assert.match(confirmRpc, /product\.status = 'available'[\s\S]*variant\.active[\s\S]*variant\.inventory >= v_item\.quantity/);
  assert.match(confirmRpc, /if not found then raise exception 'variant_unavailable'/);
  assert.doesNotMatch(confirmRpc, /inventory = inventory \+/);
  assert.doesNotMatch(confirmRpc, /create_checkout_order/);
});

test("confirmation preserves item snapshots while transitioning order and request once", () => {
  const confirmRpc = migration.slice(migration.indexOf("create or replace function public.admin_confirm_fish_request_order_draft"));
  assert.doesNotMatch(confirmRpc, /set price\s*=/);
  assert.doesNotMatch(confirmRpc, /set quantity\s*=/);
  assert.match(confirmRpc, /set status = 'new'[\s\S]*where id = v_order\.id and status = 'draft'/);
  assert.match(confirmRpc, /set status = 'converted'[\s\S]*where id = v_request\.id and status in \('waiting', 'contacted'\)/);
  assert.doesNotMatch(confirmRpc, /set payment_status\s*=/);
});

test("RPC permissions are execute-only for authenticated admins", () => {
  assert.match(migration, /revoke all on function public\.admin_save_fish_request_order_draft_metadata\(uuid, text, text, text\[\], text, text\)\s+from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.admin_confirm_fish_request_order_draft\(uuid\)\s+from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.admin_save_fish_request_order_draft_metadata[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.admin_confirm_fish_request_order_draft\(uuid\)[\s\S]*to authenticated/);
});

test("draft detail UI saves metadata before showing a confirmation summary", () => {
  assert.match(detailPage, /admin_save_fish_request_order_draft_metadata/);
  assert.match(detailPage, /admin_confirm_fish_request_order_draft/);
  assert.match(detailPage, /確認後將正式扣除庫存，並把魚貨需求標記為已完成/);
  assert.match(detailPage, /disabled=\{busy \|\| !canConfirm\}/);
  assert.match(detailPage, /訂單已確認，庫存已扣除/);
});

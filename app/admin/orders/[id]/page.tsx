"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { AdminOrder, AdminOrderItem, formatOrderTime, OrderPayment, OrderPaymentReversal, orderStatusLabel, orderStatusOptions, orderSubtotal, orderTotal, parseOrderNote, paymentStatusLabel, processingSummary } from "@/lib/admin-orders";
import { FishRequest, fishRequestStatusLabel, formatWantedBy } from "@/lib/fish-requests";

type ProcessingPreset = { id: string; name: string; active: boolean };
type ProcessingOption = { id: string; name: string; active: boolean };
type ProductConfig = { processing_enabled: boolean };
type DraftForm = { fulfillment: string; presetId: string; optionIds: string[]; processingNote: string; note: string };
const fulfillmentOptions = ["永春市場自取", "台北市配送", "冷凍宅配", "7-ELEVEN 冷凍交貨便"];

function deliveryLabel(value: string | null) {
  if (!value) return "尚未設定";
  return value === "7-ELEVEN 冷凍交貨便" ? "7-11 冷凍交貨便" : value;
}

function emptyDraftForm(): DraftForm {
  return { fulfillment: "", presetId: "", optionIds: [], processingNote: "", note: "" };
}

function errorMessage(message: string) {
  const messages: Record<string, string> = {
    admin_required: "只有管理員可以更新或確認訂單草稿。",
    order_not_found: "找不到訂單草稿。",
    order_not_draft: "這張訂單已不是草稿，請重新載入。",
    fish_request_relation_missing: "草稿缺少來源魚貨需求，無法確認。",
    fish_request_not_eligible: "來源魚貨需求已不適合確認，未扣除庫存。",
    invalid_draft_order: "草稿資料不完整或不符合 V1 訂單格式。",
    invalid_fulfillment: "請選擇有效的配送方式。",
    processing_updated: "處理方式設定已變更，請重新選擇後儲存。",
    variant_unavailable: "規格目前無法販售或庫存不足，未扣除庫存。",
    order_not_cancellable_draft: "草稿訂單尚未扣除庫存，不能使用正式訂單取消流程。",
    order_already_cancelled: "這張訂單已取消，庫存不會再次補回。",
    order_not_cancellable: "此訂單目前無法取消，請重新載入後再試。",
    order_items_missing: "訂單沒有可安全補回的品項，請改由人工處理。",
    order_item_variant_unrestorable: "訂單缺少可安全補回的原始規格，請改由人工處理。",
    order_inventory_provenance_missing: "找不到此訂單原始扣庫存紀錄，為避免錯誤補庫存，請改由人工處理。",
    order_already_restored: "此訂單已有補庫存紀錄，請重新載入。",
    order_cancellation_rpc_required: "請使用取消訂單功能，系統會安全補回庫存。",
    order_cancelled_terminal: "已取消的訂單不能恢復為其他狀態。",
    invalid_shipping_fee: "運費必須是大於或等於 0 的整數金額。",
    invalid_discount_amount: "折扣必須是大於或等於 0 的整數金額。",
    cancelled_order_totals_locked: "已取消訂單的金額 snapshot 不能再修改。",
    order_totals_snapshot_missing: "此歷史訂單尚無金額 snapshot，不能進行此操作。",
    draft_order_payment_not_allowed: "草稿訂單尚未成立，不能確認收款。",
    cancelled_order_payment_not_allowed: "已取消訂單不能確認收款。",
    order_already_paid: "此訂單已付款，不能重複記錄收款。",
    invalid_payment_amount: "實收金額必須大於 0。",
    invalid_payment_method: "請選擇有效付款方式。",
    payment_amount_mismatch: "實收金額必須與訂單應收總額一致。",
    order_payment_rpc_required: "請使用正式收款或撤銷收款功能，不能直接修改付款狀態。",
    payment_reversal_reason_required: "請輸入撤銷原因。",
    authoritative_payment_not_found: "此歷史訂單沒有可撤銷的正式收款紀錄。",
    payment_already_reversed: "此筆收款已撤銷，不能再次撤銷。",
    order_not_paid: "只有已付款訂單可以撤銷收款。",
    cancelled_order_payment_reversal_not_allowed: "已取消訂單不得撤銷收款。",
    paid_order_requires_payment_reversal: "已付款訂單必須先撤銷收款，才能取消。"
  };
  return Object.entries(messages).find(([code]) => message.includes(code))?.[1] || "操作失敗，請稍後再試。";
}

export default function AdminOrderDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [payment, setPayment] = useState<OrderPayment | null>(null);
  const [paymentReversal, setPaymentReversal] = useState<OrderPaymentReversal | null>(null);
  const [sourceRequest, setSourceRequest] = useState<FishRequest | null>(null);
  const [sourceFishName, setSourceFishName] = useState("");
  const [sourceRequestUnavailable, setSourceRequestUnavailable] = useState(false);
  const [productConfig, setProductConfig] = useState<ProductConfig | null>(null);
  const [presets, setPresets] = useState<ProcessingPreset[]>([]);
  const [options, setOptions] = useState<ProcessingOption[]>([]);
  const [presetOptions, setPresetOptions] = useState<Record<string, string[]>>({});
  const [draftForm, setDraftForm] = useState<DraftForm>(emptyDraftForm);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [shippingFee, setShippingFee] = useState("0");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [confirmingPayment, setConfirmingPayment] = useState(false);
  const [reversingPayment, setReversingPayment] = useState(false);
  const [reversalReason, setReversalReason] = useState("");

  const loadOrder = useCallback(async () => {
    const { data, error } = await supabase.from("orders").select("*,order_items(*)").eq("id", orderId).single();
    if (error || !data) { setNotice("找不到訂單，或目前沒有讀取權限。"); return; }
    const nextOrder = data as AdminOrder;
    setOrder(nextOrder);
    const paymentResult = await supabase.from("order_payments").select("id,amount,payment_method,paid_at").eq("order_id", orderId).maybeSingle();
    setPayment(paymentResult.error || !paymentResult.data ? null : paymentResult.data as OrderPayment);
    const reversalResult = paymentResult.data?.id ? await supabase.from("order_payment_reversals").select("amount,reason,reversed_at,actor_id").eq("payment_id", paymentResult.data.id).maybeSingle() : null;
    setPaymentReversal(!reversalResult || reversalResult.error || !reversalResult.data ? null : reversalResult.data as OrderPaymentReversal);
    setShippingFee(String(nextOrder.shipping_fee ?? 0));
    setDiscountAmount(String(nextOrder.discount_amount ?? 0));
    setSourceRequest(null); setSourceFishName(""); setSourceRequestUnavailable(false);
    if (nextOrder.fish_request_id) {
      const requestResult = await supabase.from("fish_requests").select("*").eq("id", nextOrder.fish_request_id).maybeSingle();
      if (requestResult.error || !requestResult.data) setSourceRequestUnavailable(true);
      else {
        const nextRequest = requestResult.data as FishRequest;
        setSourceRequest(nextRequest);
        if (nextRequest.fish_catalog_id) {
          const catalogResult = await supabase.from("fish_catalog").select("name").eq("id", nextRequest.fish_catalog_id).maybeSingle();
          setSourceFishName(catalogResult.data?.name || nextRequest.fish_name);
        } else setSourceFishName(nextRequest.fish_name);
      }
    }
    const item = nextOrder.order_items[0];
    if (!item?.product_id) return;
    const [productResult, presetResult, optionResult, presetOptionResult] = await Promise.all([
      supabase.from("products").select("processing_enabled").eq("id", item.product_id).single(),
      supabase.from("product_processing_presets").select("preset_id,active,sort_order,processing_presets(id,name,active)").eq("product_id", item.product_id).eq("active", true).order("sort_order"),
      supabase.from("product_processing_options").select("processing_option_id,active,sort_order,processing_options(id,name,active)").eq("product_id", item.product_id).eq("active", true).order("sort_order"),
      supabase.from("processing_preset_options").select("preset_id,processing_option_id")
    ]);
    setProductConfig((productResult.data || null) as ProductConfig | null);
    const nextPresets = ((presetResult.data || []) as unknown as Array<{ preset_id: string; processing_presets: ProcessingPreset[] }>).flatMap((row) => row.processing_presets[0]?.active ? [{ ...row.processing_presets[0], id: row.preset_id }] : []);
    const nextOptions = ((optionResult.data || []) as unknown as Array<{ processing_option_id: string; processing_options: ProcessingOption[] }>).flatMap((row) => row.processing_options[0]?.active ? [{ ...row.processing_options[0], id: row.processing_option_id }] : []);
    setPresets(nextPresets); setOptions(nextOptions);
    setPresetOptions(((presetOptionResult.data || []) as Array<{ preset_id: string; processing_option_id: string }>).reduce<Record<string, string[]>>((result, row) => {
      result[row.preset_id] = [...(result[row.preset_id] || []), row.processing_option_id].sort();
      return result;
    }, {}));
    setDraftForm({
      fulfillment: nextOrder.fulfillment || "",
      presetId: item.processing_preset_id || "",
      optionIds: item.processing_option_ids || [],
      processingNote: item.processing_note || "",
      note: nextOrder.note || ""
    });
  }, [orderId, supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || null);
      setAuthReady(true);
      if (data.session) loadOrder();
    });
  }, [loadOrder, supabase]);

  async function updateOrder(payload: { status?: string }) {
    if (!order || busy) return;
    if (payload.status === "cancelled") return;
    setBusy(true); setNotice("");
    const { error } = await supabase.from("orders").update(payload).eq("id", order.id);
    if (error) setNotice("訂單狀態更新失敗，請稍後再試。");
    else { setNotice("訂單狀態已更新。"); await loadOrder(); }
    setBusy(false);
  }

  function changePreset(presetId: string) {
    setDraftForm((current) => ({ ...current, presetId, optionIds: presetId ? presetOptions[presetId] || [] : [] }));
  }

  function toggleOption(optionId: string) {
    setDraftForm((current) => ({ ...current, presetId: "", optionIds: current.optionIds.includes(optionId) ? current.optionIds.filter((id) => id !== optionId) : [...current.optionIds, optionId].sort() }));
  }

  async function saveDraft() {
    if (!order || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.rpc("admin_save_fish_request_order_draft_metadata", {
      p_order_id: order.id,
      p_fulfillment: draftForm.fulfillment || null,
      p_processing_preset_id: draftForm.presetId || null,
      p_processing_option_ids: draftForm.optionIds,
      p_processing_note: draftForm.processingNote || null,
      p_note: draftForm.note || null
    });
    setBusy(false);
    if (error) setNotice(errorMessage(error.message));
    else { setNotice("草稿資料已儲存，尚未扣除庫存。"); await loadOrder(); }
  }

  async function confirmDraft() {
    if (!order || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.rpc("admin_confirm_fish_request_order_draft", { p_order_id: order.id });
    setBusy(false); setConfirming(false);
    if (error) setNotice(errorMessage(error.message));
    else { setNotice("訂單已確認，庫存已扣除。"); await loadOrder(); }
  }

  async function cancelOrder() {
    if (!order || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.rpc("admin_cancel_order", { p_order_id: order.id });
    setBusy(false); setCancelling(false);
    if (error) setNotice(errorMessage(error.message));
    else { setNotice("訂單已取消，庫存已補回，並已寫入庫存異動紀錄。"); await loadOrder(); }
  }

  async function saveOrderTotals() {
    if (!order || busy) return;
    const nextShippingFee = Number(shippingFee), nextDiscountAmount = Number(discountAmount);
    if (!Number.isInteger(nextShippingFee) || nextShippingFee < 0 || !Number.isInteger(nextDiscountAmount) || nextDiscountAmount < 0) { setNotice("運費與折扣必須是大於或等於 0 的整數金額。"); return; }
    setBusy(true); setNotice("");
    const { error } = await supabase.rpc("admin_update_order_totals", { p_order_id: order.id, p_shipping_fee: nextShippingFee, p_discount_amount: nextDiscountAmount });
    setBusy(false);
    if (error) setNotice(errorMessage(error.message));
    else { setNotice("運費、折扣與應收總額已更新。"); await loadOrder(); }
  }

  async function recordPayment() {
    if (!order || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.rpc("admin_record_order_payment", { p_order_id: order.id, p_amount: orderTotal(order), p_payment_method: paymentMethod });
    setBusy(false); setConfirmingPayment(false);
    if (error) setNotice(errorMessage(error.message));
    else { setNotice("收款已記錄，付款狀態已更新為已付款。"); await loadOrder(); }
  }

  async function reversePayment() {
    if (!order || busy) return;
    if (!reversalReason.trim()) { setNotice("請輸入撤銷原因。"); return; }
    setBusy(true); setNotice("");
    const { error } = await supabase.rpc("admin_reverse_order_payment", { p_order_id: order.id, p_reason: reversalReason.trim() });
    setBusy(false); setReversingPayment(false);
    if (error) setNotice(errorMessage(error.message));
    else { setNotice("收款已撤銷，原付款紀錄已永久保留。"); setReversalReason(""); await loadOrder(); }
  }

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!order) return <main className="admin"><section className="panel centeredNotice"><Link href="/admin/orders">← 返回訂單</Link><p>{notice || "載入訂單中…"}</p></section></main>;

  const parsedNote = parseOrderNote(order.note);
  const item = order.order_items[0] as AdminOrderItem | undefined;
  const isDraft = order.status === "draft";
  const isCancelled = order.status === "cancelled";
  const canCancel = !isDraft && !isCancelled && order.payment_status !== "paid";
  const hasTotalsSnapshot = order.subtotal !== null && order.subtotal !== undefined;
  const canRecordPayment = !isDraft && !isCancelled && hasTotalsSnapshot && order.payment_status === "unpaid";
  const editableOrderStatusOptions = orderStatusOptions.filter((option) => option.value !== "cancelled");
  const canConfirm = Boolean(order.fulfillment && order.processing && item && order.order_items.length === 1);
  const selectedPreset = presets.find((preset) => preset.id === draftForm.presetId);
  const processingDisplay = productConfig?.processing_enabled ? selectedPreset?.name || (draftForm.optionIds.length ? "客製化處理" : "不處理") : "不處理";
  const processingSummaryText = [processingDisplay, ...options.filter((option) => draftForm.optionIds.includes(option.id)).map((option) => option.name), draftForm.processingNote].filter(Boolean).join("｜");

  return <main className="admin orderDetailPage">
    <header className="adminTop ordersTop"><div><Link href="/admin/orders">← 返回今日訂單</Link><h1>訂單詳情</h1><p>#{order.id}</p></div><span className={"orderStatus status-" + order.status}>{orderStatusLabel(order.status)}</span></header>
    {isDraft && <section className="panel draftCompletionPanel"><header><div><small>F003-10</small><h2>完成訂單資料</h2><p>儲存草稿不會扣庫存；只有確認正式訂單才會扣除庫存並完成來源需求。</p></div><span>草稿</span></header><div className="draftCompletionFields"><label>配送方式 *<select value={draftForm.fulfillment} disabled={busy} onChange={(event) => setDraftForm((current) => ({ ...current, fulfillment: event.target.value }))}><option value="">請選擇配送方式</option>{fulfillmentOptions.map((value) => <option value={value} key={value}>{deliveryLabel(value)}</option>)}</select></label><label>處理方式 <select value={draftForm.presetId} disabled={busy || productConfig?.processing_enabled === false} onChange={(event) => changePreset(event.target.value)}><option value="">不處理</option>{presets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>{productConfig?.processing_enabled ? <fieldset className="draftProcessingOptions"><legend>處理項目</legend>{options.map((option) => <label className="check" key={option.id}><input type="checkbox" checked={draftForm.optionIds.includes(option.id)} disabled={busy} onChange={() => toggleOption(option.id)} />{option.name}</label>)}</fieldset> : <p className="draftNoProcessing">此商品不提供處理方式，將使用既有「不處理」設定。</p>}<label className="draftWide">其他處理需求<textarea rows={3} maxLength={500} value={draftForm.processingNote} disabled={busy || productConfig?.processing_enabled === false} onChange={(event) => setDraftForm((current) => ({ ...current, processingNote: event.target.value }))} /></label><label className="draftWide">訂單備註<textarea rows={3} value={draftForm.note} disabled={busy} onChange={(event) => setDraftForm((current) => ({ ...current, note: event.target.value }))} /></label></div><div className="draftCompletionActions"><button type="button" className="secondaryAdminAction" disabled={busy} onClick={saveDraft}>{busy ? "儲存中…" : "儲存草稿"}</button><button type="button" disabled={busy || !canConfirm} onClick={() => setConfirming(true)}>{!canConfirm ? "請先儲存完整資料" : "確認正式訂單"}</button></div>{confirming && item && <section className="draftConfirmSummary" aria-live="polite"><h3>確認正式訂單</h3><dl><div><dt>客戶</dt><dd>{order.customer_name}</dd></div><div><dt>商品</dt><dd>{item.product_name}</dd></div><div><dt>規格</dt><dd>{item.variant_name || "未指定"}</dd></div><div><dt>數量</dt><dd>{item.quantity}</dd></div><div><dt>單價</dt><dd>{(item.price || 0).toLocaleString("zh-TW")}</dd></div><div><dt>小計</dt><dd>{((item.price || 0) * item.quantity).toLocaleString("zh-TW")}</dd></div><div><dt>配送方式</dt><dd>{deliveryLabel(order.fulfillment)}</dd></div><div><dt>處理方式</dt><dd>{processingSummaryText}</dd></div><div><dt>備註</dt><dd>{order.note || "無"}</dd></div></dl><p>確認後將正式扣除庫存，並把魚貨需求標記為已完成。</p><div><button type="button" className="secondaryAdminAction" disabled={busy} onClick={() => setConfirming(false)}>返回編輯</button><button type="button" disabled={busy} onClick={confirmDraft}>{busy ? "確認中…" : "確認並扣除庫存"}</button></div></section>}</section>}
    {order.fish_request_id && <section className="panel sourceRequestPanel"><h2>來源魚貨需求</h2>{sourceRequest ? <><dl><div><dt>正式魚種</dt><dd>{sourceFishName}</dd></div><div><dt>名稱快照</dt><dd>{sourceRequest.fish_name}</dd></div><div><dt>數量需求</dt><dd>{sourceRequest.quantity_request}</dd></div><div><dt>尺寸偏好</dt><dd>{sourceRequest.size_preference || "未指定"}</dd></div><div><dt>預算</dt><dd>{sourceRequest.budget || "未指定"}</dd></div><div><dt>希望日期</dt><dd>{formatWantedBy(sourceRequest.wanted_by)}</dd></div><div><dt>用途</dt><dd>{sourceRequest.purpose || "未指定"}</dd></div><div><dt>需求狀態</dt><dd>{fishRequestStatusLabel(sourceRequest.status)}</dd></div></dl><Link className="buttonLink secondaryAdminAction" href={"/admin/requests/" + sourceRequest.id}>查看來源需求</Link></> : <p className="notice">{sourceRequestUnavailable ? "來源需求目前無法讀取" : "正在讀取來源需求…"}</p>}</section>}
    <section className="orderDetailGrid">
      <article className="panel detailCustomer"><header><div><small>建立時間</small><strong>{formatOrderTime(order.created_at, true)}</strong></div><div><small>應收總額</small><strong className="detailTotal">NT${orderTotal(order).toLocaleString("zh-TW")}</strong></div></header><h2>{order.customer_name}</h2><dl><div><dt>電話</dt><dd><a href={"tel:" + order.phone}>{order.phone}</a></dd></div>{order.email && <div><dt>Email</dt><dd><a href={"mailto:" + order.email}>{order.email}</a></dd></div>}</dl><div className="quickContact"><a className="buttonLink" href={"tel:" + order.phone}>撥打電話</a>{order.email && <a className="buttonLink secondaryAdminAction" href={"mailto:" + order.email}>寄 Email</a>}{order.customer_id && <Link className="buttonLink secondaryAdminAction" href={"/admin/customers/" + order.customer_id}>查看客戶</Link>}</div></article>
      <article className="panel detailDelivery"><h2>配送資訊</h2><dl><div><dt>配送方式</dt><dd>{deliveryLabel(order.fulfillment)}</dd></div>{Object.entries(parsedNote.details).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{isDraft && <p className="draftOrderNotice">草稿尚未確認配送與魚貨處理方式，也不代表已保留庫存。</p>}{parsedNote.customerNote && <section className="customerNote"><strong>📝 客人備註</strong><p>{parsedNote.customerNote}</p></section>}</article>
      <article className="panel detailTotals"><h2>訂單金額</h2>{hasTotalsSnapshot ? <><dl><div><dt>商品小計</dt><dd>NT${orderSubtotal(order).toLocaleString("zh-TW")}</dd></div><div><dt>運費</dt><dd>NT${(order.shipping_fee || 0).toLocaleString("zh-TW")}</dd></div><div><dt>折扣</dt><dd>-NT${(order.discount_amount || 0).toLocaleString("zh-TW")}</dd></div><div><dt>應收總額</dt><dd><strong>NT${orderTotal(order).toLocaleString("zh-TW")}</strong></dd></div></dl>{!isCancelled && <div className="orderTotalsEditor"><label>運費<input type="number" min="0" step="1" value={shippingFee} disabled={busy} onChange={(event) => setShippingFee(event.target.value)} /></label><label>折扣<input type="number" min="0" step="1" value={discountAmount} disabled={busy} onChange={(event) => setDiscountAmount(event.target.value)} /></label><button type="button" disabled={busy} onClick={saveOrderTotals}>{busy ? "儲存中…" : "儲存金額調整"}</button></div>}</> : <p className="notice">此歷史訂單尚無 F003-14 金額 snapshot，維持原始品項價格資料，不會自動回填。</p>}</article>
      <article className="panel detailPayment"><h2>收款紀錄</h2>{payment ? <>{paymentReversal && <p className="notice"><strong>此筆收款已撤銷</strong></p>}<dl><div><dt>付款狀態</dt><dd>{paymentReversal ? "未付款（原收款已撤銷）" : "已付款"}</dd></div><div><dt>{paymentReversal ? "原實收金額" : "實收金額"}</dt><dd>NT${payment.amount.toLocaleString("zh-TW")}</dd></div><div><dt>{paymentReversal ? "原付款方式" : "付款方式"}</dt><dd>{{ cash: "現金", bank_transfer: "銀行轉帳", other: "其他" }[payment.payment_method]}</dd></div><div><dt>{paymentReversal ? "原付款時間" : "付款時間"}</dt><dd>{formatOrderTime(payment.paid_at, true)}</dd></div>{paymentReversal && <><div><dt>撤銷時間</dt><dd>{formatOrderTime(paymentReversal.reversed_at, true)}</dd></div><div><dt>撤銷原因</dt><dd>{paymentReversal.reason}</dd></div></>}</dl>{!paymentReversal && !isCancelled && <button type="button" className="dangerSecondaryAction" disabled={busy} onClick={() => setReversingPayment(true)}>撤銷收款</button>}{reversingPayment && <section className="orderPaymentConfirm" aria-live="polite"><h3>確認撤銷收款</h3><p>撤銷後付款狀態會改回未付款，原收款與本次原因將永久保留。</p><label>撤銷原因 *<textarea rows={3} value={reversalReason} disabled={busy} onChange={(event) => setReversalReason(event.target.value)} placeholder="例如：客人取消、誤按收款、轉帳未實際入帳、其他" /></label><button type="button" className="secondaryAdminAction" disabled={busy} onClick={() => setReversingPayment(false)}>返回</button><button type="button" className="dangerSecondaryAction" disabled={busy || !reversalReason.trim()} onClick={reversePayment}>{busy ? "撤銷中…" : "確認撤銷收款"}</button></section>}</> : canRecordPayment ? <><p>付款狀態：未付款</p><p>應收金額：<strong>NT${orderTotal(order).toLocaleString("zh-TW")}</strong></p><label>付款方式<select value={paymentMethod} disabled={busy} onChange={(event) => setPaymentMethod(event.target.value)}><option value="cash">現金</option><option value="bank_transfer">銀行轉帳</option><option value="other">其他</option></select></label><button type="button" disabled={busy} onClick={() => setConfirmingPayment(true)}>確認收款</button>{confirmingPayment && <section className="orderPaymentConfirm" aria-live="polite"><p>確認後會記錄實收金額與付款方式，並將付款狀態改為已付款。</p><button type="button" className="secondaryAdminAction" disabled={busy} onClick={() => setConfirmingPayment(false)}>返回</button><button type="button" disabled={busy} onClick={recordPayment}>{busy ? "記錄中…" : "確認收款"}</button></section>}</> : <p className="notice">{isDraft ? "草稿訂單不能確認收款。" : isCancelled ? "已取消訂單不能確認收款。" : order.payment_status === "paid" ? "此歷史訂單沒有可撤銷的正式收款紀錄。" : "此歷史訂單尚無金額 snapshot，不能確認收款。"}</p>}</article>
      <article className="panel detailStatuses"><h2>訂單狀態</h2><label>處理進度<select disabled={busy || isDraft || isCancelled} value={order.status} onChange={(event) => updateOrder({ status: event.target.value })}>{editableOrderStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}{!editableOrderStatusOptions.some((option) => option.value === order.status) && <option value={order.status}>{orderStatusLabel(order.status)}</option>}</select></label>{isDraft && <small>草稿需先補齊配送與魚貨處理方式，不能使用正式訂單取消流程。</small>}{isCancelled && <small>此訂單已取消，庫存已補回，且不能恢復為其他狀態。</small>}<p>付款狀態：{paymentStatusLabel(order.payment_status)}</p><div className="statusSnapshot"><span>{orderStatusLabel(order.status)}</span><span>{paymentStatusLabel(order.payment_status)}</span></div>{canCancel && <div className="orderCancellationActions"><button type="button" className="dangerSecondaryAction" disabled={busy} onClick={() => setCancelling(true)}>取消訂單</button></div>}{cancelling && <section className="orderCancellationConfirm" aria-live="polite"><h3>確認取消訂單</h3><p>取消後，此訂單將標記為已取消；原本已扣除的庫存會依訂單規格與數量補回，並留下庫存異動紀錄。</p><p>此操作無法由此頁恢復，確認前請再次核對訂單內容。</p><div><button type="button" className="secondaryAdminAction" disabled={busy} onClick={() => setCancelling(false)}>返回</button><button type="button" className="dangerSecondaryAction" disabled={busy} onClick={cancelOrder}>{busy ? "取消中…" : "確認取消並補回庫存"}</button></div></section>}{notice && <p className="notice" aria-live="polite">{notice}</p>}</article>
    </section>
    <section className="panel detailItems"><h2>訂單商品</h2>{order.order_items.map((orderItem) => { const processing = processingSummary(orderItem); const subtotal = (orderItem.price || 0) * orderItem.quantity; return <article className="detailOrderItem" key={orderItem.id}><header><div><h3>{orderItem.product_name}</h3><p>{orderItem.variant_name || "未指定規格"}</p></div><strong>{subtotal.toLocaleString("zh-TW")}</strong></header><dl><div><dt>數量</dt><dd>{orderItem.quantity}</dd></div><div><dt>單價</dt><dd>{(orderItem.price || 0).toLocaleString("zh-TW")}</dd></div><div><dt>小計</dt><dd>{subtotal.toLocaleString("zh-TW")}</dd></div></dl><div className="detailProcessing"><strong>處理：{processing.name}</strong>{processing.extras.map((extra) => <span key={extra}>＋{extra}</span>)}{orderItem.processing_note && <span>其他處理需求：{orderItem.processing_note}</span>}</div></article>; })}</section>
  </main>;
}


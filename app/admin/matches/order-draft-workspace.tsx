"use client";

import { useEffect, useMemo, useState } from "react";
import type { Product, ProductVariant } from "@/lib/catalog";
import type { FishRequest } from "@/lib/fish-requests";
import { fishRequestStatusLabel, formatWantedBy } from "@/lib/fish-requests";
import { getDraftProducts, getDraftVariants, isDraftVariantAvailable, validateDraftQuantity } from "@/lib/order-draft";
import { createClient } from "@/lib/supabase-browser";

type CreatedDraft = { id: string; customer_name: string };
type Props = { request: FishRequest; fishName: string; products: Product[]; variants: ProductVariant[]; onClose: () => void };

const errorMessages: Record<string, string> = {
  admin_required: "只有管理員可以建立訂單草稿。",
  fish_request_not_found: "找不到這筆魚貨需求。",
  fish_request_not_eligible: "此需求目前無法建立訂單草稿。",
  fish_request_draft_exists: "此需求已經有一張訂單草稿。",
  variant_not_found: "找不到所選規格。",
  variant_unavailable: "所選規格目前無法販售，請重新選擇。",
  insufficient_inventory: "所選數量超過目前現貨件數，請重新確認。",
  fish_request_product_mismatch: "所選商品與這筆魚貨需求不相符。",
  invalid_quantity: "請輸入有效的整數數量。"
};

function friendlyError(message: string) {
  const match = Object.keys(errorMessages).find((code) => message.includes(code));
  return match ? errorMessages[match] : "訂單草稿建立失敗，請稍後再試。";
}

export default function OrderDraftWorkspace({ request, fishName, products, variants, onClose }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const availableProducts = useMemo(() => getDraftProducts(products, variants, request), [products, request, variants]);
  const [productId, setProductId] = useState(availableProducts.length === 1 ? availableProducts[0].id : "");
  const productVariants = useMemo(() => getDraftVariants(variants, productId), [productId, variants]);
  const availableVariants = productVariants.filter(isDraftVariantAvailable);
  const [variantId, setVariantId] = useState(availableVariants.length === 1 ? availableVariants[0].id : "");
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [created, setCreated] = useState<CreatedDraft | null>(null);
  const selectedProduct = availableProducts.find((product) => product.id === productId);
  const selectedVariant = productVariants.find((variant) => variant.id === variantId);
  const quantityError = selectedVariant ? validateDraftQuantity(quantity, selectedVariant.inventory) : "請選擇規格";

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose]);

  function selectProduct(nextProductId: string) {
    setProductId(nextProductId);
    const nextVariants = getDraftVariants(variants, nextProductId).filter(isDraftVariantAvailable);
    setVariantId(nextVariants.length === 1 ? nextVariants[0].id : "");
    setQuantity(1);
    setNotice("");
  }

  async function createDraft() {
    if (!selectedVariant || quantityError || busy) { setNotice(quantityError); return; }
    setBusy(true); setNotice("");
    const { data, error } = await supabase.rpc("admin_create_fish_request_order_draft", {
      p_request_id: request.id, p_variant_id: selectedVariant.id, p_quantity: quantity
    });
    setBusy(false);
    if (error) { setNotice(friendlyError(error.message)); return; }
    setCreated(data as CreatedDraft);
    setNotice("訂單草稿已建立；需求狀態與商品庫存均未變更。");
  }

  const subtotal = selectedVariant ? selectedVariant.price * quantity : 0;
  return <div className="contactWorkspaceBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="contactWorkspace orderDraftWorkspace" role="dialog" aria-modal="true" aria-labelledby="order-draft-title">
      <header><div><small>Fish Request → Order Draft</small><h2 id="order-draft-title">建立訂單草稿</h2><span className={"requestStatus status-" + request.status}>{fishRequestStatusLabel(request.status)}</span></div><button type="button" className="contactWorkspaceClose" aria-label="關閉訂單草稿工作台" onClick={onClose}>×</button></header>
      <div className="orderDraftBody">
        <section className="contactWorkspaceDetails"><h3>需求與客戶</h3><dl><div><dt>客戶</dt><dd>{request.customer_name}</dd></div><div><dt>電話</dt><dd>{request.phone}</dd></div>{request.email && <div><dt>Email</dt><dd>{request.email}</dd></div>}<div><dt>正式魚種</dt><dd>{fishName}</dd></div>{request.fish_name !== fishName && <div><dt>原始需求</dt><dd>{request.fish_name}</dd></div>}<div><dt>需求數量</dt><dd>{request.quantity_request}</dd></div><div><dt>尺寸偏好</dt><dd>{request.size_preference || "未指定"}</dd></div><div><dt>預算</dt><dd>{request.budget || "未指定"}</dd></div><div><dt>希望日期</dt><dd>{formatWantedBy(request.wanted_by)}</dd></div></dl>{request.note && <div className="contactWorkspaceNote"><strong>備註</strong><p>{request.note}</p></div>}</section>
        <section className="orderDraftForm"><h3>選擇實際商品</h3>{availableProducts.length === 0 ? <p className="notice">目前沒有符合魚種且可販售的商品規格。</p> : <><label>商品<select value={productId} onChange={(event) => selectProduct(event.target.value)}><option value="">請選擇商品</option>{availableProducts.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}</select></label><label>規格<select value={variantId} disabled={!productId} onChange={(event) => { setVariantId(event.target.value); setQuantity(1); setNotice(""); }}><option value="">請選擇規格</option>{productVariants.map((variant) => <option value={variant.id} disabled={!isDraftVariantAvailable(variant)} key={variant.id}>{variant.name}｜{variant.price.toLocaleString("zh-TW")}｜{variant.active ? variant.inventory > 0 ? "現貨｜剩 " + variant.inventory + " 件" : "已售完" : "未上架"}</option>)}</select></label><label>數量<input type="number" min={1} max={selectedVariant?.inventory} step={1} value={quantity} disabled={!selectedVariant} onChange={(event) => setQuantity(Number(event.target.value))} /></label><div className="orderDraftSummary"><div><span>商品</span><strong>{selectedProduct?.name || "—"}</strong></div><div><span>規格</span><strong>{selectedVariant?.name || "—"}</strong></div><div><span>單價</span><strong>{selectedVariant ? selectedVariant.price.toLocaleString("zh-TW") : "—"}</strong></div><div><span>小計</span><strong>{selectedVariant ? subtotal.toLocaleString("zh-TW") : "—"}</strong></div></div><p className="orderDraftWarning">此動作只建立草稿，不保留庫存、不扣庫存，也不會將需求標記為已完成。</p>{created ? <div className="orderDraftSuccess"><strong>草稿 #{created.id}</strong><span>{created.customer_name}｜{selectedProduct?.name}｜{selectedVariant?.name} × {quantity}</span><span>小計 {subtotal.toLocaleString("zh-TW")}｜來源：魚貨需求</span><a className="buttonLink" href={"/admin/orders/" + created.id}>查看訂單草稿</a></div> : <button type="button" className="openContactWorkspace" disabled={busy || !selectedVariant || !!quantityError} onClick={createDraft}>{busy ? "建立中…" : "建立訂單草稿"}</button>}</>}</section>
      </div><p className="contactFeedback orderDraftFeedback" aria-live="polite">{notice}</p>
    </section>
  </div>;
}

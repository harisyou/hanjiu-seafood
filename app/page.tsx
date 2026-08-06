"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { formatPrice, Product, ProductVariant } from "@/lib/catalog";

type CartItem = {
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_name: string;
  price: number;
  quantity: number;
};

function getPurchaseLimit(variant: ProductVariant) {
  return variant.inventory;
}

export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ customer_name: "", phone: "", line_id: "", fulfillment: "到店取貨", processing: "不處理", note: "" });

  useEffect(() => {
    async function loadCatalog() {
      const [productResult, variantResult] = await Promise.all([
        supabase.from("products").select("*").neq("status", "hidden").order("sort_order"),
        supabase.from("product_variants").select("*").eq("active", true).order("sort_order")
      ]);
      if (productResult.error) setNotice(`商品載入失敗：${productResult.error.message}`);
      else setProducts((productResult.data || []) as Product[]);
      if (variantResult.error) setNotice(`規格載入失敗：${variantResult.error.message}`);
      else setVariants((variantResult.data || []) as ProductVariant[]);
    }
    loadCatalog();
  }, [supabase]);

  useEffect(() => {
    const automaticSelections: Record<string, string> = {};

    products.forEach((product) => {
      const availableVariants = variants.filter((variant) =>
        variant.product_id === product.id &&
        getPurchaseLimit(variant) > 0 &&
        product.status === "available"
      );
      if (availableVariants.length === 1) automaticSelections[product.id] = availableVariants[0].id;
    });

    setSelectedVariants((current) => {
      const next = { ...current };
      let changed = false;

      Object.entries(automaticSelections).forEach(([productId, variantId]) => {
        if (!next[productId]) {
          next[productId] = variantId;
          changed = true;
        }
      });

      return changed ? next : current;
    });

    setSelectedQuantities((current) => {
      const next = { ...current };
      let changed = false;

      Object.keys(automaticSelections).forEach((productId) => {
        if (!next[productId]) {
          next[productId] = 1;
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [products, variants]);

  function selectVariant(productId: string, variantId: string) {
    setSelectedVariants((current) => ({ ...current, [productId]: variantId }));
    setSelectedQuantities((current) => ({ ...current, [productId]: 1 }));
  }

  function setProductQuantity(productId: string, inventory: number, quantity: number) {
    const nextQuantity = Math.min(inventory, Math.max(1, quantity));
    setSelectedQuantities((current) => ({ ...current, [productId]: nextQuantity }));
  }

  function addToCart(product: Product) {
    const variantId = selectedVariants[product.id];
    const variant = variants.find((item) => item.id === variantId && item.product_id === product.id);
    if (!variant) return setNotice(`請先選擇「${product.name}」的規格。`);
    const purchaseLimit = getPurchaseLimit(variant);
    if (product.status !== "available" || purchaseLimit <= 0) return setNotice("此規格目前已售完。");
    const quantity = Math.min(purchaseLimit, Math.max(1, selectedQuantities[product.id] || 1));

    setCart((items) => {
      const found = items.find((item) => item.variant_id === variant.id);
      if (found) return items.map((item) => item.variant_id === variant.id ? { ...item, quantity: item.quantity + quantity } : item);
      return [...items, { product_id: product.id, product_name: product.name, variant_id: variant.id, variant_name: variant.name, price: variant.price, quantity }];
    });
    setNotice(`${product.name}（${variant.name}）已加入購物車。`);
  }

  function changeQuantity(variantId: string, quantity: number) {
    if (quantity <= 0) setCart((items) => items.filter((item) => item.variant_id !== variantId));
    else setCart((items) => items.map((item) => item.variant_id === variantId ? { ...item, quantity } : item));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form.customer_name.trim() || !form.phone.trim() || cart.length === 0) return setNotice("請填寫姓名、電話並選購商品。");
    const { data: order, error } = await supabase.from("orders").insert({ ...form, line_id: form.line_id || null, note: form.note || null, status: "new" }).select("id").single();
    if (error || !order) return setNotice(`訂單送出失敗：${error?.message || "無法建立訂單"}`);

    const { error: itemError } = await supabase.from("order_items").insert(cart.map((item) => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      variant_id: item.variant_id,
      variant_name: item.variant_name,
      price: item.price,
      quantity: item.quantity
    })));
    if (itemError) return setNotice(`訂單品項儲存失敗：${itemError.message}`);

    const text = ["海鮮訂購單", `姓名：${form.customer_name}`, `電話：${form.phone}`, "", ...cart.map((item) => `${item.product_name}｜${item.variant_name}｜${formatPrice(item.price)} × ${item.quantity}`), "", `取貨方式：${form.fulfillment}`, `處理方式：${form.processing}`, form.note ? `備註：${form.note}` : ""].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* Clipboard permission is optional. */ }
    setCart([]); setNotice("訂單已送出，內容也已複製，可前往 LINE 聯絡我們。");
    window.open("https://lin.ee/q4avfUZ", "_blank", "noopener,noreferrer");
  }

  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  return (
    <main>
      <header className="hero"><nav><strong>漢久海鮮</strong><div><Link href="/admin">後台管理</Link><a href="#order">查看購物車</a></div></nav><section><p>每日嚴選，新鮮直送</p><h1>今天，吃好魚。</h1><p>挑選想要的商品與規格，送出訂單後由我們與你確認取貨細節。</p></section></header>
      <section className="content">
        <div className="heading"><div><small>TODAY&apos;S CATCH</small><h2>今日海鮮</h2></div><p>每個規格皆有獨立價格與限購數量，實際供應以頁面顯示為準。</p></div>
        <div className="grid">
          {products.map((product) => {
            const productVariants = variants.filter((variant) => variant.product_id === product.id);
            const purchasableVariants = productVariants.filter((variant) => getPurchaseLimit(variant) > 0 && product.status === "available");
            const selectedVariant = purchasableVariants.find((variant) => variant.id === selectedVariants[product.id]);
            const selectedQuantity = selectedQuantities[product.id] || 1;
            const purchaseLimit = selectedVariant ? getPurchaseLimit(selectedVariant) : 0;
            const soldOut = purchasableVariants.length === 0;
            return <article className="card" key={product.id}>
              <div className="photo">{product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" /> : <span>🦀</span>}{product.featured && <b>本日精選</b>}</div>
              <div className="body"><small>{product.status === "available" ? "今日供應" : "已售完"}</small><h3>{product.name}</h3><p>{product.description}</p><p>料理建議：{product.cooking || "歡迎詢問"}</p>
                {purchasableVariants.length > 0 && <div className="variantSelector">
                  <label htmlFor={`variant-${product.id}`}>選擇規格</label>
                  <select id={`variant-${product.id}`} value={selectedVariants[product.id] || ""} onChange={(event) => selectVariant(product.id, event.target.value)}>
                    <option value="" disabled>請選擇規格</option>
                    {purchasableVariants.map((variant) => <option value={variant.id} key={variant.id}>{variant.name}｜{formatPrice(variant.price)}</option>)}
                  </select>
                  {selectedVariant && <>
                    <div className="variantDetails">
                      <div><span>價格</span><strong>{formatPrice(selectedVariant.price)}</strong></div>
                      <div><span>本次限購</span><strong>{purchaseLimit} 隻</strong>{purchaseLimit === 1 && <small className="rareNotice">🔥 最後一份</small>}</div>
                    </div>
                    {purchaseLimit > 0 && <div className="variantQuantity">
                      <span>數量</span>
                      <div>
                        <button type="button" aria-label="減少數量" disabled={selectedQuantity <= 1} onClick={() => setProductQuantity(product.id, purchaseLimit, selectedQuantity - 1)}>−</button>
                        <strong>{selectedQuantity}</strong>
                        <button type="button" aria-label="增加數量" disabled={selectedQuantity >= purchaseLimit} onClick={() => setProductQuantity(product.id, purchaseLimit, selectedQuantity + 1)}>＋</button>
                      </div>
                    </div>}
                  </>}
                </div>}
                <button disabled={soldOut || !selectedVariant} onClick={() => addToCart(product)}>{soldOut ? "已售完" : !selectedVariant ? "請先選擇規格" : "加入購物車"}</button>
              </div>
            </article>;
          })}
        </div>
      </section>
      <section id="order" className="order">
        <div className="panel"><h2>你的購物車</h2>{cart.length === 0 ? <p>尚未選購商品。</p> : cart.map((item) => <div className="cartRow" key={item.variant_id}><div><strong>{item.product_name}</strong><small>{item.variant_name} · {formatPrice(item.price)}</small></div><div className="quantity"><button type="button" onClick={() => changeQuantity(item.variant_id, item.quantity - 1)}>−</button><span>{item.quantity}</span><button type="button" onClick={() => changeQuantity(item.variant_id, item.quantity + 1)}>＋</button></div></div>)}<div className="cartTotal"><strong>合計</strong><strong>{formatPrice(total)}</strong></div></div>
        <form className="panel" onSubmit={submit}><h2>聯絡資料</h2><label>姓名<input required value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} /></label><label>電話<input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label><label>LINE ID<input value={form.line_id} onChange={(e) => setForm({ ...form, line_id: e.target.value })} /></label><label>取貨方式<select value={form.fulfillment} onChange={(e) => setForm({ ...form, fulfillment: e.target.value })}><option>到店取貨</option><option>冷藏宅配</option><option>面交</option></select></label><label>處理方式<select value={form.processing} onChange={(e) => setForm({ ...form, processing: e.target.value })}><option>不處理</option><option>去鱗去內臟</option><option>切片</option></select></label><label>備註<textarea rows={4} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label><button>送出訂單</button>{notice && <p className="notice">{notice}</p>}</form>
      </section>
    </main>
  );
}

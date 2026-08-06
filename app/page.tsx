"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
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

type CartActionStatus = "idle" | "adding" | "success" | "error";
type DeliveryMethod = "永春市場自取" | "台北市配送" | "冷凍宅配" | "7-ELEVEN 冷凍交貨便";

type CheckoutForm = {
  customer_name: string;
  phone: string;
  fulfillment: DeliveryMethod;
  address: string;
  pickupDate: string;
  pickupTime: string;
  preferredStoreName: string;
  preferredStoreCode: string;
  note: string;
  rememberCustomerData: boolean;
};

const CHECKOUT_PROFILE_KEY = "hanjiu-checkout-profile-v1";
const deliveryMethods: Array<{ value: DeliveryMethod; icon: string; detail: string; recommendation: string }> = [
  { value: "永春市場自取", icon: "📍", detail: "可提前預留商品", recommendation: "最省運費" },
  { value: "台北市配送", icon: "🚚", detail: "單筆滿 2500 可配送到府", recommendation: "台北最方便" },
  { value: "冷凍宅配", icon: "❄️", detail: "韓九補貼一半運費", recommendation: "外縣市推薦" },
  { value: "7-ELEVEN 冷凍交貨便", icon: "🏪", detail: "韓九補貼一半運費", recommendation: "超商取貨" }
];

function getPurchaseLimit(variant: ProductVariant) {
  return variant.inventory;
}

function getCartQuantityForVariant(cart: CartItem[], variantId: string) {
  return cart
    .filter((item) => item.variant_id === variantId)
    .reduce((total, item) => total + item.quantity, 0);
}

function getRemainingPurchasable(variant: ProductVariant, cart: CartItem[]) {
  return Math.max(0, getPurchaseLimit(variant) - getCartQuantityForVariant(cart, variant.id));
}

export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [cartActionStatuses, setCartActionStatuses] = useState<Record<string, CartActionStatus>>({});
  const [productFeedback, setProductFeedback] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cartToast, setCartToast] = useState("");
  const [cartBounceKey, setCartBounceKey] = useState(0);
  const [animatedCartQuantity, setAnimatedCartQuantity] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<CheckoutForm>({ customer_name: "", phone: "", fulfillment: "永春市場自取", address: "", pickupDate: "", pickupTime: "", preferredStoreName: "", preferredStoreCode: "", note: "", rememberCustomerData: true });
  const [savedProfile, setSavedProfile] = useState<CheckoutForm | null>(null);
  const [editingCheckout, setEditingCheckout] = useState(true);
  const feedbackTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const cartActionLocks = useRef(new Set<string>());
  const cartToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    Object.values(feedbackTimers.current).forEach(clearTimeout);
    if (cartToastTimer.current) clearTimeout(cartToastTimer.current);
  }, []);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(CHECKOUT_PROFILE_KEY);
      if (!saved) return;
      const profile = JSON.parse(saved) as CheckoutForm;
      if (profile.customer_name || profile.phone) {
        setSavedProfile({ ...profile, rememberCustomerData: true });
        setEditingCheckout(false);
      }
    } catch {
      window.localStorage.removeItem(CHECKOUT_PROFILE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [drawerOpen]);

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

  useEffect(() => {
    setSelectedQuantities((current) => {
      const next = { ...current };
      let changed = false;

      Object.entries(selectedVariants).forEach(([productId, variantId]) => {
        const variant = variants.find((item) => item.id === variantId);
        if (!variant) return;
        const remainingPurchasable = getRemainingPurchasable(variant, cart);
        const nextQuantity = Math.min(current[productId] || 1, Math.max(1, remainingPurchasable));
        if (nextQuantity !== current[productId]) {
          next[productId] = nextQuantity;
          changed = true;
        }
      });

      return changed ? next : current;
    });
  }, [cart, selectedVariants, variants]);

  function selectVariant(productId: string, variantId: string) {
    clearTimeout(feedbackTimers.current[productId]);
    cartActionLocks.current.delete(productId);
    setSelectedVariants((current) => ({ ...current, [productId]: variantId }));
    setSelectedQuantities((current) => ({ ...current, [productId]: 1 }));
    setCartActionStatuses((current) => ({ ...current, [productId]: "idle" }));
    setProductFeedback((current) => ({ ...current, [productId]: "" }));
  }

  function showProductFeedback(productId: string, message: string, onClear?: () => void) {
    clearTimeout(feedbackTimers.current[productId]);
    setProductFeedback((current) => ({ ...current, [productId]: message }));
    feedbackTimers.current[productId] = setTimeout(() => {
      setProductFeedback((current) => ({ ...current, [productId]: "" }));
      onClear?.();
    }, 1800);
  }

  function setProductQuantity(productId: string, inventory: number, quantity: number, announceLimit = false) {
    const nextQuantity = Math.min(inventory, Math.max(1, quantity));
    setSelectedQuantities((current) => ({ ...current, [productId]: nextQuantity }));
    if (announceLimit && nextQuantity >= inventory) {
      showProductFeedback(productId, "已達本次限購上限");
    }
  }

  async function addToCart(product: Product) {
    if (cartActionLocks.current.has(product.id)) return;
    cartActionLocks.current.add(product.id);

    clearTimeout(feedbackTimers.current[product.id]);
    setProductFeedback((current) => ({ ...current, [product.id]: "" }));
    setCartActionStatuses((current) => ({ ...current, [product.id]: "adding" }));

    try {
      const variantId = selectedVariants[product.id];
      const variant = variants.find((item) => item.id === variantId && item.product_id === product.id);
      if (!variant) throw new Error("加入購物車失敗，請再試一次");
      const quantityAlreadyInCart = getCartQuantityForVariant(cart, variant.id);
      const remainingPurchasable = getRemainingPurchasable(variant, cart);
      if (product.status !== "available" || getPurchaseLimit(variant) <= 0) throw new Error("此規格目前已售完");
      if (remainingPurchasable <= 0) throw new Error("已達本次限購上限");
      const quantity = Math.max(1, selectedQuantities[product.id] || 1);
      if (quantity > remainingPurchasable) {
        throw new Error(`購物車內已有 ${quantityAlreadyInCart} 隻，本次最多還可加入 ${remainingPurchasable} 隻`);
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
      setCart((items) => {
        const found = items.find((item) => item.variant_id === variant.id);
        if (found) return items.map((item) => item.variant_id === variant.id ? { ...item, quantity: item.quantity + quantity } : item);
        return [...items, { product_id: product.id, product_name: product.name, variant_id: variant.id, variant_name: variant.name, price: variant.price, quantity }];
      });
      setCartActionStatuses((current) => ({ ...current, [product.id]: "success" }));
      const successMessage = `${variant.name} × ${quantity} 已加入購物車，購物車內共 ${quantityAlreadyInCart + quantity} 隻`;
      showProductFeedback(product.id, successMessage, () => {
        cartActionLocks.current.delete(product.id);
        setCartActionStatuses((current) => ({ ...current, [product.id]: "idle" }));
      });
      if (cartToastTimer.current) clearTimeout(cartToastTimer.current);
      setCartToast(successMessage);
      setCartBounceKey((current) => current + 1);
      cartToastTimer.current = setTimeout(() => setCartToast(""), 1800);
    } catch (error) {
      cartActionLocks.current.delete(product.id);
      setCartActionStatuses((current) => ({ ...current, [product.id]: "error" }));
      showProductFeedback(product.id, error instanceof Error ? error.message : "加入購物車失敗，請再試一次", () => {
        setCartActionStatuses((current) => ({ ...current, [product.id]: "idle" }));
      });
    }
  }

  function changeQuantity(variantId: string, quantity: number) {
    if (quantity <= 0) {
      setCart((items) => items.filter((item) => item.variant_id !== variantId));
      return;
    }

    const variant = variants.find((item) => item.id === variantId);
    if (!variant) return setNotice("無法確認此規格的限購數量，請重新整理頁面。");
    const purchaseLimit = getPurchaseLimit(variant);
    if (quantity > purchaseLimit) {
      setNotice(`${variant.name}本次最多可購買 ${purchaseLimit} 隻。`);
      return;
    }
    setCart((items) => items.map((item) => item.variant_id === variantId ? { ...item, quantity } : item));
    setAnimatedCartQuantity(`${variantId}-${quantity}`);
  }

  function useSavedCheckoutProfile() {
    if (!savedProfile) return;
    setForm({ ...savedProfile, rememberCustomerData: true });
    setEditingCheckout(true);
    setNotice("已帶入常用資料，請確認後送出訂單。");
  }

  function updateRememberPreference(rememberCustomerData: boolean) {
    setForm((current) => ({ ...current, rememberCustomerData }));
    if (!rememberCustomerData) {
      window.localStorage.removeItem(CHECKOUT_PROFILE_KEY);
      setSavedProfile(null);
    }
  }

  function validateCheckout() {
    if (!form.customer_name.trim()) return "請填寫姓名";
    if (!form.phone.trim()) return "請填寫電話";
    if (form.fulfillment === "永春市場自取" && !form.pickupDate) return "請選擇取貨日期";
    if (form.fulfillment === "永春市場自取" && !form.pickupTime) return "請選擇取貨時間";
    if ((form.fulfillment === "台北市配送" || form.fulfillment === "冷凍宅配") && !form.address.trim()) return "請填寫配送地址";
    if (form.fulfillment === "7-ELEVEN 冷凍交貨便" && !form.preferredStoreName.trim()) return "請填寫 7-ELEVEN 門市名稱";
    if (form.fulfillment === "台北市配送" && total < 2500) return `再買 ${shippingRemaining.toLocaleString("zh-TW")} 即可享台北市配送`;
    return "";
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (cart.length === 0) return setNotice("請先選購商品");
    const validationMessage = validateCheckout();
    if (validationMessage) return setNotice(validationMessage);
    const variantIds = [...new Set(cart.map((item) => item.variant_id))];
    const { data: latestVariants, error: variantError } = await supabase
      .from("product_variants")
      .select("id,name,inventory,active")
      .in("id", variantIds);
    if (variantError) return setNotice(`無法確認最新供應數量：${variantError.message}`);

    for (const item of cart) {
      const latestVariant = latestVariants?.find((variant) => variant.id === item.variant_id);
      const latestLimit = latestVariant?.active ? latestVariant.inventory : 0;
      if (!latestVariant || item.quantity > latestLimit) {
        setNotice(`此規格目前最多可購買 ${latestLimit} 隻，請調整購物車數量。`);
        return;
      }
    }

    const deliveryDetails = [
      form.address && `地址：${form.address}`,
      form.pickupDate && `日期：${form.pickupDate}`,
      form.pickupTime && `時間：${form.pickupTime}`,
      form.preferredStoreName && `門市：${form.preferredStoreName}`,
      form.preferredStoreCode && `店號：${form.preferredStoreCode}`,
      form.note && `備註：${form.note}`
    ].filter(Boolean).join("\n");
    const { data: order, error } = await supabase.from("orders").insert({ customer_name: form.customer_name, phone: form.phone, line_id: null, fulfillment: form.fulfillment, processing: "不處理", note: deliveryDetails || null, status: "new" }).select("id").single();
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

    if (form.rememberCustomerData) {
      window.localStorage.setItem(CHECKOUT_PROFILE_KEY, JSON.stringify(form));
      setSavedProfile(form);
    } else {
      window.localStorage.removeItem(CHECKOUT_PROFILE_KEY);
      setSavedProfile(null);
    }
    const text = ["海鮮訂購單", `姓名：${form.customer_name}`, `電話：${form.phone}`, "", ...cart.map((item) => `${item.product_name}｜${item.variant_name}｜${formatPrice(item.price)} × ${item.quantity}`), "", `配送方式：${form.fulfillment}`, deliveryDetails].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* Clipboard permission is optional. */ }
    setCart([]); setNotice("訂單已送出，內容也已複製，可前往 LINE 聯絡我們。");
    window.open("https://lin.ee/q4avfUZ", "_blank", "noopener,noreferrer");
  }

  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalQuantity = cart.reduce((sum, item) => sum + item.quantity, 0);
  const shippingThreshold = 2500;
  const shippingRemaining = Math.max(0, shippingThreshold - total);
  const shippingProgress = Math.min(100, (total / shippingThreshold) * 100);

  function goToCheckout() {
    setDrawerOpen(false);
    window.setTimeout(() => document.getElementById("order")?.scrollIntoView({ behavior: "smooth" }), 220);
  }

  const maskedPhone = savedProfile?.phone.replace(/^(\d{4})\d+(\d{3})$/, "$1-***-$2") || "";
  const maskedAddress = savedProfile?.address
    ? `${savedProfile.address.slice(0, 7)}${savedProfile.address.length > 7 ? "……" : ""}`
    : "";

  return (
    <main>
      <header className="hero"><nav><strong>漢久海鮮</strong><div><Link href="/admin">後台管理</Link><button className="headerCartButton" type="button" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><span className={cartBounceKey ? "cartIcon cartIconBounce" : "cartIcon"} key={cartBounceKey} aria-hidden="true">🛒</span> {totalQuantity} | {total.toLocaleString("zh-TW")}</button></div></nav><section><p>每日嚴選，新鮮直送</p><h1>今天，吃好魚。</h1><p>挑選想要的商品與規格，送出訂單後由我們與你確認取貨細節。</p></section></header>
      <section className="content">
        <div className="heading"><div><small>TODAY&apos;S CATCH</small><h2>今日海鮮</h2></div><p>每個規格皆有獨立價格與限購數量，實際供應以頁面顯示為準。</p></div>
        <div className="grid">
          {products.map((product) => {
            const productVariants = variants.filter((variant) => variant.product_id === product.id);
            const purchasableVariants = productVariants.filter((variant) => getPurchaseLimit(variant) > 0 && product.status === "available");
            const selectedVariant = purchasableVariants.find((variant) => variant.id === selectedVariants[product.id]);
            const selectedQuantity = selectedQuantities[product.id] || 1;
            const remainingPurchasable = selectedVariant ? getRemainingPurchasable(selectedVariant, cart) : 0;
            const soldOut = purchasableVariants.length === 0;
            const cartLimitReached = Boolean(selectedVariant && remainingPurchasable <= 0);
            const cartActionStatus = cartActionStatuses[product.id] || "idle";
            const addButtonText = soldOut
              ? "已售完"
              : !selectedVariant
                ? "請先選擇規格"
                : cartLimitReached
                  ? "已達本次限購上限"
                : cartActionStatus === "adding"
                  ? "加入中…"
                  : cartActionStatus === "success"
                    ? "✓ 已加入購物車"
                    : "加入購物車";
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
                      <div><span>本次還可購買</span><strong>{remainingPurchasable} 隻</strong>{remainingPurchasable === 1 && <small className="rareNotice">🔥 最後一份</small>}</div>
                    </div>
                    <div className="variantQuantity">
                      <span>數量</span>
                      <div>
                        <button type="button" aria-label="減少數量" disabled={selectedQuantity <= 1 || cartLimitReached} onClick={() => setProductQuantity(product.id, remainingPurchasable, selectedQuantity - 1)}>−</button>
                        <strong className="quantityValue" key={`${selectedVariant.id}-${selectedQuantity}`}>{selectedQuantity}</strong>
                        <button type="button" aria-label="增加數量" disabled={cartLimitReached || selectedQuantity >= remainingPurchasable} onClick={() => setProductQuantity(product.id, remainingPurchasable, selectedQuantity + 1, true)}>＋</button>
                      </div>
                    </div>
                  </>}
                </div>}
                <button className={`addToCartButton ${cartActionStatus === "success" ? "isSuccess" : ""} ${cartActionStatus === "error" ? "isError" : ""}`} disabled={soldOut || !selectedVariant || cartLimitReached || cartActionStatus === "adding" || cartActionStatus === "success"} aria-busy={cartActionStatus === "adding"} onClick={() => addToCart(product)}>{addButtonText}</button>
                <div className={`productFeedback ${cartActionStatus === "success" ? "isSuccess" : ""} ${cartActionStatus === "error" ? "isError" : ""}`} aria-live="polite" aria-atomic="true">
                  {productFeedback[product.id] && <span>{productFeedback[product.id]}</span>}
                  {cartLimitReached && <span className="limitFeedback">購物車內已達此規格的購買上限</span>}
                </div>
              </div>
            </article>;
          })}
        </div>
      </section>
      <div className={`cartDrawerLayer ${drawerOpen ? "isOpen" : ""}`} aria-hidden={!drawerOpen} onClick={() => setDrawerOpen(false)}>
        <aside className="cartDrawer" role="dialog" aria-modal="true" aria-labelledby="cart-drawer-title" onClick={(event) => event.stopPropagation()}>
          <header className="cartDrawerHeader"><div><small>YOUR CATCH</small><h2 id="cart-drawer-title">購物車</h2></div><button type="button" aria-label="關閉購物車" onClick={() => setDrawerOpen(false)}>×</button></header>
          <div className="cartDrawerBody">
            {cart.length === 0 ? <div className="cartEmpty"><strong>🐟 購物車還沒有商品</strong><p>今天去挑幾尾漂亮的魚吧！</p></div> : cart.map((item) => {
              const variant = variants.find((candidate) => candidate.id === item.variant_id);
              const product = products.find((candidate) => candidate.id === item.product_id);
              const purchaseLimit = variant ? getPurchaseLimit(variant) : item.quantity;
              const cartBusy = cartActionStatuses[item.product_id] === "adding";
              return <article className="drawerCartItem" key={item.variant_id}>
                <div className="drawerItemImage">{product?.image_url ? <img src={product.image_url} alt={item.product_name} /> : <span>🐟</span>}</div>
                <div className="drawerItemInfo"><h3>{item.product_name}</h3><p>{item.variant_name}</p><span className="priceTag">{item.price.toLocaleString("zh-TW")}</span><strong className="itemSubtotal">小計 {(item.price * item.quantity).toLocaleString("zh-TW")}</strong></div>
                <div className="drawerItemActions"><div className="quantity"><button type="button" aria-label={`減少 ${item.variant_name} 數量`} disabled={cartBusy} onClick={() => changeQuantity(item.variant_id, item.quantity - 1)}>−</button><span className={animatedCartQuantity === `${item.variant_id}-${item.quantity}` ? "cartQuantityPulse" : ""} key={`${item.variant_id}-${item.quantity}`}>{item.quantity}</span><button type="button" aria-label={`增加 ${item.variant_name} 數量`} disabled={cartBusy || !variant || item.quantity >= purchaseLimit} onClick={() => changeQuantity(item.variant_id, item.quantity + 1)}>＋</button></div><button className="removeCartItem" type="button" aria-label={`移除${item.product_name} ${item.variant_name}`} disabled={cartBusy} onClick={() => changeQuantity(item.variant_id, 0)}><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>
              </article>;
            })}
          </div>
          <footer className="cartDrawerFooter">
            <div className="shippingProgress" aria-live="polite">{shippingRemaining > 0 ? <><p>🚚 再買 <strong>{shippingRemaining.toLocaleString("zh-TW")}</strong> 即可享台北配送</p><div className="progressTrack" role="progressbar" aria-label="台北配送資格進度" aria-valuemin={0} aria-valuemax={shippingThreshold} aria-valuenow={total}><span style={{ width: `${shippingProgress}%` }} /></div></> : <p className="shippingQualified">🎉 已符合台北配送資格</p>}</div>
            <div className="drawerSubtotal"><span>購物車小計</span><strong>{total.toLocaleString("zh-TW")}</strong></div>
            <button className="checkoutButton" type="button" disabled={cart.length === 0} onClick={goToCheckout}>立即結帳</button>
            <button className="continueShoppingButton" type="button" onClick={() => setDrawerOpen(false)}>← 繼續挑魚</button>
          </footer>
        </aside>
      </div>
      {cartToast && <div className="cartToast" role="status" aria-live="polite">✓ {cartToast}</div>}
      <section id="order" className="order checkoutSection">
        <div className="checkoutShell">
          <header className="checkoutHeading"><small>SMART CHECKOUT</small><h2>確認配送與聯絡資料</h2><p>不需登入，選好配送方式即可完成訂購。</p></header>
          {savedProfile && <section className="returningCustomer" aria-labelledby="returning-title">
            <div><span aria-hidden="true">👋</span><div><h3 id="returning-title">歡迎回來{savedProfile.customer_name ? `，${savedProfile.customer_name}` : ""}</h3>{maskedPhone && <p>{maskedPhone}</p>}</div></div>
            <dl><div><dt>常用方式</dt><dd>{savedProfile.fulfillment}</dd></div>{maskedAddress && <div><dt>常用地址</dt><dd>{maskedAddress}</dd></div>}</dl>
            <div className="returningActions"><button type="button" onClick={useSavedCheckoutProfile}>使用這份資料</button><button type="button" className="secondary" onClick={() => { setForm({ ...savedProfile, rememberCustomerData: true }); setEditingCheckout(true); }}>修改資料</button></div>
          </section>}
          {editingCheckout && <form className="checkoutForm" onSubmit={submit} noValidate>
            <fieldset className="deliveryFieldset"><legend>選擇配送方式</legend><div className="deliveryOptions">{deliveryMethods.map((method) => {
              const unavailable = method.value === "台北市配送" && total < shippingThreshold;
              const selected = form.fulfillment === method.value;
              return <label className={`deliveryOption ${selected ? "isSelected" : ""} ${unavailable ? "isDisabled" : ""}`} key={method.value}>
                <input type="radio" name="delivery" value={method.value} aria-label={method.value} checked={selected} disabled={unavailable} onChange={() => setForm((current) => ({ ...current, fulfillment: method.value }))} />
                <span className="deliveryIcon" aria-hidden="true">{method.icon}</span><span className="deliveryCopy"><span className="deliveryTitle"><strong>{method.value}</strong><small className="recommendationLabel">{method.recommendation}</small></span><small className="deliverySubtitle">{method.value === "台北市配送" ? unavailable ? <>🚚 再買 <b>{shippingRemaining.toLocaleString("zh-TW")}</b> 即可享台北市配送</> : "已符合台北市配送資格" : method.detail}</small></span><span className="deliveryCheck" aria-hidden="true">{selected ? "✓" : ""}</span>
              </label>;
            })}</div>
              <div className="subsidyMessage" aria-live="polite">{(form.fulfillment === "冷凍宅配" || form.fulfillment === "7-ELEVEN 冷凍交貨便") && "💚 韓九已補貼一半運費，讓您享有更優惠的配送服務。"}</div>
              <details className="deliveryExplanation"><summary>配送說明</summary><div className="deliveryExplanationBody"><div><strong>📍 永春市場自取</strong><p>請依約定時間至永春市場取貨。</p></div><div><strong>🚚 台北市配送</strong><p>單筆消費滿 2500，即可協助配送到府。</p></div><div><strong>❄️ 冷凍宅配</strong><p>韓九補貼一半運費。</p></div><div><strong>🏪 7-ELEVEN 冷凍交貨便</strong><p>韓九補貼一半運費，實際寄送仍依商品及數量安排。</p></div></div></details>
            </fieldset>
            <div className="checkoutFields"><label>姓名<input autoComplete="name" value={form.customer_name} onChange={(event) => setForm({ ...form, customer_name: event.target.value })} /></label><label>電話<input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
              {form.fulfillment === "永春市場自取" && <><label>取貨日期<input type="date" value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>取貨時間<input type="time" value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label></>}
              {(form.fulfillment === "台北市配送" || form.fulfillment === "冷凍宅配") && <><label className="fullField">{form.fulfillment === "台北市配送" ? "配送地址" : "收件地址"}<input autoComplete="street-address" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label><label>希望{form.fulfillment === "台北市配送" ? "配送" : "到貨"}日期（選填）<input type="date" value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>希望時間（選填）<input type="time" value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label></>}
              {form.fulfillment === "7-ELEVEN 冷凍交貨便" && <><label>門市名稱<input value={form.preferredStoreName} onChange={(event) => setForm({ ...form, preferredStoreName: event.target.value })} /></label><label>門市店號（選填）<input inputMode="numeric" value={form.preferredStoreCode} onChange={(event) => setForm({ ...form, preferredStoreCode: event.target.value })} /></label></>}
              <label className="fullField">備註（選填）<textarea rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label></div>
            <label className="rememberCustomer"><input type="checkbox" checked={form.rememberCustomerData} onChange={(event) => updateRememberPreference(event.target.checked)} /><span><strong>記住我的資料，下次自動帶入</strong><small>資料只會儲存在這台裝置，不會建立會員帳號。</small></span></label>
            <button className="submitOrderButton" type="submit">確認並送出訂單</button><div className="checkoutNotice" aria-live="polite">{notice && <p className="notice">{notice}</p>}</div>
          </form>}
        </div>
      </section>
    </main>
  );
}

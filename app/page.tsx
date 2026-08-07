"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { formatPrice, ProcessingOption, ProcessingPreset, ProcessingPresetOption, Product, ProductProcessingOption, ProductProcessingPreset, ProductVariant } from "@/lib/catalog";
import { isValidEmail, isValidTaiwanMobile, normalizeTaiwanMobile, taipeiCurrentTime, taipeiToday, validateTaipeiDateTime } from "@/lib/customer-validation";
import FishRequestForm from "./fish-request-form";

type CartItem = {
  cart_key: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_name: string;
  price: number;
  quantity: number;
  processing_preset_id: string | null;
  processing_preset_name: string;
  processing_option_ids: string[];
  processing_option_names: string[];
  processing_note: string;
};

type ProcessingSelection = { presetId: string | null; optionIds: string[]; note: string };

type CartActionStatus = "idle" | "adding" | "success" | "error";
type DeliveryMethod = "永春市場自取" | "台北市配送" | "冷凍宅配" | "7-ELEVEN 冷凍交貨便";

type CheckoutForm = {
  customer_name: string;
  phone: string;
  email: string;
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
const CART_STORAGE_KEY = "hanjiu-storefront-cart-v1";
const deliveryMethods: Array<{ value: DeliveryMethod; icon: string; detail: string; recommendation: string }> = [
  { value: "永春市場自取", icon: "📍", detail: "可提前預留商品", recommendation: "最省運費" },
  { value: "台北市配送", icon: "🚚", detail: "單筆滿 2500 可配送到府", recommendation: "台北最方便" },
  { value: "冷凍宅配", icon: "❄️", detail: "韓九補貼一半運費", recommendation: "外縣市推薦" },
  { value: "7-ELEVEN 冷凍交貨便", icon: "🏪", detail: "韓九補貼一半運費", recommendation: "超商取貨" }
];

function displayDeliveryMethod(method: DeliveryMethod) {
  return method === "7-ELEVEN 冷凍交貨便" ? "7-11 冷凍交貨便" : method;
}

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

function processingSignature(variantId: string, selection: ProcessingSelection) {
  return [variantId, selection.presetId || "custom", [...selection.optionIds].sort().join(","), selection.note.trim()].join("::");
}

export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [processingOptions, setProcessingOptions] = useState<ProcessingOption[]>([]);
  const [processingPresets, setProcessingPresets] = useState<ProcessingPreset[]>([]);
  const [processingPresetOptions, setProcessingPresetOptions] = useState<ProcessingPresetOption[]>([]);
  const [productProcessingOptions, setProductProcessingOptions] = useState<ProductProcessingOption[]>([]);
  const [productProcessingPresets, setProductProcessingPresets] = useState<ProductProcessingPreset[]>([]);
  const [productProcessing, setProductProcessing] = useState<Record<string, ProcessingSelection>>({});
  const [customProcessingOpen, setCustomProcessingOpen] = useState<Record<string, boolean>>({});
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [cartActionStatuses, setCartActionStatuses] = useState<Record<string, CartActionStatus>>({});
  const [productFeedback, setProductFeedback] = useState<Record<string, string>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [cartRestored, setCartRestored] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cartToast, setCartToast] = useState("");
  const [cartBounceKey, setCartBounceKey] = useState(0);
  const [animatedCartQuantity, setAnimatedCartQuantity] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<CheckoutForm>({ customer_name: "", phone: "", email: "", fulfillment: "永春市場自取", address: "", pickupDate: "", pickupTime: "", preferredStoreName: "", preferredStoreCode: "", note: "", rememberCustomerData: true });
  const [savedProfile, setSavedProfile] = useState<CheckoutForm | null>(null);
  const [editingCheckout, setEditingCheckout] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deliveryNotesOpen, setDeliveryNotesOpen] = useState(false);
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
        setSavedProfile({ ...profile, email: profile.email || "", rememberCustomerData: true });
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
      const [productResult, variantResult, optionResult, presetResult, presetOptionResult, productOptionResult, productPresetResult] = await Promise.all([
        supabase.from("products").select("*").neq("status", "hidden").order("sort_order"),
        supabase.from("product_variants").select("*").eq("active", true).order("sort_order"),
        supabase.from("processing_options").select("*").eq("active", true).order("sort_order"),
        supabase.from("processing_presets").select("*").eq("active", true).order("sort_order"),
        supabase.from("processing_preset_options").select("*"),
        supabase.from("product_processing_options").select("*").eq("active", true).order("sort_order"),
        supabase.from("product_processing_presets").select("*").eq("active", true).order("sort_order")
      ]);
      if (productResult.error) setNotice(`商品載入失敗：${productResult.error.message}`);
      else setProducts((productResult.data || []) as Product[]);
      if (variantResult.error) setNotice(`規格載入失敗：${variantResult.error.message}`);
      else setVariants((variantResult.data || []) as ProductVariant[]);
      const processingError = [optionResult, presetResult, presetOptionResult, productOptionResult, productPresetResult].find((result) => result.error)?.error;
      if (processingError) setNotice("魚貨處理方式載入失敗，請重新整理頁面。");
      else {
        setProcessingOptions((optionResult.data || []) as ProcessingOption[]);
        setProcessingPresets((presetResult.data || []) as ProcessingPreset[]);
        setProcessingPresetOptions((presetOptionResult.data || []) as ProcessingPresetOption[]);
        setProductProcessingOptions((productOptionResult.data || []) as ProductProcessingOption[]);
        setProductProcessingPresets((productPresetResult.data || []) as ProductProcessingPreset[]);
      }
      setCatalogReady(!productResult.error && !variantResult.error && !processingError);
    }
    loadCatalog();
  }, [supabase]);

  useEffect(() => {
    if (!catalogReady || cartRestored) return;
    try {
      const saved = window.localStorage.getItem(CART_STORAGE_KEY);
      const parsed = saved ? JSON.parse(saved) as CartItem[] : [];
      const usedInventory = new Map<string, number>();
      const restored = (Array.isArray(parsed) ? parsed : []).flatMap((item) => {
        const product = products.find((candidate) => candidate.id === item.product_id);
        const variant = variants.find((candidate) => candidate.id === item.variant_id && candidate.product_id === item.product_id && candidate.active);
        if (!product || !variant || product.status !== "available" || variant.inventory < 1) return [];
        const remaining = Math.max(0, variant.inventory - (usedInventory.get(variant.id) || 0));
        const quantity = Math.min(Math.max(1, Number(item.quantity) || 1), remaining);
        if (quantity < 1) return [];
        usedInventory.set(variant.id, (usedInventory.get(variant.id) || 0) + quantity);

        if (!product.processing_enabled) return [{ ...item, cart_key: processingSignature(variant.id, { presetId: "none", optionIds: [], note: "" }), product_name: product.name, variant_name: variant.name, price: variant.price, quantity, processing_preset_id: "none", processing_preset_name: "不處理", processing_option_ids: [], processing_option_names: [], processing_note: "" }];
        const allowedOptionIds = new Set(productProcessingOptions.filter((config) => config.product_id === product.id).map((config) => config.processing_option_id));
        const optionIds = (Array.isArray(item.processing_option_ids) ? item.processing_option_ids : []).filter((id) => allowedOptionIds.has(id)).sort();
        const allowedPresetIds = new Set(productProcessingPresets.filter((config) => config.product_id === product.id).map((config) => config.preset_id));
        const presetId = item.processing_preset_id && allowedPresetIds.has(item.processing_preset_id) ? item.processing_preset_id : null;
        const selection = { presetId, optionIds, note: String(item.processing_note || "").trim() };
        const display = processingDisplay(product.id, selection);
        return [{ ...item, cart_key: processingSignature(variant.id, selection), product_name: product.name, variant_name: variant.name, price: variant.price, quantity, processing_preset_id: presetId, processing_preset_name: display.presetName, processing_option_ids: optionIds, processing_option_names: display.optionNames, processing_note: selection.note }];
      });
      setCart(restored);
    } catch {
      window.localStorage.removeItem(CART_STORAGE_KEY);
      setCart([]);
    } finally {
      setCartRestored(true);
    }
  }, [cartRestored, catalogReady, processingOptions, processingPresetOptions, processingPresets, productProcessingOptions, productProcessingPresets, products, variants]);

  useEffect(() => {
    if (!cartRestored) return;
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart, cartRestored]);

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
    setProductProcessing((current) => {
      const next = { ...current };
      let changed = false;
      products.forEach((product) => {
        if (next[product.id]) return;
        const availablePresets = productProcessingPresets.filter((item) => item.product_id === product.id);
        const availableOptions = productProcessingOptions.filter((item) => item.product_id === product.id);
        const defaultConfig = availablePresets.find((item) => item.is_default) || (availablePresets.length === 1 && availableOptions.length === 0 ? availablePresets[0] : null);
        if (!product.processing_enabled) {
          next[product.id] = { presetId: "none", optionIds: [], note: "" };
          changed = true;
        } else if (defaultConfig) {
          const allowedIds = new Set(availableOptions.map((item) => item.processing_option_id));
          next[product.id] = { presetId: defaultConfig.preset_id, optionIds: processingPresetOptions.filter((item) => item.preset_id === defaultConfig.preset_id && allowedIds.has(item.processing_option_id)).map((item) => item.processing_option_id).sort(), note: "" };
          changed = true;
        } else if (availableOptions.length === 1 && availablePresets.length === 0) {
          next[product.id] = { presetId: null, optionIds: [availableOptions[0].processing_option_id], note: "" };
          changed = true;
        } else {
          next[product.id] = { presetId: null, optionIds: [], note: "" };
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [processingPresetOptions, productProcessingOptions, productProcessingPresets, products]);

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
      const processingSelection = product.processing_enabled ? (productProcessing[product.id] || { presetId: null, optionIds: [], note: "" }) : { presetId: "none", optionIds: [], note: "" };
      if (product.processing_enabled && !processingSelection.presetId && processingSelection.optionIds.length === 0) throw new Error("請選擇魚貨處理方式");
      const processing = processingDisplay(product.id, processingSelection);
      const cartKey = processingSignature(variant.id, processingSelection);

      await new Promise((resolve) => setTimeout(resolve, 120));
      setCart((items) => {
        const found = items.find((item) => item.cart_key === cartKey);
        if (found) return items.map((item) => item.cart_key === cartKey ? { ...item, quantity: item.quantity + quantity } : item);
        return [...items, { cart_key: cartKey, product_id: product.id, product_name: product.name, variant_id: variant.id, variant_name: variant.name, price: variant.price, quantity, processing_preset_id: processingSelection.presetId, processing_preset_name: processing.presetName, processing_option_ids: processingSelection.optionIds, processing_option_names: processing.optionNames, processing_note: processingSelection.note.trim() }];
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

  function changeQuantity(cartKey: string, quantity: number) {
    if (quantity <= 0) {
      setCart((items) => items.filter((item) => item.cart_key !== cartKey));
      return;
    }

    const cartItem = cart.find((item) => item.cart_key === cartKey);
    if (!cartItem) return;
    const variantId = cartItem.variant_id;
    const variant = variants.find((item) => item.id === variantId);
    if (!variant) return setNotice("無法確認此規格的限購數量，請重新整理頁面。");
    const purchaseLimit = getPurchaseLimit(variant);
    if (quantity > purchaseLimit) {
      setNotice(`${variant.name}本次最多可購買 ${purchaseLimit} 隻。`);
      return;
    }
    const otherVariantQuantity = cart.filter((item) => item.variant_id === variantId && item.cart_key !== cartKey).reduce((sum, item) => sum + item.quantity, 0);
    if (otherVariantQuantity + quantity > purchaseLimit) {
      setNotice(`${variant.name}本次最多可購買 ${purchaseLimit} 隻。`);
      return;
    }
    setCart((items) => items.map((item) => item.cart_key === cartKey ? { ...item, quantity } : item));
    setAnimatedCartQuantity(`${variantId}-${quantity}`);
  }

  function updateCartProcessing(cartKey: string, selection: ProcessingSelection) {
    setCart((items) => {
      const source = items.find((item) => item.cart_key === cartKey);
      if (!source) return items;
      const display = processingDisplay(source.product_id, selection);
      const nextKey = processingSignature(source.variant_id, selection);
      const updated = { ...source, cart_key: nextKey, processing_preset_id: selection.presetId, processing_preset_name: display.presetName, processing_option_ids: selection.optionIds, processing_option_names: display.optionNames, processing_note: selection.note.trim() };
      const duplicate = items.find((item) => item.cart_key === nextKey && item.cart_key !== cartKey);
      if (duplicate) return items.filter((item) => item.cart_key !== cartKey && item.cart_key !== nextKey).concat({ ...duplicate, quantity: duplicate.quantity + source.quantity });
      return items.map((item) => item.cart_key === cartKey ? updated : item);
    });
  }

  function selectCartPreset(item: CartItem, presetId: string) {
    updateCartProcessing(item.cart_key, { presetId, optionIds: presetOptionIds(presetId, item.product_id), note: item.processing_note });
  }

  function toggleCartOption(item: CartItem, optionId: string) {
    const optionIds = item.processing_option_ids.includes(optionId) ? item.processing_option_ids.filter((id) => id !== optionId) : [...item.processing_option_ids, optionId].sort();
    updateCartProcessing(item.cart_key, { presetId: item.processing_preset_id, optionIds, note: item.processing_note });
  }

  function presetOptionIds(presetId: string, productId: string) {
    const allowed = new Set(productProcessingOptions.filter((item) => item.product_id === productId).map((item) => item.processing_option_id));
    return processingPresetOptions.filter((item) => item.preset_id === presetId && allowed.has(item.processing_option_id)).map((item) => item.processing_option_id).sort();
  }

  function processingDisplay(productId: string, selection: ProcessingSelection) {
    if (!products.find((product) => product.id === productId)?.processing_enabled) return { presetName: "不處理", optionNames: [] as string[] };
    const preset = selection.presetId ? processingPresets.find((item) => item.id === selection.presetId) : null;
    const exactPreset = preset && JSON.stringify(presetOptionIds(preset.id, productId)) === JSON.stringify([...selection.optionIds].sort());
    return {
      presetName: exactPreset ? preset.name : selection.optionIds.length ? "客製化處理" : "不處理",
      optionNames: selection.optionIds.map((id) => processingOptions.find((item) => item.id === id)?.name).filter((name): name is string => Boolean(name))
    };
  }

  function summarizedProcessing(item: CartItem) {
    const preset = item.processing_preset_id ? processingPresets.find((candidate) => candidate.id === item.processing_preset_id) : null;
    const includedIds = preset ? processingPresetOptions.filter((candidate) => candidate.preset_id === preset.id).map((candidate) => candidate.processing_option_id) : [];
    const containsPreset = includedIds.every((id) => item.processing_option_ids.includes(id));
    const extraIds = preset && containsPreset ? item.processing_option_ids.filter((id) => !includedIds.includes(id)) : item.processing_option_ids;
    return {
      name: preset && containsPreset ? preset.name : item.processing_preset_name,
      extras: extraIds.map((id) => processingOptions.find((option) => option.id === id)?.name).filter((name): name is string => Boolean(name))
    };
  }

  function summarizedSelection(productId: string, selection: ProcessingSelection) {
    const preset = selection.presetId ? processingPresets.find((candidate) => candidate.id === selection.presetId) : null;
    const includedIds = preset ? presetOptionIds(preset.id, productId) : [];
    const containsPreset = includedIds.every((id) => selection.optionIds.includes(id));
    const extraIds = preset && containsPreset ? selection.optionIds.filter((id) => !includedIds.includes(id)) : selection.optionIds;
    const fallback = processingDisplay(productId, selection);
    return {
      presetName: preset && containsPreset ? preset.name : fallback.presetName,
      optionNames: extraIds.map((id) => processingOptions.find((option) => option.id === id)?.name).filter((name): name is string => Boolean(name))
    };
  }

  function selectProcessingPreset(productId: string, presetId: string) {
    setProductProcessing((current) => ({ ...current, [productId]: { ...(current[productId] || { note: "" }), presetId, optionIds: presetOptionIds(presetId, productId) } }));
    setCustomProcessingOpen((current) => ({ ...current, [productId]: false }));
  }

  function toggleProcessingOption(productId: string, optionId: string) {
    setProductProcessing((current) => {
      const selection = current[productId] || { presetId: null, optionIds: [], note: "" };
      const optionIds = selection.optionIds.includes(optionId) ? selection.optionIds.filter((id) => id !== optionId) : [...selection.optionIds, optionId];
      return { ...current, [productId]: { ...selection, optionIds: optionIds.sort() } };
    });
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
    if (!isValidTaiwanMobile(form.phone)) return "電話格式錯誤，請輸入 10 碼手機號碼。";
    if (form.email.trim() && !isValidEmail(form.email)) return "Email 格式錯誤，請確認後再試。";
    if (form.fulfillment === "永春市場自取" && !form.pickupDate) return "請選擇取貨日期";
    if (form.fulfillment === "永春市場自取" && !form.pickupTime) return "請選擇取貨時間";
    if ((form.fulfillment === "台北市配送" || form.fulfillment === "冷凍宅配") && !form.pickupDate) return "請選擇希望配送日期";
    if (form.fulfillment === "7-ELEVEN 冷凍交貨便" && !form.pickupDate) return "請選擇希望配送日期";
    if (form.fulfillment === "7-ELEVEN 冷凍交貨便" && !form.pickupTime) return "請選擇希望時間";
    const dateTimeError = validateTaipeiDateTime(form.pickupDate, form.pickupTime);
    if (dateTimeError) return dateTimeError;
    if ((form.fulfillment === "台北市配送" || form.fulfillment === "冷凍宅配") && !form.address.trim()) return "請填寫配送地址";
    if (form.fulfillment === "7-ELEVEN 冷凍交貨便" && !form.preferredStoreName.trim()) return "請填寫 7-11 門市名稱";
    if (form.fulfillment === "台北市配送" && total < 2500) return `再買 ${formatPrice(shippingRemaining)} 即可享台北市配送`;
    return "";
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setNotice("");
    if (cart.length === 0) {
      setNotice("請先選購商品");
      setIsSubmitting(false);
      return;
    }
    const validationMessage = validateCheckout();
    if (validationMessage) {
      setNotice(validationMessage);
      setIsSubmitting(false);
      return;
    }
    const normalizedPhone = normalizeTaiwanMobile(form.phone);
    const normalizedForm = { ...form, phone: normalizedPhone, email: form.email.trim() };
    setForm(normalizedForm);
    try {
    const variantIds = [...new Set(cart.map((item) => item.variant_id))];
    const { data: latestVariants, error: variantError } = await supabase
      .from("product_variants")
      .select("id,name,inventory,active")
      .in("id", variantIds);
    if (variantError) {
      console.error("Checkout stock validation failed", variantError);
      setNotice("訂單送出失敗，請稍後再試，或透過 LINE 與韓九聯繫。");
      setIsSubmitting(false);
      return;
    }

    for (const item of cart) {
      const latestVariant = latestVariants?.find((variant) => variant.id === item.variant_id);
      const latestLimit = latestVariant?.active ? latestVariant.inventory : 0;
      if (!latestVariant || item.quantity > latestLimit) {
        setNotice(`此規格目前最多可購買 ${latestLimit} 隻，請調整購物車數量。`);
        setIsSubmitting(false);
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
    const { data: orderId, error } = await supabase.rpc("create_checkout_order", {
      p_customer_name: normalizedForm.customer_name,
      p_phone: normalizedPhone,
      p_fulfillment: form.fulfillment,
      p_note: deliveryDetails || null,
      p_items: cart.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity, processing_preset_id: item.processing_preset_id, processing_option_ids: item.processing_option_ids, processing_note: item.processing_note })),
      p_email: normalizedForm.email || null
    });
    if (error || !orderId) {
      console.error("Atomic checkout RPC failed", error);
      setNotice(error?.message.includes("processing_updated") ? "此商品的處理方式已更新，請重新確認。" : "訂單送出失敗，請稍後再試，或透過 LINE 與韓九聯繫。");
      setIsSubmitting(false);
      return;
    }

    if (form.rememberCustomerData) {
      window.localStorage.setItem(CHECKOUT_PROFILE_KEY, JSON.stringify(normalizedForm));
      setSavedProfile(normalizedForm);
    } else {
      window.localStorage.removeItem(CHECKOUT_PROFILE_KEY);
      setSavedProfile(null);
    }
    const text = ["海鮮訂購單", `姓名：${normalizedForm.customer_name}`, `電話：${normalizedPhone}`, "", ...cart.map((item) => { const processing = summarizedProcessing(item); return `${item.product_name}｜${item.variant_name}｜${formatPrice(item.price)} × ${item.quantity}\n處理：${processing.name}${processing.extras.map((name) => `\n＋${name}`).join("")}${item.processing_note ? `\n備註：${item.processing_note}` : ""}`; }), "", `配送方式：${displayDeliveryMethod(form.fulfillment)}`, deliveryDetails].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* Clipboard permission is optional. */ }
    setCart([]);
    setNotice("訂單已送出");
    setIsSubmitting(false);
    window.open("https://lin.ee/q4avfUZ", "_blank", "noopener,noreferrer");
    } catch (error) {
      console.error("Unexpected checkout failure", error);
      setNotice("訂單送出失敗，請稍後再試，或透過 LINE 與韓九聯繫。");
      setIsSubmitting(false);
    }
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
      <header className="hero"><nav><strong>漢久海鮮</strong><div><Link href="/admin">後台管理</Link><button className="headerCartButton" type="button" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}><span className={cartBounceKey ? "cartIcon cartIconBounce" : "cartIcon"} key={cartBounceKey} aria-hidden="true">🛒</span> {totalQuantity} <span aria-hidden="true">｜</span> <span className="headerCartSubtotal">💰 {formatPrice(total)}</span></button></div></nav><section><p>每日嚴選，新鮮直送</p><h1>今天，吃好魚。</h1><p>挑選想要的商品與規格，送出訂單後由我們與你確認取貨細節。</p></section></header>
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
            const availableProcessingOptions = productProcessingOptions.filter((item) => item.product_id === product.id).map((config) => processingOptions.find((option) => option.id === config.processing_option_id)).filter((option): option is ProcessingOption => Boolean(option));
            const availableProcessingPresets = productProcessingPresets.filter((item) => item.product_id === product.id).map((config) => ({ config, preset: processingPresets.find((preset) => preset.id === config.preset_id) })).filter((item): item is { config: ProductProcessingPreset; preset: ProcessingPreset } => Boolean(item.preset));
            const processingSelection = productProcessing[product.id] || { presetId: null, optionIds: [], note: "" };
            const processingSelectionDisplay = summarizedSelection(product.id, processingSelection);
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
                    {product.processing_enabled && <section className="productProcessing" aria-labelledby={`processing-${product.id}`}>
                      <h4 id={`processing-${product.id}`}>🐟 魚貨處理方式</h4>
                      {availableProcessingPresets.length > 0 && <div className="processingPresetCards" role="radiogroup" aria-label={`${product.name}處理套餐`}>{availableProcessingPresets.map(({ preset }) => <label className={`processingPresetCard ${processingSelection.presetId === preset.id && !customProcessingOpen[product.id] ? "isSelected" : ""}`} key={preset.id}><input type="radio" name={`processing-${product.id}`} checked={processingSelection.presetId === preset.id && !customProcessingOpen[product.id]} onChange={() => selectProcessingPreset(product.id, preset.id)} /><span><strong>{preset.name}{preset.id === "three-clean" && <small>韓九推薦</small>}</strong>{preset.id === "three-clean" && <span className="processingSocialProof">最多人選</span>}<span className="processingHelper">{preset.id === "none" ? <>💡 保留完整魚身，回家自行處理。</> : preset.id === "three-clean" ? <>✓ 適合大部分家庭料理<br />✓ 去魚鱗、去內臟、去魚鰓</> : preset.id === "three-remove" ? <>🍳 適合紅燒、清蒸或直接下鍋。<br />🐟 去頭、去尾、去內臟。</> : preset.description}</span></span></label>)}{availableProcessingOptions.length > 0 && <label className={`processingPresetCard customProcessingChoice ${customProcessingOpen[product.id] ? "isSelected" : ""}`}><input type="radio" name={`processing-${product.id}`} checked={Boolean(customProcessingOpen[product.id])} aria-expanded={Boolean(customProcessingOpen[product.id])} aria-controls={`custom-processing-${product.id}`} onChange={() => setCustomProcessingOpen((current) => ({ ...current, [product.id]: true }))} /><span><strong>我要自己選處理方式</strong><span className="processingHelper">依照料理需求自由複選。</span></span></label>}</div>}
                      {availableProcessingOptions.length > 0 && <div className={`processingCustomReveal ${customProcessingOpen[product.id] ? "isOpen" : ""}`} id={`custom-processing-${product.id}`} aria-hidden={!customProcessingOpen[product.id]}><fieldset className="processingCustom" disabled={!customProcessingOpen[product.id]}><legend>客製化處理（可複選）</legend><div>{availableProcessingOptions.map((option) => <label key={option.id}><input type="checkbox" checked={processingSelection.optionIds.includes(option.id)} onChange={() => toggleProcessingOption(product.id, option.id)} /><span>{option.name}</span></label>)}</div></fieldset></div>}
                      <label className="processingNote">其他處理需求<textarea rows={3} placeholder={"例如：\n保留魚頭煮湯\n保留魚卵\n不要切太小\n魚皮保留"} value={processingSelection.note} onChange={(event) => setProductProcessing((current) => ({ ...current, [product.id]: { ...processingSelection, note: event.target.value } }))} /></label>
                      <p className="processingSelectionStatus" aria-live="polite">目前選擇：{processingSelectionDisplay.presetName}{processingSelectionDisplay.optionNames.map((name) => <span key={name}><br />＋{name}</span>)}</p>
                    </section>}
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
      <section id="fish-request" className="fishRequestSection">
        <div className="fishRequestShell">
          <header className="fishRequestHeading"><small>FISH WISHLIST</small><h2>🔔 想找的魚</h2><p>今天沒有看到想要的魚？<br />可以先告訴我，之後有看到我再通知你。</p><a className="fishRequestAnchor" href="#fish-request-form">告訴韓九我想找什麼</a></header>
          <div id="fish-request-form"><FishRequestForm /></div>
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
              const totalVariantQuantity = getCartQuantityForVariant(cart, item.variant_id);
              const cartBusy = cartActionStatuses[item.product_id] === "adding";
              const cartPresets = productProcessingPresets.filter((config) => config.product_id === item.product_id).map((config) => processingPresets.find((preset) => preset.id === config.preset_id)).filter((preset): preset is ProcessingPreset => Boolean(preset));
              const cartOptions = productProcessingOptions.filter((config) => config.product_id === item.product_id).map((config) => processingOptions.find((option) => option.id === config.processing_option_id)).filter((option): option is ProcessingOption => Boolean(option));
              const processingSummary = summarizedProcessing(item);
              return <article className="drawerCartItem" key={item.cart_key}>
                <div className="drawerItemImage">{product?.image_url ? <img src={product.image_url} alt={item.product_name} /> : <span>🐟</span>}</div>
                <div className="drawerItemInfo"><h3>{item.product_name}</h3><p>{item.variant_name}</p><span className="priceTag"><small>單價</small>{formatPrice(item.price)}</span><div className="cartProcessingSummary"><strong>處理：{processingSummary.name}</strong>{processingSummary.extras.map((name) => <span key={name}>＋{name}</span>)}{item.processing_note && <span>其他需求：{item.processing_note}</span>}</div><strong className="itemSubtotal"><span>小計</span>{formatPrice(item.price * item.quantity)}</strong></div>
                {product?.processing_enabled && <details className="cartProcessingEditor"><summary>編輯處理方式</summary><div><div className="cartProcessingPresets">{cartPresets.map((preset) => <button type="button" className={item.processing_preset_id === preset.id ? "isSelected" : ""} onClick={() => selectCartPreset(item, preset.id)} key={preset.id}>{preset.name}</button>)}</div><div className="cartProcessingOptions">{cartOptions.map((option) => <label key={option.id}><input type="checkbox" checked={item.processing_option_ids.includes(option.id)} onChange={() => toggleCartOption(item, option.id)} />{option.name}</label>)}</div><label>其他處理需求<textarea rows={2} defaultValue={item.processing_note} onBlur={(event) => updateCartProcessing(item.cart_key, { presetId: item.processing_preset_id, optionIds: item.processing_option_ids, note: event.target.value })} /></label></div></details>}
                <div className="drawerItemActions"><div className="quantity"><button type="button" aria-label={`減少 ${item.variant_name} 數量`} disabled={cartBusy} onClick={() => changeQuantity(item.cart_key, item.quantity - 1)}>−</button><span className={animatedCartQuantity === `${item.variant_id}-${item.quantity}` ? "cartQuantityPulse" : ""} key={`${item.variant_id}-${item.quantity}`}>{item.quantity}</span><button type="button" aria-label={`增加 ${item.variant_name} 數量`} disabled={cartBusy || !variant || totalVariantQuantity >= purchaseLimit} onClick={() => changeQuantity(item.cart_key, item.quantity + 1)}>＋</button></div><button className="removeCartItem" type="button" aria-label={`移除${item.product_name} ${item.variant_name}`} disabled={cartBusy} onClick={() => changeQuantity(item.cart_key, 0)}><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>
              </article>;
            })}
          </div>
          <footer className="cartDrawerFooter">
            <div className="shippingProgress" aria-live="polite">{shippingRemaining > 0 ? <><p>🚚 再買 <strong>{formatPrice(shippingRemaining)}</strong> 即可享台北配送</p><div className="progressTrack" role="progressbar" aria-label="台北配送資格進度" aria-valuemin={0} aria-valuemax={shippingThreshold} aria-valuenow={total}><span style={{ width: `${shippingProgress}%` }} /></div></> : <p className="shippingQualified">🎉 已符合台北配送資格</p>}</div>
            <div className="drawerSubtotal"><span>購物車小計</span><strong>{formatPrice(total)}</strong></div>
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
            <dl><div><dt>常用方式</dt><dd>{displayDeliveryMethod(savedProfile.fulfillment)}</dd></div>{savedProfile.email && <div><dt>Email</dt><dd>{savedProfile.email}</dd></div>}{maskedAddress && <div><dt>常用地址</dt><dd>{maskedAddress}</dd></div>}</dl>
            <div className="returningActions"><button type="button" onClick={useSavedCheckoutProfile}>使用這份資料</button><button type="button" className="secondary" onClick={() => { setForm({ ...savedProfile, rememberCustomerData: true }); setEditingCheckout(true); }}>修改資料</button></div>
          </section>}
          {editingCheckout && <form className="checkoutForm" onSubmit={submit} noValidate>
            <section className="checkoutItemReview" aria-labelledby="checkout-items-title"><h3 id="checkout-items-title">訂購內容</h3>{cart.map((item) => { const processing = summarizedProcessing(item); return <article key={item.cart_key}><strong>{item.product_name}｜{item.variant_name}｜×{item.quantity}</strong><span>單價：{formatPrice(item.price)}</span><span>小計：{formatPrice(item.price * item.quantity)}</span><span>處理：{processing.name}</span>{processing.extras.map((name) => <span key={name}>＋{name}</span>)}{item.processing_note && <span>備註：{item.processing_note}</span>}</article>; })}</section>
            <fieldset className="deliveryFieldset"><legend>選擇配送方式</legend><div className="deliveryOptions">{deliveryMethods.map((method) => {
              const unavailable = method.value === "台北市配送" && total < shippingThreshold;
              const selected = form.fulfillment === method.value;
              return <label className={`deliveryOption ${selected ? "isSelected" : ""} ${unavailable ? "isDisabled" : ""}`} key={method.value}>
                <input type="radio" name="delivery" value={method.value} aria-label={displayDeliveryMethod(method.value)} checked={selected} disabled={unavailable} onChange={() => setForm((current) => ({ ...current, fulfillment: method.value }))} />
                <span className="deliveryIcon" aria-hidden="true">{method.icon}</span><span className="deliveryCopy"><span className="deliveryTitle"><strong>{displayDeliveryMethod(method.value)}</strong><small className="recommendationLabel">{method.recommendation}</small></span><small className="deliverySubtitle">{method.value === "台北市配送" ? unavailable ? <>🚚 再買 <b>{formatPrice(shippingRemaining)}</b> 即可享台北市配送</> : "已符合台北市配送資格" : method.detail}</small></span><span className="deliveryCheck" aria-hidden="true">{selected ? "✓" : ""}</span>
              </label>;
            })}</div>
              <div className="subsidyMessage" aria-live="polite">{(form.fulfillment === "冷凍宅配" || form.fulfillment === "7-ELEVEN 冷凍交貨便") && "💚 韓九已補貼一半運費，讓您享有更優惠的配送服務。"}</div>
              <details className="deliveryExplanation" onToggle={(event) => setDeliveryNotesOpen(event.currentTarget.open)}><summary aria-expanded={deliveryNotesOpen}>配送須知</summary><div className="deliveryExplanationBody"><div><strong>📍 永春市場自取</strong><p>請依約定時間至永春市場取貨。</p></div><div><strong>🚚 台北市配送</strong><p>單筆消費滿 2500，即可協助配送到府。</p></div><div><strong>❄️ 冷凍宅配</strong><p>韓九補貼一半運費。</p></div><div><strong>🏪 7-11 冷凍交貨便</strong><p>韓九補貼一半運費，實際寄送仍依商品及數量安排。</p></div></div></details>
            </fieldset>
            <div className="checkoutFields"><label>姓名 *<input autoComplete="name" value={form.customer_name} onChange={(event) => setForm({ ...form, customer_name: event.target.value })} /></label><label>電話 *<input type="tel" inputMode="tel" autoComplete="tel" placeholder="例如：0912-345-678" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /><small>例如：0912-345-678</small></label><label className="fullField">Email<input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
              {form.fulfillment === "永春市場自取" && <><label>取貨日期 *<input type="date" min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>取貨時間 *<input type="time" min={form.pickupDate === taipeiToday() ? taipeiCurrentTime() : undefined} value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label></>}
              {(form.fulfillment === "台北市配送" || form.fulfillment === "冷凍宅配") && <><label className="fullField">{form.fulfillment === "台北市配送" ? "配送地址 *" : "收件地址 *"}<input autoComplete="street-address" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label><label>希望配送日期 *<input type="date" required min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>希望時間<input type="time" min={form.pickupDate === taipeiToday() ? taipeiCurrentTime() : undefined} value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label></>}
              {form.fulfillment === "7-ELEVEN 冷凍交貨便" && <><label>希望配送日期 *<input type="date" required min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>希望時間 *<input type="time" required min={form.pickupDate === taipeiToday() ? taipeiCurrentTime() : undefined} value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label><label>7-11 門市名稱 *<input placeholder="例如：西湖門市" value={form.preferredStoreName} onChange={(event) => setForm({ ...form, preferredStoreName: event.target.value })} /></label><label>7-11 門市店號<input inputMode="numeric" placeholder="例如：123456" value={form.preferredStoreCode} onChange={(event) => setForm({ ...form, preferredStoreCode: event.target.value })} /></label></>}
              <label className="fullField">備註<textarea rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label></div>
            <label className="rememberCustomer"><input type="checkbox" checked={form.rememberCustomerData} onChange={(event) => updateRememberPreference(event.target.checked)} /><span><strong>記住我的資料，下次自動帶入</strong><small>資料只會儲存在這台裝置，不會建立會員帳號。</small></span></label>
            <button className="submitOrderButton" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>{isSubmitting ? "送出中…" : "送出訂單"}</button><div className="checkoutNotice" aria-live="polite">{notice && <p className="notice">{notice}</p>}</div>
          </form>}
        </div>
      </section>
    </main>
  );
}

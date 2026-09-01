"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { formatPrice, ProcessingOption, ProcessingPreset, ProcessingPresetOption, Product, ProductCategoryRecord, ProductProcessingOption, ProductProcessingPreset, ProductVariant } from "@/lib/catalog";
import { filterProducts, normalizeProductSearch, sortActiveProductCategories } from "@/lib/product-filters";
import { isValidEmail, isValidTaiwanMobile, normalizeTaiwanMobile, taipeiCurrentTime, taipeiToday, validateTaipeiDateTime } from "@/lib/customer-validation";
import { checkoutRequestFingerprint, checkoutRetryKey, clearCheckoutRetryKey } from "@/lib/checkout-idempotency";
import { activeProductProcessingOptionConfigs, activeProductProcessingPresetConfigs, validProcessingSelection } from "@/lib/processing-availability";
import { cartQuantityForVariant, remainingInStockPurchasable, supplyTypeForQuantity, variantSupplyType } from "@/lib/supply-model";
import FishRequestForm from "./fish-request-form";

type SupplyType = "in_stock" | "preorder";

type CartItem = {
  cart_key: string;
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_name: string;
  price: number;
  quantity: number;
  supply_type: SupplyType;
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
  deliveryTimeSlot: "不指定" | "上午" | "下午";
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

const deliveryTimeSlots = ["不指定", "上午", "下午"] as const;

function isDeliveryTimeSlot(value: unknown): value is CheckoutForm["deliveryTimeSlot"] {
  return typeof value === "string" && deliveryTimeSlots.includes(value as CheckoutForm["deliveryTimeSlot"]);
}

function usesDeliveryTimeSlot(method: DeliveryMethod) {
  return method === "冷凍宅配" || method === "7-ELEVEN 冷凍交貨便";
}

function getPurchaseLimit(variant: ProductVariant) {
  return variant.inventory;
}

function getRemainingPurchasable(variant: ProductVariant, cart: CartItem[]) {
  return remainingInStockPurchasable(variant, cart);
}

function processingSignature(variantId: string, supplyType: SupplyType, selection: ProcessingSelection) {
  return [variantId, supplyType, selection.presetId || "custom", [...selection.optionIds].sort().join(","), selection.note.trim()].join("::");
}

export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [productCategories, setProductCategories] = useState<ProductCategoryRecord[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [selectedProductCategory, setSelectedProductCategory] = useState("all");
  const [inStockOnly, setInStockOnly] = useState(false);
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
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const [categoryLoadError, setCategoryLoadError] = useState("");
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [cartRestored, setCartRestored] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cartToast, setCartToast] = useState("");
  const [cartBounceKey, setCartBounceKey] = useState(0);
  const [animatedCartQuantity, setAnimatedCartQuantity] = useState("");
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState<CheckoutForm>({ customer_name: "", phone: "", email: "", fulfillment: "永春市場自取", address: "", pickupDate: "", pickupTime: "", deliveryTimeSlot: "不指定", preferredStoreName: "", preferredStoreCode: "", note: "", rememberCustomerData: true });
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
        setSavedProfile({ ...profile, email: profile.email || "", deliveryTimeSlot: isDeliveryTimeSlot(profile.deliveryTimeSlot) ? profile.deliveryTimeSlot : "不指定", rememberCustomerData: true });
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
      setCatalogLoading(true);
      setCatalogError("");
      setCategoryLoadError("");
      try {
      const [productResult, variantResult, categoryResult, optionResult, presetResult, presetOptionResult, productOptionResult, productPresetResult] = await Promise.all([
        supabase.from("products").select("*").neq("status", "hidden").order("sort_order"),
        supabase.from("product_variants").select("*").eq("active", true).order("sort_order"),
        supabase.from("product_categories").select("id,name,sort_order,active").eq("active", true).order("sort_order").order("name"),
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
      if (categoryResult.error) {
        console.error("Storefront product category query failed", categoryResult.error);
        setCategoryLoadError("商品類別暫時無法載入，已先顯示全部商品。");
      }
      else setProductCategories((categoryResult.data || []) as ProductCategoryRecord[]);
      if (productResult.error || variantResult.error) setCatalogError("商品瀏覽資料暫時無法載入，請稍後再試。");
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
      } catch {
        setCatalogError("商品瀏覽資料暫時無法載入，請稍後再試。");
        setCategoryLoadError("");
        setNotice("商品載入失敗，請重新整理頁面。");
        setCatalogReady(false);
      } finally {
        setCatalogLoading(false);
      }
    }
    loadCatalog();
  }, [catalogRefresh, supabase]);

  useEffect(() => {
    if (selectedProductCategory !== "all" && !productCategories.some((category) => category.id === selectedProductCategory && category.active)) setSelectedProductCategory("all");
  }, [productCategories, selectedProductCategory]);

  useEffect(() => {
    if (!catalogReady || cartRestored) return;
    try {
      const saved = window.localStorage.getItem(CART_STORAGE_KEY);
      const parsed = saved ? JSON.parse(saved) as CartItem[] : [];
      const usedInventory = new Map<string, number>();
      const restored = (Array.isArray(parsed) ? parsed : []).flatMap((item) => {
        const product = products.find((candidate) => candidate.id === item.product_id);
        const variant = variants.find((candidate) => candidate.id === item.variant_id && candidate.product_id === item.product_id && candidate.active);
        if (!product || !variant || product.status !== "available") return [];
        const parsedQuantity = Number(item.quantity);
        const requestedQuantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
        const supplyType = supplyTypeForQuantity(variant, requestedQuantity);
        if (!supplyType) return [];
        const remaining = supplyType === "in_stock" ? Math.max(0, variant.inventory - (usedInventory.get(variant.id) || 0)) : requestedQuantity;
        const quantity = Math.min(requestedQuantity, remaining);
        if (quantity < 1) return [];
        if (supplyType === "in_stock") usedInventory.set(variant.id, (usedInventory.get(variant.id) || 0) + quantity);

        if (!product.processing_enabled) return [{ ...item, supply_type: supplyType, cart_key: processingSignature(variant.id, supplyType, { presetId: "none", optionIds: [], note: "" }), product_name: product.name, variant_name: variant.name, price: variant.price, quantity, processing_preset_id: "none", processing_preset_name: "不處理", processing_option_ids: [], processing_option_names: [], processing_note: "" }];
        const presetConfigs = activeProductProcessingPresetConfigs(product.id, productProcessingPresets, processingPresets);
        const optionConfigs = activeProductProcessingOptionConfigs(product.id, productProcessingOptions, processingOptions);
        const selection = validProcessingSelection({ presetId: item.processing_preset_id, optionIds: Array.isArray(item.processing_option_ids) ? item.processing_option_ids : [], note: item.processing_note || "" }, presetConfigs, optionConfigs);
        const display = processingDisplay(product.id, selection);
        return [{ ...item, supply_type: supplyType, cart_key: processingSignature(variant.id, supplyType, selection), product_name: product.name, variant_name: variant.name, price: variant.price, quantity, processing_preset_id: selection.presetId, processing_preset_name: display.presetName, processing_option_ids: selection.optionIds, processing_option_names: display.optionNames, processing_note: selection.note }];
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
        variantSupplyType(variant) !== null &&
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
        const availablePresets = activeProductProcessingPresetConfigs(product.id, productProcessingPresets, processingPresets);
        const availableOptions = activeProductProcessingOptionConfigs(product.id, productProcessingOptions, processingOptions);
        const existing = next[product.id];
        if (existing) {
          const valid = validProcessingSelection(existing, availablePresets, availableOptions);
          if (valid.presetId !== existing.presetId || valid.note !== existing.note || valid.optionIds.join(",") !== existing.optionIds.join(",")) {
            next[product.id] = valid;
            changed = true;
          }
          return;
        }
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
  }, [processingOptions, processingPresetOptions, processingPresets, productProcessingOptions, productProcessingPresets, products]);

  useEffect(() => {
    setSelectedQuantities((current) => {
      const next = { ...current };
      let changed = false;

      Object.entries(selectedVariants).forEach(([productId, variantId]) => {
        const variant = variants.find((item) => item.id === variantId);
        if (!variant) return;
        if (variant.preorder_enabled) {
          const nextQuantity = Math.max(1, current[productId] || 1);
          if (nextQuantity !== current[productId]) {
            next[productId] = nextQuantity;
            changed = true;
          }
          return;
        }
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

  function setProductQuantity(productId: string, purchaseLimit: number | null, quantity: number, announceLimit = false) {
    const normalizedQuantity = Math.max(1, Math.trunc(quantity));
    const nextQuantity = purchaseLimit === null ? normalizedQuantity : Math.min(purchaseLimit, normalizedQuantity);
    setSelectedQuantities((current) => ({ ...current, [productId]: nextQuantity }));
    if (announceLimit && purchaseLimit !== null && nextQuantity >= purchaseLimit) {
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
      if (product.status !== "available" || !variantSupplyType(variant)) throw new Error("此規格目前暫不可購買，請重新選擇。");
      const quantity = Math.max(1, selectedQuantities[product.id] || 1);
      const processingSelection = product.processing_enabled
        ? validProcessingSelection(productProcessing[product.id] || { presetId: null, optionIds: [], note: "" }, activeProductProcessingPresetConfigs(product.id, productProcessingPresets, processingPresets), activeProductProcessingOptionConfigs(product.id, productProcessingOptions, processingOptions))
        : { presetId: "none", optionIds: [], note: "" };
      if (product.processing_enabled && !processingSelection.presetId && processingSelection.optionIds.length === 0) throw new Error("請選擇魚貨處理方式");
      const processing = processingDisplay(product.id, processingSelection);
      const matchingVariantItems = cart.filter((item) => item.variant_id === variant.id);
      const sameProcessingItem = matchingVariantItems.find((item) => processingSignature(item.variant_id, item.supply_type, { presetId: item.processing_preset_id, optionIds: item.processing_option_ids, note: item.processing_note }) === processingSignature(variant.id, item.supply_type, processingSelection));
      if (matchingVariantItems.length > 0 && !sameProcessingItem) throw new Error("此規格已在購物車，請先在購物車調整處理方式。");
      const quantityAlreadyInCart = sameProcessingItem?.quantity || 0;
      const requestedQuantity = quantityAlreadyInCart + quantity;
      const supplyType = supplyTypeForQuantity(variant, requestedQuantity);
      if (!supplyType) throw new Error(`此規格目前最多可購買 ${variant.inventory} 件。`);
      const cartKey = processingSignature(variant.id, supplyType, processingSelection);

      await new Promise((resolve) => setTimeout(resolve, 120));
      setCart((items) => {
        const found = items.find((item) => item.variant_id === variant.id);
        if (found) return items.map((item) => item.cart_key === found.cart_key ? { ...item, cart_key: cartKey, quantity: requestedQuantity, supply_type: supplyType } : item);
        return [...items, { cart_key: cartKey, product_id: product.id, product_name: product.name, variant_id: variant.id, variant_name: variant.name, price: variant.price, quantity, supply_type: supplyType, processing_preset_id: processingSelection.presetId, processing_preset_name: processing.presetName, processing_option_ids: processingSelection.optionIds, processing_option_names: processing.optionNames, processing_note: processingSelection.note.trim() }];
      });
      setCartActionStatuses((current) => ({ ...current, [product.id]: "success" }));
      const successMessage = `${variant.name} × ${quantity} ${supplyType === "preorder" ? "預訂" : "現貨"}已加入購物車`;
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
    const supplyType = supplyTypeForQuantity(variant, quantity);
    if (!supplyType) {
      setNotice(`${variant.name}本次最多可購買 ${variant.inventory} 件。`);
      return;
    }
    const nextKey = processingSignature(variantId, supplyType, { presetId: cartItem.processing_preset_id, optionIds: cartItem.processing_option_ids, note: cartItem.processing_note });
    setCart((items) => items.map((item) => item.cart_key === cartKey ? { ...item, cart_key: nextKey, quantity, supply_type: supplyType } : item));
    setAnimatedCartQuantity(`${variantId}-${quantity}`);
  }

  function updateCartProcessing(cartKey: string, selection: ProcessingSelection) {
    setCart((items) => {
      const source = items.find((item) => item.cart_key === cartKey);
      if (!source) return items;
      const valid = validProcessingSelection(selection, activeProductProcessingPresetConfigs(source.product_id, productProcessingPresets, processingPresets), activeProductProcessingOptionConfigs(source.product_id, productProcessingOptions, processingOptions));
      const display = processingDisplay(source.product_id, valid);
      const nextKey = processingSignature(source.variant_id, source.supply_type, valid);
      const updated = { ...source, cart_key: nextKey, processing_preset_id: valid.presetId, processing_preset_name: display.presetName, processing_option_ids: valid.optionIds, processing_option_names: display.optionNames, processing_note: valid.note };
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
    const allowed = new Set(activeProductProcessingOptionConfigs(productId, productProcessingOptions, processingOptions).map((item) => item.processing_option_id));
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
    setForm({ ...savedProfile, deliveryTimeSlot: isDeliveryTimeSlot(savedProfile.deliveryTimeSlot) ? savedProfile.deliveryTimeSlot : "不指定", rememberCustomerData: true });
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
    if (form.fulfillment === "台北市配送" && !form.pickupDate) return "請選擇希望配送日期";
    if ((form.fulfillment === "冷凍宅配" || form.fulfillment === "7-ELEVEN 冷凍交貨便") && !form.pickupDate) return "請選擇希望到貨日期";
    if ((form.fulfillment === "永春市場自取" || form.fulfillment === "台北市配送") && form.pickupDate) {
      const dateTimeError = validateTaipeiDateTime(form.pickupDate, form.pickupTime);
      if (dateTimeError) return dateTimeError;
    }
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
      .select("id,name,inventory,active,preorder_enabled")
      .in("id", variantIds);
    if (variantError) {
      console.error("Checkout stock validation failed", variantError);
      setNotice("訂單送出失敗，請稍後再試，或透過 LINE 與韓九聯繫。");
      setIsSubmitting(false);
      return;
    }

    for (const item of cart) {
      const latestVariant = latestVariants?.find((variant) => variant.id === item.variant_id);
      const currentSupplyType = latestVariant ? supplyTypeForQuantity(latestVariant, item.quantity) : null;
      if (!currentSupplyType) {
        const latestLimit = latestVariant?.active ? latestVariant.inventory : 0;
        setNotice(`此規格目前最多可購買 ${latestLimit} 件，請調整購物車數量。`);
        setIsSubmitting(false);
        return;
      }
    }

    const deliveryDetails = [
      (form.fulfillment === "台北市配送" || form.fulfillment === "冷凍宅配") && form.address.trim() && `地址：${form.address.trim()}`,
      form.pickupDate && `${form.fulfillment === "永春市場自取" ? "取貨日期" : form.fulfillment === "台北市配送" ? "希望配送日期" : "希望到貨日期"}：${form.pickupDate}`,
      (form.fulfillment === "永春市場自取" || form.fulfillment === "台北市配送") && form.pickupTime && `${form.fulfillment === "永春市場自取" ? "取貨時間" : "希望時間"}：${form.pickupTime}`,
      usesDeliveryTimeSlot(form.fulfillment) && `希望到貨時段：${form.deliveryTimeSlot}`,
      form.fulfillment === "7-ELEVEN 冷凍交貨便" && form.preferredStoreName.trim() && `門市：${form.preferredStoreName.trim()}`,
      form.fulfillment === "7-ELEVEN 冷凍交貨便" && form.preferredStoreCode.trim() && `店號：${form.preferredStoreCode.trim()}`,
      form.note.trim() && `備註：${form.note.trim()}`
    ].filter(Boolean).join("\n");
    const checkoutItems = cart.map((item) => ({ variant_id: item.variant_id, quantity: item.quantity, processing_preset_id: item.processing_preset_id, processing_option_ids: item.processing_option_ids, processing_note: item.processing_note }));
    const retryFingerprint = checkoutRequestFingerprint({
      customer_name: normalizedForm.customer_name,
      phone: normalizedPhone,
      email: normalizedForm.email || null,
      fulfillment: form.fulfillment,
      note: deliveryDetails || null,
      items: checkoutItems
    });
    const idempotencyKey = checkoutRetryKey(retryFingerprint);
    const { data: orderId, error } = await supabase.rpc("create_checkout_order", {
      p_customer_name: normalizedForm.customer_name,
      p_phone: normalizedPhone,
      p_fulfillment: form.fulfillment,
      p_note: deliveryDetails || null,
      p_items: checkoutItems,
      p_email: normalizedForm.email || null,
      p_idempotency_key: idempotencyKey
    });
    if (error || !orderId) {
      console.error("Atomic checkout RPC failed", error);
      if (error?.message.includes("checkout_idempotency_conflict")) clearCheckoutRetryKey(idempotencyKey);
      setNotice(error?.message.includes("processing_updated") ? "此商品的處理方式已更新，請重新確認。" : error?.message.includes("checkout_idempotency_conflict") ? "此筆訂單資料已變更，請重新確認後再送出。" : error?.message.includes("variant_unavailable") ? "此規格目前現貨不足且未開放預訂，請重新選擇。" : "訂單送出失敗，請稍後再試，或透過 LINE 與韓九聯繫。");
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
    const text = ["海鮮訂購單", `姓名：${normalizedForm.customer_name}`, `電話：${normalizedPhone}`, "", ...cart.map((item) => { const processing = summarizedProcessing(item); return `${item.product_name}｜${item.variant_name}｜${item.supply_type === "preorder" ? "預訂" : "現貨"}｜${formatPrice(item.price)} × ${item.quantity}\n處理：${processing.name}${processing.extras.map((name) => `\n＋${name}`).join("")}${item.processing_note ? `\n備註：${item.processing_note}` : ""}`; }), "", `配送方式：${displayDeliveryMethod(form.fulfillment)}`, deliveryDetails].filter(Boolean).join("\n");
    try { await navigator.clipboard.writeText(text); } catch { /* Clipboard permission is optional. */ }
    // The server may safely reclassify a cart line from in_stock to preorder after
    // another checkout changes inventory. Reload instead of guessing local stock.
    setCatalogRefresh((current) => current + 1);
    setCart([]);
    clearCheckoutRetryKey(idempotencyKey);
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
  const filteredProducts = useMemo(
    () => filterProducts(products, variants, { query: productSearch, category: selectedProductCategory, inStockOnly }),
    [inStockOnly, productSearch, products, selectedProductCategory, variants]
  );
  const storefrontCategories = useMemo(
    () => [{ id: "all", name: "全部" }, ...sortActiveProductCategories(productCategories)],
    [productCategories]
  );
  const filtersActive = Boolean(normalizeProductSearch(productSearch) || selectedProductCategory !== "all" || inStockOnly);
  const clearProductFilters = () => {
    setProductSearch("");
    setSelectedProductCategory("all");
    setInStockOnly(false);
  };
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
      <header className="hero">
  <nav>
    <strong>韓九海鮮</strong>
      <button
        className="headerCartButton"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={drawerOpen}
        onClick={() => setDrawerOpen(true)}
      >
        <span
          className={cartBounceKey ? "cartIcon cartIconBounce" : "cartIcon"}
          key={cartBounceKey}
          aria-hidden="true"
        >
          🛒
        </span>
        <span className="headerCartQuantity">{totalQuantity}</span>
        <span className="headerCartDivider" aria-hidden="true">｜</span>
        <span className="headerCartSubtotal">💰 {formatPrice(total)}</span>
      </button>
  </nav>

  <picture className="heroPicture">
    <source media="(max-width: 560px)" srcSet="/hero-mobile.png" />
    <img src="/hero-desktop.png" alt="南方澳船釣海魚" />
  </picture>
</header>
      <section className="content productBrowsingSection">
        <div className="heading productBrowsingHeading"><div><small>TODAY&apos;S CATCH</small><h2>今日海鮮</h2></div><p>每個規格皆有獨立價格與限購數量，實際供應以頁面顯示為準。</p></div>
        <section className="productFilters" aria-label="商品搜尋與篩選">
          <label className="productSearchField">
            <span aria-hidden="true">⌕</span>
            <input type="search" value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="搜尋商品名稱，例如：馬頭" aria-label="商品搜尋" aria-controls="product-grid" />
            {productSearch && <button type="button" className="productSearchClear" aria-label="清除商品搜尋" onClick={() => setProductSearch("")}>×</button>}
          </label>
          <div className="productFilterControls">
            <div className="productCategoryChips" role="group" aria-label="商品分類">
              {storefrontCategories.map((category) => <button type="button" key={category.id} className={selectedProductCategory === category.id ? "isActive" : ""} aria-pressed={selectedProductCategory === category.id} onClick={() => setSelectedProductCategory(category.id)}>{category.name}</button>)}
            </div>
            <label className="stockOnlyToggle">
              <input type="checkbox" checked={inStockOnly} onChange={(event) => setInStockOnly(event.target.checked)} />
              <span>只看有貨</span>
            </label>
          </div>
          {filtersActive && <button type="button" className="productFilterReset" onClick={clearProductFilters}>清除篩選</button>}
        </section>
        {categoryLoadError && <div className="productCategoryLoadNotice" role="status" aria-live="polite"><span>{categoryLoadError}</span><button type="button" onClick={() => setCatalogRefresh((current) => current + 1)}>重新載入類別</button></div>}
        <div className="productBrowseResult" aria-live="polite" aria-atomic="true">
          {!catalogLoading && !catalogError && <span>{filteredProducts.length} 項商品</span>}
        </div>
        {catalogLoading ? <div className="productBrowseLoading" role="status" aria-live="polite"><span className="srOnly">商品載入中</span>{Array.from({ length: 3 }).map((_, index) => <div className="productBrowseSkeleton" key={index} aria-hidden="true"><span /><b /><i /></div>)}</div> : catalogError ? <div className="productBrowseError" role="alert"><strong>暫時無法載入今日海鮮</strong><p>{catalogError}</p><button type="button" onClick={() => setCatalogRefresh((current) => current + 1)}>重新載入</button></div> : filteredProducts.length === 0 ? <div className="productFilterEmpty" role="status" aria-live="polite"><strong>{filtersActive ? "目前沒有符合條件的商品" : "今天的魚貨正在準備中"}</strong><p>{filtersActive ? "試試其他關鍵字或分類，看看更多今日魚貨。" : "稍後再回來看看，或先告訴韓九您想找什麼。"}</p>{filtersActive ? <button type="button" className="productFilterReset" onClick={clearProductFilters}>清除篩選</button> : <a className="productBrowseRequestLink" href="#fish-request">告訴韓九我想找什麼</a>}</div> : <div className="grid storefrontProductGrid" id="product-grid">
          {filteredProducts.map((product) => {
            const productVariants = variants.filter((variant) => variant.product_id === product.id);
            const displayVariants = productVariants.filter((variant) => variant.active);
            const purchasableVariants = displayVariants.filter((variant) => variantSupplyType(variant) !== null && product.status === "available");
            const selectedVariant = purchasableVariants.find((variant) => variant.id === selectedVariants[product.id]);
            const selectedQuantity = selectedQuantities[product.id] || 1;
            const remainingPurchasable = selectedVariant ? getRemainingPurchasable(selectedVariant, cart) : 0;
            const quantityAlreadyInCart = selectedVariant ? cartQuantityForVariant(cart, selectedVariant.id) : 0;
            const selectedSupplyType = selectedVariant ? supplyTypeForQuantity(selectedVariant, quantityAlreadyInCart + selectedQuantity) : null;
            const soldOut = purchasableVariants.length === 0;
            const staleSelectedVariant = Boolean(selectedVariants[product.id] && !selectedVariant);
            const hasMultipleVariantPrices = new Set(displayVariants.map((variant) => variant.price)).size > 1;
            const cartLimitReached = Boolean(selectedVariant && !selectedVariant.preorder_enabled && remainingPurchasable <= 0);
            const cartActionStatus = cartActionStatuses[product.id] || "idle";
            const availableProcessingOptions = activeProductProcessingOptionConfigs(product.id, productProcessingOptions, processingOptions).map((config) => processingOptions.find((option) => option.id === config.processing_option_id)).filter((option): option is ProcessingOption => Boolean(option));
            const availableProcessingPresets = activeProductProcessingPresetConfigs(product.id, productProcessingPresets, processingPresets).map((config) => ({ config, preset: processingPresets.find((preset) => preset.id === config.preset_id) })).filter((item): item is { config: ProductProcessingPreset; preset: ProcessingPreset } => Boolean(item.preset));
            const processingSelection = productProcessing[product.id] || { presetId: null, optionIds: [], note: "" };
            const processingSelectionDisplay = summarizedSelection(product.id, processingSelection);
            const addButtonText = soldOut
              ? "已售完"
              : staleSelectedVariant
                ? "請重新選擇規格"
              : !selectedVariant
                ? "請先選擇規格"
                : cartLimitReached
                  ? "已達本次限購上限"
                : cartActionStatus === "adding"
                  ? "加入中…"
                  : cartActionStatus === "success"
                    ? "✓ 已加入購物車"
                    : "加入購物車";
            return <article className={`card storefrontProductCard ${soldOut ? "isSoldOut" : "isAvailable"}`} key={product.id}>
              <div className="photo">{product.image_url ? <img src={product.image_url} alt={product.name} loading="lazy" /> : <span aria-label="尚無商品圖片" role="img">🐟</span>}{product.featured && <div className="productCardBadges"><b>本日精選</b></div>}</div>
              <div className="body"><div className="productCardIntro"><div><small>{soldOut ? "已售完" : "今日供應"}</small>{!soldOut && <span>{purchasableVariants.length} 個可購買規格</span>}<h3>{product.name}</h3></div></div><p className="productDescription">{product.description || "今日新鮮上架，規格與價格請見下方。"}</p><p className="productCooking">料理建議：{product.cooking || "歡迎詢問"}</p>
                {displayVariants.length > 0 && <div className="variantSelector">
                  <label htmlFor={`variant-${product.id}`}>選擇規格</label>
                  <p className="variantSelectorHint">{selectedVariant ? "已依您選擇更新價格與可購買狀態。" : hasMultipleVariantPrices ? "不同規格有不同價格，請選擇後查看確切價格。" : "請選擇規格查看價格與可購買狀態。"}</p>
                  <select id={`variant-${product.id}`} value={selectedVariants[product.id] || ""} onChange={(event) => selectVariant(product.id, event.target.value)}>
                    <option value="" disabled>請選擇規格</option>
                    {displayVariants.map((variant) => {
                      const supplyType = variantSupplyType(variant);
                      const unavailable = product.status !== "available" || !supplyType;
                      const availability = variant.preorder_enabled ? variant.inventory > 0 ? `現貨剩 ${variant.inventory} 件｜可預訂` : "目前無現貨｜可預訂" : supplyType === "in_stock" ? `現貨剩 ${variant.inventory} 件` : "已售完";
                      return <option value={variant.id} disabled={unavailable} key={variant.id}>{variant.name}｜{formatPrice(variant.price)}｜{availability}</option>;
                    })}
                  </select>
                  <p className="weightBasisNotice">重量皆以魚貨處理前秤重為準，去鱗、去鰓、去內臟等處理後，實際收到重量會減少。</p>
                  {staleSelectedVariant && !soldOut && <p className="variantUnavailableNotice" role="status">此規格目前無法購買，請重新選擇。</p>}
                  {selectedVariant && <>
                    <div className="variantDetails variantSelectionSummary" aria-live="polite" aria-atomic="true">
                      <div className="variantSelectedName"><span>已選規格</span><strong>{selectedVariant.name}</strong></div>
                      <div className="variantSelectedPrice"><span>價格</span><strong>{formatPrice(selectedVariant.price)}</strong></div>
                      <div className={`variantPurchaseStatus ${cartLimitReached ? "isUnavailable" : ""}`}><span>供應狀態</span><strong>{selectedVariant.preorder_enabled ? selectedVariant.inventory > 0 ? `現貨剩 ${selectedVariant.inventory} 件｜可預訂` : "目前無現貨｜可預訂" : cartLimitReached ? "已達本次限購上限" : `現貨剩 ${remainingPurchasable} 件`}</strong>{selectedVariant.preorder_enabled ? <small>{selectedSupplyType === "preorder" ? `目前現貨 ${selectedVariant.inventory} 件，此數量將以預訂方式處理。` : "超過現貨數量仍可預訂。"}</small> : !cartLimitReached && <small>本次可購買 {remainingPurchasable} 件</small>}{remainingPurchasable === 1 && !selectedVariant.preorder_enabled && selectedSupplyType === "in_stock" && !cartLimitReached && <small className="rareNotice">🔥 最後一件</small>}</div>
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
                        <button type="button" aria-label="減少數量" disabled={selectedQuantity <= 1 || cartLimitReached} onClick={() => setProductQuantity(product.id, selectedVariant.preorder_enabled ? null : remainingPurchasable, selectedQuantity - 1)}>−</button>
                        <strong className="quantityValue" key={`${selectedVariant.id}-${selectedQuantity}`}>{selectedQuantity}</strong>
                        <button type="button" aria-label="增加數量" disabled={cartLimitReached || (!selectedVariant.preorder_enabled && selectedQuantity >= remainingPurchasable)} onClick={() => setProductQuantity(product.id, selectedVariant.preorder_enabled ? null : remainingPurchasable, selectedQuantity + 1, true)}>＋</button>
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
        </div>}
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
              const totalVariantQuantity = cartQuantityForVariant(cart, item.variant_id);
              const cartBusy = cartActionStatuses[item.product_id] === "adding";
              const cartPresets = activeProductProcessingPresetConfigs(item.product_id, productProcessingPresets, processingPresets).map((config) => processingPresets.find((preset) => preset.id === config.preset_id)).filter((preset): preset is ProcessingPreset => Boolean(preset));
              const cartOptions = activeProductProcessingOptionConfigs(item.product_id, productProcessingOptions, processingOptions).map((config) => processingOptions.find((option) => option.id === config.processing_option_id)).filter((option): option is ProcessingOption => Boolean(option));
              const processingSummary = summarizedProcessing(item);
              return <article className={`drawerCartItem ${item.supply_type === "preorder" ? "isPreorder" : "isInStock"}`} key={item.cart_key}>
                <div className="drawerItemImage">{product?.image_url ? <img src={product.image_url} alt={item.product_name} /> : <span>🐟</span>}</div>
                <div className="drawerItemInfo"><h3>{item.product_name}</h3><p>{item.variant_name}</p><span className={`cartSupplyBadge ${item.supply_type === "preorder" ? "isPreorder" : "isInStock"}`}>{item.supply_type === "preorder" ? "🟠 預訂" : "🟢 現貨"}</span>{item.supply_type === "preorder" && <small className="preorderCartNotice">目前現貨 {variant?.inventory || 0} 件，此數量將以預訂方式處理。</small>}<span className="priceTag"><small>單價</small>{formatPrice(item.price)}</span><div className="cartProcessingSummary"><strong>處理：{processingSummary.name}</strong>{processingSummary.extras.map((name) => <span key={name}>＋{name}</span>)}{item.processing_note && <span>其他需求：{item.processing_note}</span>}</div><strong className="itemSubtotal"><span>小計</span>{formatPrice(item.price * item.quantity)}</strong></div>
                {product?.processing_enabled && <details className="cartProcessingEditor"><summary>編輯處理方式</summary><div><div className="cartProcessingPresets">{cartPresets.map((preset) => <button type="button" className={item.processing_preset_id === preset.id ? "isSelected" : ""} onClick={() => selectCartPreset(item, preset.id)} key={preset.id}>{preset.name}</button>)}</div><div className="cartProcessingOptions">{cartOptions.map((option) => <label key={option.id}><input type="checkbox" checked={item.processing_option_ids.includes(option.id)} onChange={() => toggleCartOption(item, option.id)} />{option.name}</label>)}</div><label>其他處理需求<textarea rows={2} defaultValue={item.processing_note} onBlur={(event) => updateCartProcessing(item.cart_key, { presetId: item.processing_preset_id, optionIds: item.processing_option_ids, note: event.target.value })} /></label></div></details>}
                <div className="drawerItemActions"><div className="quantity"><button type="button" aria-label={`減少 ${item.variant_name} 數量`} disabled={cartBusy} onClick={() => changeQuantity(item.cart_key, item.quantity - 1)}>−</button><span className={animatedCartQuantity === `${item.variant_id}-${item.quantity}` ? "cartQuantityPulse" : ""} key={`${item.variant_id}-${item.quantity}`}>{item.quantity}</span><button type="button" aria-label={`增加 ${item.variant_name} 數量`} disabled={cartBusy || !variant || (!variant.preorder_enabled && totalVariantQuantity >= purchaseLimit)} onClick={() => changeQuantity(item.cart_key, item.quantity + 1)}>＋</button></div><button className="removeCartItem" type="button" aria-label={`移除${item.product_name} ${item.variant_name}`} disabled={cartBusy} onClick={() => changeQuantity(item.cart_key, 0)}><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg></button></div>
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
            <section className="checkoutItemReview" aria-labelledby="checkout-items-title"><h3 id="checkout-items-title">訂購內容</h3>{cart.some((item) => item.supply_type === "preorder") && <p className="checkoutPreorderNotice" role="status">此訂單包含預訂商品，將待商品到齊後一起安排取貨／配送。</p>}{cart.map((item) => { const processing = summarizedProcessing(item); return <article key={item.cart_key}><strong>{item.product_name}｜{item.variant_name}｜{item.supply_type === "preorder" ? "🟠 預訂" : "🟢 現貨"}｜×{item.quantity}</strong><span>單價：{formatPrice(item.price)}</span><span>小計：{formatPrice(item.price * item.quantity)}</span><span>處理：{processing.name}</span>{processing.extras.map((name) => <span key={name}>＋{name}</span>)}{item.processing_note && <span>備註：{item.processing_note}</span>}</article>; })}</section>
            <fieldset className="deliveryFieldset"><legend>選擇配送方式</legend><div className="deliveryOptions">{deliveryMethods.map((method) => {
              const unavailable = method.value === "台北市配送" && total < shippingThreshold;
              const selected = form.fulfillment === method.value;
              return <label className={`deliveryOption ${selected ? "isSelected" : ""} ${unavailable ? "isDisabled" : ""}`} key={method.value}>
                <input type="radio" name="delivery" value={method.value} aria-label={displayDeliveryMethod(method.value)} checked={selected} disabled={unavailable} onChange={() => setForm((current) => ({ ...current, fulfillment: method.value, deliveryTimeSlot: usesDeliveryTimeSlot(method.value) && !isDeliveryTimeSlot(current.deliveryTimeSlot) ? "不指定" : current.deliveryTimeSlot }))} />
                <span className="deliveryIcon" aria-hidden="true">{method.icon}</span><span className="deliveryCopy"><span className="deliveryTitle"><strong>{displayDeliveryMethod(method.value)}</strong><small className="recommendationLabel">{method.recommendation}</small></span><small className="deliverySubtitle">{method.value === "台北市配送" ? unavailable ? <>🚚 再買 <b>{formatPrice(shippingRemaining)}</b> 即可享台北市配送</> : "已符合台北市配送資格" : method.detail}</small></span><span className="deliveryCheck" aria-hidden="true">{selected ? "✓" : ""}</span>
              </label>;
            })}</div>
              <div className="subsidyMessage" aria-live="polite">{(form.fulfillment === "冷凍宅配" || form.fulfillment === "7-ELEVEN 冷凍交貨便") && "💚 韓九已補貼一半運費，讓您享有更優惠的配送服務。"}</div>
              <details className="deliveryExplanation" onToggle={(event) => setDeliveryNotesOpen(event.currentTarget.open)}><summary aria-expanded={deliveryNotesOpen}>配送須知</summary><div className="deliveryExplanationBody"><div><strong>📍 永春市場自取</strong><p>請依約定時間至永春市場取貨。</p></div><div><strong>🚚 台北市配送</strong><p>單筆消費滿 2500，即可協助配送到府。</p></div><div><strong>❄️ 冷凍宅配</strong><p>韓九補貼一半運費。</p></div><div><strong>🏪 7-11 冷凍交貨便</strong><p>韓九補貼一半運費，實際寄送仍依商品及數量安排。</p></div></div></details>
            </fieldset>
            <div className="checkoutFields"><label>姓名 *<input autoComplete="name" value={form.customer_name} onChange={(event) => setForm({ ...form, customer_name: event.target.value })} /></label><label>電話 *<input type="tel" inputMode="tel" autoComplete="tel" placeholder="例如：0912-345-678" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /><small>例如：0912-345-678</small></label><label className="fullField">Email<input type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
              {form.fulfillment === "永春市場自取" && <><label>取貨日期 *<input type="date" min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>取貨時間 *<input type="time" min={form.pickupDate === taipeiToday() ? taipeiCurrentTime() : undefined} value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label></>}
              {form.fulfillment === "台北市配送" && <><label className="fullField">配送地址 *<input autoComplete="street-address" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label><label>希望配送日期 *<input type="date" required min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>希望時間<input type="time" min={form.pickupDate === taipeiToday() ? taipeiCurrentTime() : undefined} value={form.pickupTime} onChange={(event) => setForm({ ...form, pickupTime: event.target.value })} /></label></>}
              {form.fulfillment === "冷凍宅配" && <><label className="fullField">收件地址 *<input autoComplete="street-address" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label><label>希望到貨日期 *<input type="date" required min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>希望到貨時段<select value={form.deliveryTimeSlot} onChange={(event) => setForm({ ...form, deliveryTimeSlot: event.target.value as CheckoutForm["deliveryTimeSlot"] })}>{deliveryTimeSlots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}</select><small>實際到貨時間依物流配送狀況為準。</small></label></>}
              {form.fulfillment === "7-ELEVEN 冷凍交貨便" && <><label>希望到貨日期 *<input type="date" required min={taipeiToday()} value={form.pickupDate} onChange={(event) => setForm({ ...form, pickupDate: event.target.value })} /></label><label>希望到貨時段<select value={form.deliveryTimeSlot} onChange={(event) => setForm({ ...form, deliveryTimeSlot: event.target.value as CheckoutForm["deliveryTimeSlot"] })}>{deliveryTimeSlots.map((slot) => <option key={slot} value={slot}>{slot}</option>)}</select><small>實際到貨時間依物流配送狀況為準。</small></label><label>7-11 門市名稱 *<input placeholder="例如：西湖門市" value={form.preferredStoreName} onChange={(event) => setForm({ ...form, preferredStoreName: event.target.value })} /></label><label>7-11 門市店號<input inputMode="numeric" placeholder="例如：123456" value={form.preferredStoreCode} onChange={(event) => setForm({ ...form, preferredStoreCode: event.target.value })} /></label></>}
              <label className="fullField">備註<textarea rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></label></div>
            <label className="rememberCustomer"><input type="checkbox" checked={form.rememberCustomerData} onChange={(event) => updateRememberPreference(event.target.checked)} /><span><strong>記住我的資料，下次自動帶入</strong><small>資料只會儲存在這台裝置，不會建立會員帳號。</small></span></label>
            <section className="checkoutAmountSummary" aria-label="結帳金額摘要"><div><span>商品小計</span><strong>{formatPrice(total)}</strong></div><div><span>配送／運費</span><strong>{formatPrice(0)}</strong></div><div className="checkoutPayableTotal"><span>應付總額</span><strong>{formatPrice(total)}</strong></div></section>
            <button className="submitOrderButton" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>{isSubmitting ? "送出中…" : "送出訂單"}</button><div className="checkoutNotice" aria-live="polite">{notice && <p className="notice">{notice}</p>}</div>
          </form>}
        </div>
      </section>
    </main>
  );
}

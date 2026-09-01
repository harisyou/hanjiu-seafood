import type { Product, ProductVariant } from "@/lib/catalog";
import type { FishRequest } from "@/lib/fish-requests";

function normalizeFishName(value: string) {
  return value.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim().toLocaleLowerCase("zh-TW");
}

function draftFishIdentityMatches(product: Product, request: FishRequest) {
  if (product.fish_catalog_id && request.fish_catalog_id) return product.fish_catalog_id === request.fish_catalog_id;
  return normalizeFishName(product.name) === normalizeFishName(request.fish_name);
}

export function canCreateOrderDraft(request: FishRequest) {
  return request.status === "waiting" || request.status === "contacted";
}

export function getDraftProducts(products: Product[], variants: ProductVariant[], request: FishRequest) {
  return products.filter((product) => product.status === "available"
    && draftFishIdentityMatches(product, request)
    && variants.some((variant) => variant.product_id === product.id && variant.active && variant.inventory > 0));
}

export function getDraftVariants(variants: ProductVariant[], productId: string) {
  return variants.filter((variant) => variant.product_id === productId);
}

export function isDraftVariantAvailable(variant: ProductVariant) {
  return variant.active && variant.inventory > 0;
}

export function validateDraftQuantity(quantity: number, inventory: number) {
  if (!Number.isInteger(quantity) || quantity < 1) return "數量必須是至少 1 的整數";
  if (quantity > inventory) return "目前最多可建立 " + inventory + " 件";
  return "";
}

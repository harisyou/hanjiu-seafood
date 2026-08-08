import type { Product, ProductVariant } from "@/lib/catalog";
import type { FishRequest, FishRequestStatus } from "@/lib/fish-requests";

export const activeFishRequestStatuses: FishRequestStatus[] = ["waiting", "matched", "contacted"];

export type FishMatch = {
  product: Product;
  availableVariants: ProductVariant[];
  requests: FishRequest[];
};

export function normalizeFishName(value: string) {
  return value.normalize("NFKC").replace(/[\s\u3000]+/g, " ").trim().toLocaleLowerCase("zh-TW");
}

export function isActiveFishRequest(request: FishRequest) {
  return activeFishRequestStatuses.includes(request.status);
}

export function fishIdentityMatches(product: Product, request: FishRequest) {
  if (product.fish_catalog_id && request.fish_catalog_id) {
    return product.fish_catalog_id === request.fish_catalog_id;
  }
  return normalizeFishName(request.fish_name) === normalizeFishName(product.name);
}

export function buildFishMatches(products: Product[], variants: ProductVariant[], requests: FishRequest[]) {
  const activeRequests = requests.filter(isActiveFishRequest);

  return products.flatMap<FishMatch>((product) => {
    if (product.status !== "available") return [];
    const availableVariants = variants.filter((variant) => variant.product_id === product.id && variant.active && variant.inventory > 0);
    if (availableVariants.length === 0) return [];
    const matchingRequests = activeRequests.filter((request) => fishIdentityMatches(product, request));
    return matchingRequests.length > 0 ? [{ product, availableVariants, requests: matchingRequests }] : [];
  });
}

export function requestHasAvailableMatch(request: FishRequest, matches: FishMatch[]) {
  return isActiveFishRequest(request) && matches.some((match) => fishIdentityMatches(match.product, request));
}

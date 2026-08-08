import type { Product, ProductVariant } from "@/lib/catalog";
import type { FishRequest, FishRequestStatus } from "@/lib/fish-requests";
import type { FishCatalogItem } from "@/lib/fish-catalog";

export const activeFishRequestStatuses: FishRequestStatus[] = ["waiting", "matched", "contacted"];

export type FishMatch = {
  product: Product;
  availableVariants: ProductVariant[];
  requests: FishRequest[];
};

export type FishMatchGroup = {
  key: string;
  name: string;
  products: Product[];
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

export function buildFishMatchGroups(products: Product[], variants: ProductVariant[], requests: FishRequest[], catalog: FishCatalogItem[] = []) {
  const matches = buildFishMatches(products, variants, requests);
  const groups = new Map<string, FishMatchGroup>();

  for (const match of matches) {
    for (const request of match.requests) {
      const normalizedName = normalizeFishName(request.fish_name);
      const catalogItem = catalog.find((fish) => fish.id === (request.fish_catalog_id || match.product.fish_catalog_id))
        || catalog.find((fish) => normalizeFishName(fish.name) === normalizedName);
      const key = request.fish_catalog_id || match.product.fish_catalog_id || catalogItem?.id || `legacy:${normalizedName}`;
      const name = catalogItem?.name || (match.product.fish_catalog_id ? match.product.name : request.fish_name);
      const group = groups.get(key) || { key, name, products: [], availableVariants: [], requests: [] };
      if (!group.products.some((product) => product.id === match.product.id)) group.products.push(match.product);
      for (const variant of match.availableVariants) {
        if (!group.availableVariants.some((item) => item.id === variant.id)) group.availableVariants.push(variant);
      }
      if (!group.requests.some((item) => item.id === request.id)) group.requests.push(request);
      groups.set(key, group);
    }
  }

  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-TW"));
}

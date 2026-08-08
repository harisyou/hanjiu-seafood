import type { Product, ProductVariant } from "@/lib/catalog";

export type InventoryProduct = Product & { variants: ProductVariant[] };
export type InventoryFilter = "all" | "selling" | "sold_out" | "hidden";

export function validateInventoryValues(name: string, price: number, inventory: number) {
  if (!name.trim()) return "規格名稱不可空白。";
  if (!Number.isInteger(price) || price < 0) return "價格必須是大於或等於 0 的整數。";
  if (!Number.isInteger(inventory) || inventory < 0) return "剩餘尾數必須是大於或等於 0 的整數。";
  return "";
}

export function inventoryProductState(product: InventoryProduct) {
  if (product.status === "hidden") return "hidden";
  if (product.status === "sold_out" || product.variants.every((variant) => variant.inventory === 0 || !variant.active)) return "sold_out";
  return "selling";
}

export function matchesInventoryProduct(product: InventoryProduct, search: string, filter: InventoryFilter) {
  const keyword = search.trim().toLocaleLowerCase("zh-TW");
  const matchesSearch = !keyword || [product.name, ...product.variants.map((variant) => variant.name)]
    .some((value) => value.toLocaleLowerCase("zh-TW").includes(keyword));
  return matchesSearch && (filter === "all" || inventoryProductState(product) === filter);
}

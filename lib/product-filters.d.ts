import { Product, ProductCategoryRecord, ProductVariant } from "@/lib/catalog";

export type ProductFilterState = { query: string; category: string; inStockOnly: boolean };
export function normalizeProductSearch(value: string): string;
export function sortActiveProductCategories(categories: ProductCategoryRecord[]): ProductCategoryRecord[];
export function hasPurchasableVariant(product: Product, variants: ProductVariant[]): boolean;
export function filterProducts(products: Product[], variants: ProductVariant[], filters: ProductFilterState): Product[];

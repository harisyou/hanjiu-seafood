import { Product, ProductVariant } from "@/lib/catalog";

export const PRODUCT_CATEGORIES: ReadonlyArray<{ id: ProductCategory; label: string }>;
export type ProductCategory = "all" | "live_fish" | "shrimp_crab" | "shellfish" | "frozen" | "other";
export type ProductFilterState = { query: string; category: ProductCategory; inStockOnly: boolean };
export function normalizeProductSearch(value: string): string;
export function productCategory(product: Product): ProductCategory;
export function hasPurchasableVariant(product: Product, variants: ProductVariant[]): boolean;
export function filterProducts(products: Product[], variants: ProductVariant[], filters: ProductFilterState): Product[];

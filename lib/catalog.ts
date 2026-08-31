export type ProductStatus = "available" | "sold_out" | "hidden";

export type Product = {
  id: string;
  name: string;
  description: string | null;
  cooking: string | null;
  image_url: string | null;
  status: ProductStatus;
  featured: boolean;
  sort_order: number;
  processing_enabled?: boolean;
  fish_catalog_id?: string | null;
  category_id?: string | null;
};

export type ProductCategoryRecord = {
  id: string;
  name: string;
  sort_order: number;
  active: boolean;
  created_at?: string;
  updated_at?: string;
};

export type ProductVariant = {
  id: string;
  product_id: string;
  name: string;
  price: number;
  inventory: number;
  active: boolean;
  sort_order: number;
};

export type ProcessingOption = { id: string; name: string; active: boolean; sort_order: number };
export type ProcessingPreset = { id: string; name: string; description: string | null; active: boolean; sort_order: number };
export type ProcessingPresetOption = { preset_id: string; processing_option_id: string };
export type ProductProcessingOption = { product_id: string; processing_option_id: string; active: boolean; recommended: boolean; sort_order: number };
export type ProductProcessingPreset = { product_id: string; preset_id: string; active: boolean; recommended: boolean; is_default: boolean; sort_order: number };

export function inventoryLabel(inventory: number) {
  if (inventory <= 0) return "已售完";
  if (inventory === 1) return "最後1份";
  if (inventory <= 3) return "剩少量";
  return "現貨充足";
}

export function formatPrice(price: number) {
  return `NT$${price.toLocaleString("zh-TW")}`;
}

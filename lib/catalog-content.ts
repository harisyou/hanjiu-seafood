import type { Product, ProductFaq, ProductImage, ProductVariant } from "./catalog";

export function stableOrder<T extends { sort_order: number; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
}
export function imageSource(image: ProductImage, supabaseUrl: string): string {
  return image.legacy_url || image.public_url || (image.storage_bucket === "product-images" && image.storage_path
    ? `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/product-images/${image.storage_path.split("/").map(encodeURIComponent).join("/")}` : "");
}
export function primaryImage(product: Product, images: ProductImage[], supabaseUrl: string): string | null {
  const primary = stableOrder(images.filter((image) => image.product_id === product.id)).find((image) => image.is_primary);
  return (primary && imageSource(primary, supabaseUrl)) || product.image_url || null;
}
export function visibleFaqs(faqs: ProductFaq[]): ProductFaq[] { return stableOrder(faqs.filter((faq) => faq.active)); }
export function catalogVisible(product: Pick<Product, "status">): boolean { return product.status !== "hidden"; }
// Deliberately legacy semantics, not physical-stock or preorder-demand domains.
export function legacySummary(product: Product, variants: ProductVariant[]) {
  const active = variants.filter((variant) => variant.product_id === product.id && variant.active);
  const prices = active.map((variant) => variant.price);
  return { min: prices.length ? Math.min(...prices) : null, max: prices.length ? Math.max(...prices) : null,
    inStock: product.status === "available" && active.some((variant) => variant.inventory > 0),
    preorder: product.status === "available" && active.some((variant) => variant.preorder_enabled) };
}

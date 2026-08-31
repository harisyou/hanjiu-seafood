export function normalizeProductSearch(value) {
  return value.normalize("NFKC").trim().replace(/[\s　]+/g, " ").toLocaleLowerCase("zh-TW");
}

export function sortActiveProductCategories(categories) {
  return categories
    .filter((category) => category.active)
    .slice()
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, "zh-TW") || left.id.localeCompare(right.id));
}

export function hasPurchasableVariant(product, variants) {
  return product.status === "available" && variants.some((variant) => variant.product_id === product.id && variant.active && variant.inventory > 0);
}

export function filterProducts(products, variants, filters) {
  const query = normalizeProductSearch(filters.query);
  return products.filter((product) => {
    if (query && !normalizeProductSearch(product.name).includes(query)) return false;
    if (filters.category !== "all" && product.category_id !== filters.category) return false;
    if (filters.inStockOnly && !hasPurchasableVariant(product, variants)) return false;
    return true;
  });
}

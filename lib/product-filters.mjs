export const PRODUCT_CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "live_fish", label: "現流魚" },
  { id: "shrimp_crab", label: "蝦蟹" },
  { id: "shellfish", label: "貝類" },
  { id: "frozen", label: "冷凍" },
  { id: "other", label: "其他" }
];

const frozenPattern = /冷凍|冷藏|急凍|凍品|冰鮮/;
const shrimpCrabPattern = /蝦|蟹|龍蝦|螯/;
const shellfishPattern = /貝|蛤|蠔|牡蠣|蚵|蜆|鮑/;
const fishPattern = /魚|鯛|鱸|鯖|鯧|鰹|鮭|石斑|白帶|午仔|馬頭|透抽|小卷|花枝|魷/;

export function normalizeProductSearch(value) {
  return value.normalize("NFKC").trim().replace(/[\s　]+/g, " ").toLocaleLowerCase("zh-TW");
}

export function productCategory(product) {
  const name = normalizeProductSearch(product.name);
  if (frozenPattern.test(name)) return "frozen";
  if (shrimpCrabPattern.test(name)) return "shrimp_crab";
  if (shellfishPattern.test(name)) return "shellfish";
  if (product.fish_catalog_id || fishPattern.test(name)) return "live_fish";
  return "other";
}

export function hasPurchasableVariant(product, variants) {
  return product.status === "available" && variants.some((variant) => variant.product_id === product.id && variant.active && variant.inventory > 0);
}

export function filterProducts(products, variants, filters) {
  const query = normalizeProductSearch(filters.query);
  return products.filter((product) => {
    if (query && !normalizeProductSearch(product.name).includes(query)) return false;
    if (filters.category !== "all" && productCategory(product) !== filters.category) return false;
    if (filters.inStockOnly && !hasPurchasableVariant(product, variants)) return false;
    return true;
  });
}

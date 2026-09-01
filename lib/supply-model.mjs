export function variantSupplyType(variant) {
  if (variant?.active === false) return null;
  if (variant.inventory > 0) return "in_stock";
  return variant.preorder_enabled ? "preorder" : null;
}

export function cartQuantityForVariant(cart, variantId, supplyType) {
  return cart
    .filter((item) => item.variant_id === variantId && (!supplyType || item.supply_type === supplyType))
    .reduce((total, item) => total + item.quantity, 0);
}

export function remainingInStockPurchasable(variant, cart) {
  return Math.max(0, variant.inventory - cartQuantityForVariant(cart, variant.id, "in_stock"));
}

export function isPreorderCartItemValid(item, variant) {
  return item.supply_type === "preorder" && Boolean(variant?.active) && variant.inventory === 0 && Boolean(variant.preorder_enabled);
}

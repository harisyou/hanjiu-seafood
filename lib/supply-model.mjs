export function variantSupplyType(variant) {
  if (variant?.active === false) return null;
  if (variant.inventory > 0) return "in_stock";
  return variant.preorder_enabled ? "preorder" : null;
}

// This is only the customer-facing estimate. Checkout derives the final snapshot
// while holding the current variant row lock in PostgreSQL.
export function supplyTypeForQuantity(variant, quantity) {
  if (variant?.active === false || !Number.isInteger(quantity) || quantity < 1) return null;
  if (quantity <= variant.inventory) return "in_stock";
  return variant.preorder_enabled ? "preorder" : null;
}

export function shouldShowExcessPreorderNotice(variant, quantity) {
  return variant?.active !== false && variant.preorder_enabled && variant.inventory > 0 && quantity > variant.inventory;
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
  return item.supply_type === "preorder" && supplyTypeForQuantity(variant, item.quantity) === "preorder";
}

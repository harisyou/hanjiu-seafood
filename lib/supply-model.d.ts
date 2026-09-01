export type SupplyType = "in_stock" | "preorder";

export type SupplyVariant = { id: string; inventory: number; preorder_enabled?: boolean; active?: boolean };
export type SupplyCartItem = { variant_id: string; quantity: number; supply_type: SupplyType };

export function variantSupplyType(variant: SupplyVariant): SupplyType | null;
export function supplyTypeForQuantity(variant: SupplyVariant, quantity: number): SupplyType | null;
export function shouldShowExcessPreorderNotice(variant: SupplyVariant, quantity: number): boolean;
export function cartQuantityForVariant(cart: SupplyCartItem[], variantId: string, supplyType?: SupplyType): number;
export function remainingInStockPurchasable(variant: SupplyVariant, cart: SupplyCartItem[]): number;
export function isPreorderCartItemValid(item: SupplyCartItem, variant: SupplyVariant | undefined): boolean;

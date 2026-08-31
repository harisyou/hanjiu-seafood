export type ActiveCatalogItem = { id: string; active: boolean };
export type ProductProcessingPresetConfig = { product_id: string; preset_id: string; active: boolean; recommended?: boolean; is_default?: boolean; sort_order?: number };
export type ProductProcessingOptionConfig = { product_id: string; processing_option_id: string; active: boolean; recommended?: boolean; sort_order?: number };
export type ProcessingSelectionInput = { presetId: string | null; optionIds: string[]; note: string };

export function activeProductProcessingPresetConfigs(productId: string, productConfigs: ProductProcessingPresetConfig[], presets: ActiveCatalogItem[]): ProductProcessingPresetConfig[];
export function activeProductProcessingOptionConfigs(productId: string, productConfigs: ProductProcessingOptionConfig[], options: ActiveCatalogItem[]): ProductProcessingOptionConfig[];
export function validProcessingSelection(selection: ProcessingSelectionInput, presetConfigs: ProductProcessingPresetConfig[], optionConfigs: ProductProcessingOptionConfig[]): ProcessingSelectionInput;

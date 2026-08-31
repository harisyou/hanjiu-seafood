function activeIds(items) {
  return new Set(items.filter((item) => item.active).map((item) => item.id));
}

export function activeProductProcessingPresetConfigs(productId, productConfigs, presets) {
  const presetIds = activeIds(presets);
  return productConfigs.filter((config) => config.product_id === productId && config.active && presetIds.has(config.preset_id));
}

export function activeProductProcessingOptionConfigs(productId, productConfigs, options) {
  const optionIds = activeIds(options);
  return productConfigs.filter((config) => config.product_id === productId && config.active && optionIds.has(config.processing_option_id));
}

export function validProcessingSelection(selection, presetConfigs, optionConfigs) {
  const presetIds = new Set(presetConfigs.map((config) => config.preset_id));
  const optionIds = new Set(optionConfigs.map((config) => config.processing_option_id));
  return {
    presetId: selection.presetId && presetIds.has(selection.presetId) ? selection.presetId : null,
    optionIds: [...new Set(selection.optionIds || [])].filter((id) => optionIds.has(id)).sort(),
    note: String(selection.note || "").trim()
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { activeProductProcessingOptionConfigs, activeProductProcessingPresetConfigs, validProcessingSelection } from "../lib/processing-availability.mjs";
import { readFileSync } from "node:fs";

const presets = [
  { id: "three-clean", active: true },
  { id: "retired-preset", active: false }
];
const options = [
  { id: "scale", active: true },
  { id: "retired-option", active: false }
];
const presetConfigs = [
  { product_id: "fish", preset_id: "three-clean", active: true, is_default: true },
  { product_id: "fish", preset_id: "retired-preset", active: true, is_default: false }
];
const optionConfigs = [
  { product_id: "fish", processing_option_id: "scale", active: true },
  { product_id: "fish", processing_option_id: "retired-option", active: true }
];

test("active product configuration and active global catalog remain selectable", () => {
  assert.deepEqual(activeProductProcessingPresetConfigs("fish", presetConfigs, presets).map((config) => config.preset_id), ["three-clean"]);
  assert.deepEqual(activeProductProcessingOptionConfigs("fish", optionConfigs, options).map((config) => config.processing_option_id), ["scale"]);
  assert.deepEqual(validProcessingSelection({ presetId: "three-clean", optionIds: ["scale"], note: "  保留魚頭 " }, activeProductProcessingPresetConfigs("fish", presetConfigs, presets), activeProductProcessingOptionConfigs("fish", optionConfigs, options)), { presetId: "three-clean", optionIds: ["scale"], note: "保留魚頭" });
});

test("an active product config cannot revive an inactive global preset", () => {
  const selection = validProcessingSelection({ presetId: "retired-preset", optionIds: ["scale"], note: "" }, activeProductProcessingPresetConfigs("fish", presetConfigs, presets), activeProductProcessingOptionConfigs("fish", optionConfigs, options));
  assert.equal(selection.presetId, null);
  assert.deepEqual(selection.optionIds, ["scale"]);
});

test("an active product config cannot revive an inactive global option", () => {
  const selection = validProcessingSelection({ presetId: "three-clean", optionIds: ["retired-option", "scale", "retired-option"], note: "" }, activeProductProcessingPresetConfigs("fish", presetConfigs, presets), activeProductProcessingOptionConfigs("fish", optionConfigs, options));
  assert.deepEqual(selection.optionIds, ["scale"]);
});

test("storefront sanitizes restore, initialization, cart editing, and checkout payload without weakening the server guard", () => {
  const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/f004-3-3-in-stock-preorder-product-model.sql", import.meta.url), "utf8");
  assert.match(page, /activeProductProcessingPresetConfigs\(/);
  assert.match(page, /activeProductProcessingOptionConfigs\(/);
  assert.match(page, /validProcessingSelection\(/);
  assert.match(page, /const checkoutItems = cart\.map\(\(item\) => \(\{ variant_id: item\.variant_id, quantity: item\.quantity, processing_preset_id: item\.processing_preset_id, processing_option_ids: item\.processing_option_ids, processing_note: item\.processing_note \}\)\)/);
  assert.match(migration, /raise exception 'processing_updated'/);
});

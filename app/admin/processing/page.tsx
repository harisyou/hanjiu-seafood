"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { ProcessingOption, ProcessingPreset, ProcessingPresetOption, Product } from "@/lib/catalog";

export default function ProcessingAdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const [productId, setProductId] = useState("");
  const [user, setUser] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [options, setOptions] = useState<ProcessingOption[]>([]);
  const [presets, setPresets] = useState<ProcessingPreset[]>([]);
  const [presetOptions, setPresetOptions] = useState<ProcessingPresetOption[]>([]);
  const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);
  const [recommended, setRecommended] = useState("");
  const [defaultPreset, setDefaultPreset] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!productId) return setNotice("缺少商品編號。");
    const [productResult, optionResult, presetResult, compositionResult, productOptionResult, productPresetResult] = await Promise.all([
      supabase.from("products").select("*").eq("id", productId).single(),
      supabase.from("processing_options").select("*").order("sort_order"),
      supabase.from("processing_presets").select("*").order("sort_order"),
      supabase.from("processing_preset_options").select("*"),
      supabase.from("product_processing_options").select("*").eq("product_id", productId),
      supabase.from("product_processing_presets").select("*").eq("product_id", productId)
    ]);
    const firstError = [productResult, optionResult, presetResult, compositionResult, productOptionResult, productPresetResult].find((result) => result.error)?.error;
    if (firstError) return setNotice(`處理設定載入失敗：${firstError.message}`);
    setProduct(productResult.data as Product);
    setOptions((optionResult.data || []) as ProcessingOption[]);
    setPresets((presetResult.data || []) as ProcessingPreset[]);
    setPresetOptions((compositionResult.data || []) as ProcessingPresetOption[]);
    setSelectedOptions((productOptionResult.data || []).filter((item) => item.active).map((item) => item.processing_option_id));
    setSelectedPresets((productPresetResult.data || []).filter((item) => item.active).map((item) => item.preset_id));
    setRecommended((productPresetResult.data || []).find((item) => item.recommended)?.preset_id || (productOptionResult.data || []).find((item) => item.recommended)?.processing_option_id || "");
    setDefaultPreset((productPresetResult.data || []).find((item) => item.is_default)?.preset_id || "");
    setEnabled(Boolean(productResult.data.processing_enabled));
  }, [productId, supabase]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("productId") || "";
    setProductId(id);
    if (!id) return setNotice("缺少商品編號。");
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || "");
      if (data.session) setProductId(id);
    });
  }, [supabase]);

  useEffect(() => { if (user && productId) load(); }, [load, productId, user]);

  function toggleValue(values: string[], value: string, setter: (next: string[]) => void) {
    setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!product) return;
    if (enabled && selectedPresets.length + selectedOptions.length === 0) return setNotice("請至少啟用一種處理方式。");
    if (defaultPreset && !selectedPresets.includes(defaultPreset)) return setNotice("預設套餐必須先啟用。");
    setBusy(true); setNotice("");
    try {
      const requiredPresetOptions = presetOptions.filter((item) => selectedPresets.includes(item.preset_id)).map((item) => item.processing_option_id);
      const effectiveOptions = [...new Set([...selectedOptions, ...requiredPresetOptions])];
      const productUpdate = await supabase.from("products").update({ processing_enabled: enabled }).eq("id", product.id);
      if (productUpdate.error) throw productUpdate.error;
      const [deleteOptions, deletePresets] = await Promise.all([
        supabase.from("product_processing_options").delete().eq("product_id", product.id),
        supabase.from("product_processing_presets").delete().eq("product_id", product.id)
      ]);
      if (deleteOptions.error || deletePresets.error) throw deleteOptions.error || deletePresets.error;
      if (effectiveOptions.length) {
        const result = await supabase.from("product_processing_options").insert(effectiveOptions.map((id, index) => ({ product_id: product.id, processing_option_id: id, active: true, recommended: recommended === id, sort_order: (index + 1) * 10 })));
        if (result.error) throw result.error;
      }
      if (selectedPresets.length) {
        const result = await supabase.from("product_processing_presets").insert(selectedPresets.map((id, index) => ({ product_id: product.id, preset_id: id, active: true, recommended: recommended === id, is_default: defaultPreset === id, sort_order: (index + 1) * 10 })));
        if (result.error) throw result.error;
      }
      setNotice("處理設定已儲存。");
      await load();
    } catch (error) {
      setNotice(`處理設定儲存失敗：${error instanceof Error ? error.message : "請稍後再試"}`);
    } finally { setBusy(false); }
  }

  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>請先登入後台</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!product) return <main className="admin"><section className="panel centeredNotice"><p>{notice || "載入中…"}</p></section></main>;

  const recommendedChoices = [
    ...presets.filter((preset) => selectedPresets.includes(preset.id)),
    ...options.filter((option) => selectedOptions.includes(option.id))
  ];

  return <main className="admin processingAdmin">
    <header className="adminTop"><div><Link href="/admin">← 返回商品管理</Link><h1>{product.name}｜處理設定</h1><p>設定顧客可選擇的魚貨處理方式。</p></div></header>
    <form className="panel processingConfig" onSubmit={save}>
      <label className="check processingToggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>提供魚貨處理服務</strong><small>關閉後，顧客端不顯示處理選項並視為不處理。</small></span></label>
      <fieldset disabled={!enabled}><legend>可用套餐</legend><div className="processingAdminChoices">{presets.map((preset) => <label className="check" key={preset.id}><input type="checkbox" checked={selectedPresets.includes(preset.id)} onChange={() => toggleValue(selectedPresets, preset.id, setSelectedPresets)} /><span><strong>{preset.name}</strong><small>{preset.description || presetOptions.filter((item) => item.preset_id === preset.id).map((item) => options.find((option) => option.id === item.processing_option_id)?.name).filter(Boolean).join("、")}</small></span></label>)}</div></fieldset>
      <fieldset disabled={!enabled}><legend>可用客製選項</legend><div className="processingAdminChoices">{options.map((option) => <label className="check" key={option.id}><input type="checkbox" checked={selectedOptions.includes(option.id)} onChange={() => toggleValue(selectedOptions, option.id, setSelectedOptions)} /><span>{option.name}</span></label>)}</div></fieldset>
      <div className="processingAdminSelects"><label>推薦方式<select value={recommended} onChange={(event) => setRecommended(event.target.value)}><option value="">不指定</option>{recommendedChoices.map((choice) => <option value={choice.id} key={choice.id}>{choice.name}</option>)}</select></label><label>預設套餐<select value={defaultPreset} onChange={(event) => setDefaultPreset(event.target.value)}><option value="">不指定</option>{presets.filter((preset) => selectedPresets.includes(preset.id)).map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label></div>
      <button disabled={busy}>{busy ? "儲存中…" : "儲存處理設定"}</button>{notice && <p className="notice" aria-live="polite">{notice}</p>}
    </form>
  </main>;
}

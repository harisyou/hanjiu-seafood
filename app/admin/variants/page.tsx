"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { formatPrice, inventoryLabel, Product, ProductVariant } from "@/lib/catalog";

const emptyForm = { name: "", price: 0, inventory: 0, active: true, sort_order: 100 };

export default function ProductVariantsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [productId, setProductId] = useState("");
  const [product, setProduct] = useState<Product | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const loadProduct = useCallback(async (id: string) => {
    setLoading(true);
    const [{ data: productData, error: productError }, { data: variantData, error: variantError }] =
      await Promise.all([
        supabase.from("products").select("*").eq("id", id).single(),
        supabase.from("product_variants").select("*").eq("product_id", id).order("sort_order")
      ]);

    if (productError || !productData) {
      setNotice(`找不到商品：${productError?.message || "商品不存在"}`);
      setProduct(null);
    } else {
      setProduct(productData as Product);
      setVariants((variantData || []) as ProductVariant[]);
      if (variantError) setNotice(`規格載入失敗：${variantError.message}`);
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("productId") || "";
    setProductId(id);
    if (id) loadProduct(id);
    else {
      setNotice("缺少 productId，請從商品管理頁進入。");
      setLoading(false);
    }
  }, [loadProduct]);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
  }

  async function saveVariant(event: React.FormEvent) {
    event.preventDefault();
    if (!productId || !form.name.trim()) return;

    const payload = { name: form.name.trim(), price: Math.max(0, Math.round(form.price)), inventory: Math.max(0, Math.round(form.inventory)), active: form.active, sort_order: Math.round(form.sort_order) };
    const result = editingId
      ? await supabase.rpc("admin_update_inventory_variant", { p_variant_id: editingId, p_name: payload.name, p_price: payload.price, p_inventory: payload.inventory, p_active: payload.active, p_sort_order: payload.sort_order })
      : await supabase.rpc("admin_create_inventory_variant", { p_product_id: productId, p_name: payload.name, p_price: payload.price, p_inventory: payload.inventory, p_active: payload.active, p_sort_order: payload.sort_order });

    if (result.error) setNotice(`儲存失敗：${result.error.message}`);
    else {
      setNotice(editingId ? "規格已更新。" : "規格已新增。");
      resetForm();
      await loadProduct(productId);
    }
  }

  function editVariant(variant: ProductVariant) {
    setEditingId(variant.id);
    setForm({
      name: variant.name,
      price: variant.price,
      inventory: variant.inventory,
      active: variant.active,
      sort_order: variant.sort_order
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function removeVariant(variant: ProductVariant) {
    if (!confirm(`確定下架規格「${variant.name}」？歷史訂單資料不會受影響。`)) return;
    const { error } = await supabase.rpc("admin_update_inventory_variant", { p_variant_id: variant.id, p_name: variant.name, p_price: variant.price, p_inventory: variant.inventory, p_active: false, p_sort_order: variant.sort_order });
    if (error) setNotice(`下架失敗：${error.message}`);
    else {
      setNotice("規格已下架。");
      await loadProduct(productId);
    }
  }

  return (
    <main className="admin variantsAdmin">
      <header className="adminTop">
        <div>
          <Link href="/admin">← 返回商品管理</Link>
          <h1>⚖️ 管理規格</h1>
          <p>{loading ? "載入中…" : product?.name || "未選擇商品"}</p>
        </div>
      </header>

      {product && (
        <section className="adminGrid">
          <form className="panel" onSubmit={saveVariant}>
            <h2>{editingId ? "編輯規格" : "新增規格"}</h2>
            <label>重量區間（處理前）<input required value={form.name} placeholder="例如：150g～200g" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>固定售價（NT$）<input required min={0} type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} /></label>
            <label>剩餘尾數<input required min={0} type="number" value={form.inventory} onChange={(e) => setForm({ ...form, inventory: Number(e.target.value) })} /></label>
            <small className="uploadHelp">每個重量區間維持固定售價；重量皆為處理前重量，剩餘尾數為目前可販售數量。</small>
            <label>排序<input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} /></label>
            <label className="check"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />前台顯示</label>
            <button>{editingId ? "更新規格" : "新增規格"}</button>
            {editingId && <button className="cancelEditButton" type="button" onClick={resetForm}>取消編輯</button>}
          </form>

          <section className="panel">
            <h2>可用規格</h2>
            {variants.length === 0 ? <p>尚未建立規格。</p> : variants.map((variant) => (
              <div className="manageRow" key={variant.id}>
                <div className="variantSummary">
                  <strong>{variant.name}</strong>
                  <span>{formatPrice(variant.price)}</span>
                  <small>{variant.inventory > 0 ? `剩餘 ${variant.inventory} 尾` : inventoryLabel(variant.inventory)} · {variant.active ? "顯示中" : "已隱藏"}</small>
                </div>
                <div className="manageActions">
                  <button type="button" onClick={() => editVariant(variant)}>編輯</button>
                  <button type="button" onClick={() => removeVariant(variant)}>下架</button>
                </div>
              </div>
            ))}
          </section>
        </section>
      )}
      {notice && <p className="notice centeredNotice">{notice}</p>}
    </main>
  );
}

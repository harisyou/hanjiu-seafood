"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Product, ProductVariant } from "@/lib/catalog";
import { validateInventoryValues } from "@/lib/inventory";
import { FishCatalogItem } from "@/lib/fish-catalog";

const blankVariant = { name: "", price: 0, inventory: 0, preorder_enabled: false, active: true, sort_order: 100 };

export default function InventoryProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [catalog, setCatalog] = useState<FishCatalogItem[]>([]);
  const [newVariant, setNewVariant] = useState(blankVariant);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [productResult, variantResult, catalogResult] = await Promise.all([
      supabase.from("products").select("*").eq("id", id).single(),
      supabase.from("product_variants").select("*").eq("product_id", id).order("sort_order"),
      supabase.from("fish_catalog").select("*").order("sort_order").order("name")
    ]);
    if (productResult.error || variantResult.error || catalogResult.error) setNotice("商品載入失敗，請確認 F003-6 migration 與管理員權限。");
    else { setProduct(productResult.data as Product); setVariants((variantResult.data || []) as ProductVariant[]); setCatalog((catalogResult.data || []) as FishCatalogItem[]); }
  }, [id, supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); if (data.session) load(); }); }, [load, supabase]);

  async function saveProduct(event: React.FormEvent) {
    event.preventDefault();
    if (!product || !product.name.trim()) return setNotice("商品名稱不可空白。");
    setBusy(true);
    const { error } = await supabase.from("products").update({ name: product.name.trim(), status: product.status, processing_enabled: Boolean(product.processing_enabled), fish_catalog_id: product.fish_catalog_id || null }).eq("id", product.id);
    setBusy(false);
    if (error) setNotice("商品更新失敗。"); else { setNotice("商品資料已更新。"); await load(); }
  }

  async function addVariant(event: React.FormEvent) {
    event.preventDefault();
    const validation = validateInventoryValues(newVariant.name, newVariant.price, newVariant.inventory);
    if (validation) return setNotice(validation);
    setBusy(true);
    const { error } = await supabase.rpc("admin_create_inventory_variant", {
      p_product_id: id, p_name: newVariant.name.trim(), p_price: newVariant.price,
      p_inventory: newVariant.inventory, p_preorder_enabled: newVariant.preorder_enabled, p_active: newVariant.active, p_sort_order: newVariant.sort_order
    });
    setBusy(false);
    if (error) setNotice("新增規格失敗。"); else { setNotice("規格已新增。"); setNewVariant(blankVariant); await load(); }
  }

  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>請先登入後台</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!product) return <main className="admin"><section className="panel centeredNotice"><Link href="/admin/inventory">← 返回庫存</Link><p>{notice || "載入中…"}</p></section></main>;

  return <main className="admin adminOrdersPage inventoryDetailPage"><header className="adminTop ordersTop"><div><Link href="/admin/inventory">← 返回今日魚貨</Link><h1>{product.name}</h1><p>以處理前重量區間設定固定售價、現貨件數與預訂；既有規格不會被刪除。</p></div><Link className="buttonLink" href={`/admin/processing?productId=${product.id}`}>🐟 管理處理方式</Link></header><div className="inventoryDetailGrid"><form className="panel" onSubmit={saveProduct}><h2>商品資料</h2><label>商品名稱 *<input value={product.name} onChange={(event) => setProduct({ ...product, name: event.target.value })} /></label><label>魚種分類<select value={product.fish_catalog_id || ""} onChange={(event) => setProduct({ ...product, fish_catalog_id: event.target.value || null })}><option value="">未分類</option>{catalog.map((fish) => <option value={fish.id} key={fish.id}>{fish.name}{fish.active ? "" : "（已停用）"}</option>)}</select></label><label>商品狀態<select value={product.status} onChange={(event) => setProduct({ ...product, status: event.target.value as Product["status"] })}><option value="available">販售中</option><option value="sold_out">售完</option><option value="hidden">下架</option></select></label><label className="check"><input type="checkbox" checked={Boolean(product.processing_enabled)} onChange={(event) => setProduct({ ...product, processing_enabled: event.target.checked })} />啟用魚貨處理</label><button disabled={busy}>{busy ? "儲存中…" : "儲存商品"}</button></form><form className="panel" onSubmit={addVariant}><h2>新增重量區間</h2><label>重量區間（處理前）*<input placeholder="例如：150g～200g" value={newVariant.name} onChange={(event) => setNewVariant({ ...newVariant, name: event.target.value })} /></label><label>固定售價 *<input type="number" min={0} step={1} value={newVariant.price} onChange={(event) => setNewVariant({ ...newVariant, price: Number(event.target.value) })} /></label><label>現貨件數 *<input type="number" min={0} step={1} value={newVariant.inventory} onChange={(event) => setNewVariant({ ...newVariant, inventory: Number(event.target.value) })} /></label><label className="check"><input type="checkbox" checked={newVariant.preorder_enabled} onChange={(event) => setNewVariant({ ...newVariant, preorder_enabled: event.target.checked })} />接受預訂</label><label className="check"><input type="checkbox" checked={newVariant.active} onChange={(event) => setNewVariant({ ...newVariant, active: event.target.checked })} />規格上架</label><button disabled={busy}>{busy ? "新增中…" : "新增規格"}</button></form></div><section className="panel inventoryExisting"><h2>既有規格</h2>{variants.map((variant) => <div key={variant.id}><strong>{variant.name}</strong><span>NT${variant.price.toLocaleString("zh-TW")}｜{variant.inventory > 0 ? `現貨｜剩 ${variant.inventory} 件` : variant.preorder_enabled ? "可預訂" : "已售完"}｜{variant.active ? "上架" : "下架"}</span></div>)}</section>{notice && <p className="notice centeredNotice" aria-live="polite">{notice}</p>}</main>;
}

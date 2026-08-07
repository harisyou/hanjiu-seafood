"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Product, ProductVariant } from "@/lib/catalog";
import { validateInventoryValues } from "@/lib/inventory";

const blankVariant = { name: "", price: 0, inventory: 0, active: true, sort_order: 100 };

export default function InventoryProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [newVariant, setNewVariant] = useState(blankVariant);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [productResult, variantResult] = await Promise.all([
      supabase.from("products").select("*").eq("id", id).single(),
      supabase.from("product_variants").select("*").eq("product_id", id).order("sort_order")
    ]);
    if (productResult.error || variantResult.error) setNotice("商品載入失敗，請確認管理員權限。");
    else { setProduct(productResult.data as Product); setVariants((variantResult.data || []) as ProductVariant[]); }
  }, [id, supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); if (data.session) load(); }); }, [load, supabase]);

  async function saveProduct(event: React.FormEvent) {
    event.preventDefault();
    if (!product || !product.name.trim()) return setNotice("商品名稱不可空白。");
    setBusy(true);
    const { error } = await supabase.from("products").update({ name: product.name.trim(), status: product.status, processing_enabled: Boolean(product.processing_enabled) }).eq("id", product.id);
    setBusy(false);
    if (error) setNotice("商品更新失敗。"); else { setNotice("商品資料已更新。"); await load(); }
  }

  async function addVariant(event: React.FormEvent) {
    event.preventDefault();
    const validation = validateInventoryValues(newVariant.name, newVariant.price, newVariant.inventory);
    if (validation) return setNotice(validation);
    setBusy(true);
    const { error } = await supabase.from("product_variants").insert({ ...newVariant, name: newVariant.name.trim(), product_id: id });
    setBusy(false);
    if (error) setNotice("新增規格失敗。"); else { setNotice("規格已新增。"); setNewVariant(blankVariant); await load(); }
  }

  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>請先登入後台</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!product) return <main className="admin"><section className="panel centeredNotice"><Link href="/admin/inventory">← 返回庫存</Link><p>{notice || "載入中…"}</p></section></main>;

  return <main className="admin adminOrdersPage inventoryDetailPage"><header className="adminTop ordersTop"><div><Link href="/admin/inventory">← 返回今日魚貨</Link><h1>{product.name}</h1><p>編輯商品狀態並新增規格；既有規格不會被刪除。</p></div><Link className="buttonLink" href={`/admin/processing?productId=${product.id}`}>🐟 管理處理方式</Link></header><div className="inventoryDetailGrid"><form className="panel" onSubmit={saveProduct}><h2>商品資料</h2><label>商品名稱 *<input value={product.name} onChange={(event) => setProduct({ ...product, name: event.target.value })} /></label><label>商品狀態<select value={product.status} onChange={(event) => setProduct({ ...product, status: event.target.value as Product["status"] })}><option value="available">販售中</option><option value="sold_out">售完</option><option value="hidden">下架</option></select></label><label className="check"><input type="checkbox" checked={Boolean(product.processing_enabled)} onChange={(event) => setProduct({ ...product, processing_enabled: event.target.checked })} />啟用魚貨處理</label><button disabled={busy}>{busy ? "儲存中…" : "儲存商品"}</button></form><form className="panel" onSubmit={addVariant}><h2>新增規格</h2><label>規格名稱 *<input value={newVariant.name} onChange={(event) => setNewVariant({ ...newVariant, name: event.target.value })} /></label><label>價格 *<input type="number" min={0} step={1} value={newVariant.price} onChange={(event) => setNewVariant({ ...newVariant, price: Number(event.target.value) })} /></label><label>庫存 *<input type="number" min={0} step={1} value={newVariant.inventory} onChange={(event) => setNewVariant({ ...newVariant, inventory: Number(event.target.value) })} /></label><label className="check"><input type="checkbox" checked={newVariant.active} onChange={(event) => setNewVariant({ ...newVariant, active: event.target.checked })} />規格上架</label><button disabled={busy}>{busy ? "新增中…" : "新增規格"}</button></form></div><section className="panel inventoryExisting"><h2>既有規格</h2>{variants.map((variant) => <div key={variant.id}><strong>{variant.name}</strong><span>NT${variant.price.toLocaleString("zh-TW")}｜庫存 {variant.inventory}｜{variant.active ? "上架" : "下架"}</span></div>)}</section>{notice && <p className="notice centeredNotice" aria-live="polite">{notice}</p>}</main>;
}

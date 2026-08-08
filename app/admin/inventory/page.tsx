"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Product, ProductVariant } from "@/lib/catalog";
import { InventoryFilter, InventoryProduct, inventoryProductState, matchesInventoryProduct, validateInventoryValues } from "@/lib/inventory";

const newProductInitial = { productName: "", processingEnabled: false, variantName: "", price: 0, inventory: 0, active: true };

export default function AdminInventoryPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newProduct, setNewProduct] = useState(newProductInitial);

  const load = useCallback(async () => {
    const [productResult, variantResult] = await Promise.all([
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("product_variants").select("*").order("sort_order")
    ]);
    if (productResult.error || variantResult.error) return setNotice("庫存載入失敗，請確認 F003-4 migration 與管理員權限。");
    const variants = (variantResult.data || []) as ProductVariant[];
    setProducts(((productResult.data || []) as Product[]).map((product) => ({ ...product, variants: variants.filter((variant) => variant.product_id === product.id) })));
  }, [supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) load(); }); }, [load, supabase]);

  function changeVariant(productId: string, variantId: string, patch: Partial<ProductVariant>) {
    setProducts((current) => current.map((product) => product.id === productId ? { ...product, variants: product.variants.map((variant) => variant.id === variantId ? { ...variant, ...patch } : variant) } : product));
  }

  async function saveVariant(product: InventoryProduct, variant: ProductVariant) {
    const validation = validateInventoryValues(variant.name, variant.price, variant.inventory);
    if (validation) return setNotice(validation);
    setBusyKey(variant.id); setNotice("");
    const { error } = await supabase.from("product_variants").update({ name: variant.name.trim(), price: variant.price, inventory: variant.inventory, active: variant.active }).eq("id", variant.id);
    setBusyKey("");
    if (error) setNotice("規格更新失敗，請確認管理員權限與輸入內容。");
    else { setNotice(`${product.name}｜${variant.name} 已更新。`); await load(); }
  }

  async function markSoldOut(product: InventoryProduct, variant: ProductVariant) {
    changeVariant(product.id, variant.id, { inventory: 0 });
    setBusyKey(variant.id);
    const { error } = await supabase.from("product_variants").update({ inventory: 0 }).eq("id", variant.id);
    setBusyKey("");
    if (error) { setNotice("標記售完失敗。"); await load(); }
    else setNotice(`${product.name}｜${variant.name} 已標記售完。`);
  }

  async function toggleProduct(product: InventoryProduct) {
    const hiding = product.status !== "hidden";
    if (hiding && !window.confirm(`確定下架「${product.name}」？商品將不再出現在前台。`)) return;
    setBusyKey(product.id);
    const { error } = await supabase.from("products").update({ status: hiding ? "hidden" : "available" }).eq("id", product.id);
    setBusyKey("");
    if (error) setNotice("商品狀態更新失敗。"); else { setNotice(hiding ? "商品已下架。" : "商品已上架。"); await load(); }
  }

  async function createProduct(event: React.FormEvent) {
    event.preventDefault();
    if (!newProduct.productName.trim()) return setNotice("商品名稱不可空白。");
    const validation = validateInventoryValues(newProduct.variantName, newProduct.price, newProduct.inventory);
    if (validation) return setNotice(validation);
    setBusyKey("create"); setNotice("");
    const { error } = await supabase.rpc("admin_create_inventory_product", {
      p_product_name: newProduct.productName.trim(), p_processing_enabled: newProduct.processingEnabled,
      p_product_status: "available", p_variant_name: newProduct.variantName.trim(),
      p_price: newProduct.price, p_inventory: newProduct.inventory, p_variant_active: newProduct.active
    });
    setBusyKey("");
    if (error) setNotice("商品建立失敗，請確認欄位與管理員權限。");
    else { setNotice("今日魚貨已建立。"); setNewProduct(newProductInitial); setShowCreate(false); await load(); }
  }

  const visibleProducts = products.filter((product) => matchesInventoryProduct(product, search, filter));
  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  return <main className="admin adminOrdersPage inventoryAdminPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>🐟 今日魚貨／剩餘尾數</h1><p>以重量區間管理固定售價、剩餘尾數與販售狀態。</p></div><button type="button" onClick={() => setShowCreate((value) => !value)}>{showCreate ? "關閉新增" : "＋ 新增今日魚貨"}</button></header>
    {showCreate && <form className="panel inventoryCreate" onSubmit={createProduct}><h2>新增今日魚貨</h2><p className="inventoryGuidance">每個重量區間建立一個規格；重量皆為魚貨處理前重量。</p><div><label>商品名稱 *<input value={newProduct.productName} onChange={(event) => setNewProduct({ ...newProduct, productName: event.target.value })} /></label><label>第一個重量區間 *<input placeholder="例如：150g～200g" value={newProduct.variantName} onChange={(event) => setNewProduct({ ...newProduct, variantName: event.target.value })} /></label><label>固定售價 *<input type="number" min={0} step={1} value={newProduct.price} onChange={(event) => setNewProduct({ ...newProduct, price: Number(event.target.value) })} /></label><label>剩餘尾數 *<input type="number" min={0} step={1} value={newProduct.inventory} onChange={(event) => setNewProduct({ ...newProduct, inventory: Number(event.target.value) })} /></label></div><label className="check"><input type="checkbox" checked={newProduct.processingEnabled} onChange={(event) => setNewProduct({ ...newProduct, processingEnabled: event.target.checked })} />啟用魚貨處理</label><button disabled={busyKey === "create"}>{busyKey === "create" ? "建立中…" : "建立商品與規格"}</button></form>}
    <section className="panel inventoryTools"><label>搜尋<input type="search" placeholder="商品或規格名稱" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div role="group" aria-label="商品篩選">{([['all','全部'],['selling','販售中'],['sold_out','售完'],['hidden','已下架']] as const).map(([value,label]) => <button type="button" className={filter === value ? "isSelected" : ""} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div></section>
    {notice && <p className="notice centeredNotice" aria-live="polite">{notice}</p>}
    <section className="inventoryProductList">{visibleProducts.map((product) => <article className="panel inventoryProductCard" key={product.id}><header><div><h2>{product.name}</h2><span className={`inventoryState state-${inventoryProductState(product)}`}>{inventoryProductState(product) === "selling" ? "販售中" : inventoryProductState(product) === "sold_out" ? "售完" : "已下架"}</span><small>{product.processing_enabled ? "🐟 已啟用處理" : "不提供處理"}</small></div><div><Link className="buttonLink secondaryAdminAction" href={`/admin/inventory/${product.id}`}>編輯商品</Link><Link className="buttonLink secondaryAdminAction" href={`/admin/processing?productId=${product.id}`}>處理設定</Link><button type="button" disabled={busyKey === product.id} onClick={() => toggleProduct(product)}>{product.status === "hidden" ? "重新上架" : "下架商品"}</button></div></header><div className="inventoryVariants">{product.variants.map((variant) => <div className="inventoryVariantRow" key={variant.id}><label>重量區間（處理前）<input placeholder="例如：150g～200g" value={variant.name} onChange={(event) => changeVariant(product.id, variant.id, { name: event.target.value })} /></label><label>固定售價<input type="number" min={0} step={1} value={variant.price} onChange={(event) => changeVariant(product.id, variant.id, { price: Number(event.target.value) })} /></label><label>剩餘尾數<input type="number" min={0} step={1} value={variant.inventory} onChange={(event) => changeVariant(product.id, variant.id, { inventory: Number(event.target.value) })} /></label><label className="inventoryActive"><input type="checkbox" checked={variant.active} onChange={(event) => changeVariant(product.id, variant.id, { active: event.target.checked })} />{variant.active ? "規格上架" : "規格下架"}</label><div><button type="button" disabled={busyKey === variant.id} onClick={() => saveVariant(product, variant)}>{busyKey === variant.id ? "儲存中…" : "儲存"}</button><button type="button" className="secondaryAdminAction" disabled={busyKey === variant.id || variant.inventory === 0} onClick={() => markSoldOut(product, variant)}>標記售完</button></div></div>)}</div></article>)}</section>
  </main>;
}

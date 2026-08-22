"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Product, ProductVariant } from "@/lib/catalog";
import { InventoryFilter, InventoryMovement, InventoryProduct, inventoryMovementLabel, inventoryProductState, matchesInventoryProduct, validateInventoryValues } from "@/lib/inventory";
import { FishRequest } from "@/lib/fish-requests";
import { buildFishMatches } from "@/lib/fish-matching";

const newProductInitial = { productName: "", processingEnabled: false, variantName: "", price: 0, inventory: 0, active: true };

export default function AdminInventoryPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [requests, setRequests] = useState<FishRequest[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InventoryFilter>("all");
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [dirtyProducts, setDirtyProducts] = useState<Record<string, boolean>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [newProduct, setNewProduct] = useState(newProductInitial);

  const load = useCallback(async () => {
    const [productResult, variantResult, requestResult, movementResult] = await Promise.all([
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("product_variants").select("*").order("sort_order"),
      supabase.from("fish_requests").select("*").order("created_at", { ascending: false }),
      supabase.from("inventory_movements").select("*").order("created_at", { ascending: false }).limit(30)
    ]);
    if (productResult.error || variantResult.error || requestResult.error) return setNotice("庫存與配對資料載入失敗，請確認管理員權限。");
    const variants = (variantResult.data || []) as ProductVariant[];
    setProducts(((productResult.data || []) as Product[]).map((product) => ({ ...product, variants: variants.filter((variant) => variant.product_id === product.id) })));
    setRequests((requestResult.data || []) as FishRequest[]);
    setMovements((movementResult.data || []) as InventoryMovement[]);
  }, [supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) load(); }); }, [load, supabase]);

  function changeVariant(productId: string, variantId: string, patch: Partial<ProductVariant>, markDirty = true) {
    setProducts((current) => current.map((product) => product.id === productId ? { ...product, variants: product.variants.map((variant) => variant.id === variantId ? { ...variant, ...patch } : variant) } : product));
    if (markDirty) setDirtyProducts((current) => ({ ...current, [productId]: true }));
  }

  async function saveAllVariants(product: InventoryProduct) {
    for (const [index, variant] of product.variants.entries()) {
      const validation = validateInventoryValues(variant.name, variant.price, variant.inventory);
      if (validation) return setNotice(`第 ${index + 1} 個規格：${validation}`);
    }
    setBusyKey(`batch:${product.id}`); setNotice("");
    const { error } = await supabase.rpc("admin_update_inventory_variants", {
      p_product_id: product.id,
      p_variants: product.variants.map((variant) => ({ id: variant.id, name: variant.name.trim(), price: variant.price, inventory: variant.inventory, active: variant.active }))
    });
    setBusyKey("");
    if (error) setNotice("整批儲存失敗，未更新任何規格。請確認管理員權限與欄位內容。");
    else {
      setDirtyProducts((current) => ({ ...current, [product.id]: false }));
      setNotice(`${product.name}｜全部規格已儲存。`);
    }
  }

  async function markSoldOut(product: InventoryProduct, variant: ProductVariant) {
    const previousInventory = variant.inventory;
    changeVariant(product.id, variant.id, { inventory: 0 }, false);
    setBusyKey(variant.id);
    const { error } = await supabase.rpc("admin_adjust_inventory_variant", { p_variant_id: variant.id, p_inventory: 0 });
    setBusyKey("");
    if (error) { changeVariant(product.id, variant.id, { inventory: previousInventory }, false); setNotice("標記售完失敗，剩餘尾數未變更。"); }
    else { setNotice(`${product.name}｜${variant.name} 已標記售完。`); await load(); }
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
  const matches = buildFishMatches(products, products.flatMap((product) => product.variants), requests);
  const productNameById = new Map(products.map((product) => [product.id, product.name]));
  const variantNameById = new Map(products.flatMap((product) => product.variants.map((variant) => [variant.id, variant.name])));
  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  return <main className="admin adminOrdersPage inventoryAdminPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>🐟 今日魚貨／剩餘尾數</h1><p>以重量區間管理固定售價、剩餘尾數與販售狀態。</p></div><button type="button" onClick={() => setShowCreate((value) => !value)}>{showCreate ? "關閉新增" : "＋ 新增今日魚貨"}</button></header>
    {showCreate && <form className="panel inventoryCreate" onSubmit={createProduct}><h2>新增今日魚貨</h2><p className="inventoryGuidance">每個重量區間建立一個規格；重量皆為魚貨處理前重量。</p><div><label>商品名稱 *<input value={newProduct.productName} onChange={(event) => setNewProduct({ ...newProduct, productName: event.target.value })} /></label><label>第一個重量區間 *<input placeholder="例如：150g～200g" value={newProduct.variantName} onChange={(event) => setNewProduct({ ...newProduct, variantName: event.target.value })} /></label><label>固定售價 *<input type="number" min={0} step={1} value={newProduct.price} onChange={(event) => setNewProduct({ ...newProduct, price: Number(event.target.value) })} /></label><label>剩餘尾數 *<input type="number" min={0} step={1} value={newProduct.inventory} onChange={(event) => setNewProduct({ ...newProduct, inventory: Number(event.target.value) })} /></label></div><label className="check"><input type="checkbox" checked={newProduct.processingEnabled} onChange={(event) => setNewProduct({ ...newProduct, processingEnabled: event.target.checked })} />啟用魚貨處理</label><button disabled={busyKey === "create"}>{busyKey === "create" ? "建立中…" : "建立商品與規格"}</button></form>}
    <section className="panel inventoryTools"><label>搜尋<input type="search" placeholder="商品或規格名稱" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div role="group" aria-label="商品篩選">{([['all','全部'],['selling','販售中'],['sold_out','售完'],['hidden','已下架']] as const).map(([value,label]) => <button type="button" className={filter === value ? "isSelected" : ""} onClick={() => setFilter(value)} key={value}>{label}</button>)}</div></section>
    {notice && <p className="notice centeredNotice" aria-live="polite">{notice}</p>}
    <section className="inventoryProductList">{visibleProducts.map((product) => {
      const batchBusy = busyKey === `batch:${product.id}`;
      const dirty = Boolean(dirtyProducts[product.id]);
      const match = matches.find((item) => item.product.id === product.id);
      return <article className="panel inventoryProductCard" key={product.id}><header><div><h2>{product.name}</h2><span className={`inventoryState state-${inventoryProductState(product)}`}>{inventoryProductState(product) === "selling" ? "販售中" : inventoryProductState(product) === "sold_out" ? "售完" : "已下架"}</span>{match && <Link className="inventoryMatchIndicator" href={`/admin/matches?product=${product.id}`}>🔔 {match.requests.length} 人正在等</Link>}<small>{product.processing_enabled ? "🐟 已啟用處理" : "不提供處理"}</small></div><div><Link className="buttonLink secondaryAdminAction" href={`/admin/inventory/${product.id}`}>編輯商品</Link><Link className="buttonLink secondaryAdminAction" href={`/admin/processing?productId=${product.id}`}>處理設定</Link><button type="button" disabled={busyKey === product.id} onClick={() => toggleProduct(product)}>{product.status === "hidden" ? "重新上架" : "下架商品"}</button></div></header><fieldset className="inventoryVariants inventoryVariantsFieldset" disabled={batchBusy}>{product.variants.map((variant) => <div className="inventoryVariantRow" key={variant.id}><label>重量區間（處理前）<input placeholder="例如：150g～200g" value={variant.name} onChange={(event) => changeVariant(product.id, variant.id, { name: event.target.value })} /></label><label>固定售價<input type="number" min={0} step={1} value={variant.price} onChange={(event) => changeVariant(product.id, variant.id, { price: Number(event.target.value) })} /></label><label>剩餘尾數<input type="number" min={0} step={1} value={variant.inventory} onChange={(event) => changeVariant(product.id, variant.id, { inventory: Number(event.target.value) })} /></label><label className="inventoryActive"><input type="checkbox" checked={variant.active} onChange={(event) => changeVariant(product.id, variant.id, { active: event.target.checked })} />{variant.active ? "規格上架" : "規格下架"}</label><div><button type="button" className="secondaryAdminAction" disabled={busyKey === variant.id || variant.inventory === 0 || batchBusy} onClick={() => markSoldOut(product, variant)}>標記售完</button></div></div>)}</fieldset><footer className="inventoryBatchActions"><span aria-live="polite">{dirty ? "有尚未儲存的規格變更" : "全部規格已儲存"}</span><button type="button" disabled={!dirty || batchBusy} onClick={() => saveAllVariants(product)}>{batchBusy ? "儲存中…" : dirty ? "儲存全部規格" : "已儲存"}</button></footer></article>;
    })}</section>
    <section className="panel inventoryMovementLedger"><header><div><h2>庫存異動紀錄</h2><p>僅顯示 F003-12 上線後的異動；歷史庫存不會補寫。</p></div></header>{movements.length === 0 ? <p>目前沒有庫存異動紀錄。</p> : <div className="inventoryMovementList">{movements.map((movement) => <article key={movement.id}><time>{new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "short" }).format(new Date(movement.created_at))}</time><strong>{productNameById.get(movement.product_id) || "商品資料不可用"}</strong><span>{variantNameById.get(movement.variant_id) || "規格資料不可用"}</span><span>{inventoryMovementLabel(movement.movement_type)}</span><b>{movement.quantity_before} → {movement.inventory_delta > 0 ? "+" : ""}{movement.inventory_delta} → {movement.quantity_after}</b>{movement.order_id && <Link href={`/admin/orders/${movement.order_id}`}>Order #{movement.order_id.slice(0, 8)}</Link>}</article>)}</div>}</section>
  </main>;
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Product } from "@/lib/catalog";

type Order = { id: string; customer_name: string; phone: string; fulfillment: string; processing: string; note: string | null; status: string; created_at: string };
const blank = { name: "", description: "", cooking: "", status: "available" as Product["status"], featured: false, sort_order: 100 };
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SOURCE_SIZE = 20 * 1024 * 1024;

function storagePath(url: string | null) {
  const marker = "/storage/v1/object/public/product-images/";
  const index = url?.indexOf(marker) ?? -1;
  return index < 0 || !url ? null : decodeURIComponent(url.slice(index + marker.length));
}

async function compressToWebP(file: File) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("圖片讀取失敗，請改用 JPG、PNG 或 WebP。"));
      element.src = objectUrl;
    });
    const scale = Math.min(1, 1800 / image.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("瀏覽器無法處理圖片。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
    if (!blob) throw new Error("圖片壓縮失敗。");
    return blob;
  } finally { URL.revokeObjectURL(objectUrl); }
}

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [existingImageUrl, setExistingImageUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const loadAll = useCallback(async () => {
    const [productResult, orderResult] = await Promise.all([
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("orders").select("*").order("created_at", { ascending: false })
    ]);
    if (productResult.error) setNotice(`商品載入失敗：${productResult.error.message}`);
    else setProducts((productResult.data || []) as Product[]);
    if (orderResult.error) setNotice(`訂單載入失敗：${orderResult.error.message}`);
    else setOrders((orderResult.data || []) as Order[]);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || "");
      if (data.session) loadAll();
    });
  }, [loadAll, supabase]);

  useEffect(() => () => { if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setNotice(`登入失敗：${error.message}`);
    else { setUser(data.user.email || ""); await loadAll(); }
  }

  function resetForm() {
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setForm(blank); setEditingId(null); setExistingImageUrl(null); setFile(null); setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function selectFile(selected: File | null) {
    if (!selected) return;
    const extension = selected.name.split(".").pop()?.toLowerCase();
    if (extension === "heic" || extension === "heif") return setNotice("尚不支援 HEIC/HEIF，請先轉成 JPG、PNG 或 WebP。 ");
    if (!ALLOWED_TYPES.includes(selected.type)) return setNotice("只支援 JPG、PNG 或 WebP 圖片。");
    if (selected.size > MAX_SOURCE_SIZE) return setNotice("原始圖片不可超過 20 MB。");
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setFile(selected); setPreviewUrl(URL.createObjectURL(selected)); setNotice(`已選擇 ${selected.name}`);
  }

  async function uploadImage(selected: File) {
    const compressed = await compressToWebP(selected);
    const path = `products/${crypto.randomUUID()}.webp`;
    const { error } = await supabase.storage.from("product-images").upload(path, compressed, { contentType: "image/webp", cacheControl: "3600" });
    if (error) throw new Error(`圖片上傳失敗：${error.message}`);
    return supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return setNotice("請輸入商品名稱。");
    setBusy(true); setNotice("");
    try {
      let imageUrl = existingImageUrl;
      const oldPath = file ? storagePath(existingImageUrl) : null;
      if (file) imageUrl = await uploadImage(file);
      const payload = { ...form, name: form.name.trim(), description: form.description.trim() || null, cooking: form.cooking.trim() || null, image_url: imageUrl };
      const result = editingId ? await supabase.from("products").update(payload).eq("id", editingId) : await supabase.from("products").insert(payload);
      if (result.error) throw new Error(`商品儲存失敗：${result.error.message}`);
      if (oldPath) await supabase.storage.from("product-images").remove([oldPath]);
      setNotice(editingId ? "商品已更新。" : "商品已新增。"); resetForm(); await loadAll();
    } catch (error) { setNotice(error instanceof Error ? error.message : "商品儲存失敗。"); }
    finally { setBusy(false); }
  }

  function editProduct(product: Product) {
    resetForm(); setEditingId(product.id); setExistingImageUrl(product.image_url); setPreviewUrl(product.image_url);
    setForm({ name: product.name, description: product.description || "", cooking: product.cooking || "", status: product.status, featured: product.featured, sort_order: product.sort_order });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggle(product: Product) {
    const status = product.status === "available" ? "sold_out" : "available";
    const { error } = await supabase.from("products").update({ status }).eq("id", product.id);
    if (error) setNotice(`狀態更新失敗：${error.message}`); else await loadAll();
  }

  async function remove(product: Product) {
    if (!confirm(`確定刪除「${product.name}」？`)) return;
    const { error } = await supabase.from("products").delete().eq("id", product.id);
    if (error) return setNotice(`刪除失敗：${error.message}`);
    const path = storagePath(product.image_url); if (path) await supabase.storage.from("product-images").remove([path]);
    await loadAll();
  }

  async function setOrderStatus(id: string, status: string) {
    const { error } = await supabase.from("orders").update({ status }).eq("id", id);
    if (error) setNotice(`訂單更新失敗：${error.message}`); else await loadAll();
  }

  if (!user) return <main className="admin"><form className="login" onSubmit={login}><h1>後台登入</h1><label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>密碼<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label><button>登入</button>{notice && <p className="notice">{notice}</p>}</form></main>;

  return (
    <main className="admin">
      <header className="adminTop"><div><Link href="/">← 返回商店</Link><h1>海鮮商品後台</h1><p>{user}</p></div><button onClick={() => supabase.auth.signOut().then(() => setUser(""))}>登出</button></header>
      <section className="adminGrid">
        <form className="panel" onSubmit={save}>
          <h2>{editingId ? "編輯商品" : "新增商品"}</h2>
          <label>商品名稱<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>商品描述<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>料理建議<input value={form.cooking} onChange={(e) => setForm({ ...form, cooking: e.target.value })} /></label>
          <div className={`uploadDropzone ${dragging ? "isDragging" : ""}`} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); selectFile(e.dataTransfer.files?.[0] || null); }} onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click(); }}>
            {previewUrl ? <img className="uploadPreview" src={previewUrl} alt="商品預覽" /> : <div><strong>拖曳圖片或點擊選擇</strong><p>JPG、PNG、WebP</p></div>}
          </div>
          <input ref={fileInputRef} className="hiddenFileInput" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(e) => selectFile(e.target.files?.[0] || null)} />
          {file && <div className="selectedFileRow"><span>{file.name}</span><button type="button" onClick={() => { setFile(null); setPreviewUrl(existingImageUrl); }}>移除選取</button></div>}
          <small className="uploadHelp">上傳時會縮放至 1800px 並轉為 WebP。</small>
          <label>狀態<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Product["status"] })}><option value="available">可購買</option><option value="sold_out">已售完</option><option value="hidden">隱藏</option></select></label>
          <label>排序<input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} /></label>
          <label className="check"><input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />精選商品</label>
          <button disabled={busy}>{busy ? "儲存中…" : "儲存商品"}</button>
          {editingId && <button className="cancelEditButton" type="button" onClick={resetForm}>取消編輯</button>}
          {notice && <p className="notice">{notice}</p>}
        </form>
        <section className="panel"><h2>商品管理</h2>{products.map((product) => <div className="manageRow" key={product.id}><div className="manageProduct"><div className="manageThumb">{product.image_url ? <img src={product.image_url} alt={product.name} /> : <span>🦀</span>}</div><div><strong>{product.name}</strong><small>{product.status === "available" ? "可購買" : product.status === "sold_out" ? "已售完" : "已隱藏"}</small></div></div><div className="manageActions"><Link className="buttonLink" href={`/admin/variants?productId=${product.id}`}>⚖️ 管理規格</Link><button type="button" onClick={() => editProduct(product)}>編輯</button><button type="button" onClick={() => toggle(product)}>{product.status === "available" ? "下架" : "上架"}</button><button type="button" onClick={() => remove(product)}>刪除</button></div></div>)}</section>
      </section>
      <section className="panel orders"><h2>訂單管理</h2>{orders.map((order) => <article className="orderCard" key={order.id}><div><strong>{order.customer_name}</strong><p>{order.phone}</p></div><div><p>{order.fulfillment}</p><p>{order.processing}</p></div><div><p>{order.note || "沒有備註"}</p></div><select value={order.status} onChange={(e) => setOrderStatus(order.id, e.target.value)}><option value="new">新訂單</option><option value="contacted">已聯絡</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></article>)}</section>
    </main>
  );
}

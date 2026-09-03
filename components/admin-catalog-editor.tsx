"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import type { Product, ProductCategoryRecord, ProductFaq, ProductImage } from "@/lib/catalog";
import type { FishCatalogItem } from "@/lib/fish-catalog";
import { imageSource, stableOrder } from "@/lib/catalog-content";

async function compressImage(file: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error("請選擇 20MB 以下 JPG、PNG 或 WebP。");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("圖片讀取失敗")); img.src = url; });
    const ratio = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d"); if (!context) throw new Error("無法處理圖片");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("圖片壓縮失敗")), "image/webp", .82));
  } finally { URL.revokeObjectURL(url); }
}
function move<T>(items: T[], index: number, delta: number): T[] {
  const next = [...items]; const target = index + delta;
  if (target < 0 || target >= items.length) return items;
  [next[index], next[target]] = [next[target], next[index]]; return next;
}
export default function AdminCatalogEditor({ id, onSaved }: { id: string; onSaved: () => void }) {
  const db = useMemo(() => createClient(), []);
  const [product, setProduct] = useState<Product | null>(null);
  const [images, setImages] = useState<ProductImage[]>([]);
  const [faqs, setFaqs] = useState<ProductFaq[]>([]);
  const [categories, setCategories] = useState<ProductCategoryRecord[]>([]);
  const [fish, setFish] = useState<FishCatalogItem[]>([]);
  const [otherProducts, setOtherProducts] = useState<Product[]>([]);
  const [originalFish, setOriginalFish] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const auth = await db.rpc("is_hanjiu_admin");
      if (auth.error || auth.data !== true) throw new Error("需要管理員權限。");
      const results = await Promise.all([db.from("products").select("*").eq("id", id).single(), db.from("product_images").select("*").eq("product_id", id), db.from("product_faqs").select("*").eq("product_id", id), db.from("product_categories").select("*").order("sort_order"), db.from("fish_catalog").select("*").order("sort_order"), db.from("products").select("id,name,fish_catalog_id").neq("id", id)]);
      if (results.some((result) => result.error)) throw new Error("Catalog 載入失敗，請確認 Phase 1 migration 與權限。");
      setProduct(results[0].data as Product); setOriginalFish(results[0].data.fish_catalog_id || null);
      setImages(stableOrder(results[1].data as ProductImage[])); setFaqs(stableOrder(results[2].data as ProductFaq[]));
      setCategories(results[3].data as ProductCategoryRecord[]); setFish(results[4].data as FishCatalogItem[]); setOtherProducts(results[5].data as Product[]);
    } catch (error) { setNotice(error instanceof Error ? error.message : "載入失敗"); }
    finally { setBusy(false); }
  }, [db, id]);
  useEffect(() => { load(); }, [load]);
  const duplicates = otherProducts.filter((other) => product?.fish_catalog_id && other.fish_catalog_id === product.fish_catalog_id);
  const blockedAssociation = duplicates.length > 0 && product?.fish_catalog_id !== originalFish;
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    if (images.length + files.length > 30) return setNotice("每商品最多 30 張圖片。");
    setBusy(true); setNotice("");
    const uploaded: ProductImage[] = [];
    try {
      for (const file of Array.from(files)) {
        const blob = await compressImage(file); const imageId = crypto.randomUUID(); const path = `products/${id}/${imageId}.webp`;
        const result = await db.storage.from("product-images").upload(path, blob, { contentType: "image/webp", upsert: false });
        if (result.error) throw result.error;
        uploaded.push({ id: imageId, product_id: id, storage_bucket: "product-images", storage_path: path, legacy_url: null, public_url: db.storage.from("product-images").getPublicUrl(path).data.publicUrl, alt_text: product?.name || "", sort_order: images.length + uploaded.length, is_primary: images.length === 0 && uploaded.length === 0 });
      }
      setNotice("圖片已上傳；請儲存商品以套用 gallery。未儲存物件由後續獨立清理處理。");
    } catch { setNotice("部分圖片未能上傳；已成功的圖片保留於編輯區，請檢查後儲存或重試。"); }
    finally { setImages((current) => [...current, ...uploaded]); setBusy(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!product || blockedAssociation) return;
    setBusy(true); setNotice("");
    try {
      const result = await db.rpc("admin_save_product_catalog", { p_product_id: id, p_expected_updated_at: product.updated_at, p_content: product, p_images: images, p_faqs: faqs });
      if (result.error) throw result.error;
      const saved = (Array.isArray(result.data) ? result.data[0] : result.data) as Product | null;
      if (!saved?.id || !saved.updated_at) throw new Error("儲存回應不完整，請重新載入確認資料。");
      setProduct(saved); setOriginalFish(saved.fish_catalog_id || null); setNotice("商品、圖片與 FAQ 已儲存。"); onSaved();
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
      setNotice(message.includes("catalog_edit_conflict") ? "商品已被其他操作更新。請先複製未儲存內容，再重新載入。" : message.includes("fish_catalog_already_used") ? "此魚種已有商品，請使用既有商品。" : `無法確認儲存結果，請重新載入確認後再試。${message}`);
    } finally { setBusy(false); }
  }
  if (!product) return <section className="panel"><p>{notice || "載入商品內容…"}</p><button type="button" onClick={load} disabled={busy}>重新載入</button></section>;
  return <form className="panel catalogEditor" onSubmit={save}><h2>商品 Catalog</h2><fieldset disabled={busy}>
    <label>商品名稱 *<input required maxLength={120} value={product.name} onChange={(e) => setProduct({ ...product, name: e.target.value })} /></label>
    <label>商品類別 *<select required value={product.category_id || ""} onChange={(e) => setProduct({ ...product, category_id: e.target.value })}>{categories.filter((category) => category.active || category.id === product.category_id).map((category) => <option key={category.id} value={category.id}>{category.name}{!category.active ? "（已停用，可保留既有指派）" : ""}</option>)}</select></label>
    <label>魚種<select value={product.fish_catalog_id || ""} onChange={(e) => setProduct({ ...product, fish_catalog_id: e.target.value || null })}><option value="">未指定</option>{fish.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.active ? "（停用）" : ""}</option>)}</select></label>
    {duplicates.length > 0 && <p role="alert">此魚種另有商品：{duplicates.map((item) => item.name).join("、")}。{blockedAssociation ? "不可新增重複關聯，請改用既有商品。" : "既有重複資料仍可編輯；不會自動合併或搬動規格。"}</p>}
    {([['description','商品介紹'],['texture_description','肉質／口感'],['cooking','推薦料理'],['storage_instructions','保存方式']] as const).map(([key,label]) => <label key={key}>{label}<textarea value={product[key] || ""} onChange={(e) => setProduct({ ...product, [key]: e.target.value })} /></label>)}
    <label>狀態<select value={product.status} onChange={(e) => setProduct({ ...product, status: e.target.value as Product['status'] })}><option value="available">公開／legacy 可購買</option><option value="sold_out">公開／legacy 暫停購買</option><option value="hidden">隱藏</option></select></label>
    <label>排序<input type="number" required step={1} value={product.sort_order} onChange={(e) => setProduct({ ...product, sort_order: Number(e.target.value) })} /></label>
    <label className="check"><input type="checkbox" checked={product.featured} onChange={(e) => setProduct({ ...product, featured: e.target.checked })} />精選商品</label>
    <h3>商品圖片</h3><p>移除只解除 gallery 關聯，不刪除 Storage 檔案。替換時先上傳新圖，再移除舊圖。</p>
    <input aria-label="上傳商品圖片" type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
    {images.map((image, index) => <div className="catalogAdminRow" key={image.id}><img src={imageSource(image, process.env.NEXT_PUBLIC_SUPABASE_URL || "")} alt={image.alt_text} /><label>圖片說明<input maxLength={500} value={image.alt_text} onChange={(e) => setImages(images.map((item) => item.id === image.id ? { ...item, alt_text: e.target.value } : item))} /></label><div className="catalogAdminActions">
      <button type="button" disabled={index === 0} onClick={() => setImages(move(images,index,-1))}>上移</button><button type="button" disabled={index === images.length - 1} onClick={() => setImages(move(images,index,1))}>下移</button>
      <button type="button" aria-pressed={image.is_primary} onClick={() => setImages(images.map((item) => ({ ...item, is_primary: item.id === image.id })))}>{image.is_primary ? "封面" : "設為封面"}</button>
      <button type="button" onClick={() => { const next = images.filter((item) => item.id !== image.id); if (image.is_primary && next.length) next[0] = { ...next[0], is_primary: true }; setImages(next); }}>移除圖片</button>
    </div></div>)}
    <h3>商品 FAQ（選填）</h3><p>只填此商品相關問答；配送、付款、預購制度等全站資訊不在這裡重複設定。</p>
    {faqs.map((faq,index) => <div className="catalogAdminRow" key={faq.id}><label>問題<input required maxLength={200} value={faq.question} onChange={(e) => setFaqs(faqs.map((item) => item.id === faq.id ? { ...item, question: e.target.value } : item))} /></label><label>回答<textarea required maxLength={5000} value={faq.answer} onChange={(e) => setFaqs(faqs.map((item) => item.id === faq.id ? { ...item, answer: e.target.value } : item))} /></label><label className="check"><input type="checkbox" checked={faq.active} onChange={(e) => setFaqs(faqs.map((item) => item.id === faq.id ? { ...item, active: e.target.checked } : item))} />顯示此問答</label><div className="catalogAdminActions"><button type="button" disabled={!index} onClick={() => setFaqs(move(faqs,index,-1))}>上移</button><button type="button" disabled={index === faqs.length - 1} onClick={() => setFaqs(move(faqs,index,1))}>下移</button><button type="button" onClick={() => setFaqs(faqs.filter((item) => item.id !== faq.id))}>移除 FAQ</button></div></div>)}
    <button type="button" disabled={faqs.length >= 50} onClick={() => setFaqs([...faqs, { id: crypto.randomUUID(), product_id: id, question: "", answer: "", active: true, sort_order: faqs.length }])}>新增 FAQ</button>
    <button disabled={blockedAssociation} type="submit">儲存商品、圖片與 FAQ</button>
    <button type="button" onClick={() => { if (window.confirm("重新載入會放棄未儲存的編輯，確定？")) load(); }}>重新載入</button>
  </fieldset><p role="status" aria-live="polite">{busy ? "處理中…" : notice}</p></form>;
}

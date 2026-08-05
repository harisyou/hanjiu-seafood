"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase-browser";

type Product = {
  id: string;
  name: string;
  description: string | null;
  cooking: string | null;
  image_url: string | null;
  status: "available" | "sold_out" | "hidden";
  featured: boolean;
  sort_order: number;
};

type Order = {
  id: string;
  customer_name: string;
  phone: string;
  fulfillment: string;
  processing: string;
  note: string | null;
  status: string;
  created_at: string;
};

const blank = {
  name: "",
  description: "",
  cooking: "",
  status: "available" as Product["status"],
  featured: false,
  sort_order: 100
};

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SOURCE_SIZE = 20 * 1024 * 1024;
const MAX_OUTPUT_WIDTH = 1800;
const WEBP_QUALITY = 0.82;

function getStoragePathFromPublicUrl(url: string | null) {
  if (!url) return null;
  const marker = "/storage/v1/object/public/product-images/";
  const index = url.indexOf(marker);
  if (index === -1) return null;
  return decodeURIComponent(url.slice(index + marker.length));
}

async function compressToWebP(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("圖片讀取失敗，請改用 JPG、PNG 或 WebP。"));
      img.src = objectUrl;
    });

    const scale = Math.min(1, MAX_OUTPUT_WIDTH / image.naturalWidth);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("瀏覽器無法處理圖片。");

    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", WEBP_QUALITY)
    );

    if (!blob) throw new Error("圖片壓縮失敗。");
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || "");
      if (data.session) loadAll();
    });
  }, [supabase]);

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setNotice("");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setNotice(`登入失敗：${error.message}`);
    else {
      setUser(data.user.email || "");
      loadAll();
    }
  }

  async function loadAll() {
    const p = await supabase.from("products").select("*").order("sort_order");
    const o = await supabase.from("orders").select("*").order("created_at", { ascending: false });

    if (p.error) setNotice(`魚貨讀取失敗：${p.error.message}`);
    else setProducts((p.data || []) as Product[]);

    if (o.error) setNotice(`訂單讀取失敗：${o.error.message}`);
    else setOrders((o.data || []) as Order[]);
  }

  function clearSelectedFile() {
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(existingImageUrl);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function validateAndSelectFile(selected: File | null) {
    if (!selected) return;

    const extension = selected.name.split(".").pop()?.toLowerCase();

    if (extension === "heic" || extension === "heif") {
      setNotice("目前瀏覽器無法直接處理 HEIC／HEIF，請先轉成 JPG、PNG 或 WebP。");
      return;
    }

    if (!ALLOWED_TYPES.includes(selected.type)) {
      setNotice("僅支援 JPG、PNG、WebP 圖片。");
      return;
    }

    if (selected.size > MAX_SOURCE_SIZE) {
      setNotice("原始圖片不可超過 20 MB。");
      return;
    }

    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);

    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
    setNotice(`已選擇 ${selected.name}，儲存時會自動壓縮並轉成 WebP。`);
  }

  async function uploadImage(selected: File) {
    const compressed = await compressToWebP(selected);
    const safePath = `products/${crypto.randomUUID()}.webp`;

    const { error } = await supabase.storage
      .from("product-images")
      .upload(safePath, compressed, {
        contentType: "image/webp",
        cacheControl: "3600",
        upsert: false
      });

    if (error) throw new Error(`圖片上傳失敗：${error.message}`);

    return supabase.storage
      .from("product-images")
      .getPublicUrl(safePath).data.publicUrl;
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    if (!form.name.trim()) {
      setNotice("請輸入魚名。");
      return;
    }

    setBusy(true);
    setNotice("");

    try {
      let imageUrl = existingImageUrl;
      let oldStoragePath: string | null = null;

      if (file) {
        imageUrl = await uploadImage(file);
        oldStoragePath = getStoragePathFromPublicUrl(existingImageUrl);
      }

      const payload = {
        ...form,
        name: form.name.trim(),
        description: form.description.trim() || null,
        cooking: form.cooking.trim() || null,
        image_url: imageUrl || null
      };

      const result = editingId
        ? await supabase.from("products").update(payload).eq("id", editingId)
        : await supabase.from("products").insert(payload);

      if (result.error) throw new Error(`商品儲存失敗：${result.error.message}`);

      if (file && oldStoragePath) {
        await supabase.storage.from("product-images").remove([oldStoragePath]);
      }

      setNotice(editingId ? "商品已更新。" : "商品已新增。");
      resetForm();
      await loadAll();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "儲存失敗，請稍後再試。");
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setForm(blank);
    setEditingId(null);
    setExistingImageUrl(null);
    setFile(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function editProduct(product: Product) {
    resetForm();
    setEditingId(product.id);
    setExistingImageUrl(product.image_url);
    setPreviewUrl(product.image_url);
    setForm({
      name: product.name,
      description: product.description || "",
      cooking: product.cooking || "",
      status: product.status,
      featured: product.featured,
      sort_order: product.sort_order
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggle(product: Product) {
    const next = product.status === "available" ? "sold_out" : "available";
    const { error } = await supabase
      .from("products")
      .update({ status: next })
      .eq("id", product.id);

    if (error) setNotice(`狀態更新失敗：${error.message}`);
    else {
      setNotice(`${product.name}已改為${next === "available" ? "今日現貨" : "已售完"}。`);
      loadAll();
    }
  }

  async function remove(product: Product) {
    if (!confirm(`確定刪除「${product.name}」嗎？`)) return;

    const { error } = await supabase.from("products").delete().eq("id", product.id);
    if (error) {
      setNotice(`刪除失敗：${error.message}`);
      return;
    }

    const storagePath = getStoragePathFromPublicUrl(product.image_url);
    if (storagePath) {
      await supabase.storage.from("product-images").remove([storagePath]);
    }

    setNotice(`${product.name}已刪除。`);
    loadAll();
  }

  async function setOrderStatus(id: string, status: string) {
    const { error } = await supabase.from("orders").update({ status }).eq("id", id);
    if (error) setNotice(`訂單更新失敗：${error.message}`);
    else loadAll();
  }

  if (!user) {
    return (
      <main className="admin">
        <form className="login" onSubmit={login}>
          <h1>店家管理登入</h1>
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            密碼
            <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button>登入</button>
          {notice && <p className="notice">{notice}</p>}
        </form>
      </main>
    );
  }

  return (
    <main className="admin">
      <header className="adminTop">
        <div>
          <a href="/">← 回前台</a>
          <h1>韓九店家管理</h1>
          <p>{user}</p>
        </div>
        <button onClick={() => supabase.auth.signOut().then(() => setUser(""))}>登出</button>
      </header>

      <section className="adminGrid">
        <form className="panel" onSubmit={save}>
          <h2>{editingId ? "編輯魚貨" : "新增魚貨"}</h2>

          <label>
            魚名
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>

          <label>
            介紹
            <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>

          <label>
            料理方式
            <input value={form.cooking} onChange={(e) => setForm({ ...form, cooking: e.target.value })} />
          </label>

          <div
            className={`uploadDropzone ${dragging ? "isDragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              validateAndSelectFile(e.dataTransfer.files?.[0] || null);
            }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
            }}
          >
            {previewUrl ? (
              <img className="uploadPreview" src={previewUrl} alt="圖片預覽" />
            ) : (
              <div>
                <strong>拖曳圖片到這裡</strong>
                <p>或點一下選擇 JPG、PNG、WebP</p>
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            className="hiddenFileInput"
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            onChange={(e) => validateAndSelectFile(e.target.files?.[0] || null)}
          />

          {file && (
            <div className="selectedFileRow">
              <span>{file.name}</span>
              <button type="button" onClick={clearSelectedFile}>取消新照片</button>
            </div>
          )}

          <small className="uploadHelp">
            上傳時會自動縮小至最寬 1800px，並轉成 WebP。HEIC／HEIF 請先轉成 JPG。
          </small>

          <label>
            狀態
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Product["status"] })}>
              <option value="available">今日現貨</option>
              <option value="sold_out">已售完</option>
              <option value="hidden">隱藏</option>
            </select>
          </label>

          <label>
            排序
            <input type="number" value={form.sort_order} onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) })} />
          </label>

          <label className="check">
            <input type="checkbox" checked={form.featured} onChange={(e) => setForm({ ...form, featured: e.target.checked })} />
            老闆推薦
          </label>

          <button disabled={busy}>{busy ? "儲存中…" : "儲存"}</button>

          {editingId && (
            <button className="cancelEditButton" type="button" onClick={resetForm}>
              取消編輯
            </button>
          )}

          {notice && <p className="notice">{notice}</p>}
        </form>

        <section className="panel">
          <h2>魚貨管理</h2>
          {products.map((product) => (
            <div className="manageRow" key={product.id}>
              <div className="manageProduct">
                <div className="manageThumb">
                  {product.image_url ? (
                    <img
                      src={product.image_url}
                      alt={product.name}
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <span>🐟</span>
                  )}
                </div>
                <div>
                  <strong>{product.name}</strong>
                  <small>{product.status === "available" ? "今日現貨" : product.status === "sold_out" ? "已售完" : "已隱藏"}</small>
                </div>
              </div>

              <div className="manageActions">
                <button type="button" onClick={() => editProduct(product)}>編輯</button>
                <button type="button" onClick={() => toggle(product)}>
                  {product.status === "available" ? "售完" : "上架"}
                </button>
                <button type="button" onClick={() => remove(product)}>刪除</button>
              </div>
            </div>
          ))}
        </section>
      </section>

      <section className="panel orders">
        <h2>訂單管理</h2>
        {orders.map((order) => (
          <article className="orderCard" key={order.id}>
            <div><strong>{order.customer_name}</strong><p>{order.phone}</p></div>
            <div><p>{order.fulfillment}</p><p>{order.processing}</p></div>
            <div><p>{order.note || "無備註"}</p></div>
            <select value={order.status} onChange={(e) => setOrderStatus(order.id, e.target.value)}>
              <option value="new">新訂單</option>
              <option value="contacted">已聯絡</option>
              <option value="completed">已完成</option>
              <option value="cancelled">已取消</option>
            </select>
          </article>
        ))}
      </section>
    </main>
  );
}

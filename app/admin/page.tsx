"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { primaryImage } from "@/lib/catalog-content";
import type { ProductImage } from "@/lib/catalog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Product, ProductCategoryRecord, ProductVariant } from "@/lib/catalog";
import { FishRequest } from "@/lib/fish-requests";
import { FishCatalogItem } from "@/lib/fish-catalog";
import { buildFishMatchGroups } from "@/lib/fish-matching";

type Order = { id: string; customer_name: string; phone: string; fulfillment: string | null; processing: string | null; note: string | null; status: string; created_at: string };
type OrderItem = { id: string; order_id: string; product_name: string; variant_name: string | null; quantity: number; supply_type?: "in_stock" | "preorder"; processing_preset_name: string | null; processing_option_names: string[]; processing_note: string | null };
const blank = { name: "", description: "", cooking: "", category_id: "", status: "available" as Product["status"], featured: false, sort_order: 100 };
function productSaveErrorMessage(message: string) {
  if (message.includes("product_category_required")) return "請選擇商品類別。";
  if (message.includes("product_category_not_found")) return "商品類別不存在，請重新選擇。";
  if (message.includes("product_category_inactive")) return "此商品類別已停用，請選擇啟用中的類別。";
  if (message.includes("product_not_found")) return "找不到此商品，請重新整理後再試。";
  if (message.includes("admin_required")) return "沒有管理員權限。";
  return `商品儲存失敗：${message}`;
}

export default function AdminPage() {
  const router = useRouter();
  const [fishCatalog, setFishCatalog] = useState<FishCatalogItem[]>([]);
  const [fishId, setFishId] = useState("");
  const [galleryImages, setGalleryImages] = useState<ProductImage[]>([]);
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productCategories, setProductCategories] = useState<ProductCategoryRecord[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [form, setForm] = useState(blank);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingMatchCount, setPendingMatchCount] = useState(0);
  const selectedFormCategory = productCategories.find((category) => category.id === form.category_id) || null;
  const activeProductCategories = productCategories.filter((category) => category.active);

  const loadAll = useCallback(async () => {
    const [productResult, orderResult, orderItemResult, variantResult, requestResult, catalogResult, categoryResult, imageResult] = await Promise.all([
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("orders").select("*").order("created_at", { ascending: false }),
      supabase.from("order_items").select("*"),
      supabase.from("product_variants").select("*").order("sort_order"),
      supabase.from("fish_requests").select("*").order("created_at", { ascending: false }),
      supabase.from("fish_catalog").select("*").order("sort_order"),
      supabase.from("product_categories").select("*").order("sort_order").order("name"),
      supabase.from("product_images").select("*")
    ]);
    setFishCatalog((catalogResult.data || []) as FishCatalogItem[]);
    if (!imageResult.error) setGalleryImages((imageResult.data || []) as ProductImage[]);
    if (productResult.error) setNotice(`商品載入失敗：${productResult.error.message}`);
    else setProducts((productResult.data || []) as Product[]);
    if (categoryResult.error) setNotice(`商品類別載入失敗：${categoryResult.error.message}`);
    else setProductCategories((categoryResult.data || []) as ProductCategoryRecord[]);
    if (orderResult.error) setNotice(`訂單載入失敗：${orderResult.error.message}`);
    else setOrders(((orderResult.data || []) as Order[]).filter((order) => order.status !== "draft"));
    if (!orderItemResult.error) setOrderItems((orderItemResult.data || []) as OrderItem[]);
    if (!productResult.error && !variantResult.error && !requestResult.error && !catalogResult.error) {
      const groups = buildFishMatchGroups((productResult.data || []) as Product[], (variantResult.data || []) as ProductVariant[], (requestResult.data || []) as FishRequest[], (catalogResult.data || []) as FishCatalogItem[]);
      setPendingMatchCount(new Set(groups.flatMap((group) => group.requests.map((request) => request.id))).size);
    }
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || "");
      if (data.session) loadAll();
    });
  }, [loadAll, supabase]);


  async function login(event: React.FormEvent) {
    event.preventDefault();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setNotice(`登入失敗：${error.message}`);
    else { setUser(data.user.email || ""); await loadAll(); }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) return setNotice("請輸入商品名稱。");
    if (!form.category_id || !productCategories.some((category) => category.id === form.category_id && category.active)) return setNotice("請選擇有效的商品類別。");
    if (fishId && products.some((product) => product.fish_catalog_id === fishId)) return setNotice("此魚種已有商品，請編輯既有商品。");
    setBusy(true);
    const result = await supabase.rpc("admin_create_phase1_product", { p_name: form.name.trim(), p_category_id: form.category_id, p_fish_catalog_id: fishId || null });
    setBusy(false);
    if (result.error) setNotice(productSaveErrorMessage(result.error.message));
    else router.push(`/admin/inventory/${result.data.id}`);
  }

  async function toggle(product: Product) {
    const status = product.status === "hidden" ? "available" : "hidden";
    const { error } = await supabase.from("products").update({ status }).eq("id", product.id);
    if (error) setNotice(`狀態更新失敗：${error.message}`); else await loadAll();
  }

  async function setOrderStatus(id: string, status: string) {
    const { error } = await supabase.from("orders").update({ status }).eq("id", id);
    if (error) setNotice(`訂單更新失敗：${error.message}`); else await loadAll();
  }

  if (!user) return <main className="admin"><form className="login" onSubmit={login}><h1>後台登入</h1><label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label><label>密碼<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label><button>登入</button>{notice && <p className="notice">{notice}</p>}</form></main>;

  return (
    <main className="admin">
      <header className="adminTop"><div><Link href="/">← 返回商店</Link><h1>海鮮商品後台</h1><nav className="adminNavigation" aria-label="後台功能"><Link href="/admin/orders">🛒 今日訂單</Link><Link href="/admin/requests">🔔 想找的魚</Link><Link href="/admin/matches">🔔 到貨配對{pendingMatchCount > 0 ? ` ${pendingMatchCount}` : ""}</Link><Link href="/admin/fish-catalog">🐟 魚種管理</Link><Link href="/admin/categories">🏷️ 商品類別</Link><Link href="/admin/customers">👥 客戶</Link><Link href="/admin/inventory">🐟 今日魚貨</Link></nav><p>{user}</p></div><button onClick={() => supabase.auth.signOut().then(() => setUser(""))}>登出</button></header>
      <section className="adminGrid">
        <form className="panel" onSubmit={save}>
          <h2>新增長期商品</h2><p>先建立隱藏商品，再於商品編輯頁管理內容、圖片與 FAQ。</p>
          <label>商品名稱<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>商品類別 *<select required value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}><option value="">請選擇商品類別</option>{activeProductCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label>魚種<select value={fishId} onChange={(e) => setFishId(e.target.value)}><option value="">未指定</option>{fishCatalog.filter((fish) => fish.active).map((fish) => <option key={fish.id} value={fish.id}>{fish.name}</option>)}</select></label>
          {fishId && products.some((product) => product.fish_catalog_id === fishId) && <p role="alert">此魚種已有商品，請從右側開啟既有商品，不要重複建立。</p>}
          <button disabled={busy || Boolean(fishId && products.some((product) => product.fish_catalog_id === fishId))}>建立並編輯商品</button>
          {notice && <p className="notice">{notice}</p>}
        </form>
        <section className="panel"><h2>商品管理</h2>{products.map((product) => <div className="manageRow" key={product.id}><div className="manageProduct"><div className="manageThumb">{primaryImage(product, galleryImages, process.env.NEXT_PUBLIC_SUPABASE_URL || "") ? <img src={primaryImage(product, galleryImages, process.env.NEXT_PUBLIC_SUPABASE_URL || "")!} alt={product.name} /> : <span>🦀</span>}</div><div><strong>{product.name}</strong><small>{productCategories.find((category) => category.id === product.category_id)?.name || "未分類"}｜{product.status === "available" ? "可購買" : product.status === "sold_out" ? "已售完" : "已隱藏"}</small></div></div><div className="manageActions"><Link className="buttonLink" href={`/admin/variants?productId=${product.id}`}>⚖️ 管理規格</Link><Link className="buttonLink" href={`/admin/processing?productId=${product.id}`}>🐟 處理設定</Link><Link className="buttonLink" href={`/admin/inventory/${product.id}`}>編輯商品</Link><button type="button" onClick={() => toggle(product)}>{product.status === "hidden" ? "上架" : "下架"}</button></div></div>)}</section>
      </section>
      <section className="panel orders"><h2>訂單管理</h2>{orders.map((order) => <article className="orderCard" key={order.id}><div><strong>{order.customer_name}</strong><p>{order.phone}</p></div><div><p>{order.fulfillment}</p><p>{order.processing}</p></div><div><p>{order.note || "沒有備註"}</p>{orderItems.filter((item) => item.order_id === order.id).map((item) => <div className="adminOrderItem" key={item.id}><strong>{item.product_name}｜{item.variant_name}｜{item.supply_type === "preorder" ? "預訂" : "現貨"}｜×{item.quantity}</strong><small>處理：{item.processing_preset_name || "不處理"}{item.processing_option_names?.length ? `｜${item.processing_option_names.join("、")}` : ""}</small>{item.processing_note && <small>其他需求：{item.processing_note}</small>}</div>)}</div><select value={order.status} onChange={(e) => setOrderStatus(order.id, e.target.value)}><option value="new">新訂單</option><option value="contacted">已聯絡</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></article>)}</section>
    </main>
  );
}

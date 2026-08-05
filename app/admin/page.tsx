"use client";

import { useEffect, useMemo, useState } from "react";
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

export default function AdminPage() {
  const supabase = useMemo(() => createClient(), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || "");
      if (data.session) loadAll();
    });
  }, [supabase]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setNotice(error.message);
    else {
      setUser(data.user.email || "");
      loadAll();
    }
  }

  async function loadAll() {
    const p = await supabase.from("products").select("*").order("sort_order");
    const o = await supabase.from("orders").select("*").order("created_at", { ascending: false });
    setProducts((p.data || []) as Product[]);
    setOrders((o.data || []) as Order[]);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    let image_url: string | undefined;

    if (file) {
      const path = `${Date.now()}-${file.name}`;
      const upload = await supabase.storage.from("product-images").upload(path, file);
      if (upload.error) {
        setNotice(upload.error.message);
        return;
      }
      image_url = supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;
    }

    const payload = { ...form, ...(image_url ? { image_url } : {}) };

    const result = editingId
      ? await supabase.from("products").update(payload).eq("id", editingId)
      : await supabase.from("products").insert(payload);

    if (result.error) setNotice(result.error.message);
    else {
      setNotice(editingId ? "商品已更新" : "商品已新增");
      setForm(blank);
      setEditingId(null);
      setFile(null);
      loadAll();
    }
  }

  async function toggle(product: Product) {
    await supabase.from("products").update({
      status: product.status === "available" ? "sold_out" : "available"
    }).eq("id", product.id);
    loadAll();
  }

  async function remove(id: string) {
    if (!confirm("確定刪除？")) return;
    await supabase.from("products").delete().eq("id", id);
    loadAll();
  }

  async function setOrderStatus(id: string, status: string) {
    await supabase.from("orders").update({ status }).eq("id", id);
    loadAll();
  }

  if (!user) {
    return <main className="admin"><form className="login" onSubmit={login}>
      <h1>店家管理登入</h1>
      <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>密碼<input type="password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button>登入</button>
      {notice && <p className="notice">{notice}</p>}
    </form></main>;
  }

  return <main className="admin">
    <header className="adminTop">
      <div><a href="/">← 回前台</a><h1>韓九店家管理</h1><p>{user}</p></div>
      <button onClick={() => supabase.auth.signOut().then(() => setUser(""))}>登出</button>
    </header>

    <section className="adminGrid">
      <form className="panel" onSubmit={save}>
        <h2>{editingId ? "編輯魚貨" : "新增魚貨"}</h2>
        <label>魚名<input value={form.name} onChange={e => setForm({...form, name:e.target.value})} /></label>
        <label>介紹<textarea rows={3} value={form.description} onChange={e => setForm({...form, description:e.target.value})} /></label>
        <label>料理方式<input value={form.cooking} onChange={e => setForm({...form, cooking:e.target.value})} /></label>
        <label>照片<input type="file" accept="image/*" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
        <label>狀態<select value={form.status} onChange={e => setForm({...form, status:e.target.value as Product["status"]})}>
          <option value="available">今日現貨</option>
          <option value="sold_out">已售完</option>
          <option value="hidden">隱藏</option>
        </select></label>
        <label>排序<input type="number" value={form.sort_order} onChange={e => setForm({...form, sort_order:Number(e.target.value)})} /></label>
        <label className="check"><input type="checkbox" checked={form.featured} onChange={e => setForm({...form, featured:e.target.checked})} />老闆推薦</label>
        <button>儲存</button>
        {notice && <p className="notice">{notice}</p>}
      </form>

      <section className="panel">
        <h2>魚貨管理</h2>
        {products.map(p => <div className="manageRow" key={p.id}>
          <strong>{p.name}</strong>
          <span>{p.status}</span>
          <button onClick={() => {
            setEditingId(p.id);
            setForm({
              name:p.name,
              description:p.description || "",
              cooking:p.cooking || "",
              status:p.status,
              featured:p.featured,
              sort_order:p.sort_order
            });
          }}>編輯</button>
          <button onClick={() => toggle(p)}>{p.status === "available" ? "售完" : "上架"}</button>
          <button onClick={() => remove(p.id)}>刪除</button>
        </div>)}
      </section>
    </section>

    <section className="panel orders">
      <h2>訂單管理</h2>
      {orders.map(o => <article className="orderCard" key={o.id}>
        <div><strong>{o.customer_name}</strong><p>{o.phone}</p></div>
        <div><p>{o.fulfillment}</p><p>{o.processing}</p></div>
        <div><p>{o.note || "無備註"}</p></div>
        <select value={o.status} onChange={e => setOrderStatus(o.id, e.target.value)}>
          <option value="new">新訂單</option>
          <option value="contacted">已聯絡</option>
          <option value="completed">已完成</option>
          <option value="cancelled">已取消</option>
        </select>
      </article>)}
    </section>
  </main>;
}

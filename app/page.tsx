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

type CartItem = { product: Product; quantity: number };

export default function HomePage() {
  const supabase = useMemo(() => createClient(), []);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    customer_name: "",
    phone: "",
    line_id: "",
    fulfillment: "永春市場自取",
    processing: "三清",
    note: ""
  });

  useEffect(() => {
    supabase.from("products").select("*").neq("status", "hidden")
      .order("sort_order", { ascending: true })
      .then(({ data }) => setProducts((data || []) as Product[]));
  }, [supabase]);

  function add(product: Product) {
    if (product.status !== "available") return;
    setCart(items => {
      const found = items.find(i => i.product.id === product.id);
      return found
        ? items.map(i => i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i)
        : [...items, { product, quantity: 1 }];
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customer_name || !form.phone || cart.length === 0) {
      setNotice("請填寫姓名、電話，並先選擇魚貨。");
      return;
    }

    const { data: order, error } = await supabase.from("orders").insert({
      customer_name: form.customer_name,
      phone: form.phone,
      line_id: form.line_id || null,
      fulfillment: form.fulfillment,
      processing: form.processing,
      note: form.note || null,
      status: "new"
    }).select("id").single();

    if (error) {
      setNotice("送出失敗：" + error.message);
      return;
    }

    await supabase.from("order_items").insert(
      cart.map(i => ({
        order_id: order.id,
        product_id: i.product.id,
        product_name: i.product.name,
        quantity: i.quantity
      }))
    );

    const text = [
      "🐟 韓九嚴選生鮮｜新詢價",
      `姓名：${form.customer_name}`,
      `電話：${form.phone}`,
      "",
      ...cart.map(i => `${i.product.name} × ${i.quantity}`),
      "",
      `取貨方式：${form.fulfillment}`,
      `魚貨處理：${form.processing}`,
      form.note ? `備註：${form.note}` : ""
    ].filter(Boolean).join("\n");

    await navigator.clipboard.writeText(text);
    setNotice("詢價已送出，內容已複製，正在開啟 LINE。");
    setCart([]);
    window.open("https://lin.ee/q4avfUZ", "_blank");
  }

  return (
    <main>
      <header className="hero">
        <nav>
          <strong>韓九嚴選生鮮</strong>
          <div><a href="/admin">店家管理</a><a href="#order">開始詢價</a></div>
        </nav>
        <section>
          <p>南方澳現流海鮮</p>
          <h1>今天有什麼魚？</h1>
          <p>每日新鮮到貨｜可協助處理｜自取、外送、冷凍宅配</p>
        </section>
      </header>

      <section className="content">
        <div className="heading">
          <div><small>TODAY'S CATCH</small><h2>今日魚貨</h2></div>
          <p>魚貨依實際大小、重量與當日貨況報價，網站不公開價格。</p>
        </div>

        <div className="grid">
          {products.map(product => (
            <article className="card" key={product.id}>
              <div className="photo">
                {product.image_url ? (
                  <img
                    src={product.image_url}
                    alt={product.name}
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : <span>🐟</span>}
                {product.featured && <b>老闆推薦</b>}
              </div>
              <div className="body">
                <small>{product.status === "available" ? "● 今日現貨" : "● 已售完"}</small>
                <h3>{product.name}</h3>
                <p>{product.description}</p>
                <p>適合：{product.cooking || "歡迎詢問"}</p>
                <button disabled={product.status !== "available"} onClick={() => add(product)}>
                  {product.status === "available" ? "加入詢價" : "已售完"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section id="order" className="order">
        <div className="panel">
          <h2>我的詢價單</h2>
          {cart.length === 0 ? <p>尚未選擇魚貨。</p> : cart.map(item => (
            <div className="cartRow" key={item.product.id}>
              <strong>{item.product.name}</strong>
              <span>{item.quantity}</span>
            </div>
          ))}
        </div>

        <form className="panel" onSubmit={submit}>
          <h2>留下需求</h2>
          <label>姓名<input value={form.customer_name} onChange={e => setForm({...form, customer_name:e.target.value})} /></label>
          <label>電話<input value={form.phone} onChange={e => setForm({...form, phone:e.target.value})} /></label>
          <label>LINE ID<input value={form.line_id} onChange={e => setForm({...form, line_id:e.target.value})} /></label>
          <label>取貨方式
            <select value={form.fulfillment} onChange={e => setForm({...form, fulfillment:e.target.value})}>
              <option>永春市場自取</option><option>台北市外送</option><option>冷凍宅配</option>
            </select>
          </label>
          <label>處理方式
            <select value={form.processing} onChange={e => setForm({...form, processing:e.target.value})}>
              <option>不處理</option><option>三清</option><option>切塊</option><option>真空包裝</option>
            </select>
          </label>
          <label>備註<textarea rows={4} value={form.note} onChange={e => setForm({...form, note:e.target.value})} /></label>
          <button>送出詢價訂單</button>
          {notice && <p className="notice">{notice}</p>}
        </form>
      </section>
    </main>
  );
}

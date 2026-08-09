"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { AdminOrder, formatOrderTime, orderStatusLabel, orderStatusOptions, orderTotal, parseOrderNote, paymentStatusLabel, processingSummary } from "@/lib/admin-orders";

const deliveryOptions = ["永春市場自取", "台北市配送", "冷凍宅配", "7-ELEVEN 冷凍交貨便"];

function deliveryLabel(value: string | null) {
  if (!value) return "尚未設定配送";
  if (value === "永春市場自取") return "📍 永春市場自取";
  if (value === "台北市配送") return "🚚 台北市配送";
  if (value === "冷凍宅配") return "❄️ 冷凍宅配";
  if (value === "7-ELEVEN 冷凍交貨便") return "🏪 7-11 冷凍交貨便";
  return value;
}

export default function AdminOrdersPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [deliveryFilter, setDeliveryFilter] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [sort, setSort] = useState("newest");

  const loadOrders = useCallback(async () => {
    const { data, error } = await supabase.from("orders").select("*,order_items(*)").order("created_at", { ascending: false });
    if (error) setNotice("訂單載入失敗，請確認資料庫 migration 已執行。");
    else setOrders((data || []) as AdminOrder[]);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || null);
      setAuthReady(true);
      if (data.session) loadOrders();
    });
  }, [loadOrders, supabase]);

  const todayOrders = orders.filter((order) => order.status !== "draft" && new Date(order.created_at).toDateString() === new Date().toDateString());
  const filteredOrders = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-TW");
    const next = orders.filter((order) => {
      const matchesSearch = !keyword || [order.customer_name, order.phone, order.email, order.id, ...order.order_items.map((item) => item.product_name)].some((value) => value?.toLocaleLowerCase("zh-TW").includes(keyword));
      const normalizedStatus = orderStatusLabel(order.status);
      const matchesStatus = !statusFilter || normalizedStatus === statusFilter;
      return matchesSearch && matchesStatus && (!deliveryFilter || order.fulfillment === deliveryFilter) && (!paymentFilter || order.payment_status === paymentFilter);
    });
    return next.sort((a, b) => sort === "delivery" ? (a.fulfillment || "").localeCompare(b.fulfillment || "", "zh-TW") : sort === "status" ? orderStatusLabel(a.status).localeCompare(orderStatusLabel(b.status), "zh-TW") : new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [deliveryFilter, orders, paymentFilter, search, sort, statusFilter]);

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><p>請先登入後台以查看顧客訂單。</p><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  const summary = [
    ["今日訂單", todayOrders.length],
    ["新訂單", todayOrders.filter((order) => orderStatusLabel(order.status) === "新訂單").length],
    ["處理中", todayOrders.filter((order) => orderStatusLabel(order.status) === "處理中").length],
    ["待配送／待取貨", todayOrders.filter((order) => orderStatusLabel(order.status) === "待配送／待取貨").length],
    ["已完成", todayOrders.filter((order) => orderStatusLabel(order.status) === "已完成").length]
  ] as const;

  return <main className="admin adminOrdersPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>🛒 今日訂單</h1><p>{user}</p></div><button type="button" onClick={() => supabase.auth.signOut().then(() => setUser(null))}>登出</button></header>
    <section className="todaySummary" aria-label="今日訂單摘要">{summary.map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong></div>)}</section>
    <section className="orderTools panel">
      <label className="orderSearch">搜尋訂單<input type="search" placeholder="姓名、電話、Email、訂單編號或商品" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div className="orderFilterGrid"><label>訂單狀態<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">全部</option>{orderStatusOptions.map((option) => <option value={option.label} key={option.value}>{option.label}</option>)}</select></label><label>配送方式<select value={deliveryFilter} onChange={(event) => setDeliveryFilter(event.target.value)}><option value="">全部配送方式</option>{deliveryOptions.map((option) => <option value={option} key={option}>{option === "7-ELEVEN 冷凍交貨便" ? "7-11 冷凍交貨便" : option}</option>)}</select></label><label>付款狀態<select value={paymentFilter} onChange={(event) => setPaymentFilter(event.target.value)}><option value="">全部付款狀態</option><option value="unpaid">未付款</option><option value="paid">已付款</option></select></label><label>排序<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">建立時間（新到舊）</option><option value="delivery">配送方式</option><option value="status">訂單狀態</option></select></label></div>
    </section>
    {notice && <p className="notice centeredNotice">{notice}</p>}
    <section className="adminOrderList" aria-live="polite">{filteredOrders.length === 0 ? <div className="panel orderEmpty"><strong>沒有符合條件的訂單</strong><p>請調整搜尋或篩選條件。</p></div> : filteredOrders.map((order) => {
      const parsedNote = parseOrderNote(order.note);
      return <article className="adminOrderCard" key={order.id}>
        <header><div><h2>{order.customer_name}</h2><time dateTime={order.created_at}>{formatOrderTime(order.created_at, new Date(order.created_at).toDateString() !== new Date().toDateString())}</time>{order.fish_request_id && <small className="requestOrderOrigin">魚貨需求轉單</small>}</div><span className={`orderStatus status-${order.status}`}>{orderStatusLabel(order.status)}</span></header>
        <div className="orderCardMeta"><a href={`tel:${order.phone}`}>{order.phone}</a><span>{deliveryLabel(order.fulfillment)}</span><span className={`paymentStatus ${order.payment_status}`}>{paymentStatusLabel(order.payment_status)}</span></div>
        <div className="orderCardItems">{order.order_items.map((item) => { const processing = processingSummary(item); return <div key={item.id}><strong>{item.product_name}｜{item.variant_name || "未指定規格"} ×{item.quantity}</strong><span>處理：{processing.name}</span>{processing.extras.map((extra) => <span key={extra}>＋{extra}</span>)}{item.processing_note && <span>其他需求：{item.processing_note}</span>}</div>; })}</div>
        {parsedNote.customerNote && <section className="customerNote"><strong>📝 客人備註</strong><p>{parsedNote.customerNote}</p></section>}
        <footer><div><span>總計</span><strong>{orderTotal(order).toLocaleString("zh-TW")}</strong></div><Link className="buttonLink" href={`/admin/orders/${order.id}`}>查看訂單</Link></footer>
      </article>;
    })}</section>
  </main>;
}

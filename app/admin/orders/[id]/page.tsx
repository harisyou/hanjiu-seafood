"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { AdminOrder, formatOrderTime, orderStatusLabel, orderStatusOptions, orderTotal, parseOrderNote, PaymentStatus, paymentStatusLabel, processingSummary } from "@/lib/admin-orders";

function deliveryLabel(value: string) {
  return value === "7-ELEVEN 冷凍交貨便" ? "7-11 冷凍交貨便" : value;
}

export default function AdminOrderDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadOrder = useCallback(async () => {
    const { data, error } = await supabase.from("orders").select("*,order_items(*)").eq("id", orderId).single();
    if (error || !data) setNotice("找不到訂單，或目前沒有讀取權限。");
    else setOrder(data as AdminOrder);
  }, [orderId, supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || null);
      setAuthReady(true);
      if (data.session) loadOrder();
    });
  }, [loadOrder, supabase]);

  async function updateOrder(payload: { status?: string; payment_status?: PaymentStatus }) {
    if (!order || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.from("orders").update(payload).eq("id", order.id);
    if (error) setNotice("訂單狀態更新失敗，請稍後再試。");
    else { setNotice("訂單狀態已更新。"); await loadOrder(); }
    setBusy(false);
  }

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!order) return <main className="admin"><section className="panel centeredNotice"><Link href="/admin/orders">← 返回訂單</Link><p>{notice || "載入訂單中…"}</p></section></main>;

  const parsedNote = parseOrderNote(order.note);
  return <main className="admin orderDetailPage">
    <header className="adminTop ordersTop"><div><Link href="/admin/orders">← 返回今日訂單</Link><h1>訂單詳情</h1><p>#{order.id}</p></div><span className={`orderStatus status-${order.status}`}>{orderStatusLabel(order.status)}</span></header>
    <section className="orderDetailGrid">
      <article className="panel detailCustomer"><header><div><small>建立時間</small><strong>{formatOrderTime(order.created_at, true)}</strong></div><div><small>總計</small><strong className="detailTotal">{orderTotal(order).toLocaleString("zh-TW")}</strong></div></header><h2>{order.customer_name}</h2><dl><div><dt>電話</dt><dd><a href={`tel:${order.phone}`}>{order.phone}</a></dd></div>{order.email && <div><dt>Email</dt><dd><a href={`mailto:${order.email}`}>{order.email}</a></dd></div>}</dl><div className="quickContact"><a className="buttonLink" href={`tel:${order.phone}`}>撥打電話</a>{order.email && <a className="buttonLink secondaryAdminAction" href={`mailto:${order.email}`}>寄 Email</a>}{order.customer_id && <Link className="buttonLink secondaryAdminAction" href={`/admin/customers/${order.customer_id}`}>查看客戶</Link>}</div></article>
      <article className="panel detailDelivery"><h2>配送資訊</h2><dl><div><dt>配送方式</dt><dd>{deliveryLabel(order.fulfillment)}</dd></div>{Object.entries(parsedNote.details).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{parsedNote.customerNote && <section className="customerNote"><strong>📝 客人備註</strong><p>{parsedNote.customerNote}</p></section>}</article>
      <article className="panel detailStatuses"><h2>訂單狀態</h2><label>處理進度<select disabled={busy} value={order.status} onChange={(event) => updateOrder({ status: event.target.value })}>{orderStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}{!orderStatusOptions.some((option) => option.value === order.status) && <option value={order.status}>{orderStatusLabel(order.status)}</option>}</select></label><label>付款狀態<select disabled={busy} value={order.payment_status} onChange={(event) => updateOrder({ payment_status: event.target.value as PaymentStatus })}><option value="unpaid">未付款</option><option value="paid">已付款</option></select></label><div className="statusSnapshot"><span>{orderStatusLabel(order.status)}</span><span>{paymentStatusLabel(order.payment_status)}</span></div>{notice && <p className="notice" aria-live="polite">{notice}</p>}</article>
    </section>
    <section className="panel detailItems"><h2>訂單商品</h2>{order.order_items.map((item) => { const processing = processingSummary(item); const subtotal = (item.price || 0) * item.quantity; return <article className="detailOrderItem" key={item.id}><header><div><h3>{item.product_name}</h3><p>{item.variant_name || "未指定規格"}</p></div><strong>{subtotal.toLocaleString("zh-TW")}</strong></header><dl><div><dt>數量</dt><dd>{item.quantity}</dd></div><div><dt>單價</dt><dd>{(item.price || 0).toLocaleString("zh-TW")}</dd></div><div><dt>小計</dt><dd>{subtotal.toLocaleString("zh-TW")}</dd></div></dl><div className="detailProcessing"><strong>處理：{processing.name}</strong>{processing.extras.map((extra) => <span key={extra}>＋{extra}</span>)}{item.processing_note && <span>其他處理需求：{item.processing_note}</span>}</div></article>; })}</section>
  </main>;
}

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { orderStatusLabel } from "@/lib/admin-orders";
import { FishRequest, fishRequestStatusLabel } from "@/lib/fish-requests";
import { Customer, CustomerOrder, activeFishRequests, customerDisplayName, customerOrderTotal, customerSummary, customerTypeLabel, formatCustomerPhone, frequentlyPurchased } from "@/lib/customers";

export default function AdminCustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => createClient(), []);
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [requests, setRequests] = useState<FishRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadCustomer = useCallback(async () => {
    const [customerResult, orderResult, requestResult] = await Promise.all([
      supabase.from("customers").select("*").eq("id", id).single(),
      supabase.from("orders").select("*,order_items(*)").eq("customer_id", id).order("created_at", { ascending: false }),
      supabase.from("fish_requests").select("*").eq("customer_id", id).order("created_at", { ascending: false })
    ]);
    if (customerResult.error || !customerResult.data || orderResult.error || requestResult.error) setNotice("客戶資料載入失敗，或目前沒有讀取權限。");
    else { setCustomer(customerResult.data as Customer); setOrders((orderResult.data || []) as CustomerOrder[]); setRequests((requestResult.data || []) as FishRequest[]); }
  }, [id, supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) loadCustomer(); }); }, [loadCustomer, supabase]);

  async function saveCustomer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!customer || busy) return;
    setBusy(true); setNotice("");
    const updates = {
      name: customer.name?.trim() || null,
      email: customer.email?.trim() || null,
      customer_type: customer.customer_type,
      business_name: customer.customer_type === "restaurant" ? customer.business_name?.trim() || null : null,
      preferred_notification_channel: customer.preferred_notification_channel,
      admin_note: customer.admin_note?.trim() || null
    };
    const { error } = await supabase.from("customers").update(updates).eq("id", customer.id);
    setBusy(false);
    if (error) setNotice("客戶資料儲存失敗，請稍後再試。");
    else { setNotice("客戶資料已更新。"); await loadCustomer(); }
  }

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!customer) return <main className="admin"><section className="panel centeredNotice"><Link href="/admin/customers">← 返回客戶</Link><p>{notice || "載入客戶中…"}</p></section></main>;

  const summary = customerSummary(orders);
  const favoriteProducts = frequentlyPurchased(orders);
  const waitingRequests = activeFishRequests(requests);
  const historicalRequests = requests.filter((request) => !waitingRequests.includes(request));
  const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat("zh-TW").format(new Date(value)) : "尚無紀錄";

  return <main className="admin adminOrdersPage customerDetailPage">
    <header className="adminTop ordersTop"><div><Link href="/admin/customers">← 返回客戶</Link><h1>{customerDisplayName(customer)}</h1><p>{customerTypeLabel(customer.customer_type)}｜{formatCustomerPhone(customer.phone)}</p></div><span className="orderStatus">{customerTypeLabel(customer.customer_type)}</span></header>
    <section className="customerSummaryGrid" aria-label="客戶摘要">{[["累積訂單數", summary.orderCount], ["累積消費", `NT$${summary.spending.toLocaleString("zh-TW")}`], ["平均客單", `NT$${summary.average.toLocaleString("zh-TW")}`], ["最近一次購買", formatDate(summary.lastPurchase)], ["第一次購買", formatDate(summary.firstPurchase)]].map(([label, value]) => <div className="panel" key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
    <div className="customerDetailGrid">
      <form className="panel customerProfileForm" onSubmit={saveCustomer}><h2>基本資料</h2><label>姓名<input value={customer.name || ""} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></label><label>電話<input value={formatCustomerPhone(customer.phone)} readOnly aria-describedby="phone-identity-note" /><small id="phone-identity-note">電話是客戶識別依據，不能在此修改。</small></label><label>Email<input type="email" value={customer.email || ""} onChange={(event) => setCustomer({ ...customer, email: event.target.value })} /></label><div><span>LINE 狀態</span><strong>{customer.line_user_id ? "LINE 已綁定" : "LINE 尚未綁定"}</strong></div><label>客戶類型<select value={customer.customer_type} onChange={(event) => setCustomer({ ...customer, customer_type: event.target.value as Customer["customer_type"] })}><option value="household">家庭客</option><option value="restaurant">餐廳／商用</option></select></label>{customer.customer_type === "restaurant" && <label>店家名稱<input value={customer.business_name || ""} onChange={(event) => setCustomer({ ...customer, business_name: event.target.value })} /></label>}<label>偏好聯絡方式<select value={customer.preferred_notification_channel || ""} onChange={(event) => setCustomer({ ...customer, preferred_notification_channel: (event.target.value || null) as Customer["preferred_notification_channel"] })}><option value="">未設定</option><option value="line">LINE</option><option value="email">Email</option><option value="phone">簡訊／電話</option></select></label><label>韓九備註<textarea rows={5} value={customer.admin_note || ""} onChange={(event) => setCustomer({ ...customer, admin_note: event.target.value })} /></label><button className="buttonLink" disabled={busy}>{busy ? "儲存中…" : "儲存客戶資料"}</button>{notice && <p className="notice" aria-live="polite">{notice}</p>}</form>
      <section className="panel customerContact"><h2>快速聯絡</h2><a className="buttonLink" href={`tel:${customer.phone}`}>撥打電話</a>{customer.email && <a className="buttonLink secondaryAdminAction" href={`mailto:${customer.email}`}>寄 Email</a>}<p>{customer.line_user_id ? "LINE 已綁定" : "LINE 尚未綁定"}</p><h2>最常購買</h2>{favoriteProducts.length ? <ol>{favoriteProducts.map(([name, quantity]) => <li key={name}><strong>{name}</strong><span>累積 {quantity} 件</span></li>)}</ol> : <p>尚無購買紀錄</p>}</section>
      <section className="panel customerHistory"><h2>訂單紀錄</h2>{orders.length ? orders.map((order) => <article key={order.id}><div><time>{formatDate(order.created_at)}</time><strong>NT${customerOrderTotal(order).toLocaleString("zh-TW")}</strong><p>{order.order_items.map((item) => item.product_name).filter((name, index, list) => list.indexOf(name) === index).join("、")}</p><span>{orderStatusLabel(order.status)}</span></div><Link className="buttonLink" href={`/admin/orders/${order.id}`}>查看訂單</Link></article>) : <p>尚無訂單</p>}</section>
      <section className="panel customerHistory"><h2>正在等待</h2>{waitingRequests.length ? waitingRequests.map((request) => <article key={request.id}><div><strong>{request.fish_name}</strong><p>{request.quantity_request}</p><span>{fishRequestStatusLabel(request.status)}</span></div><Link className="buttonLink" href={`/admin/requests/${request.id}`}>查看需求</Link></article>) : <p>目前沒有等待中的需求</p>}<h2>歷史需求</h2>{historicalRequests.length ? historicalRequests.map((request) => <article key={request.id}><div><strong>{request.fish_name}</strong><p>{request.quantity_request}</p><span>{fishRequestStatusLabel(request.status)}</span></div><Link className="buttonLink" href={`/admin/requests/${request.id}`}>查看需求</Link></article>) : <p>尚無歷史需求</p>}</section>
    </div>
  </main>;
}

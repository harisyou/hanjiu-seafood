"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { Customer, CustomerOrder, customerDisplayName, customerSummary, customerTypeLabel, formatCustomerPhone } from "@/lib/customers";

export default function AdminCustomersPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");

  const loadCustomers = useCallback(async () => {
    const [customerResult, orderResult] = await Promise.all([
      supabase.from("customers").select("*").order("updated_at", { ascending: false }),
      supabase.from("orders").select("*,order_items(*)").not("customer_id", "is", null).order("created_at", { ascending: false })
    ]);
    if (customerResult.error || orderResult.error) setNotice("客戶資料載入失敗，請確認 F003-3 migration 與管理員權限。");
    else { setCustomers((customerResult.data || []) as Customer[]); setOrders((orderResult.data || []) as CustomerOrder[]); }
  }, [supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) loadCustomers(); }); }, [loadCustomers, supabase]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-TW").replace(/[\s-]/g, "");
    return customers.filter((customer) => !keyword || [customer.name, customer.phone, customer.email, customer.business_name]
      .some((value) => value?.toLocaleLowerCase("zh-TW").replace(/[\s-]/g, "").includes(keyword)));
  }, [customers, search]);

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  return <main className="admin adminOrdersPage customerAdminPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>👥 客戶</h1><p>用姓名或電話快速找到訂單、需求與聯絡方式。</p></div><button type="button" onClick={() => supabase.auth.signOut().then(() => setUser(null))}>登出</button></header>
    <section className="orderTools panel"><label className="orderSearch">搜尋客戶<input type="search" placeholder="姓名、電話、Email 或店家名稱" value={search} onChange={(event) => setSearch(event.target.value)} /></label></section>
    {notice && <p className="notice centeredNotice">{notice}</p>}
    <section className="customerCardList" aria-live="polite">{filtered.length === 0 ? <div className="panel orderEmpty"><strong>沒有符合條件的客戶</strong><p>請嘗試姓名、電話、Email 或店家名稱。</p></div> : filtered.map((customer) => {
      const summary = customerSummary(orders.filter((order) => order.customer_id === customer.id));
      return <article className="customerCard" key={customer.id}><header><div><h2>{customerDisplayName(customer)}</h2>{customer.customer_type === "restaurant" && customer.name && <p>聯絡人：{customer.name}</p>}<a href={`tel:${customer.phone}`}>{formatCustomerPhone(customer.phone)}</a></div><span>{customerTypeLabel(customer.customer_type)}</span></header><dl><div><dt>累積訂單</dt><dd>{summary.orderCount}</dd></div><div><dt>累積消費</dt><dd>NT${summary.spending.toLocaleString("zh-TW")}</dd></div><div><dt>最近購買</dt><dd>{summary.lastPurchase ? new Intl.DateTimeFormat("zh-TW").format(new Date(summary.lastPurchase)) : "尚無訂單"}</dd></div></dl><Link className="buttonLink" href={`/admin/customers/${customer.id}`}>查看客戶</Link></article>;
    })}</section>
  </main>;
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { FishRequest, fishRequestStatusLabel, fishRequestStatusOptions, formatWantedBy, notificationLabel } from "@/lib/fish-requests";

export default function AdminRequestsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [requests, setRequests] = useState<FishRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("waiting");
  const [sort, setSort] = useState("newest");

  const loadRequests = useCallback(async () => {
    const { data, error } = await supabase.from("fish_requests").select("*").order("created_at", { ascending: false });
    if (error) setNotice("需求載入失敗，請確認 F003-2 migration 與管理員權限。");
    else setRequests((data || []) as FishRequest[]);
  }, [supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) loadRequests(); }); }, [loadRequests, supabase]);

  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase("zh-TW");
    return requests.filter((request) => (!status || request.status === status) && (!keyword || [request.fish_name, request.customer_name, request.phone].some((value) => value.toLocaleLowerCase("zh-TW").includes(keyword)))).sort((a, b) => {
      if (sort === "oldest") return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      if (sort === "wanted") return (a.wanted_by || "9999-12-31").localeCompare(b.wanted_by || "9999-12-31");
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [requests, search, sort, status]);

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  const summary = [
    ["等待中", requests.filter((request) => request.status === "waiting").length],
    ["已找到", requests.filter((request) => request.status === "matched").length],
    ["已聯絡", requests.filter((request) => request.status === "contacted").length],
    ["已成交", requests.filter((request) => request.status === "converted").length]
  ] as const;

  return <main className="admin adminOrdersPage adminRequestsPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>🔔 想找的魚</h1><p>到港後搜尋魚名，立即找到正在等待的客人。</p></div><button type="button" onClick={() => supabase.auth.signOut().then(() => setUser(null))}>登出</button></header>
    <section className="todaySummary requestSummary" aria-label="需求摘要">{summary.map(([label, count]) => <div key={label}><span>{label}</span><strong>{count}</strong></div>)}</section>
    <section className="orderTools panel"><label className="orderSearch">搜尋需求<input type="search" placeholder="魚種、客戶姓名或電話" value={search} onChange={(event) => setSearch(event.target.value)} /></label><div className="requestFilterGrid"><label>狀態<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部</option>{fishRequestStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label>排序<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">最新需求</option><option value="wanted">希望日期最近</option><option value="oldest">最早建立</option></select></label></div></section>
    {notice && <p className="notice centeredNotice">{notice}</p>}
    <section className="requestCardList" aria-live="polite">{filtered.length === 0 ? <div className="panel orderEmpty"><strong>沒有符合條件的需求</strong><p>可調整魚種搜尋或狀態篩選。</p></div> : filtered.map((request) => <article className="requestCard" key={request.id}><header><div><small>🔔 想找</small><h2>{request.fish_name}</h2></div><span className={`requestStatus status-${request.status}`}>{fishRequestStatusLabel(request.status)}</span></header><div className="requestCustomer"><strong>{request.customer_name}</strong><a href={`tel:${request.phone}`}>{request.phone}</a></div><dl><div><dt>需求</dt><dd>{request.quantity_request}</dd></div>{request.size_preference && <div><dt>尺寸</dt><dd>{request.size_preference}</dd></div>}<div><dt>希望日期</dt><dd>{formatWantedBy(request.wanted_by)}{request.wanted_by ? " 前" : ""}</dd></div><div><dt>偏好通知</dt><dd>{notificationLabel(request)}</dd></div></dl>{request.note && <section className="customerNote"><strong>備註</strong><p>{request.note}</p></section>}<footer><Link className="buttonLink" href={`/admin/requests/${request.id}`}>查看需求</Link></footer></article>)}</section>
  </main>;
}


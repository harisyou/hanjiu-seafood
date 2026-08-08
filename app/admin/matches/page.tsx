"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import type { Product, ProductVariant } from "@/lib/catalog";
import { arrivalWorkflowActions, FishRequest, FishRequestStatus, fishRequestStatusLabel, formatWantedBy, notificationLabel } from "@/lib/fish-requests";
import { buildFishMatchGroups } from "@/lib/fish-matching";
import { FishCatalogItem } from "@/lib/fish-catalog";

function AdminMatchesContent() {
  const supabase = useMemo(() => createClient(), []);
  const searchParams = useSearchParams();
  const selectedProductId = searchParams.get("product");
  const selectedFishKey = searchParams.get("fish");
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [requests, setRequests] = useState<FishRequest[]>([]);
  const [catalog, setCatalog] = useState<FishCatalogItem[]>([]);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    const [productResult, variantResult, requestResult, catalogResult] = await Promise.all([
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("product_variants").select("*").order("sort_order"),
      supabase.from("fish_requests").select("*").order("created_at", { ascending: false }),
      supabase.from("fish_catalog").select("*").order("sort_order")
    ]);
    if (productResult.error || variantResult.error || requestResult.error || catalogResult.error) {
      setNotice("配對資料載入失敗，請確認 F003-7 migration 與管理員權限。");
      return;
    }
    setProducts((productResult.data || []) as Product[]);
    setVariants((variantResult.data || []) as ProductVariant[]);
    setRequests((requestResult.data || []) as FishRequest[]);
    setCatalog((catalogResult.data || []) as FishCatalogItem[]);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || null);
      setAuthReady(true);
      if (data.session) load();
    });
  }, [load, supabase]);

  const matches = useMemo(() => buildFishMatchGroups(products, variants, requests, catalog), [catalog, products, requests, variants]);
  const selectedMatch = matches.find((match) => match.key === selectedFishKey || match.products.some((product) => product.id === selectedProductId));

  async function updateStatus(request: FishRequest, status: FishRequestStatus) {
    setBusyId(request.id); setNotice("");
    const { error } = await supabase.rpc("admin_update_fish_request_status", { p_request_id: request.id, p_status: status });
    setBusyId("");
    if (error) setNotice("需求狀態更新失敗，請確認管理員權限。");
    else {
      setRequests((current) => current.map((item) => item.id === request.id ? { ...item, status } : item));
      setNotice(`${request.customer_name} 的需求已更新為「${fishRequestStatusLabel(status)}」。`);
    }
  }

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  return <main className="admin adminOrdersPage adminMatchesPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>🔔 到貨配對</h1><p>只顯示目前有可售規格，且魚名完全相符的有效需求。</p></div><Link className="buttonLink secondaryAdminAction" href="/admin/requests">全部需求</Link></header>
    {notice && <p className="notice centeredNotice" aria-live="polite">{notice}</p>}
    {(selectedProductId || selectedFishKey) && !selectedMatch ? <section className="panel orderEmpty matchEmpty"><strong>目前沒有可聯絡的配對需求</strong><p>商品可能已售完、下架，或相關需求已完成／取消。</p><Link className="buttonLink" href="/admin/matches">返回配對總覽</Link></section> : selectedMatch ? <>
      <section className="panel matchProductSummary"><div><Link href="/admin/matches">← 返回配對總覽</Link><h2>{selectedMatch.name}</h2><p>{selectedMatch.availableVariants.length} 個可售規格｜{selectedMatch.requests.length} 位客人待處理</p></div><Link className="buttonLink secondaryAdminAction" href={`/admin/inventory/${selectedMatch.products[0].id}`}>查看商品</Link></section>
      <section className="matchRequestList" aria-live="polite">{selectedMatch.requests.map((request) => <article className="panel matchRequestCard" key={request.id}>
        <header><div><h2>{request.customer_name}</h2>{request.customer_id && <Link href={`/admin/customers/${request.customer_id}`}>查看客戶資料</Link>}</div><span className={`requestStatus status-${request.status}`}>{fishRequestStatusLabel(request.status)}</span></header>
        <dl><div><dt>正式魚種</dt><dd>{selectedMatch.name}</dd></div><div><dt>電話</dt><dd><a href={`tel:${request.phone}`}>{request.phone}</a></dd></div>{request.email && <div><dt>Email</dt><dd><a href={`mailto:${request.email}`}>{request.email}</a></dd></div>}<div><dt>數量需求</dt><dd>{request.quantity_request}</dd></div><div><dt>尺寸偏好</dt><dd>{request.size_preference || "未指定"}</dd></div><div><dt>預算</dt><dd>{request.budget || "未指定"}</dd></div><div><dt>希望日期</dt><dd>{formatWantedBy(request.wanted_by)}{request.wanted_by ? " 前" : ""}</dd></div><div><dt>用途</dt><dd>{request.purpose || "未指定"}</dd></div><div><dt>偏好通知</dt><dd>{notificationLabel(request)}</dd></div>{request.line_user_id && <div><dt>LINE</dt><dd>已綁定</dd></div>}</dl>
        {request.note && <section className="customerNote"><strong>備註</strong><p>{request.note}</p></section>}
        <div className="quickContact"><a className="buttonLink" href={`tel:${request.phone}`}>致電 {request.phone}</a>{request.email && <a className="buttonLink secondaryAdminAction" href={`mailto:${request.email}`}>寄 Email</a>}{request.line_user_id && <span className="lineReady">LINE 已綁定（V1 不自動發送）</span>}<Link className="buttonLink secondaryAdminAction" href={`/admin/requests/${request.id}`}>需求詳情</Link></div>
        <div className="matchWorkflowActions" aria-label={`${request.customer_name} 的需求處理`}>{arrivalWorkflowActions.map((action) => <button type="button" className={action.status === "cancelled" ? "dangerSecondaryAction" : action.status === request.status ? "currentWorkflowAction" : "secondaryAdminAction"} disabled={busyId === request.id || action.status === request.status} onClick={() => updateStatus(request, action.status)} key={action.status}>{busyId === request.id ? "更新中…" : action.label}</button>)}</div>
      </article>)}</section>
    </> : <section className="matchSummaryList" aria-live="polite">{matches.length === 0 ? <div className="panel orderEmpty"><strong>目前沒有到貨配對</strong><p>有可售魚貨且魚種 ID 相同，或舊資料魚名完全相符時，配對會自動出現在這裡。</p></div> : matches.map((match) => <article className="panel matchSummaryCard" key={match.key}><div><small>🐟 已到貨</small><h2>{match.name}</h2><p>{match.availableVariants.length} 個可售規格</p></div><div><strong>{match.requests.length}</strong><span>位客人待處理</span><Link className="buttonLink" href={`/admin/matches?fish=${encodeURIComponent(match.key)}`}>展開處理</Link></div></article>)}</section>}
  </main>;
}

export default function AdminMatchesPage() {
  return <Suspense fallback={<main className="admin"><section className="panel centeredNotice">載入配對資料中…</section></main>}><AdminMatchesContent /></Suspense>;
}

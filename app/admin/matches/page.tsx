"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase-browser";
import type { Product, ProductVariant } from "@/lib/catalog";
import { FishRequest, FishRequestStatus, fishRequestStatusLabel, fishRequestStatusOptions, formatWantedBy, notificationLabel } from "@/lib/fish-requests";
import { buildFishMatches } from "@/lib/fish-matching";

function AdminMatchesContent() {
  const supabase = useMemo(() => createClient(), []);
  const searchParams = useSearchParams();
  const selectedProductId = searchParams.get("product");
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [requests, setRequests] = useState<FishRequest[]>([]);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    const [productResult, variantResult, requestResult] = await Promise.all([
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("product_variants").select("*").order("sort_order"),
      supabase.from("fish_requests").select("*").order("created_at", { ascending: false })
    ]);
    if (productResult.error || variantResult.error || requestResult.error) {
      setNotice("配對資料載入失敗，請確認管理員權限。");
      return;
    }
    setProducts((productResult.data || []) as Product[]);
    setVariants((variantResult.data || []) as ProductVariant[]);
    setRequests((requestResult.data || []) as FishRequest[]);
  }, [supabase]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user.email || null);
      setAuthReady(true);
      if (data.session) load();
    });
  }, [load, supabase]);

  const matches = useMemo(() => buildFishMatches(products, variants, requests), [products, requests, variants]);
  const selectedMatch = matches.find((match) => match.product.id === selectedProductId);

  async function updateStatus(request: FishRequest, status: FishRequestStatus) {
    setBusyId(request.id); setNotice("");
    const { error } = await supabase.from("fish_requests").update({ status }).eq("id", request.id);
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
    {selectedProductId && !selectedMatch ? <section className="panel orderEmpty matchEmpty"><strong>目前沒有可聯絡的配對需求</strong><p>商品可能已售完、下架，或相關需求已結束。</p><Link className="buttonLink" href="/admin/matches">返回配對總覽</Link></section> : selectedMatch ? <>
      <section className="panel matchProductSummary"><div><Link href="/admin/matches">← 返回配對總覽</Link><h2>{selectedMatch.product.name}</h2><p>{selectedMatch.availableVariants.length} 個可售規格｜{selectedMatch.requests.length} 位客人正在等</p></div><Link className="buttonLink secondaryAdminAction" href={`/admin/inventory/${selectedMatch.product.id}`}>查看商品</Link></section>
      <section className="matchRequestList" aria-live="polite">{selectedMatch.requests.map((request) => <article className="panel matchRequestCard" key={request.id}>
        <header><div><h2>{request.customer_name}</h2>{request.customer_id && <Link href={`/admin/customers/${request.customer_id}`}>查看客戶資料</Link>}</div><span className={`requestStatus status-${request.status}`}>{fishRequestStatusLabel(request.status)}</span></header>
        <dl><div><dt>想找</dt><dd>{request.fish_name}</dd></div><div><dt>數量</dt><dd>{request.quantity_request}</dd></div>{request.size_preference && <div><dt>尺寸</dt><dd>{request.size_preference}</dd></div>}{request.budget && <div><dt>預算</dt><dd>{request.budget}</dd></div>}<div><dt>希望日期</dt><dd>{formatWantedBy(request.wanted_by)}{request.wanted_by ? " 前" : ""}</dd></div><div><dt>偏好通知</dt><dd>{notificationLabel(request)}</dd></div>{request.purpose && <div><dt>用途</dt><dd>{request.purpose}</dd></div>}</dl>
        {request.note && <section className="customerNote"><strong>其他需求</strong><p>{request.note}</p></section>}
        <div className="quickContact"><a className="buttonLink" href={`tel:${request.phone}`}>致電 {request.phone}</a>{request.email && <a className="buttonLink secondaryAdminAction" href={`mailto:${request.email}`}>Email</a>}{request.line_user_id && <span className="lineReady">LINE 已綁定，可依正式通知流程聯絡</span>}<Link className="buttonLink secondaryAdminAction" href={`/admin/requests/${request.id}`}>需求詳情</Link></div>
        <label className="matchStatusControl">更新需求狀態<select disabled={busyId === request.id} value={request.status} onChange={(event) => updateStatus(request, event.target.value as FishRequestStatus)}>{fishRequestStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
      </article>)}</section>
    </> : <section className="matchSummaryList" aria-live="polite">{matches.length === 0 ? <div className="panel orderEmpty"><strong>目前沒有到貨配對</strong><p>有可售魚貨且魚名完全相符時，配對會自動出現在這裡。</p></div> : matches.map((match) => <article className="panel matchSummaryCard" key={match.product.id}><div><small>🐟 已到貨</small><h2>{match.product.name}</h2><p>{match.availableVariants.length} 個可售規格</p></div><div><strong>{match.requests.length}</strong><span>位客人正在等</span><Link className="buttonLink" href={`/admin/matches?product=${match.product.id}`}>查看配對</Link></div></article>)}</section>}
  </main>;
}

export default function AdminMatchesPage() {
  return <Suspense fallback={<main className="admin"><section className="panel centeredNotice">載入配對資料中…</section></main>}><AdminMatchesContent /></Suspense>;
}

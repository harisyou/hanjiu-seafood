"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { FishRequest, FishRequestStatus, fishRequestStatusLabel, fishRequestStatusOptions, formatWantedBy, notificationLabel } from "@/lib/fish-requests";
import { FishCatalogItem } from "@/lib/fish-catalog";

export default function AdminRequestDetailPage() {
  const supabase = useMemo(() => createClient(), []);
  const params = useParams<{ id: string }>();
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [request, setRequest] = useState<FishRequest | null>(null);
  const [catalog, setCatalog] = useState<FishCatalogItem[]>([]);
  const [draftOrderId, setDraftOrderId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const loadRequest = useCallback(async () => {
    const [requestResult, catalogResult, draftOrderResult] = await Promise.all([
      supabase.from("fish_requests").select("*").eq("id", params.id).single(),
      supabase.from("fish_catalog").select("*").order("sort_order").order("name"),
      supabase.from("orders").select("id").eq("fish_request_id", params.id).eq("status", "draft").maybeSingle()
    ]);
    if (requestResult.error || !requestResult.data || catalogResult.error) setNotice("找不到需求，或目前沒有讀取權限。");
    else {
      setRequest(requestResult.data as FishRequest);
      setCatalog((catalogResult.data || []) as FishCatalogItem[]);
      setDraftOrderId(draftOrderResult.data?.id || null);
      if (draftOrderResult.error) setNotice("訂單草稿讀取失敗，請稍後再試。");
    }
  }, [params.id, supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) loadRequest(); }); }, [loadRequest, supabase]);

  async function updateStatus(status: FishRequestStatus) {
    if (!request || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.from("fish_requests").update({ status }).eq("id", request.id);
    if (error) setNotice("需求狀態更新失敗，請稍後再試。");
    else { setNotice("需求狀態已更新。"); await loadRequest(); }
    setBusy(false);
  }

  async function classifyFish(fishCatalogId: string) {
    if (!request || busy) return;
    setBusy(true); setNotice("");
    const { error } = await supabase.from("fish_requests").update({ fish_catalog_id: fishCatalogId || null }).eq("id", request.id);
    if (error) setNotice("魚種歸類失敗，請確認管理員權限。");
    else { setNotice("魚種歸類已更新，原始輸入保持不變。"); await loadRequest(); }
    setBusy(false);
  }

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;
  if (!request) return <main className="admin"><section className="panel centeredNotice"><Link href="/admin/requests">← 返回需求</Link><p>{notice || "載入需求中…"}</p></section></main>;

  const classifiedFish = catalog.find((fish) => fish.id === request.fish_catalog_id);
  return <main className="admin requestDetailPage"><header className="adminTop ordersTop"><div><Link href="/admin/requests">← 返回想找的魚</Link><h1>🔔 {request.fish_name}</h1><p>建立於 {new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(new Date(request.created_at))}</p></div><div className="requestHeaderActions">{draftOrderId && <Link className="buttonLink" href={"/admin/orders/" + draftOrderId}>查看訂單草稿</Link>}<span className={`requestStatus status-${request.status}`}>{fishRequestStatusLabel(request.status)}</span></div></header><section className="requestDetailGrid">
    <article className="panel requestDetailCard"><h2>魚貨需求</h2><dl><div><dt>原始輸入／名稱快照</dt><dd>{request.fish_name}</dd></div><div><dt>歸類魚種</dt><dd>{classifiedFish?.name || "尚未歸類"}</dd></div><div><dt>數量</dt><dd>{request.quantity_request}</dd></div><div><dt>尺寸</dt><dd>{request.size_preference || "未指定"}</dd></div><div><dt>預算</dt><dd>{request.budget || "未指定"}</dd></div><div><dt>希望日期</dt><dd>{formatWantedBy(request.wanted_by)}</dd></div><div><dt>用途</dt><dd>{request.purpose || "未指定"}</dd></div></dl><label className="requestClassify">歸類魚種<select disabled={busy} value={request.fish_catalog_id || ""} onChange={(event) => classifyFish(event.target.value)}><option value="">尚未歸類</option>{catalog.filter((fish) => fish.active || fish.id === request.fish_catalog_id).map((fish) => <option key={fish.id} value={fish.id}>{fish.name}{fish.active ? "" : "（已停用）"}</option>)}</select></label><small>人工歸類只更新 fish_catalog_id，不會修改客戶原始輸入。</small></article>
    <article className="panel requestDetailCard"><h2>客戶與聯絡</h2><dl><div><dt>姓名</dt><dd>{request.customer_name}</dd></div><div><dt>電話</dt><dd><a href={`tel:${request.phone}`}>{request.phone}</a></dd></div><div><dt>Email</dt><dd>{request.email ? <a href={`mailto:${request.email}`}>{request.email}</a> : "未提供"}</dd></div><div><dt>LINE</dt><dd>{request.line_user_id ? "LINE 可通知" : "LINE 尚未綁定"}</dd></div><div><dt>偏好通知</dt><dd>{notificationLabel(request)}</dd></div></dl><div className="quickContact"><a className="buttonLink" href={`tel:${request.phone}`}>撥打電話</a>{request.email && <a className="buttonLink secondaryAdminAction" href={`mailto:${request.email}`}>寄 Email</a>}{request.customer_id && <Link className="buttonLink secondaryAdminAction" href={`/admin/customers/${request.customer_id}`}>查看客戶</Link>}</div></article>
    <article className="panel requestDetailCard"><h2>其他需求</h2><p className="requestLongNote">{request.note || "沒有其他需求"}</p></article>
    <article className="panel requestDetailCard"><h2>目前狀態</h2><label>需求進度<select disabled={busy} value={request.status} onChange={(event) => updateStatus(event.target.value as FishRequestStatus)}>{fishRequestStatusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>{notice && <p className="notice" aria-live="polite">{notice}</p>}</article>
  </section></main>;
}

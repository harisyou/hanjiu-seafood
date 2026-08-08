"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase-browser";
import { FishAlias, FishCatalogItem, normalizeCatalogTerm } from "@/lib/fish-catalog";
import { FishRequest } from "@/lib/fish-requests";
import { Product } from "@/lib/catalog";
import { activeFishRequestStatuses } from "@/lib/fish-matching";

export default function AdminFishCatalogPage() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [catalog, setCatalog] = useState<FishCatalogItem[]>([]);
  const [aliases, setAliases] = useState<FishAlias[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [requests, setRequests] = useState<FishRequest[]>([]);
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busyKey, setBusyKey] = useState("");

  const load = useCallback(async () => {
    const [catalogResult, aliasResult, productResult, requestResult] = await Promise.all([
      supabase.from("fish_catalog").select("*").order("sort_order").order("name"),
      supabase.from("fish_aliases").select("*").order("alias"),
      supabase.from("products").select("*").order("sort_order"),
      supabase.from("fish_requests").select("*").order("created_at", { ascending: false })
    ]);
    if (catalogResult.error || aliasResult.error || productResult.error || requestResult.error) return setNotice("魚種主檔載入失敗，請確認 F003-6 migration 與管理員權限。");
    setCatalog((catalogResult.data || []) as FishCatalogItem[]);
    setAliases((aliasResult.data || []) as FishAlias[]);
    setProducts((productResult.data || []) as Product[]);
    setRequests((requestResult.data || []) as FishRequest[]);
  }, [supabase]);

  useEffect(() => { supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user.email || null); setAuthReady(true); if (data.session) load(); }); }, [load, supabase]);

  async function createFish(event: FormEvent) {
    event.preventDefault();
    if (!newName.trim()) return setNotice("正式魚種名稱不可空白。");
    setBusyKey("create"); setNotice("");
    const { error } = await supabase.from("fish_catalog").insert({ name: newName.trim(), active: true, sort_order: 100 });
    setBusyKey("");
    if (error) setNotice("新增失敗；請確認名稱未重複且管理員權限有效。");
    else { setNewName(""); setNotice("魚種已新增。"); await load(); }
  }

  function patchFish(id: string, patch: Partial<FishCatalogItem>) {
    setCatalog((current) => current.map((fish) => fish.id === id ? { ...fish, ...patch } : fish));
  }

  async function saveFish(fish: FishCatalogItem) {
    if (!fish.name.trim() || !Number.isInteger(fish.sort_order)) return setNotice("名稱不可空白，排序必須是整數。");
    setBusyKey(fish.id); setNotice("");
    const { error } = await supabase.from("fish_catalog").update({ name: fish.name.trim(), active: fish.active, sort_order: fish.sort_order }).eq("id", fish.id);
    setBusyKey("");
    if (error) setNotice("魚種儲存失敗；請確認名稱未重複。"); else { setNotice(`${fish.name} 已儲存。`); await load(); }
  }

  async function addAlias(fish: FishCatalogItem) {
    const alias = (aliasDrafts[fish.id] || "").trim();
    if (!alias) return setNotice("別名不可空白。");
    setBusyKey(`alias:${fish.id}`); setNotice("");
    const { error } = await supabase.from("fish_aliases").insert({ fish_catalog_id: fish.id, alias });
    setBusyKey("");
    if (error) setNotice("別名新增失敗；同一個別名不可指向不同魚種。");
    else { setAliasDrafts((current) => ({ ...current, [fish.id]: "" })); setNotice("別名已新增。"); await load(); }
  }

  async function removeAlias(alias: FishAlias) {
    setBusyKey(alias.id);
    const { error } = await supabase.from("fish_aliases").delete().eq("id", alias.id);
    setBusyKey("");
    if (error) setNotice("別名移除失敗。"); else { setNotice("別名已移除。"); await load(); }
  }

  const visibleCatalog = catalog.filter((fish) => {
    const keyword = normalizeCatalogTerm(search);
    return !keyword || normalizeCatalogTerm(fish.name).includes(keyword) || aliases.some((alias) => alias.fish_catalog_id === fish.id && normalizeCatalogTerm(alias.alias).includes(keyword));
  });
  const waitingCount = (fish: FishCatalogItem) => requests.filter((request) => activeFishRequestStatuses.includes(request.status) && (request.fish_catalog_id === fish.id || (!request.fish_catalog_id && normalizeCatalogTerm(request.fish_name) === normalizeCatalogTerm(fish.name)))).length;
  const hasProduct = (fish: FishCatalogItem) => products.some((product) => product.fish_catalog_id === fish.id || (!product.fish_catalog_id && normalizeCatalogTerm(product.name) === normalizeCatalogTerm(fish.name)));

  if (!authReady) return <main className="admin"><section className="panel centeredNotice">驗證管理員身分中…</section></main>;
  if (!user) return <main className="admin"><section className="panel centeredNotice"><h1>此頁僅限管理員</h1><Link className="buttonLink" href="/admin">前往登入</Link></section></main>;

  return <main className="admin adminOrdersPage fishCatalogAdminPage">
    <header className="adminTop ordersTop"><div><Link href="/admin">← 商品後台</Link><h1>🐟 魚種管理</h1><p>維護正式魚名與別名；魚種停用後仍保留歷史關聯。</p></div></header>
    <form className="panel fishCatalogCreate" onSubmit={createFish}><label>新增正式魚種 *<input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：馬頭魚" /></label><button disabled={busyKey === "create"}>{busyKey === "create" ? "新增中…" : "新增魚種"}</button></form>
    <section className="panel fishCatalogSearch"><label>搜尋魚種或別名<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="例如：馬頭、甘鯛" /></label></section>
    {notice && <p className="notice centeredNotice" aria-live="polite">{notice}</p>}
    <section className="fishCatalogList">{visibleCatalog.map((fish) => { const fishAliases = aliases.filter((alias) => alias.fish_catalog_id === fish.id); return <article className="panel fishCatalogCard" key={fish.id}>
      <div className="fishCatalogFields"><label>正式名稱<input value={fish.name} onChange={(event) => patchFish(fish.id, { name: event.target.value })} /></label><label>排序<input type="number" step={1} value={fish.sort_order} onChange={(event) => patchFish(fish.id, { sort_order: Number(event.target.value) })} /></label><label className="check"><input type="checkbox" checked={fish.active} onChange={(event) => patchFish(fish.id, { active: event.target.checked })} />{fish.active ? "啟用" : "停用"}</label><button type="button" disabled={busyKey === fish.id} onClick={() => saveFish(fish)}>{busyKey === fish.id ? "儲存中…" : "儲存魚種"}</button></div>
      <div className="fishCatalogMeta"><span>等待需求：<strong>{waitingCount(fish)}</strong></span><span>目前商品：<strong>{hasProduct(fish) ? "有" : "無"}</strong></span></div>
      <div className="fishAliasSection"><strong>別名</strong><div className="fishAliasList">{fishAliases.length ? fishAliases.map((alias) => <span key={alias.id}>{alias.alias}<button type="button" aria-label={`移除別名 ${alias.alias}`} disabled={busyKey === alias.id} onClick={() => removeAlias(alias)}>×</button></span>) : <small>尚無別名</small>}</div><div className="fishAliasAdd"><input aria-label={`新增 ${fish.name} 的別名`} value={aliasDrafts[fish.id] || ""} onChange={(event) => setAliasDrafts((current) => ({ ...current, [fish.id]: event.target.value }))} placeholder="新增別名" /><button type="button" disabled={busyKey === `alias:${fish.id}`} onClick={() => addAlias(fish)}>加入</button></div></div>
    </article>; })}</section>
  </main>;
}

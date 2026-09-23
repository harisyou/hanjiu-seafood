"use client";

import Link from "next/link";
import {useEffect,useMemo,useState} from "react";
import {createClient} from "@/lib/supabase-browser";

export default function FreshnessRulesPage(){
  const db=useMemo(()=>createClient(),[]);
  const [auth,setAuth]=useState<"loading"|"yes"|"no">("loading");
  const [policy,setPolicy]=useState<{max_sale_day:number;version:number}|null>(null);
  const [days,setDays]=useState<{day_offset:number;multiplier:number}[]>([]);
  const [manualRatio,setManualRatio]=useState<number|null>(null);const [notice,setNotice]=useState("");
  useEffect(()=>{db.auth.getSession().then(async({data})=>{if(!data.session){setAuth("no");return;}
    const check=await db.rpc("is_hanjiu_admin");if(check.error||check.data!==true){setAuth("no");return;}setAuth("yes");
    const [p,d,m]=await Promise.all([db.from("phase2_freshness_policy").select("max_sale_day,version").eq("id",1).single(),
      db.from("phase2_freshness_days").select("day_offset,multiplier").order("day_offset"),
      db.from("phase2_manual_price_confirmation_policy").select("max_unconfirmed_deviation_ratio").eq("id",1).single()]);
    if(p.error||d.error||m.error){setNotice("規則載入失敗，請確認管理員權限。");return;}
    setPolicy(p.data);setDays(d.data||[]);setManualRatio(m.data?.max_unconfirmed_deviation_ratio??null);
  });},[db]);
  if(auth==="loading")return <main className="admin">驗證管理員身分中…</main>;
  if(auth==="no")return <main className="admin"><h1>此頁僅限管理員</h1><Link href="/admin">前往登入</Link></main>;
  return <main className="admin weightedPage"><header className="adminTop"><div><Link href="/admin">← 後台首頁</Link><h1>T+N 新鮮度規則</h1><p>現行資料庫規則（唯讀）。價格依每尾魚貨日與台灣曆日動態計算。</p></div></header>
    <section className="panel"><p>{notice}</p>{policy&&<><p>最晚可售：T+{policy.max_sale_day}｜全域設定版本：{policy.version}</p>
      <div className="weightedSummary">{days.map(day=><div key={day.day_offset}>T+{day.day_offset}<strong>{Math.round(day.multiplier*100)}%</strong></div>)}</div>
      <p>人工售價偏差確認門檻：{manualRatio===null?"尚未設定（不自行套用任意百分比）":`${Math.round(manualRatio*10000)/100}%`}</p>
      <p>此頁不提供未審核的直接設定寫入；規則調整須透過受控管理流程及 Audit。</p></>}</section>
  </main>;
}

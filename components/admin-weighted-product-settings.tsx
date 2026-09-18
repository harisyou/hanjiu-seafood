"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {createClient} from "@/lib/supabase-browser";
import type {Product} from "@/lib/catalog";
import type {WeightedTier} from "@/lib/weighted-quick-entry";

type TierForm={id:string|null;lower:number;upper:number;rate:number;sort:number;enabled:boolean;updatedAt:string|null};
const blankTier:TierForm={id:null,lower:300,upper:500,rate:480,sort:0,enabled:true,updatedAt:null};

export default function AdminWeightedProductSettings({productId,onSaved}:{productId:string;onSaved:()=>void}) {
  const db=useMemo(()=>createClient(),[]);
  const [product,setProduct]=useState<Product|null>(null);
  const [tiers,setTiers]=useState<WeightedTier[]>([]);
  const [mode,setMode]=useState<""|"SINGLE_WEIGHTED"|"QUANTITY_VARIANT">("");
  const [minimum,setMinimum]=useState("");
  const [maximum,setMaximum]=useState("");
  const [form,setForm]=useState<TierForm>(blankTier);
  const [reason,setReason]=useState("");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const load=useCallback(async()=>{
    const [p,t]=await Promise.all([
      db.from("products").select("*").eq("id",productId).single(),
      db.from("phase2_weight_pricing_tiers").select("*").eq("product_id",productId).order("sort_order").order("lower_bound_g")
    ]);
    if(p.error||t.error){setNotice("現貨設定載入失敗，請確認 PR-A migration 與管理員權限。");return;}
    const next=p.data as Product;
    setProduct(next);setMode(next.inventory_mode||"");
    setMinimum(next.common_weight_min_g?.toString()||"");setMaximum(next.common_weight_max_g?.toString()||"");
    setTiers((t.data||[]) as WeightedTier[]);
  },[db,productId]);
  useEffect(()=>{load();},[load]);

  async function saveSettings(){
    if(!product?.updated_at||!reason.trim())return setNotice("請填寫變更原因；若商品已由他人修改，請先重新載入。");
    const min=minimum===""?null:Number(minimum),max=maximum===""?null:Number(maximum);
    if((min===null)!==(max===null)|| (min!==null&&max!==null&&(!Number.isInteger(min)||!Number.isInteger(max)||min<=0||max<min)))return setNotice("常見重量範圍請同時填寫有效的最小與最大克數。");
    setBusy(true);setNotice("");
    const {error}=await db.rpc("admin_update_weighted_product_settings",{
      p_product_id:productId,p_expected_updated_at:product.updated_at,p_mode:mode||null,
      p_common_weight_min_g:min,p_common_weight_max_g:max,p_reason:reason.trim()
    });
    setBusy(false);
    if(error)return setNotice(`現貨設定未儲存：${error.message}。若有現貨、規格數量或未完結訂單，DB 會拒絕切換模式。`);
    setReason("");setNotice("現貨設定已儲存。");await load();onSaved();
  }

  async function saveTier(){
    if(!reason.trim())return setNotice("請填寫價格級距變更原因。");
    if(!Number.isInteger(form.lower)||!Number.isInteger(form.upper)||form.lower<=0||form.upper<=form.lower||!Number.isInteger(form.rate)||form.rate<=0)return setNotice("級距與每台斤價格必須是有效正整數，且上限大於下限。");
    setBusy(true);setNotice("");
    const {error}=await db.rpc("admin_save_weight_pricing_tier",{
      p_product_id:productId,p_lower_bound_g:form.lower,p_upper_bound_g:form.upper,
      p_price_per_jin:form.rate,p_sort_order:form.sort,p_enabled:form.enabled,p_reason:reason.trim(),
      p_tier_id:form.id,p_expected_updated_at:form.updatedAt
    });
    setBusy(false);
    if(error)return setNotice(error.message.includes("weight_pricing_tier_overlap")?"啟用級距不可與其他啟用級距重疊。":`級距未儲存：${error.message}`);
    setForm(blankTier);setReason("");setNotice("重量價格級距已儲存。");await load();
  }

  const active=[...tiers].filter(t=>t.enabled).sort((a,b)=>a.lower_bound_g-b.lower_bound_g);
  const gaps=active.slice(1).flatMap((tier,index)=>active[index].upper_bound_g<tier.lower_bound_g?[`${active[index].upper_bound_g}–${tier.lower_bound_g-1}g`]:[]);
  return <section className="panel weightedSettings"><h2>現貨設定 → 重量價格級距</h2>
    <p>每尾以魚貨處理前克數計價；1 台斤＝600g。區間採下限含、上限不含，停用級距保留歷史，舊現貨定價快照不會重算。</p>
    <label>現貨模式<select value={mode} onChange={e=>setMode(e.target.value as typeof mode)}><option value="">尚未設定（legacy）</option><option value="SINGLE_WEIGHTED">單件秤重型</option><option value="QUANTITY_VARIANT">規格數量型</option></select></label>
    <div className="weightedTwo"><label>常見最小重量（g，選填）<input type="number" min="1" value={minimum} onChange={e=>setMinimum(e.target.value)}/></label><label>常見最大重量（g，選填）<input type="number" min="1" value={maximum} onChange={e=>setMaximum(e.target.value)}/></label></div>
    <label>變更原因 *<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="例如：切換為單尾秤重販售"/></label>
    <button type="button" disabled={busy||!product} onClick={saveSettings}>儲存現貨模式與重量範圍</button>
    {mode==="SINGLE_WEIGHTED"&&product?.inventory_mode==="SINGLE_WEIGHTED"&&<div className="weightedTierSection"><h3>重量價格級距</h3>
      {gaps.length>0&&<p role="status" className="weightedWarning">未定價空檔：{gaps.join("、")}。快速上架不會猜價，需補級距或明確輸入 manual T+0。</p>}
      <div className="weightedTierList">{tiers.map(t=><div key={t.id}><span>{t.lower_bound_g}–{t.upper_bound_g-1}g｜NT${t.price_per_jin}/台斤｜{t.enabled?"啟用":"停用"}｜排序 {t.sort_order}</span><button type="button" disabled={busy} onClick={()=>setForm({id:t.id,lower:t.lower_bound_g,upper:t.upper_bound_g,rate:t.price_per_jin,sort:t.sort_order,enabled:t.enabled,updatedAt:t.updated_at||null})}>編輯</button></div>)}</div>
      <h4>{form.id?"編輯級距":"新增級距"}</h4><div className="weightedTierFields"><label>下限 g（含）<input type="number" value={form.lower} onChange={e=>setForm({...form,lower:Number(e.target.value)})}/></label><label>上限 g（不含）<input type="number" value={form.upper} onChange={e=>setForm({...form,upper:Number(e.target.value)})}/></label><label>NT$/台斤<input type="number" value={form.rate} onChange={e=>setForm({...form,rate:Number(e.target.value)})}/></label><label>排序<input type="number" value={form.sort} onChange={e=>setForm({...form,sort:Number(e.target.value)})}/></label></div>
      <label className="check"><input type="checkbox" checked={form.enabled} onChange={e=>setForm({...form,enabled:e.target.checked})}/>啟用此級距</label>
      <div className="weightedActions"><button type="button" disabled={busy} onClick={saveTier}>{form.id?"儲存級距":"新增級距"}</button>{form.id&&<button type="button" onClick={()=>setForm(blankTier)}>取消編輯</button>}</div>
    </div>}
    <p role="status" aria-live="polite">{notice}</p>
  </section>;
}

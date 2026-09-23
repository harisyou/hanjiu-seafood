"use client";

import Link from "next/link";
import {useParams} from "next/navigation";
import {useCallback,useEffect,useMemo,useState} from "react";
import {createClient} from "@/lib/supabase-browser";
import {imageSource} from "@/lib/catalog-content";
import type {ProductImage} from "@/lib/catalog";
import {dayOffset,taiwanDate} from "@/lib/weighted-quick-entry";

type Stock={id:string;stock_code:string;product_id:string;raw_weight_g:number;fish_date:string;
  pricing_tier_id:string|null;price_per_jin_snapshot:number|null;system_base_price:number|null;
  manual_base_price:number|null;manual_price_confirmed:boolean;t0_base_price:number;status:string;
  batch_id:string|null;batch_reference:string|null;version:number;created_at:string};

export default function WeightedStockDetailPage(){
  const {id}=useParams<{id:string}>();const db=useMemo(()=>createClient(),[]);
  const [auth,setAuth]=useState<"loading"|"yes"|"no">("loading");const [stock,setStock]=useState<Stock|null>(null);
  const [productName,setProductName]=useState("");const [productEligible,setProductEligible]=useState(true);const [photo,setPhoto]=useState<string|null>(null);
  const [day,setDay]=useState(()=>taiwanDate());const [days,setDays]=useState<{day_offset:number;multiplier:number}[]>([]);const [maxDay,setMaxDay]=useState(2);const [notice,setNotice]=useState("");
  const [reason,setReason]=useState("");const [busy,setBusy]=useState(false);
  useEffect(()=>{const timer=setInterval(()=>setDay(taiwanDate()),60000);return()=>clearInterval(timer);},[]);
  const load=useCallback(async()=>{
    const result=await db.from("phase2_weighted_stock").select("*").eq("id",id).single();
    if(result.error){setNotice("找不到此尾現貨或沒有權限。");return;}const row=result.data as Stock;setStock(row);
    const [p,photoResult,galleryResult,dayResult,policyResult]=await Promise.all([
      db.from("products").select("name,image_url,status,inventory_mode").eq("id",row.product_id).single(),
      db.from("phase2_stock_photos").select("storage_path").eq("stock_id",id).maybeSingle(),
      db.from("product_images").select("*").eq("product_id",row.product_id).eq("is_primary",true).maybeSingle(),
      db.from("phase2_freshness_days").select("day_offset,multiplier"),
      db.from("phase2_freshness_policy").select("max_sale_day").eq("id",1).single()
    ]);
    setProductName(p.data?.name||"");setProductEligible(p.data?.status==="available"&&p.data?.inventory_mode==="SINGLE_WEIGHTED");if(photoResult.data)setPhoto(db.storage.from("product-images").getPublicUrl(photoResult.data.storage_path).data.publicUrl);
    else setPhoto(galleryResult.data?imageSource(galleryResult.data as ProductImage,process.env.NEXT_PUBLIC_SUPABASE_URL||""):p.data?.image_url||null);
    setDays(dayResult.data||[]);
    setMaxDay(policyResult.data?.max_sale_day??2);
  },[db,id]);
  useEffect(()=>{db.auth.getSession().then(async({data})=>{if(!data.session){setAuth("no");return;}const check=await db.rpc("is_hanjiu_admin");
    if(check.error||check.data!==true){setAuth("no");return;}setAuth("yes");await load();});},[db,load]);
  async function act(action:"unlist"|"relist"){
    if(!stock||!reason.trim()||busy)return setNotice("請填寫非空白原因。");
    const label=action==="unlist"?"下架":"重新上架";
    if(!window.confirm(`確定要${label} ${stock.stock_code}？\n\n原因：${reason.trim()}`))return;
    setBusy(true);setNotice("");
    const result=await db.rpc(action==="unlist"?"admin_unlist_weighted_stock":"admin_relist_weighted_stock",{
      p_stock_id:stock.id,p_expected_version:stock.version,p_reason:reason.trim()});
    setBusy(false);
    if(result.error){setNotice(`${label}失敗：${result.error.message}。資料可能已由其他管理員更新，請重新確認。`);await load();return;}
    setReason("");setNotice(`${label}成功。`);await load();
  }
  if(auth==="loading")return <main className="admin">驗證管理員身分中…</main>;
  if(auth==="no")return <main className="admin"><h1>此頁僅限管理員</h1><Link href="/admin">前往登入</Link></main>;
  if(!stock)return <main className="admin"><Link href="/admin/weighted">← 現貨管理</Link><p>{notice||"載入中…"}</p></main>;
  const offset=dayOffset(stock.fish_date,day);
  const multiplier=days.find(item=>item.day_offset===offset)?.multiplier??null;
  const current=stock.status==="sellable"&&offset!==null&&offset>=0&&offset<=maxDay&&multiplier!==null?Math.round(stock.t0_base_price*multiplier):null;
  const relistPrice=offset!==null&&offset>=0&&offset<=maxDay&&multiplier!==null&&productEligible?Math.round(stock.t0_base_price*multiplier):null;
  const statusLabel=stock.status==="sellable"?"可售":stock.status==="manually_unlisted"?"手動下架":stock.status;
  return <main className="admin weightedPage"><header className="adminTop"><div><Link href={stock.batch_id?`/admin/weighted?batch=${stock.batch_id}`:"/admin/weighted"}>← 現貨管理</Link><h1>{stock.stock_code}</h1><p>{productName}｜單尾現貨唯讀明細</p></div></header>
    <section className="panel weightedDetail">{photo&&<img src={photo} alt={`${productName}單尾照片`}/>}<dl>
      <div><dt>魚貨日期／重量</dt><dd>{stock.fish_date}｜{stock.raw_weight_g}g</dd></div>
      <div><dt>建立時級距</dt><dd>{stock.pricing_tier_id||"無級距／人工定價"}</dd></div>
      <div><dt>每台斤價格快照</dt><dd>{stock.price_per_jin_snapshot==null?"—":`NT$${stock.price_per_jin_snapshot}`}</dd></div>
      <div><dt>系統 T+0 價格快照</dt><dd>{stock.system_base_price==null?"—":`NT$${stock.system_base_price}`}</dd></div>
      <div><dt>人工 T+0 價格</dt><dd>{stock.manual_base_price==null?"未設定":`NT$${stock.manual_base_price}｜${stock.manual_price_confirmed?"已明確確認":"未要求額外確認"}`}</dd></div>
      <div><dt>有效 T+0 基價</dt><dd>NT${stock.t0_base_price}</dd></div>
      <div><dt>目前 T+N／售價</dt><dd>T+{offset??"?"}｜{current==null?"不可售":`NT$${current}`}</dd></div>
      <div><dt>狀態／版本</dt><dd>{statusLabel}｜v{stock.version}</dd></div>
      <div><dt>批次</dt><dd>{stock.batch_reference||"未歸批"}</dd></div>
      <div><dt>建立時間</dt><dd>{stock.created_at}</dd></div>
    </dl><p>正式現貨不可刪除；此頁只提供手動下架與符合新鮮度規則的重新上架。外售與其他狀態處置由後續受控流程提供。</p></section>
    {(stock.status==="sellable"||stock.status==="manually_unlisted")&&<section className="panel weightedDetail weightedStockAction"><h2>{stock.status==="sellable"?"手動下架":"重新上架"}</h2>
      {stock.status==="manually_unlisted"&&(relistPrice===null?<p className="weightedError">目前不可重新上架：{!productEligible?"商品未開放販售或已非單件秤重模式":offset===null||offset<0?"魚貨日期無效":"已超過目前新鮮度規則或缺少當日倍率"}。</p>:<p>目前 T+{offset}，重新上架後售價為 NT${relistPrice}；建立時價格快照不會改變。</p>)}
      {(stock.status==="sellable"||relistPrice!==null)&&<><label>原因 *<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={1000}/></label><button type="button" disabled={busy||!reason.trim()} onClick={()=>act(stock.status==="sellable"?"unlist":"relist")}>{busy?"處理中…":stock.status==="sellable"?"確認下架":"確認重新上架"}</button></>}
    </section>}
    {notice&&<p className="notice" role="status">{notice}</p>}
  </main>;
}

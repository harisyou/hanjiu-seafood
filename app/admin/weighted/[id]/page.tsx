"use client";

import Link from "next/link";
import {useParams} from "next/navigation";
import {useEffect,useMemo,useState} from "react";
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
  const [productName,setProductName]=useState("");const [photo,setPhoto]=useState<string|null>(null);
  const [day,setDay]=useState(()=>taiwanDate());const [days,setDays]=useState<{day_offset:number;multiplier:number}[]>([]);const [maxDay,setMaxDay]=useState(2);const [notice,setNotice]=useState("");
  useEffect(()=>{const timer=setInterval(()=>setDay(taiwanDate()),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{db.auth.getSession().then(async({data})=>{if(!data.session){setAuth("no");return;}const check=await db.rpc("is_hanjiu_admin");
    if(check.error||check.data!==true){setAuth("no");return;}setAuth("yes");
    const result=await db.from("phase2_weighted_stock").select("*").eq("id",id).single();
    if(result.error){setNotice("找不到此尾現貨或沒有權限。");return;}const row=result.data as Stock;setStock(row);
    const [p,photoResult,galleryResult,dayResult,policyResult]=await Promise.all([
      db.from("products").select("name,image_url").eq("id",row.product_id).single(),
      db.from("phase2_stock_photos").select("storage_path").eq("stock_id",id).maybeSingle(),
      db.from("product_images").select("*").eq("product_id",row.product_id).eq("is_primary",true).maybeSingle(),
      db.from("phase2_freshness_days").select("day_offset,multiplier"),
      db.from("phase2_freshness_policy").select("max_sale_day").eq("id",1).single()
    ]);
    setProductName(p.data?.name||"");if(photoResult.data)setPhoto(db.storage.from("product-images").getPublicUrl(photoResult.data.storage_path).data.publicUrl);
    else setPhoto(galleryResult.data?imageSource(galleryResult.data as ProductImage,process.env.NEXT_PUBLIC_SUPABASE_URL||""):p.data?.image_url||null);
    setDays(dayResult.data||[]);
    setMaxDay(policyResult.data?.max_sale_day??2);
  });},[db,id]);
  if(auth==="loading")return <main className="admin">驗證管理員身分中…</main>;
  if(auth==="no")return <main className="admin"><h1>此頁僅限管理員</h1><Link href="/admin">前往登入</Link></main>;
  if(!stock)return <main className="admin"><Link href="/admin/weighted">← 現貨管理</Link><p>{notice||"載入中…"}</p></main>;
  const offset=dayOffset(stock.fish_date,day);
  const multiplier=days.find(item=>item.day_offset===offset)?.multiplier??null;
  const current=stock.status==="sellable"&&offset!==null&&offset>=0&&offset<=maxDay&&multiplier!==null?Math.round(stock.t0_base_price*multiplier):null;
  return <main className="admin weightedPage"><header className="adminTop"><div><Link href={stock.batch_id?`/admin/weighted?batch=${stock.batch_id}`:"/admin/weighted"}>← 現貨管理</Link><h1>{stock.stock_code}</h1><p>{productName}｜單尾現貨唯讀明細</p></div></header>
    <section className="panel weightedDetail">{photo&&<img src={photo} alt={`${productName}單尾照片`}/>}<dl>
      <div><dt>魚貨日期／重量</dt><dd>{stock.fish_date}｜{stock.raw_weight_g}g</dd></div>
      <div><dt>建立時級距</dt><dd>{stock.pricing_tier_id||"無級距／人工定價"}</dd></div>
      <div><dt>每台斤價格快照</dt><dd>{stock.price_per_jin_snapshot==null?"—":`NT$${stock.price_per_jin_snapshot}`}</dd></div>
      <div><dt>系統 T+0 價格快照</dt><dd>{stock.system_base_price==null?"—":`NT$${stock.system_base_price}`}</dd></div>
      <div><dt>人工 T+0 價格</dt><dd>{stock.manual_base_price==null?"未設定":`NT$${stock.manual_base_price}｜${stock.manual_price_confirmed?"已明確確認":"未要求額外確認"}`}</dd></div>
      <div><dt>有效 T+0 基價</dt><dd>NT${stock.t0_base_price}</dd></div>
      <div><dt>目前 T+N／售價</dt><dd>T+{offset??"?"}｜{current==null?"不可售":`NT$${current}`}</dd></div>
      <div><dt>狀態／版本</dt><dd>{stock.status}｜v{stock.version}</dd></div>
      <div><dt>批次</dt><dd>{stock.batch_reference||"未歸批"}</dd></div>
      <div><dt>建立時間</dt><dd>{stock.created_at}</dd></div>
    </dl><p>正式現貨不可刪除；下架、修正、外售等受控動作由後續 PR 提供。</p></section>
  </main>;
}

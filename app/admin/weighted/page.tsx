"use client";

import Link from "next/link";
import {Suspense,useCallback,useEffect,useMemo,useState} from "react";
import {useSearchParams} from "next/navigation";
import {createClient} from "@/lib/supabase-browser";
import {imageSource} from "@/lib/catalog-content";
import type {ProductImage} from "@/lib/catalog";
import {dayOffset,taiwanDate} from "@/lib/weighted-quick-entry";

type Stock={id:string;stock_code:string;product_id:string;raw_weight_g:number;fish_date:string;t0_base_price:number;
  system_base_price:number|null;manual_base_price:number|null;status:string;batch_id:string|null;batch_line_no:number|null;representative_image_id:string|null};
type Product={id:string;name:string;image_url:string|null};
type Batch={id:string;name:string};
type Photo={stock_id:string;storage_path:string};
const money=(price:number|null)=>price===null?"不可售":`NT$${price.toLocaleString("zh-TW")}`;

function WeightedStockManagementContent(){
  const db=useMemo(()=>createClient(),[]);const params=useSearchParams();const batchFilter=params.get("batch")||"";
  const [auth,setAuth]=useState<"loading"|"yes"|"no">("loading");const [notice,setNotice]=useState("");
  const [stocks,setStocks]=useState<Stock[]>([]);const [products,setProducts]=useState<Product[]>([]);
  const [batches,setBatches]=useState<Batch[]>([]);const [photos,setPhotos]=useState<Photo[]>([]);const [gallery,setGallery]=useState<ProductImage[]>([]);
  const [days,setDays]=useState<{day_offset:number;multiplier:number}[]>([]);const [maxDay,setMaxDay]=useState(2);
  const [today,setToday]=useState(()=>taiwanDate());const [search,setSearch]=useState("");
  const load=useCallback(async()=>{
    let stockQuery=db.from("phase2_weighted_stock").select("id,stock_code,product_id,raw_weight_g,fish_date,t0_base_price,system_base_price,manual_base_price,status,batch_id,batch_line_no,representative_image_id");
    if(batchFilter)stockQuery=stockQuery.eq("batch_id",batchFilter);
    const results=await Promise.all([
      stockQuery.order("created_at",{ascending:false}).limit(300),
      db.from("products").select("id,name,image_url"),
      db.from("phase2_stock_batches").select("id,name").order("created_at",{ascending:false}).limit(100),
      db.from("phase2_stock_photos").select("stock_id,storage_path"),
      db.from("product_images").select("*").eq("is_primary",true),
      db.from("phase2_freshness_days").select("day_offset,multiplier"),
      db.from("phase2_freshness_policy").select("max_sale_day").eq("id",1).single()
    ]);
    if(results.some(result=>result.error)){setNotice("現貨資料載入失敗，請確認 F006-2 與管理員權限。");return;}
    setStocks((results[0].data||[]) as Stock[]);setProducts((results[1].data||[]) as Product[]);setBatches((results[2].data||[]) as Batch[]);
    setPhotos((results[3].data||[]) as Photo[]);setGallery((results[4].data||[]) as ProductImage[]);
    setDays(results[5].data||[]);setMaxDay(results[6].data?.max_sale_day??2);
  },[db,batchFilter]);
  useEffect(()=>{db.auth.getSession().then(async({data})=>{if(!data.session){setAuth("no");return;}const check=await db.rpc("is_hanjiu_admin");
    if(check.error||check.data!==true){setAuth("no");return;}setAuth("yes");load();});},[db,load]);
  useEffect(()=>{const timer=setInterval(()=>setToday(taiwanDate()),60000);return()=>clearInterval(timer);},[]);
  const visible=stocks.filter(stock=>(!batchFilter||stock.batch_id===batchFilter)&&
    (!search||`${stock.stock_code} ${products.find(p=>p.id===stock.product_id)?.name||""}`.toLowerCase().includes(search.toLowerCase())));
  function current(stock:Stock){const offset=dayOffset(stock.fish_date,today);const multiplier=days.find(day=>day.day_offset===offset)?.multiplier;
    return stock.status==="sellable"&&offset!==null&&offset>=0&&offset<=maxDay&&multiplier!=null?Math.round(stock.t0_base_price*multiplier):null;}
  function photo(stock:Stock){const direct=photos.find(item=>item.stock_id===stock.id);
    if(direct)return db.storage.from("product-images").getPublicUrl(direct.storage_path).data.publicUrl;
    const image=gallery.find(item=>item.product_id===stock.product_id);
    return image?imageSource(image,process.env.NEXT_PUBLIC_SUPABASE_URL||""):products.find(item=>item.id===stock.product_id)?.image_url||null;}
  if(auth==="loading")return <main className="admin"><p>驗證管理員身分中…</p></main>;
  if(auth==="no")return <main className="admin"><h1>此頁僅限管理員</h1><Link href="/admin">前往登入</Link></main>;
  return <main className="admin weightedPage"><header className="adminTop"><div><Link href="/admin">← 後台首頁</Link><h1>單尾現貨管理</h1><p>正式現貨不可刪除。此頁提供檢視與 batch 篩選；狀態處置留給後續受控 action。</p></div><Link className="buttonLink" href="/admin/weighted/quick-entry">＋ 今日魚貨快速上架</Link></header>
    {notice&&<p className="notice" role="status">{notice}</p>}
    <section className="panel weightedFilters"><label>搜尋 stock code／商品<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label><label>批次<select value={batchFilter} onChange={e=>window.location.href=e.target.value?`/admin/weighted?batch=${e.target.value}`:"/admin/weighted"}><option value="">全部批次</option>{batches.map(batch=><option key={batch.id} value={batch.id}>{batch.name}</option>)}</select></label><button type="button" onClick={load}>重新整理</button></section>
    <p>顯示 {visible.length} 尾（最近 300 尾）；目前價格依台灣日期與即時 T+N 規則計算。</p>
    <div className="weightedStockCards">{visible.map(stock=><Link className="panel weightedStockCard" key={stock.id} href={`/admin/weighted/${stock.id}`}>
      <div className="weightedStockImage">{photo(stock)?<img src={photo(stock)!} alt="單尾魚貨或商品主圖"/>:<span>🐟</span>}</div>
      <div><strong>{stock.stock_code}</strong><h2>{products.find(p=>p.id===stock.product_id)?.name||"商品資料不可用"}</h2><p>{stock.raw_weight_g}g｜魚貨日 {stock.fish_date}｜T+{dayOffset(stock.fish_date,today)??"?"}</p><p>系統基價 {money(stock.system_base_price)}｜T+0 {money(stock.t0_base_price)}</p><p>目前售價 <b>{money(current(stock))}</b>｜{stock.status}</p><small>{batches.find(batch=>batch.id===stock.batch_id)?.name||"未歸批"}</small></div>
    </Link>)}{visible.length===0&&<section className="panel">沒有符合條件的單尾現貨。</section>}</div>
  </main>;
}

export default function WeightedStockManagementPage(){
  return <Suspense fallback={<main className="admin">載入現貨管理中…</main>}><WeightedStockManagementContent/></Suspense>;
}

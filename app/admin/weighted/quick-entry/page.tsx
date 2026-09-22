"use client";

import Link from "next/link";
import {useCallback,useEffect,useId,useMemo,useRef,useState} from "react";
import {createClient} from "@/lib/supabase-browser";
import {dayOffset,duplicateWeightWarnings,gramsFromJinLiang,gramsLabel,jinLiangInputsForGrams,rowQuote,taiwanDate} from "@/lib/weighted-quick-entry";
import type {EntryRow,FreshnessDay,FreshnessPolicy,WeightedProduct,WeightedTier} from "@/lib/weighted-quick-entry";
import {saveOptionalStockPhotos} from "@/lib/weighted-stock-photo";

type Product=WeightedProduct&{status:string};
type Row=EntryRow&{id:string;photo:File|null;photoToken:string;inputMode:"grams"|"jin";jin:string;liang:string;needsReconfirm:boolean};
type Batch={id:string;name:string;stock_count:number;source:string|null;created_at:string};
type Stock={id:string;stock_code:string;product_id:string;raw_weight_g:number;fish_date:string;t0_base_price:number;batch_line_no:number;status:string};
type Pending={submissionId:string;items:EntryRow[];source:string;note:string;version:number};
const pendingKey="phase2-weighted-quick-entry-pending";
const blank=(date:string,productId=""):Row=>({id:crypto.randomUUID(),product_id:productId,raw_weight_g:"",fish_date:date,
  manual_base_price:"",manual_price_confirmed:false,photo:null,photoToken:crypto.randomUUID(),inputMode:"grams",jin:"",liang:"",needsReconfirm:false});
const money=(value:number|null)=>value===null?"—":`NT$${value.toLocaleString("zh-TW")}`;

function ProductPicker({products,value,onSelect}:{products:Product[];value:string;onSelect:(id:string)=>void}){
  const listId=useId();
  const [query,setQuery]=useState("");const [open,setOpen]=useState(false);const [index,setIndex]=useState(0);
  const selected=products.find(product=>product.id===value);
  const matching=products.filter(product=>product.name.toLowerCase().includes(query.toLowerCase())).slice(0,12);
  return <div className="weightedPicker"><input role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
    placeholder="搜尋商品（可用 ↑↓ Enter）" value={open?query:selected?.name||query}
    onFocus={()=>{setQuery("");setOpen(true);setIndex(0);}}
    onChange={event=>{setQuery(event.target.value);setOpen(true);setIndex(0);}}
    onBlur={()=>setTimeout(()=>setOpen(false),120)}
    onKeyDown={event=>{if(!open)return;if(event.key==="ArrowDown"){event.preventDefault();setIndex(Math.min(index+1,matching.length-1));}
      else if(event.key==="ArrowUp"){event.preventDefault();setIndex(Math.max(0,index-1));}
      else if(event.key==="Enter"&&matching[index]){event.preventDefault();const product=matching[index];if(product.inventory_mode==="SINGLE_WEIGHTED"&&product.status==="available"){onSelect(product.id);setQuery("");setOpen(false);}}
      else if(event.key==="Escape")setOpen(false);}}/>
    {open&&<div className="weightedPickerMenu" id={listId} role="listbox">{matching.length===0?<span>找不到商品</span>:matching.map((product,i)=>{
      const eligible=product.inventory_mode==="SINGLE_WEIGHTED"&&product.status==="available";
      const why=product.inventory_mode==="QUANTITY_VARIANT"?"規格數量型":product.inventory_mode===null?"尚未設定現貨模式":product.status!=="available"?"商品未開放販售":"";
      return <button key={product.id} type="button" role="option" aria-selected={i===index} disabled={!eligible}
        className={i===index?"isActive":""} onMouseDown={event=>event.preventDefault()} onClick={()=>{onSelect(product.id);setQuery("");setOpen(false);}}>{product.name}{why&&<small>｜{why}（至商品設定處理）</small>}</button>;
    })}</div>}
  </div>;
}

async function compressPhoto(file:File){
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)||file.size>20*1024*1024)throw new Error("照片需為 20MB 以下 JPG、PNG 或 WebP。");
  const url=URL.createObjectURL(file);
  try {const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error("照片讀取失敗"));img.src=url;});
    const ratio=Math.min(1,1800/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));
    const context=canvas.getContext("2d");if(!context)throw new Error("無法處理照片");context.drawImage(image,0,0,canvas.width,canvas.height);
    return await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("照片壓縮失敗")),"image/webp",.82));
  } finally {URL.revokeObjectURL(url);}
}

export default function WeightedQuickEntryPage(){
  const db=useMemo(()=>createClient(),[]);const [today,setToday]=useState(()=>taiwanDate());
  const [auth,setAuth]=useState<"loading"|"yes"|"no">("loading");
  const [products,setProducts]=useState<Product[]>([]);const [tiers,setTiers]=useState<WeightedTier[]>([]);
  const [days,setDays]=useState<FreshnessDay[]>([]);const [policy,setPolicy]=useState<FreshnessPolicy|null>(null);
  const [rows,setRows]=useState<Row[]>(()=>[blank(taiwanDate())]);const [source,setSource]=useState("");const [note,setNote]=useState("");
  const [step,setStep]=useState<"edit"|"review"|"success">("edit");const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");const [batch,setBatch]=useState<Batch|null>(null);const [stocks,setStocks]=useState<Stock[]>([]);
  const [lastProducts,setLastProducts]=useState<string[]>([]);const [recentProducts,setRecentProducts]=useState<string[]>([]);
  const [submissionId,setSubmissionId]=useState(()=>crypto.randomUUID());const [uncertain,setUncertain]=useState<Pending|null>(null);
  const [photoFailures,setPhotoFailures]=useState<number[]>([]);const weightRefs=useRef<Record<string,HTMLInputElement|null>>({});
  const dirty=step!=="success"&&(Boolean(source||note)||rows.some(row=>row.product_id||row.raw_weight_g||row.manual_base_price||row.photo));

  const load=useCallback(async()=>{
    const authResult=await db.rpc("is_hanjiu_admin");
    if(authResult.error||authResult.data!==true){setAuth("no");return;}
    setAuth("yes");
    const [p,t,d,pol,manual,b]=await Promise.all([
      db.from("products").select("id,name,status,inventory_mode,common_weight_min_g,common_weight_max_g").order("name"),
      db.from("phase2_weight_pricing_tiers").select("*").order("lower_bound_g"),
      db.from("phase2_freshness_days").select("day_offset,multiplier").order("day_offset"),
      db.from("phase2_freshness_policy").select("max_sale_day,version").eq("id",1).single(),
      db.from("phase2_manual_price_confirmation_policy").select("max_unconfirmed_deviation_ratio").eq("id",1).single(),
      db.from("phase2_stock_batches").select("id").order("created_at",{ascending:false}).limit(1)
    ]);
    if([p,t,d,pol,manual,b].some(result=>result.error)){setNotice("現貨資料載入失敗，請確認 F006-2 已部署與管理員權限。");return;}
    setProducts((p.data||[]) as Product[]);setTiers((t.data||[]) as WeightedTier[]);setDays((d.data||[]) as FreshnessDay[]);
    setPolicy({...pol.data,max_unconfirmed_deviation_ratio:manual.data?.max_unconfirmed_deviation_ratio} as FreshnessPolicy);
    if(b.data?.[0]){const last=await db.from("phase2_weighted_stock").select("product_id").eq("batch_id",b.data[0].id).order("batch_line_no");
      if(!last.error)setLastProducts([...new Set((last.data||[]).map(item=>item.product_id))]);}
    try {setRecentProducts(JSON.parse(localStorage.getItem("phase2-recent-weighted-products")||"[]"));}catch{/* local shortcut only */}
  },[db]);
  useEffect(()=>{db.auth.getSession().then(({data})=>{if(!data.session){setAuth("no");return;}load();});},[db,load]);
  useEffect(()=>{const timer=setInterval(()=>setToday(taiwanDate()),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{try{const raw=sessionStorage.getItem(pendingKey);if(raw){const pending=JSON.parse(raw) as Pending;setUncertain(pending);setSubmissionId(pending.submissionId);setSource(pending.source);setNote(pending.note);
    setRows(pending.items.map(item=>({...blank(item.fish_date,item.product_id),...item,raw_weight_g:String(item.raw_weight_g),manual_base_price:item.manual_base_price==null?"":String(item.manual_base_price)})));
    setNotice("前次上架結果尚未確認。請以相同提交編號重試，系統不會重複建立現貨。");setStep("review");}}catch{/* session shortcut only */}},[]);
  useEffect(()=>{const handler=(event:BeforeUnloadEvent)=>{if(dirty||uncertain){event.preventDefault();event.returnValue="尚有未上架的魚貨，離開後將遺失。";}};
    window.addEventListener("beforeunload",handler);return()=>window.removeEventListener("beforeunload",handler);},[dirty,uncertain]);

  function updateRow(id:string,patch:Partial<Row>){setRows(current=>current.map(row=>row.id===id?{...row,...patch}:row));}
  function changeWeightMode(row:Row,inputMode:Row["inputMode"]){
    if(inputMode!=="jin"){updateRow(row.id,{inputMode});return;}
    updateRow(row.id,{inputMode,...jinLiangInputsForGrams(Number(row.raw_weight_g),row.jin,row.liang)});
  }
  function selectProduct(id:string,productId:string){updateRow(id,{product_id:productId,manual_price_confirmed:false,needsReconfirm:true});
    const next=[productId,...recentProducts.filter(value=>value!==productId)].slice(0,6);setRecentProducts(next);localStorage.setItem("phase2-recent-weighted-products",JSON.stringify(next));}
  function addRow(){const last=rows.at(-1);const next=blank(last?.fish_date||today,last?.product_id||"");setRows(current=>[...current,next]);setTimeout(()=>weightRefs.current[next.id]?.focus(),0);}
  const quotes=rows.map(row=>rowQuote(row,products.find(product=>product.id===row.product_id)||null,tiers,days,policy,today));
  const duplicateWarnings=duplicateWeightWarnings(rows,products);
  const rowErrors=quotes.map((quote,i)=>[...quote.errors,...(rows[i].needsReconfirm&&rows[i].manual_base_price!==""&&!rows[i].manual_price_confirmed?["重量或商品已變更，請重新確認人工價格"]:[])]);
  const hardErrors=rowErrors.some(errors=>errors.length>0);
  const warnings=quotes.reduce((n,quote)=>n+quote.warnings.length,0)+duplicateWarnings.filter(Boolean).length;
  const grouped=rows.reduce<Record<string,number>>((out,row)=>({...out,[row.product_id]:(out[row.product_id]||0)+1}),{});
  function review(){if(hardErrors){setNotice("請先修正標示的 hard error，再進入確認畫面。");return;}setNotice("");setStep("review");window.scrollTo({top:0,behavior:"smooth"});}
  function leave(href:string){if(!dirty&&!uncertain||window.confirm("尚有未上架的魚貨，離開後將遺失。\n\n確定離開？"))window.location.href=href;}

  async function uploadPhotos(created:Stock[],onlyIndexes?:number[]){
    const retrySet=onlyIndexes?new Set(onlyIndexes):null;
    const tasks=rows.flatMap((row,index)=>{const stock=created.find(item=>item.batch_line_no===index+1);
      return row.photo&&stock&&(!retrySet||retrySet.has(index))?[{index,stockId:stock.id,photoToken:row.photoToken,photo:row.photo}]:[];});
    const failed=await saveOptionalStockPhotos(tasks,{prepare:compressPhoto,
      upload:async(path,blob)=>{const uploaded=await db.storage.from("product-images").upload(path,blob,{contentType:"image/webp",upsert:false});if(uploaded.error)throw uploaded.error;},
      link:async(stockId,path)=>{const linked=await db.rpc("admin_link_weighted_stock_photo",{p_stock_id:stockId,p_storage_path:path});if(linked.error)throw linked.error;}});
    setPhotoFailures(failed);if(failed.length)setNotice(`現貨已建立；${failed.length} 張選填照片未完成，請重試。照片失敗不影響庫存。`);
    else if(onlyIndexes?.length)setNotice("選填照片重試完成；現貨資料未重新建立。");
  }

  async function submit(){if(busy||!policy||hardErrors)return;
    setBusy(true);setNotice("");
    const items=uncertain?.items||rows.map((row,i)=>({product_id:row.product_id,raw_weight_g:Number(row.raw_weight_g),fish_date:row.fish_date,
      manual_base_price:row.manual_base_price===""?null:Number(row.manual_base_price),manual_price_confirmed:row.manual_price_confirmed,
      expected_tier_id:quotes[i].tier?.id||null,expected_system_base_price:quotes[i].system}));
    const pending=uncertain||{submissionId,items,source,note,version:policy.version};
    sessionStorage.setItem(pendingKey,JSON.stringify(pending));
    const result=await db.rpc("admin_create_weighted_stock_batch",{p_submission_id:pending.submissionId,p_items:pending.items,
      p_expected_freshness_version:pending.version,p_source:pending.source||null,p_note:pending.note||null});
    if(result.error){setBusy(false);const message=result.error.message||"";
      if(/quick_entry_|weighted_stock_|weight_pricing_|manual_price_|invalid_|check constraint|admin_required/i.test(message)&&!/network|timeout/i.test(message)){
        sessionStorage.removeItem(pendingKey);setUncertain(null);setSubmissionId(crypto.randomUUID());setStep("edit");
        setNotice(`整批沒有建立：${message}。輸入內容仍保留，請修正後重新確認。`);
        if(/price_changed|freshness_conflict/i.test(message))await load();
      }else{setUncertain(pending);setNotice("無法確認提交結果。請按『重試同一筆提交』；不要另開一批，以免重複上架。");}
      return;}
    const createdBatch=result.data as Batch;
    const stockResult=await db.from("phase2_weighted_stock").select("id,stock_code,product_id,raw_weight_g,fish_date,t0_base_price,batch_line_no,status").eq("batch_id",createdBatch.id).order("batch_line_no");
    setBatch(createdBatch);setStocks((stockResult.data||[]) as Stock[]);setStep("success");setUncertain(null);sessionStorage.removeItem(pendingKey);
    if(stockResult.error)setNotice("上架已成功，但明細暫時載入失敗；請從現貨管理以 batch 查詢。");
    else await uploadPhotos((stockResult.data||[]) as Stock[]);
    setBusy(false);
  }
  function startAgain(){setRows([blank(today)]);setSource("");setNote("");setBatch(null);setStocks([]);setStep("edit");setSubmissionId(crypto.randomUUID());setPhotoFailures([]);setNotice("");load();}

  if(auth==="loading")return <main className="admin"><p>驗證管理員身分中…</p></main>;
  if(auth==="no")return <main className="admin"><h1>此頁僅限管理員</h1><Link href="/admin">前往登入</Link></main>;
  return <main className="admin weightedPage"><header className="adminTop"><div><button type="button" className="weightedTextLink" onClick={()=>leave("/admin")}>← 後台首頁</button><h1>今日魚貨快速上架</h1><p>每尾一列，輸入重量後系統計價；只有最後確認才建立可售現貨。</p></div><button type="button" className="weightedTextLink" onClick={()=>leave("/admin/weighted")}>現貨管理</button></header>
    {notice&&<p className="notice" role="status">{notice}</p>}
    {step==="edit"&&<><section className="panel"><h2>本批資訊</h2><div className="weightedTwo"><label>來源（選填）<input maxLength={80} value={source} onChange={e=>setSource(e.target.value)} placeholder="例如：南方澳"/></label><label>備註（選填）<input maxLength={1000} value={note} onChange={e=>setNote(e.target.value)}/></label></div><p>批次名稱由系統自動編號；每尾自己的魚貨日期決定 T+N。</p><div className="weightedChips"><span>最近使用：</span>{recentProducts.map(id=>{const p=products.find(item=>item.id===id);return p?.inventory_mode==="SINGLE_WEIGHTED"&&p.status==="available"?<button type="button" key={id} onClick={()=>selectProduct(rows.at(-1)!.id,id)}>{p.name}</button>:null;})}</div><div className="weightedChips"><span>從上一批帶入商品：</span>{lastProducts.map(id=>{const p=products.find(item=>item.id===id);return p?.inventory_mode==="SINGLE_WEIGHTED"&&p.status==="available"?<button type="button" key={id} onClick={()=>selectProduct(rows.at(-1)!.id,id)}>{p.name}</button>:null;})}<small>只帶入商品；重量、日期、價格、照片都重新輸入。</small></div></section>
      <div className="weightedRows">{rows.map((row,i)=>{const quote=quotes[i],product=products.find(item=>item.id===row.product_id);
        return <section className="panel weightedRow" key={row.id}><header><h2>第 {i+1} 尾</h2><button type="button" disabled={rows.length===1} onClick={()=>setRows(current=>current.filter(item=>item.id!==row.id))}>移除此列</button></header>
          <div className="weightedRowFields"><label>商品 *<ProductPicker products={products} value={row.product_id} onSelect={id=>selectProduct(row.id,id)}/></label><label>魚貨日期 *<input type="date" max={today} value={row.fish_date} onChange={e=>updateRow(row.id,{fish_date:e.target.value})}/></label>
            <label>重量輸入<select value={row.inputMode} onChange={e=>changeWeightMode(row,e.target.value as Row["inputMode"])}><option value="grams">克 g</option><option value="jin">台斤＋兩</option></select></label>
            {row.inputMode==="grams"?<label>處理前重量（g）*<input ref={element=>{weightRefs.current[row.id]=element;}} type="number" min="1" step="1" inputMode="numeric" value={row.raw_weight_g}
              onChange={e=>updateRow(row.id,{raw_weight_g:e.target.value,manual_price_confirmed:false,needsReconfirm:row.manual_base_price!==""})}
              onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addRow();}}}/></label>
              :<div className="weightedTwo"><label>台斤<input type="number" min="0" step="1" inputMode="numeric" value={row.jin} onChange={e=>{const jin=e.target.value,grams=gramsFromJinLiang(Number(jin||0),Number(row.liang||0));updateRow(row.id,{jin,raw_weight_g:grams===null?"":String(grams),manual_price_confirmed:false,needsReconfirm:row.manual_base_price!==""});}}/></label><label>兩（0–未滿 16）<input type="number" min="0" step="any" inputMode="decimal" value={row.liang} onChange={e=>{const liang=e.target.value,grams=gramsFromJinLiang(Number(row.jin||0),Number(liang||0));updateRow(row.id,{liang,raw_weight_g:grams===null?"":String(grams),manual_price_confirmed:false,needsReconfirm:row.manual_base_price!==""});}} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();addRow();}}}/></label></div>}
            <label>人工 T+0 基準價（選填）<input type="number" min="1" step="1" value={row.manual_base_price??""} onChange={e=>updateRow(row.id,{manual_base_price:e.target.value,manual_price_confirmed:false,needsReconfirm:false})}/></label>
            <label>單尾照片（選填）<input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>updateRow(row.id,{photo:e.target.files?.[0]||null})}/></label>
          </div>
          <div className="weightedQuote"><span>{gramsLabel(Number(row.raw_weight_g))||"尚未輸入重量"}</span><span>級距：{quote.tier?`${quote.tier.lower_bound_g}–${quote.tier.upper_bound_g-1}g｜NT$${quote.tier.price_per_jin}/斤`:"無適用級距"}</span><span>系統 T+0：{money(quote.system)}</span><span>T+0 基準：{money(quote.base)}</span><span>目前 T+{quote.offset??"?"}：{money(quote.currentPrice)}</span></div>
          {row.manual_base_price!==""&&(row.needsReconfirm||!quote.tier||quote.errors.some(error=>error.includes("偏離")))&&<label className="check"><input type="checkbox" checked={row.manual_price_confirmed} onChange={e=>updateRow(row.id,{manual_price_confirmed:e.target.checked,needsReconfirm:!e.target.checked})}/>我已核對人工價格與本尾重量／系統價格</label>}
          {quote.warnings.map((warning,index)=><p className="weightedWarning" key={index}>⚠ {warning}{warning.includes("價格級距")&&product&&<Link href={`/admin/inventory/${product.id}`} onClick={event=>{if(dirty&&!window.confirm("尚有未上架的魚貨，離開後將遺失。\n\n確定離開？"))event.preventDefault();}}> 前往補商品級距</Link>}</p>)}{duplicateWarnings[i]&&<p className="weightedWarning">⚠ {duplicateWarnings[i]}</p>}
          {rowErrors[i].map((error,index)=><p role="alert" className="weightedError" key={index}>{error}{error.includes("現貨模式")&&product&&<Link href={`/admin/inventory/${product.id}`}> 前往商品設定</Link>}</p>)}
        </section>;
      })}</div><div className="weightedFooter"><button type="button" onClick={addRow}>＋ 新增下一尾（沿用商品與日期）</button><button type="button" disabled={hardErrors||!policy} onClick={review}>檢查並確認 {rows.length} 尾魚</button></div>
    </>}
    {step==="review"&&<section className="panel weightedReview"><h2>準備上架 {rows.length} 尾魚</h2><p>請確認商品、日期、價格與警告；返回編輯會完整保留資料。</p><div className="weightedSummary">{Object.entries(grouped).map(([id,count])=><div key={id}>{products.find(item=>item.id===id)?.name||id} <strong>{count} 尾</strong></div>)}</div>
      <p>人工調價 {rows.filter(row=>row.manual_base_price!=="").length} 尾｜重量／重複等警告 {warnings} 項｜未附照片 {rows.filter(row=>!row.photo).length} 尾</p>
      {rows.map((row,i)=><div className="weightedReviewLine" key={row.id}><strong>#{i+1} {products.find(p=>p.id===row.product_id)?.name}</strong><span>{row.fish_date}｜{gramsLabel(Number(row.raw_weight_g))}｜T+0 {money(quotes[i].base)}｜目前 T+{quotes[i].offset} {money(quotes[i].currentPrice)}</span>{[...quotes[i].warnings,duplicateWarnings[i]].filter(Boolean).map((warning,j)=><small key={j}>⚠ {warning}</small>)}</div>)}
      <div className="weightedActions"><button type="button" disabled={busy||Boolean(uncertain)} onClick={()=>setStep("edit")}>返回編輯</button><button type="button" disabled={busy||hardErrors} onClick={submit}>{busy?"上架中…":uncertain?"重試同一筆提交":`確認建立 ${rows.length} 尾現貨`}</button></div>
    </section>}
    {step==="success"&&batch&&<section className="panel weightedSuccess"><h2>本批上架成功｜共 {batch.stock_count} 尾</h2><p>{batch.name}</p><div className="weightedSummary">{Object.entries(grouped).map(([id,count])=><div key={id}>{products.find(item=>item.id===id)?.name||id} <strong>{count} 尾</strong></div>)}</div>
      <div className="weightedStockList">{stocks.map(stock=>{const offset=dayOffset(stock.fish_date,today);const multiplier=days.find(item=>item.day_offset===offset)?.multiplier;const current=offset!==null&&offset>=0&&offset<=(policy?.max_sale_day??-1)&&multiplier!=null?Math.round(stock.t0_base_price*multiplier):null;
        return <div key={stock.id}><strong>{stock.stock_code}</strong><span>{products.find(p=>p.id===stock.product_id)?.name}｜{stock.raw_weight_g}g｜T+0 {money(stock.t0_base_price)}｜T+{offset??"?"}｜目前 {money(current)}｜{stock.status}</span></div>;})}</div>
      {photoFailures.length>0&&<button type="button" disabled={busy} onClick={async()=>{setBusy(true);await uploadPhotos(stocks,photoFailures);setBusy(false);}}>重試未完成照片（不重建現貨）</button>}
      <div className="weightedActions"><Link className="buttonLink" href={`/admin/weighted?batch=${batch.id}`}>查看本批現貨</Link><button type="button" onClick={startAgain}>繼續上架魚貨</button></div></section>}
  </main>;
}

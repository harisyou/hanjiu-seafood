export function taiwanDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}

export function dayOffset(fishDate, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fishDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(today || '')) return null;
  const fish=Date.parse(`${fishDate}T00:00:00Z`);
  const now=Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(fish) || !Number.isFinite(now) || new Date(fish).toISOString().slice(0,10)!==fishDate) return null;
  return Math.round((now-fish)/86400000);
}

export function gramsFromJinLiang(jin, liang) {
  if (!Number.isInteger(jin) || !Number.isInteger(liang) || jin<0 || liang<0 || liang>=16) return null;
  return Math.round(jin*600+liang*37.5);
}

export function gramsLabel(grams) {
  if (!Number.isInteger(grams) || grams<=0) return '';
  const jin=Math.floor(grams/600);
  const liang=Math.round((grams%600)/37.5*10)/10;
  return `${grams}g（${jin}斤${Number.isInteger(liang)?liang:liang.toFixed(1)}兩）`;
}

export function matchedTier(tiers, productId, grams) {
  if (!Number.isInteger(grams) || grams<=0) return null;
  return tiers.find(tier=>tier.product_id===productId && tier.enabled &&
    grams>=tier.lower_bound_g && grams<tier.upper_bound_g) || null;
}

export function systemBasePrice(grams, pricePerJin) {
  if (!Number.isInteger(grams) || grams<=0 || !Number.isInteger(pricePerJin) || pricePerJin<=0) return null;
  return Math.round(grams*pricePerJin/600);
}

export function manualConfirmationRequired(systemPrice, manualPrice, ratio) {
  if (manualPrice==null || ratio==null || systemPrice==null) return false;
  return Math.abs(manualPrice-systemPrice)/systemPrice>ratio;
}

export function rowQuote(row, product, tiers, freshnessDays, policy, today) {
  const errors=[]; const warnings=[];
  if (!product) errors.push('請選擇商品');
  else if (product.inventory_mode!=='SINGLE_WEIGHTED') errors.push(product.inventory_mode==='QUANTITY_VARIANT'?'此商品使用規格數量型':'此商品尚未設定現貨模式');
  else if (product.status && product.status!=='available') errors.push('此商品目前未開放販售');
  const grams=Number(row.raw_weight_g);
  if (!Number.isInteger(grams) || grams<=0) errors.push('重量必須是大於 0 的整數克');
  const offset=dayOffset(row.fish_date,today);
  if (offset==null) errors.push('魚貨日期無效');
  else if (offset<0) errors.push('不可建立未來日期魚貨');
  else if (!policy || offset>policy.max_sale_day || !freshnessDays.some(day=>day.day_offset===offset)) errors.push('已超過可販售天數或缺少新鮮度規則');
  const tier=product?matchedTier(tiers,product.id,grams):null;
  const system=tier?systemBasePrice(grams,tier.price_per_jin):null;
  const manual=row.manual_base_price===''||row.manual_base_price==null?null:Number(row.manual_base_price);
  if (manual!==null && (!Number.isInteger(manual)||manual<=0)) errors.push('人工 T+0 價格必須是正整數');
  if (!tier && Number.isInteger(grams) && grams>0) {
    warnings.push(`${grams}g 目前沒有適用的價格級距`);
    if (manual===null) errors.push('無適用級距時必須輸入人工 T+0 價格');
    else if (!row.manual_price_confirmed) errors.push('無級距的人工價格需要明確確認');
  }
  if (manual!==null && system!==null && manualConfirmationRequired(system,manual,policy?.max_unconfirmed_deviation_ratio) && !row.manual_price_confirmed) {
    errors.push('人工價格偏離系統價格，請明確確認');
  }
  if (product && Number.isInteger(grams) && grams>0 && product.common_weight_min_g!=null && product.common_weight_max_g!=null &&
      (grams<product.common_weight_min_g || grams>product.common_weight_max_g)) warnings.push('重量超出此商品常見範圍，請確認是否輸入正確');
  const base=manual??system;
  const multiplier=freshnessDays.find(day=>day.day_offset===offset)?.multiplier ?? null;
  const currentPrice=base!==null && multiplier!==null && offset!==null && offset>=0 && offset<=policy?.max_sale_day
    ?Math.round(base*multiplier):null;
  return {tier,system,base,offset,currentPrice,errors,warnings};
}

export function duplicateWeightWarnings(rows, products) {
  const groups=new Map();
  for (const row of rows) {
    const grams=Number(row.raw_weight_g);
    if (!row.product_id || !Number.isInteger(grams) || grams<=0) continue;
    const key=`${row.product_id}:${grams}`;
    groups.set(key,(groups.get(key)||0)+1);
  }
  return rows.map(row=>{
    const grams=Number(row.raw_weight_g); const count=groups.get(`${row.product_id}:${grams}`)||0;
    const product=products.find(item=>item.id===row.product_id);
    return count>1?`本批有 ${count} 尾${product?.name||'此商品'}皆為 ${grams}g，請確認是否為不同魚貨`:null;
  });
}

// Loopback-only fixture. No Supabase connection or production data.
// Opt-in admin mode mutates disposable memory only, never Storage objects.
import { createServer } from 'node:http';
import { fixtures } from './catalog-fixtures.mjs';
const data = fixtures();
if (process.env.CATALOG_FIXTURE_LAYOUT === '1') {
  data.products[0].description = ['馬頭魚細緻的肉質帶有自然鮮甜，適合清蒸，也適合以簡單調味煮湯，保留魚肉本身的香氣。', '每尾魚的大小與外觀略有不同，請依下方規格挑選。商品圖片呈現完整魚身，實際魚貨以當日到貨為準。', '料理前請先依需求解凍並擦乾，採用適當火候避免過度烹調。若有特殊處理需求，可於購買區選擇處理方式並填寫備註。'].join('\n\n');
  data.products[0].texture_description = '肉質細緻柔嫩，帶有自然鮮甜。不同部位口感略有差異，魚皮與魚肉可以一起品嚐。';
  data.products[0].cooking = '清蒸、煮湯或乾煎均適合。清蒸可搭配薑絲與蔥段；煮湯以簡單調味保留鮮味。';
  data.products[0].storage_instructions = '收到後請盡速冷藏並食用。若需較長時間保存，請分裝密封冷凍；避免反覆解凍。';
  Object.assign(data.products[1], {name:'白蝦', description:'鮮甜白蝦，適合清蒸或鹽烤。', texture_description:null, cooking:'清蒸／鹽烤', storage_instructions:null, processing_enabled:false});
}
const adminMode = process.env.CATALOG_FIXTURE_ADMIN === '1';
const user = {id:'90000000-0000-4000-8000-000000000001',email:'fixture@example.test',role:'authenticated',aud:'authenticated'};
createServer(async (req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.end();return;}
  const url = new URL(req.url,'http://127.0.0.1:54329');
  const json = (value) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
  if(adminMode && url.pathname==='/auth/v1/token' && req.method==='POST') {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const exp = Math.floor(Date.now()/1000)+3600;
    json({access_token:`${encode({alg:'HS256',typ:'JWT'})}.${encode({...user,exp})}.fixture`,refresh_token:'local-fixture-only',token_type:'bearer',expires_in:3600,expires_at:exp,user}); return;
  }
  if(adminMode && url.pathname==='/auth/v1/user') {json(user);return;}
  if(adminMode && url.pathname==='/rest/v1/rpc/is_hanjiu_admin' && req.method==='POST') {json(true);return;}
  if(adminMode && url.pathname==='/rest/v1/rpc/admin_save_product_catalog' && req.method==='POST') {
    let body=''; for await(const part of req) body+=part;
    const input=JSON.parse(body), index=data.products.findIndex(p=>p.id===input.p_product_id);
    if(index<0) {res.writeHead(404);json({message:'missing fixture product'});return;}
    data.products[index]={...data.products[index],...input.p_content,updated_at:new Date().toISOString()};
    data.product_images=[...data.product_images.filter(i=>i.product_id!==input.p_product_id),...input.p_images.map((i,sort_order)=>({...i,sort_order}))];
    data.product_faqs=[...data.product_faqs.filter(i=>i.product_id!==input.p_product_id),...input.p_faqs.map((i,sort_order)=>({...i,sort_order}))];
    data.products[index].image_url=input.p_images.find(i=>i.is_primary)?.legacy_url || null;
    json(data.products[index]);return;
  }
  if(req.method!=='GET'){res.writeHead(403);res.end('Fixture is read-only');return;}
  if(url.pathname.startsWith('/image/')) { const width=url.pathname.endsWith('0')?1600:600, height=1200; res.setHeader('Content-Type','image/svg+xml'); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${url.pathname.endsWith('0')?'#c9ded8':'#b5ccda'}"/><ellipse cx="${width/2}" cy="600" rx="${width*.4}" ry="140" fill="#5d8f8b"/><text x="20" y="50" font-size="40">Full image ${url.pathname.slice(-1)}</text></svg>`); return; }
  const table = url.pathname.split('/').at(-1);
  let rows = structuredClone(data[table] || []);
  if(table==='products') rows=rows.filter(row=>row.status!=='hidden');
  if(table==='product_faqs' && !adminMode) rows=rows.filter(row=>row.active);
  for(const [key,value] of url.searchParams){
    if(value.startsWith('eq.') && !key.includes('.')) rows=rows.filter(row=>String(row[key])===value.slice(3));
    if(value.startsWith('neq.')) rows=rows.filter(row=>String(row[key])!==value.slice(4));
  }
  if(table==='product_processing_options') rows=rows.map(row=>({...row,processing_options:{name:'去鱗',active:true}}));
  if(table==='product_processing_presets') rows=rows.map(row=>({...row,processing_presets:{name:'不處理',active:true}}));
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.headers.accept?.includes('vnd.pgrst.object') ? rows[0] || null : rows));
}).listen(54329,'127.0.0.1',()=>console.log(`Catalog fixture on 127.0.0.1:54329 (${adminMode?'disposable admin memory':'read-only'})`));

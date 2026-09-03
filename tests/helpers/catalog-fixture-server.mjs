// Local-only read fixture. No Supabase connection, no production data, no writes.
import { createServer } from 'node:http';
import { fixtures } from './catalog-fixtures.mjs';
const data = fixtures();
createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Headers','*');
  if(req.method==='OPTIONS'){res.end();return;}
  if(req.method!=='GET'){res.writeHead(403);res.end('Fixture is read-only');return;}
  const url = new URL(req.url,'http://127.0.0.1:54329');
  if(url.pathname.startsWith('/image/')) { res.setHeader('Content-Type','image/svg+xml'); res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="${url.pathname.endsWith('0')?'#c9ded8':'#b5ccda'}"/><text x="200" y="300" font-size="50">Fish ${url.pathname.slice(-1)}</text></svg>`); return; }
  const table = url.pathname.split('/').at(-1);
  let rows = structuredClone(data[table] || []);
  if(table==='products') rows=rows.filter(row=>row.status!=='hidden');
  if(table==='product_faqs') rows=rows.filter(row=>row.active);
  for(const [key,value] of url.searchParams){
    if(value.startsWith('eq.') && !key.includes('.')) rows=rows.filter(row=>String(row[key])===value.slice(3));
    if(value.startsWith('neq.')) rows=rows.filter(row=>String(row[key])!==value.slice(4));
  }
  if(table==='product_processing_options') rows=rows.map(row=>({...row,processing_options:{name:'去鱗',active:true}}));
  if(table==='product_processing_presets') rows=rows.map(row=>({...row,processing_presets:{name:'不處理',active:true}}));
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(req.headers.accept?.includes('vnd.pgrst.object') ? rows[0] || null : rows));
}).listen(54329,'127.0.0.1',()=>console.log('Read-only catalog fixture on 127.0.0.1:54329'));

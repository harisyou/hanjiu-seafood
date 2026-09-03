import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import * as supply from '../lib/supply-model.mjs';
import * as availability from '../lib/processing-availability.mjs';
import * as filters from '../lib/product-filters.mjs';
import { fixtures, ids } from './helpers/catalog-fixtures.mjs';
const require=createRequire(import.meta.url);
// Use fileURLToPath for Windows/non-ASCII checkout paths.
import { fileURLToPath } from 'node:url';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
const key='hanjiu-storefront-cart-v1';

test('real storefront component preserves cart across route updates and refresh, legacy limits and processing',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const local=storage(),session=storage();
 globalThis.window={crypto:globalThis.crypto,localStorage:local,sessionStorage:session,setTimeout,addEventListener(){},removeEventListener(){},open(){}};
 globalThis.document={body:{style:{}},getElementById(){return null}};
 let pathname='/', renderer;
 const data=fixtures(), calls=[];
 const db={from(table){
   let rows=data[table]||[];
   const q={select(){return q},order(){return q},eq(k,v){rows=rows.filter(row=>row[k]===v);return q},neq(k,v){rows=rows.filter(row=>row[k]!==v);return q},in(k,v){rows=rows.filter(row=>v.includes(row[k]));return q},then(fn){return Promise.resolve({data:rows,error:null}).then(fn)}};
   return q;
 },async rpc(name,payload){calls.push({name,payload});return {data:null,error:{message:'temporary_network_failure'}};}};
 const cache=new Map();
 function load(file){
   if(cache.has(file))return cache.get(file);
   const source=readFileSync(file,'utf8');
   const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
   const module={exports:{}};cache.set(file,module.exports);
   const req=(id)=>{
     if(id==='next/navigation')return {usePathname:()=>pathname,useRouter:()=>({push:value=>{pathname=value.split('#')[0]}})};
     if(id==='next/link')return {__esModule:true,default:({children,...props})=>React.createElement('a',props,children)};
     if(id==='@/lib/supabase-browser')return {createClient:()=>db};
     if(id==='@/lib/supabase-public')return {createPublicClient:()=>db};
     if(id==='@/app/fish-request-form')return {__esModule:true,default:()=>null};
     if(id==='@/lib/supply-model')return supply;
     if(id==='@/lib/processing-availability')return availability;
     if(id==='@/lib/product-filters')return filters;
     if(id.startsWith('@/')||id.startsWith('.')){
       let path=id.startsWith('@/')?resolve(workspace,id.slice(2)):resolve(dirname(file),id);
       if(!existsSync(path))path+='.ts';return load(path);
     }
     return require(id);
   };
   new Function('require','module','exports',js)(req,module,module.exports);cache.set(file,module.exports);return module.exports;
 }
 const Shell=load(resolve(workspace,'components/storefront-shell.tsx')).default;
 const render=()=>React.createElement(Shell,null,React.createElement('span',null,pathname));
 const route=async(path)=>{pathname=path;await act(async()=>{renderer.update(render())});};
 const selectedQuantity=()=>Number(renderer.root.findByProps({className:'quantityValue'}).children[0]);
 const notice=()=>renderer.root.findAllByProps({className:'excessPreorderNotice'}).length;
 const click=async(label)=>act(async()=>{const button=renderer.root.findByProps({'aria-label':label});assert.equal(Boolean(button.props.disabled),false);await button.props.onClick()});
 const add=async()=>act(async()=>{await renderer.root.findAllByType('button').find(node=>node.props.className?.startsWith('addToCartButton')).props.onClick()});
 const cart=()=>JSON.parse(local.getItem(key)||'[]');
 try {
  await act(async()=>{renderer=Renderer.create(render())});
  assert.equal(renderer.root.findAllByProps({className:'variantSelector'}).length,0);
  await route(`/products/${ids.p1}`);
  assert.equal(selectedQuantity(),1);assert.equal(notice(),0);
  for(let n=1;n<10;n++)await click('增加數量');
  assert.equal(selectedQuantity(),10);assert.equal(notice(),0);
  await click('增加數量');assert.equal(selectedQuantity(),11);assert.equal(notice(),1);
  for(let n=11;n<20;n++)await click('增加數量');
  assert.equal(selectedQuantity(),20);assert.equal(notice(),1);
  await add(); assert.equal(cart()[0].quantity,20);assert.equal(cart()[0].supply_type,'preorder');
  await route('/'); assert.equal(cart()[0].quantity,20);
  await route(`/products/${ids.p2}`);
  for(let n=1;n<10;n++)await click('增加數量');
  assert.equal(notice(),0);assert.equal(renderer.root.findByProps({'aria-label':'增加數量'}).props.disabled,true);
  await add();assert.equal(cart().length,2);
  await route(`/products/${ids.p3}`); assert.match(JSON.stringify(renderer.toJSON()),/目前無現貨｜可預訂/);assert.equal(notice(),0);
  await route(`/products/${ids.p1}`);
  await act(async()=>renderer.root.findByProps({id:`variant-${ids.p1}`}).props.onChange({target:{value:data.product_variants[0].id}}));
  await add();assert.equal(cart().length,2);assert.equal(cart()[0].quantity,21);
  // Reset transient add feedback through the same selector action, then change processing.
  await act(async()=>renderer.root.findByProps({id:`variant-${ids.p1}`}).props.onChange({target:{value:data.product_variants[0].id}}));
  const note=renderer.root.findAllByType('textarea').find(node=>node.props.placeholder?.includes('保留魚頭煮湯'));
  await act(async()=>note.props.onChange({target:{value:'不同處理'}}));
  await add();assert.equal(cart().length,2);assert.equal(cart()[0].quantity,21);
  assert.match(JSON.stringify(renderer.toJSON()),/請先在購物車調整處理方式/);
  // Full browser refresh: all cart products restore, prices refresh, stale options sanitize.
  await act(async()=>renderer.unmount());
  const persisted=cart();persisted[0].processing_option_ids=['removed'];persisted[0].price=1;local.setItem(key,JSON.stringify(persisted));
  data.product_variants[0].price=599;
  await act(async()=>{renderer=Renderer.create(render())});
  assert.equal(cart().length,2);assert.equal(cart()[0].price,599);assert.deepEqual(cart()[0].processing_option_ids,[]);
  await route('/');
  // Checkout's actual submit handler, with controlled valid fields and transient RPC response.
  const form=renderer.root.findAllByType('form')[0];
  const inputs=renderer.root.findAllByType('input');
  const change=async(node,value)=>act(async()=>node.props.onChange({target:{value}}));
  await change(inputs.find(n=>n.props.autoComplete==='name'),'測試客人');
  await change(inputs.find(n=>n.props.autoComplete==='tel'),'0912345678');
  await change(inputs.find(n=>n.props.type==='date'),'2099-01-01');
  await change(inputs.find(n=>n.props.type==='time'),'12:00');
  await act(async()=>form.props.onSubmit({preventDefault(){}}));
  await act(async()=>form.props.onSubmit({preventDefault(){}}));
  assert.equal(calls.length,2);assert.equal(calls[0].payload.p_idempotency_key,calls[1].payload.p_idempotency_key);
  assert.equal(cart().length,2);assert.ok(session.getItem('hanjiu-checkout-submission-v1'));
  assert.deepEqual(Object.keys(calls[0].payload.p_items[0]).sort(),['processing_note','processing_option_ids','processing_preset_id','quantity','variant_id']);
 } finally {if(renderer)await act(async()=>renderer.unmount());delete globalThis.window;delete globalThis.document;delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});

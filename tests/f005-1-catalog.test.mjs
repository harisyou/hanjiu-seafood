import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { primaryImage, stableOrder, visibleFaqs, legacySummary, catalogVisible } from '../lib/catalog-content.ts';
import { fixtures, ids } from './helpers/catalog-fixtures.mjs';
const data=fixtures();
test('gallery ordering is stable and primary wins over legacy fallback',()=>{
  assert.deepEqual(stableOrder([{id:'b',sort_order:0},{id:'a',sort_order:0}]).map(x=>x.id),['a','b']);
  assert.equal(primaryImage({...data.products[0],image_url:'old'},data.product_images,'http://local'),data.product_images[0].legacy_url);
  assert.equal(primaryImage({...data.products[0],image_url:'old'},[],'http://local'),'old');
  assert.equal(primaryImage(data.products[0],[],'http://local'),null);
});
test('optional FAQ removes inactive entries and preserves stable order',()=>{
  assert.deepEqual(visibleFaqs([]),[]); assert.deepEqual(visibleFaqs(data.product_faqs).map(x=>x.question),['適合煮湯嗎？']);
  assert.deepEqual(visibleFaqs([{...data.product_faqs[0],id:'b',sort_order:1},{...data.product_faqs[0],id:'c',sort_order:0},{...data.product_faqs[0],id:'a',sort_order:0}]).map(x=>x.id),['a','c','b']);
});
test('catalog visibility is independent from legacy purchasing status',()=>{
  assert.equal(catalogVisible(data.products[4]),true); assert.equal(catalogVisible(data.products[3]),false);
  assert.equal(legacySummary(data.products[0],data.product_variants).min,499);
  assert.equal(legacySummary(data.products[1],data.product_variants).min,12999);
  assert.deepEqual(legacySummary(data.products[2],data.product_variants),{min:1080,max:1080,inStock:false,preorder:true});
  assert.equal(legacySummary({...data.products[0],status:'sold_out'},data.product_variants).inStock,false);
});
test('public detail uses anonymous client, explicit visibility, and server 404',()=>{
  const page=readFileSync(new URL('../app/(storefront)/products/[id]/page.tsx',import.meta.url),'utf8');
  const client=readFileSync(new URL('../lib/supabase-public.ts',import.meta.url),'utf8');
  assert.match(page,/neq\("status", "hidden"\)/); assert.match(page,/if \(!result.data\) notFound\(\)/);
  assert.match(client,/persistSession: false/); assert.doesNotMatch(client,/cookies\(|SERVICE_ROLE/);
  assert.match(page,/if \(result.error\) throw/); assert.match(page,/questions.length > 0/);
});
test('catalog-only homepage and persistent layout keep legacy purchase outside browsing cards',()=>{
  const shell=readFileSync(new URL('../components/storefront-shell.tsx',import.meta.url),'utf8');
  const browsing=shell.slice(shell.indexOf('{isCatalog && <section className="content productBrowsingSection"'),shell.indexOf('{productId &&'));
  assert.doesNotMatch(browsing,/addToCart\(|variantSelector|variantQuantity|processingPresetCards/);
  assert.match(browsing,/查看商品/);
  assert.match(shell,/if \(!isCatalog\) router.push\("\/#order"\)/);
  const layout=readFileSync(new URL('../app/(storefront)/layout.tsx',import.meta.url),'utf8');
  assert.match(layout,/<StorefrontShell>\{children\}<\/StorefrontShell>/); assert.doesNotMatch(layout,/key=/);
});
test('extracted cart actions and checkout handler are byte-identical to audited main',()=>{
  const source=readFileSync(new URL('../components/storefront-shell.tsx',import.meta.url),'utf8').replace(/\r\n/g,'\n');
  // Hashes of these exact blocks in main 4c4b909. UI routing is intentionally outside them.
  for(const [start,end,hash] of [
    ['  async function submit(','  const total =','370685821e69f7395ed0f36e29ac4221cd835ecd1480985046d68df5a8d7a007'],
    ['  function selectVariant(','  function useSavedCheckoutProfile()','3b0072a41ee70d367230cec05f091f30d778a4ba3bb8093abf552fa54c980489']
  ]) assert.equal(createHash('sha256').update(source.slice(source.indexOf(start),source.indexOf(end)).trim()).digest('hex'),hash);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
const read = path => readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
test('desktop polish preserves the accepted purchase markup byte-for-byte',()=>{
  const source=read('components/storefront-shell.tsx');
  const start=source.indexOf('<section className="content legacyPurchaseSection"');
  const block=source.slice(start,source.indexOf('      </section>}',start)+19).replace(/\r\n/g,'\n').trim();
  // Baseline: approved PR #40 revision 710b760. Placement wrapper is outside this block.
  assert.equal(createHash('sha256').update(block).digest('hex'),'cfdccbadf89e0a2c50987b0849871974eb1e015ac2375d39c7b018527da212c2');
});
test('catalog image contract is 4:3 with contain, stable gallery, and advisory admin size',()=>{
  const css=read('app/catalog.css'), gallery=read('components/product-gallery.tsx'), editor=read('components/admin-catalog-editor.tsx');
  assert.match(css,/\.catalogGalleryTrack\s*\{[^}]*aspect-ratio: 4 \/ 3/);
  assert.match(css,/\.catalogGalleryTrack > img\s*\{[^}]*object-fit: contain/);
  assert.match(css,/\.catalogBrowseCard \.photo\s*\{[^}]*aspect-ratio: 4 \/ 3/);
  assert.match(css,/\.catalogBrowseCard \.photo img\s*\{[^}]*object-fit: contain/);
  assert.match(gallery,/width=\{1600\} height=\{1200\}/);
  assert.match(editor,/建議圖片比例 4:3｜建議尺寸 1600 × 1200 px/);
  assert.doesNotMatch(editor,/naturalWidth\s*\/\s*image.naturalHeight|\.storage[\s\S]*?\.remove\(/);
});
test('detail header occupies space, both return links target the catalog anchor',()=>{
  assert.match(read('app/catalog.css'),/\.hero.catalogHeader nav\s*\{[^}]*position: relative/);
  for(const path of ['page.tsx','not-found.tsx']) assert.match(read(`app/(storefront)/products/[id]/${path}`),/className="catalogBackLink" href="\/#catalog"/);
  assert.match(read('components/storefront-shell.tsx'),/className="content productBrowsingSection" id="catalog"/);
});
test('purchase presentation omits duplicate content; compact admin controls retain safe actions',()=>{
  const shell=read('components/storefront-shell.tsx'),editor=read('components/admin-catalog-editor.tsx');
  const purchase=shell.slice(shell.indexOf('{productId &&'),shell.indexOf('className={`cartDrawer'));
  assert.doesNotMatch(purchase,/productCardIntro|productDescription|productCooking/);
  assert.match(editor,/disabled=\{image.is_primary\} aria-pressed=\{image.is_primary\}/);
  assert.match(editor,/disabled=\{index === 0\}/);
  assert.match(editor,/disabled=\{index === images.length - 1\}/);
  assert.match(editor,/className="catalogSave" disabled=\{blockedAssociation\} type="submit"/);
  assert.match(read('app/catalog.css'),/\.catalogEditor \.catalogAdminActions button[^}]*width: auto/);
});

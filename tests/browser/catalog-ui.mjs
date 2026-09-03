// Run via the Browser skill's supported browser-client tab, against loopback fixtures.
// Tests actual clicks/navigation and rendered geometry; never connects to Production.
import assert from 'node:assert/strict';
const origin = 'http://localhost:3001';
const productPath = '/products/10000000-0000-4000-8000-000000000001';

export async function runCatalogUiRegression(tab, viewport) {
  const report = [];
  for (const width of [320, 375, 390, 1024, 1440]) {
    await viewport.set({width, height: 900});
    if ((await tab.url()) === `${origin}/#catalog`) await tab.reload();
    else await tab.goto(`${origin}/#catalog`);
    await tab.playwright.getByRole('link', {name:'查看商品'}).first().waitFor({state:'visible'});
    const cards = await tab.playwright.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      columns: getComputedStyle(document.querySelector('#product-grid')).gridTemplateColumns.split(' ').length,
      photos: [...document.querySelectorAll('.catalogBrowseCard .photo')].map(el => {
        const r=el.getBoundingClientRect();return r.width/r.height;
      }),
      prices: [...document.querySelectorAll('.catalogPrice')].map(el=>({text:el.textContent,clipped:el.scrollWidth>el.clientWidth})),
    }));
    assert.equal(cards.overflow,false,`catalog overflow ${width}`);
    assert.equal(cards.columns,width>=1024?3:1);
    cards.photos.forEach(ratio=>assert.ok(Math.abs(ratio-4/3)<.01));
    for(const price of ['NT$499','NT$12,999']) assert.ok(cards.prices.some(p=>p.text===price&&!p.clipped));
    await tab.playwright.getByRole('link',{name:'查看商品'}).first().click();
    await tab.playwright.waitForURL(`${origin}${productPath}`);
    await tab.playwright.getByRole('combobox',{name:'選擇規格'}).waitFor({state:'visible'});
    const gallery = await tab.playwright.evaluate(()=>{
      const r=document.querySelector('.catalogGalleryTrack').getBoundingClientRect();
      return {width:r.width,height:r.height,fit:getComputedStyle(document.querySelector('.catalogGalleryTrack>img')).objectFit,
        overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
        purchaseTop:document.querySelector('.legacyPurchaseSection').getBoundingClientRect().top+scrollY};
    });
    assert.equal(gallery.overflow,false,`detail overflow ${width}`);
    assert.ok(Math.abs(gallery.width/gallery.height-4/3)<.01);
    assert.equal(gallery.fit,'contain');
    if(width===1440) {assert.ok(gallery.width>=480&&gallery.width<=520);assert.ok(gallery.purchaseTop<900);}
    await tab.playwright.getByRole('button',{name:'查看第 2 張圖片'}).click();
    const after = await tab.playwright.locator('.catalogGalleryTrack').evaluate(el=>({width:el.clientWidth,height:el.clientHeight}));
    assert.ok(Math.abs(after.height-gallery.height)<1);
    // Click the real link: catches the former invisible header overlay regression.
    await tab.playwright.getByRole('link',{name:'← 返回商品目錄'}).click();
    await tab.playwright.waitForURL(`${origin}/#catalog`);
    assert.equal(await tab.playwright.getByRole('heading',{name:'海鮮商品',exact:true}).isVisible(),true);
    report.push({width,cards,gallery,returnNavigation:'passed'});
  }
  for(const id of ['missing','10000000-0000-4000-8000-999999999999','10000000-0000-4000-8000-000000000004']) {
    await tab.goto(`${origin}/products/${id}`);
    await tab.playwright.getByRole('heading',{name:'找不到商品'}).waitFor({state:'visible'});
    assert.equal(await tab.playwright.getByRole('region',{name:'商品購買',exact:true}).count(),0);
    assert.equal(await tab.playwright.getByRole('heading',{name:'選擇規格與處理方式'}).count(),0);
    assert.equal(await tab.playwright.locator('.variantSelector, .productProcessing, .addToCartButton').count(),0);
    await tab.playwright.getByRole('link',{name:'返回商品目錄',exact:true}).click();
    await tab.playwright.waitForURL(`${origin}/#catalog`);
  }
  return report;
}

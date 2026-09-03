// Run via the Browser skill's supported browser-client tab, against loopback fixtures.
// Tests actual clicks/navigation and rendered geometry; never connects to Production.
import assert from 'node:assert/strict';
const origin = 'http://localhost:3001';
const productPath = '/products/10000000-0000-4000-8000-000000000001';

export async function runCatalogUiRegression(tab, viewport) {
  const report = [];
  for (const width of [320, 375, 390, 1024, 1440, 1920]) {
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
    if(width>=1440) assert.ok(gallery.width>=520&&gallery.width<=560);
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

export async function runDesktopPolishRegression(tab, viewport) {
  const report=[];
  for(const width of [390,1024,1440,1920]) {
    await viewport.set({width,height:1080});
    for(const suffix of ['001','002','005']) {
      await tab.goto(`${origin}${productPath.slice(0,-3)}${suffix}`);
      await tab.playwright.getByRole('region',{name:'商品購買',exact:true}).waitFor({state:'visible'});
      const layout=await tab.playwright.evaluate(()=>{
        const rect=selector=>{const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y+scrollY,width:r.width,height:r.height};};
        const image=document.querySelector('.catalogGalleryTrack > img');
        return {width:innerWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth,
          content:rect('.catalogProductLayout'),gallery:rect('.catalogGalleryTrack, .catalogPlaceholder'),info:rect('.catalogInformation'),
          faq:rect('.catalogFaq'),purchase:rect('.legacyPurchaseSection'),top:rect('.catalogDetailGrid'),
          attributes:getComputedStyle(document.querySelector('.catalogAttributes')).gridTemplateColumns,
          contain:image?getComputedStyle(image).objectFit:null,
          clipped:[...document.querySelectorAll('.catalogInformation p, .catalogAttributes dd')].some(el=>el.scrollWidth>el.clientWidth||el.scrollHeight>el.clientHeight+1)};
      });
      assert.equal(layout.overflow,false);assert.equal(layout.clipped,false);
      assert.ok(Math.abs(layout.gallery.width/layout.gallery.height-4/3)<.01);
      if(layout.contain) assert.equal(layout.contain,'contain');
      if(width>=1024) {
        assert.ok(layout.content.width<=1280);
        if(width>=1440) {assert.equal(layout.content.width,1280);assert.equal(layout.gallery.width,550);assert.ok(layout.info.width>=600);}
        assert.equal(layout.attributes.split(' ').length,2);
        assert.ok(layout.purchase.y>=layout.top.y+layout.top.height);
        if(layout.faq) {assert.ok(Math.abs(layout.faq.y-layout.purchase.y)<1);assert.ok(layout.faq.x<layout.purchase.x);}
        else {assert.ok(Math.abs(layout.purchase.x+layout.purchase.width/2-(layout.content.x+layout.content.width/2))<1);assert.ok(layout.purchase.width<=700);}
      } else {
        assert.equal(layout.attributes,'none');assert.ok(layout.info.y>=layout.gallery.y+layout.gallery.height);
        if(layout.faq) assert.ok(layout.purchase.y>=layout.faq.y+layout.faq.height);
      }
      if(suffix==='005') {assert.equal(await tab.playwright.getByRole('button',{name:'已售完',exact:true}).isEnabled(),false);assert.equal(await tab.playwright.getByRole('combobox',{name:'選擇規格'}).count(),0);}
      else {assert.equal(await tab.playwright.getByRole('button',{name:'增加數量',exact:true}).isEnabled(),true);}
      report.push({product:suffix,...layout});
    }
  }
  return report;
}

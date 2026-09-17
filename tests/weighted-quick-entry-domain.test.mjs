import assert from 'node:assert/strict';
import test from 'node:test';
import {dayOffset,duplicateWeightWarnings,gramsFromJinLiang,matchedTier,manualConfirmationRequired,
  rowQuote,systemBasePrice} from '../lib/weighted-quick-entry.mjs';

const product={id:'fish',name:'赤棕',inventory_mode:'SINGLE_WEIGHTED',common_weight_min_g:250,common_weight_max_g:900};
const tiers=[
  {id:'one',product_id:'fish',lower_bound_g:300,upper_bound_g:500,price_per_jin:480,enabled:true},
  {id:'disabled',product_id:'fish',lower_bound_g:300,upper_bound_g:500,price_per_jin:900,enabled:false},
  {id:'two',product_id:'fish',lower_bound_g:600,upper_bound_g:800,price_per_jin:520,enabled:true}
];
const days=[{day_offset:0,multiplier:1},{day_offset:1,multiplier:.95},{day_offset:2,multiplier:.90}];
const policy={max_sale_day:2,version:1,max_unconfirmed_deviation_ratio:null};
const base={product_id:'fish',raw_weight_g:420,fish_date:'2026-09-18',manual_base_price:null,manual_price_confirmed:false};

test('tier boundaries, disabled tiers, grams/jin/liang and NTD rounding',()=>{
  assert.equal(matchedTier(tiers,'fish',300)?.id,'one');
  assert.equal(matchedTier(tiers,'fish',499)?.id,'one');
  assert.equal(matchedTier(tiers,'fish',500),null);
  assert.equal(matchedTier(tiers,'fish',600)?.id,'two');
  assert.equal(gramsFromJinLiang(1,2),675);
  assert.equal(gramsFromJinLiang(0,1),38);
  assert.equal(gramsFromJinLiang(1,16),null);
  assert.equal(systemBasePrice(520,480),416);
  assert.equal(systemBasePrice(401,450),301);
});

test('row quote uses each fish date and effective manual T+0 base',()=>{
  const today='2026-09-18';
  assert.equal(rowQuote(base,product,tiers,days,policy,today).currentPrice,336);
  assert.equal(rowQuote({...base,fish_date:'2026-09-17'},product,tiers,days,policy,today).currentPrice,319);
  assert.equal(rowQuote({...base,fish_date:'2026-09-16'},product,tiers,days,policy,today).currentPrice,302);
  assert.equal(rowQuote({...base,fish_date:'2026-09-15'},product,tiers,days,policy,today).errors.length>0,true);
  assert.equal(rowQuote({...base,fish_date:'2026-09-19'},product,tiers,days,policy,today).errors.length>0,true);
  const manual=rowQuote({...base,manual_base_price:450},product,tiers,days,policy,today);
  assert.equal(manual.system,336);assert.equal(manual.base,450);assert.equal(manual.currentPrice,450);
  assert.equal(dayOffset('2026-09-17',today),1);
});

test('tier gap, common-weight and duplicate warnings; configurable manual reconfirm',()=>{
  const gap=rowQuote({...base,raw_weight_g:550},product,tiers,days,policy,'2026-09-18');
  assert.equal(gap.tier,null);assert.equal(gap.errors.some(value=>value.includes('無適用級距')),true);
  const manualGap=rowQuote({...base,raw_weight_g:550,manual_base_price:450,manual_price_confirmed:true},product,tiers,days,policy,'2026-09-18');
  assert.deepEqual(manualGap.errors,[]);assert.equal(manualGap.system,null);
  assert.equal(rowQuote({...base,raw_weight_g:52},product,tiers,days,policy,'2026-09-18').warnings.some(value=>value.includes('常見範圍')),true);
  assert.equal(duplicateWeightWarnings([base,base], [product]).every(Boolean),true);
  assert.equal(manualConfirmationRequired(416,450,null),false);
  assert.equal(manualConfirmationRequired(416,450,.05),true);
  assert.equal(rowQuote({...base,manual_base_price:450},product,tiers,days,{...policy,max_unconfirmed_deviation_ratio:.05},'2026-09-18').errors.some(value=>value.includes('明確確認')),true);
});

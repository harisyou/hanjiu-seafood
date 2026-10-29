import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';

const url=process.env.F006_4_TEST_DATABASE_URL;
const enabled=process.env.F006_4_ENABLE_POSTGRES_TESTS==='1';
const raceStockId=process.env.F006_4_TEST_RACE_STOCK_ID;
const replayStockId=process.env.F006_4_TEST_REPLAY_STOCK_ID;
const psqlAvailable=spawnSync('psql',['--version'],{encoding:'utf8'}).status===0;
const runnable=Boolean(enabled&&url&&raceStockId&&replayStockId&&psqlAvailable);
function psql(sql){return spawnSync('psql',[url,'-X','-v','ON_ERROR_STOP=1','-At','-c',sql],{encoding:'utf8'});}
function concurrent(sql){return new Promise(resolve=>{const child=spawn('psql',[url,'-X','-v','ON_ERROR_STOP=1','-At','-c',sql]);let out='';let err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('close',status=>resolve({status,stdout:out.trim(),stderr:err.trim()}));});}
const call=(key,stockId)=>`select public.phase2_create_checkout_order('C1 concurrency','0912345678','永春市場自取','', '[]'::jsonb, jsonb_build_array(jsonb_build_object('weighted_stock_id','${stockId}','processing_option_ids','[]'::jsonb)),null,'${key}'::uuid)`;

test('PostgreSQL: different keys racing for one fish produce exactly one reservation',{skip:!runnable},async()=>{
  const key1=psql('select gen_random_uuid()').stdout.trim();const key2=psql('select gen_random_uuid()').stdout.trim();
  const results=await Promise.all([concurrent(call(key1,raceStockId)),concurrent(call(key2,raceStockId))]);
  assert.equal(results.filter(x=>x.status===0).length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>/weighted_stock_unavailable/.test(x.stderr)).length,1,JSON.stringify(results));
  const facts=psql(`select count(distinct order_id),count(*) from public.order_items where weighted_stock_id='${raceStockId}' and order_id in (select id from public.orders where checkout_idempotency_key in ('${key1}','${key2}'))`);
  assert.equal(facts.status,0,facts.stderr);assert.equal(facts.stdout,'1|1');
});

test('PostgreSQL: concurrent same-key retry converges to one order and one reservation',{skip:!runnable},async()=>{
  const key=psql('select gen_random_uuid()').stdout.trim();
  const results=await Promise.all([concurrent(call(key,replayStockId)),concurrent(call(key,replayStockId))]);
  assert.equal(results.every(x=>x.status===0),true,JSON.stringify(results));
  assert.equal(new Set(results.map(x=>x.stdout)).size,1,JSON.stringify(results));
  const facts=psql(`select count(*),(select count(*) from public.order_items where order_id=o.id and weighted_stock_id='${replayStockId}') from public.orders o where checkout_idempotency_key='${key}' group by o.id`);
  assert.equal(facts.stdout,'1|1');
});

test('PostgreSQL: payment and expiration serialize on the order lock',{skip:!runnable||!process.env.F006_4_TEST_EXPIRING_ORDER_ID},async()=>{
  const orderId=process.env.F006_4_TEST_EXPIRING_ORDER_ID;const paymentKey=psql('select gen_random_uuid()').stdout.trim();
  const payment=`select (public.admin_record_order_payment('${orderId}',(select total_amount from orders where id='${orderId}'),'cash','${paymentKey}')).id`;
  const release=`select (public.phase2_release_expired_checkout_hold('${orderId}',clock_timestamp())).id`;
  const results=await Promise.all([concurrent(payment),concurrent(release)]);
  assert.equal(results.filter(x=>x.status===0).length,1,JSON.stringify(results));
  const state=psql(`select payment_status,status,weighted_hold_released_at is not null from orders where id='${orderId}'`);
  assert.equal(state.status,0,state.stderr);assert.match(state.stdout,/^(paid\|[^|]+\|f|unpaid\|cancelled\|t)$/);
});

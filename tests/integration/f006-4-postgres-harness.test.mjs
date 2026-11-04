import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const {Client}=pg;
const url=process.env.F006_4_TEST_DATABASE_URL;
const enabled=process.env.F006_4_ENABLE_POSTGRES_TESTS==='1';
const raceStockId=process.env.F006_4_TEST_RACE_STOCK_ID;
const replayStockId=process.env.F006_4_TEST_REPLAY_STOCK_ID;
const expiringOrderId=process.env.F006_4_TEST_EXPIRING_ORDER_ID;
const runnable=Boolean(enabled&&url&&raceStockId&&replayStockId&&expiringOrderId);

async function query(sql){
  const client=new Client({connectionString:url});
  await client.connect();
  try{return await client.query(sql);}finally{await client.end();}
}
async function concurrent(sql){
  try{
    const result=await query(sql);
    return {status:0,stdout:String(result.rows[0]?.value??Object.values(result.rows[0]??{})[0]??''),stderr:''};
  }catch(error){return {status:1,stdout:'',stderr:error instanceof Error?error.message:String(error)};}
}
async function uuid(){return (await query('select gen_random_uuid() value')).rows[0].value;}
const call=(key,stockId)=>`select public.phase2_create_checkout_order('C1 concurrency','0912345678','永春市場自取','', '[]'::jsonb, jsonb_build_array(jsonb_build_object('weighted_stock_id','${stockId}','processing_option_ids','[]'::jsonb)),null,'${key}'::uuid) value`;

test('PostgreSQL: different keys racing for one fish produce exactly one reservation',{skip:!runnable},async()=>{
  const key1=await uuid();const key2=await uuid();
  const results=await Promise.all([concurrent(call(key1,raceStockId)),concurrent(call(key2,raceStockId))]);
  assert.equal(results.filter(x=>x.status===0).length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>/weighted_stock_unavailable/.test(x.stderr)).length,1,JSON.stringify(results));
  const facts=await query(`select
    (select count(*)::integer from public.orders where checkout_idempotency_key in ('${key1}','${key2}')) orders,
    (select count(*)::integer from public.order_items where weighted_stock_id='${raceStockId}' and order_id in (select id from public.orders where checkout_idempotency_key in ('${key1}','${key2}'))) items,
    (select count(*)::integer from public.phase2_weighted_stock where id='${raceStockId}' and status='reserved' and order_id is not null and order_item_id is not null) reservations`);
  assert.deepEqual(facts.rows[0],{orders:1,items:1,reservations:1});
});

test('PostgreSQL: concurrent same-key retry converges to one order and one reservation',{skip:!runnable},async()=>{
  const key=await uuid();
  const results=await Promise.all([concurrent(call(key,replayStockId)),concurrent(call(key,replayStockId))]);
  assert.equal(results.every(x=>x.status===0),true,JSON.stringify(results));
  assert.equal(new Set(results.map(x=>x.stdout)).size,1,JSON.stringify(results));
  const facts=await query(`select count(*)::integer orders,(select count(*)::integer from public.order_items where order_id=o.id and weighted_stock_id='${replayStockId}') items from public.orders o where checkout_idempotency_key='${key}' group by o.id`);
  assert.deepEqual(facts.rows[0],{orders:1,items:1});
});

test('PostgreSQL: payment and expiration serialize on the order lock',{skip:!runnable},async()=>{
  const initial=await query(`select o.payment_status,o.status,o.weighted_hold_expires_at<clock_timestamp() expired,
    count(s.id) filter(where s.status='reserved' and s.order_id=o.id)::integer reserved_stocks
    from orders o left join phase2_weighted_stock s on s.order_id=o.id where o.id='${expiringOrderId}'
    group by o.id`);
  assert.deepEqual(initial.rows[0],{payment_status:'unpaid',status:'new',expired:true,reserved_stocks:1},
    'fixture must contain one real expired unpaid reservation; missing data must fail, not skip');
  const paymentKey=await uuid();
  const payment=`select (public.admin_record_order_payment('${expiringOrderId}',(select total_amount from orders where id='${expiringOrderId}'),'cash','${paymentKey}')).id value`;
  const release=`select (public.phase2_release_expired_checkout_hold('${expiringOrderId}',clock_timestamp())).id value`;
  const results=await Promise.all([concurrent(payment),concurrent(release)]);
  assert.equal(results.filter(x=>x.status===0).length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>/order_payment_hold_expired|paid_order_hold_not_releasable/.test(x.stderr)).length,1,JSON.stringify(results));
  const state=await query(`select o.payment_status,o.status,o.weighted_hold_released_at is not null released,
    (select count(*)::integer from order_payments p where p.order_id=o.id) payments,
    (select count(*)::integer from phase2_weighted_stock s where s.order_id=o.id and s.status='sold') sold_stocks,
    (select count(*)::integer from phase2_weighted_stock s where s.id in (select weighted_stock_id from order_items where order_id=o.id) and s.status in ('sellable','expired') and s.order_id is null) released_stocks
    from orders o where o.id='${expiringOrderId}'`);
  assert.equal(
    JSON.stringify(state.rows[0]),
    JSON.stringify(results[0].status===0&&results[1].status!==0
      ? {payment_status:'paid',status:'new',released:false,payments:1,sold_stocks:1,released_stocks:0}
      : {payment_status:'unpaid',status:'cancelled',released:true,payments:0,sold_stocks:0,released_stocks:1}),
  );
  assert.equal(results.some(x=>/deadlock detected/i.test(x.stderr)),false,JSON.stringify(results));
});

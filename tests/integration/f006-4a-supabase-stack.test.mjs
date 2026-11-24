import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const required=['MAINTENANCE_SUPABASE_URL','MAINTENANCE_SUPABASE_ANON_KEY','MAINTENANCE_SUPABASE_SERVICE_KEY','MAINTENANCE_SUPABASE_OWNER_DATABASE_URL'];
const enabled=process.env.MAINTENANCE_CONFIRM_DISPOSABLE_SUPABASE==='YES'&&required.every(name=>process.env[name]);

test('F006-4a isolated Supabase Data API and Storage integration', {skip:!enabled}, async()=>{
  const base=process.env.MAINTENANCE_SUPABASE_URL.replace(/\/$/,'');
  assert.doesNotMatch(base,/supabase\.co$/,'a disposable project URL must be explicit, never inferred');
  const db=new pg.Client({connectionString:process.env.MAINTENANCE_SUPABASE_OWNER_DATABASE_URL}); await db.connect();
  const op=crypto.randomUUID();
  const state=(await db.query('select active,version from maintenance_private.maintenance_state')).rows[0];
  assert.equal(state.active,false,'test refuses an already-active environment');
  try{
    await db.query('select maintenance_private.enable($1,$2,$3,1800,$4,true,true,true)',[op,state.version,'isolated Supabase integration','integration']);
    const anon=process.env.MAINTENANCE_SUPABASE_ANON_KEY;
    const service=process.env.MAINTENANCE_SUPABASE_SERVICE_KEY;
    for(const request of [
      fetch(`${base}/rest/v1/products?select=id&limit=1`,{headers:{apikey:anon,Authorization:`Bearer ${anon}`}}),
      fetch(`${base}/rest/v1/rpc/is_hanjiu_admin`,{method:'GET',headers:{apikey:anon,Authorization:`Bearer ${anon}`}}),
      fetch(`${base}/rest/v1/rpc/phase2_create_checkout_order`,{method:'POST',headers:{apikey:anon,Authorization:`Bearer ${anon}`,'Content-Type':'application/json'},body:'{}'}),
      fetch(`${base}/storage/v1/object/product-images/maintenance-integration.txt`,{method:'POST',headers:{apikey:service,Authorization:`Bearer ${service}`,'Content-Type':'text/plain','x-upsert':'true'},body:'blocked'})
    ]){
      const response=await request;
      assert.ok(response.status>=400,`expected maintenance rejection, got ${response.status}`);
    }
  } finally {
    const current=(await db.query('select version from maintenance_private.maintenance_state')).rows[0];
    await db.query('select maintenance_private.disable($1,$2,$3)',[crypto.randomUUID(),current.version,'isolated integration cleanup']);
    await db.end();
  }
});


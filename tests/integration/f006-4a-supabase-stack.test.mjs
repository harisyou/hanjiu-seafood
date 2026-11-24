import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

const required=['MAINTENANCE_SUPABASE_URL','MAINTENANCE_SUPABASE_ANON_KEY','MAINTENANCE_SUPABASE_SERVICE_KEY','MAINTENANCE_SUPABASE_OWNER_DATABASE_URL','MAINTENANCE_TEST_PROJECT_REF','MAINTENANCE_TEST_ENVIRONMENT_ID','MAINTENANCE_TEST_DATABASE_SYSTEM_IDENTIFIER'];
const destructiveConfirmation='I_CONFIRM_DISPOSABLE_SUPABASE_STACK';
const configured=required.every(name=>process.env[name]);
const enabled=configured&&process.env.MAINTENANCE_CONFIRM_DISPOSABLE_SUPABASE===destructiveConfirmation;
const ownerUrl=process.env.MAINTENANCE_SUPABASE_OWNER_DATABASE_URL;
const base=configured?process.env.MAINTENANCE_SUPABASE_URL.replace(/\/$/,''):null;
const headers=key=>({apikey:key,Authorization:`Bearer ${key}`});
const bodyText=async response=>(await response.text()).slice(0,1000);
async function expectSuccess(response,label){const body=await bodyText(response);assert.ok(response.ok,`${label}: expected success, got HTTP ${response.status}: ${body}`);return body;}
async function expectMaintenance(response,label){const body=await bodyText(response);assert.ok(response.status>=400,`${label}: unexpectedly succeeded`);assert.match(body,/maintenance_mode_active/i,`${label}: rejection was not attributable to Maintenance Gate (HTTP ${response.status})`);}

async function verifyDisposableIdentity(db){
  const rows=(await db.query(`select environment_id,project_ref,api_origin,database_name,database_system_identifier,purpose,allow_destructive,expires_at from maintenance_test_identity.environment where singleton=true`)).rows;
  assert.equal(rows.length,1,'missing unique database-side disposable identity');
  const row=rows[0];
  const actual=(await db.query(`select current_database() database_name,(pg_control_system()).system_identifier::text system_identifier`)).rows[0];
  assert.equal(row.environment_id,process.env.MAINTENANCE_TEST_ENVIRONMENT_ID,'environment identity mismatch');
  assert.equal(row.project_ref,process.env.MAINTENANCE_TEST_PROJECT_REF,'project identity mismatch');
  assert.equal(row.api_origin,base,'API origin mismatch');
  assert.equal(row.database_name,actual.database_name,'database identity mismatch');
  assert.equal(row.database_system_identifier,actual.system_identifier,'database cluster identity mismatch');
  assert.equal(row.database_system_identifier,process.env.MAINTENANCE_TEST_DATABASE_SYSTEM_IDENTIFIER,'expected cluster identity mismatch');
  assert.equal(row.purpose,'disposable_maintenance_integration');
  assert.equal(row.allow_destructive,true);
  assert.ok(new Date(row.expires_at)>new Date(),'disposable authorization expired');
}

async function ensureInactiveAndCleanup({probeTable,storagePaths}){
  const recovery=new pg.Client({connectionString:ownerUrl});await recovery.connect();
  try{
    const state=(await recovery.query('select active,version from maintenance_private.maintenance_state where singleton')).rows[0];
    if(state?.active){await recovery.query('select maintenance_private.reconcile_protected_relations()');await recovery.query('select maintenance_private.disable($1,$2,$3)',[crypto.randomUUID(),state.version,'isolated integration mandatory cleanup']);}
    const restored=(await recovery.query('select active from maintenance_private.maintenance_state where singleton')).rows;
    assert.equal(restored.length,1,'maintenance state missing after cleanup');assert.equal(restored[0].active,false,'cleanup did not restore inactive state');
    if(probeTable){await recovery.query(`drop table if exists public.${probeTable}`);await recovery.query('select maintenance_private.reconcile_protected_relations()');}
  } finally {await recovery.end();}
  const service=process.env.MAINTENANCE_SUPABASE_SERVICE_KEY;
  for(const path of storagePaths) await fetch(`${base}/storage/v1/object/product-images/${path}`,{method:'DELETE',headers:headers(service)});
}

test('F006-4a isolated Supabase Data API and Storage integration',{skip:!enabled},async()=>{
  const db=new pg.Client({connectionString:ownerUrl});await db.connect();
  const runId=crypto.randomUUID().replaceAll('-','');const probeTable=`maintenance_http_probe_${runId}`;
  const beforePath=`maintenance-tests/${runId}/before.txt`;const blockedPath=`maintenance-tests/${runId}/blocked.txt`;const storagePaths=[beforePath,blockedPath];let testError;let identityVerified=false;
  try{
    await verifyDisposableIdentity(db); // No test write occurs before this multi-factor DB identity check.
    identityVerified=true;
    const state=(await db.query('select active,version from maintenance_private.maintenance_state where singleton')).rows[0];assert.equal(state.active,false,'test refuses an active environment');
    await db.query(`create table public.${probeTable}(id integer primary key,value text not null)`);await db.query(`insert into public.${probeTable} values(1,$1)`,[runId]);
    await db.query(`grant select,insert,update,delete on public.${probeTable} to anon,authenticated,service_role`);await db.query('select maintenance_private.reconcile_protected_relations()');
    const service=process.env.MAINTENANCE_SUPABASE_SERVICE_KEY;const serviceHeaders={...headers(service),'Content-Type':'application/json'};const tableUrl=`${base}/rest/v1/${probeTable}`;
    assert.match(await expectSuccess(await fetch(`${tableUrl}?id=eq.1&select=value`,{headers:headers(service)}),'API/DB identity probe'),new RegExp(runId));
    await expectSuccess(await fetch(tableUrl,{method:'POST',headers:{...serviceHeaders,Prefer:'return=minimal'},body:'{"id":2,"value":"post"}'}),'inactive POST');
    await expectSuccess(await fetch(`${tableUrl}?id=eq.2`,{method:'PATCH',headers:{...serviceHeaders,Prefer:'return=minimal'},body:'{"value":"patch"}'}),'inactive PATCH');
    await expectSuccess(await fetch(`${tableUrl}?id=eq.2`,{method:'DELETE',headers:serviceHeaders}),'inactive DELETE');
    await expectSuccess(await fetch(`${base}/rest/v1/rpc/is_hanjiu_admin`,{method:'GET',headers:headers(service)}),'inactive GET RPC');
    await expectSuccess(await fetch(`${base}/storage/v1/object/product-images/${beforePath}`,{method:'POST',headers:{...headers(service),'Content-Type':'text/plain','x-upsert':'true'},body:'before maintenance'}),'inactive service-role Storage upload');
    assert.equal((await db.query('select count(*) n from storage.objects where bucket_id=$1 and name=$2',['product-images',beforePath])).rows[0].n,'1');
    await expectSuccess(await fetch(`${base}/storage/v1/object/product-images/${beforePath}`,{method:'DELETE',headers:headers(service)}),'inactive Storage cleanup');

    await db.query('select maintenance_private.enable($1,$2,$3,1800,$4,true,true,true)',[crypto.randomUUID(),state.version,'isolated Supabase integration',`integration-${runId}`]);
    for(const [label,request] of [
      ['active GET',fetch(`${tableUrl}?select=id`,{headers:headers(service)})],['active POST',fetch(tableUrl,{method:'POST',headers:serviceHeaders,body:'{"id":3,"value":"blocked"}'})],
      ['active PATCH',fetch(`${tableUrl}?id=eq.1`,{method:'PATCH',headers:serviceHeaders,body:'{"value":"blocked"}'})],['active DELETE',fetch(`${tableUrl}?id=eq.1`,{method:'DELETE',headers:serviceHeaders})],
      ['active GET RPC',fetch(`${base}/rest/v1/rpc/is_hanjiu_admin`,{method:'GET',headers:headers(service)})],['active POST RPC',fetch(`${base}/rest/v1/rpc/is_hanjiu_admin`,{method:'POST',headers:serviceHeaders,body:'{}'})]
    ]) await expectMaintenance(await request,label);

    await expectMaintenance(await fetch(`${base}/storage/v1/object/product-images/${blockedPath}`,{method:'POST',headers:{...headers(service),'Content-Type':'text/plain','x-upsert':'true'},body:'must not persist'}),'active service-role Storage upload');
    assert.equal((await db.query('select count(*) n from storage.objects where bucket_id=$1 and name=$2',['product-images',blockedPath])).rows[0].n,'0','blocked upload created metadata');
    assert.equal((await fetch(`${base}/storage/v1/object/product-images/${blockedPath}`,{headers:headers(service)})).status,404,'blocked upload left an API-accessible orphan');
    const list=await fetch(`${base}/storage/v1/object/list/product-images`,{method:'POST',headers:serviceHeaders,body:JSON.stringify({prefix:`maintenance-tests/${runId}`,limit:100})});assert.doesNotMatch(await expectSuccess(list,'Storage orphan listing'),/blocked\.txt/);

    const active=(await db.query('select version from maintenance_private.maintenance_state where singleton')).rows[0];
    await db.query('select maintenance_private.confirm_postgrest_runtime_gate($1,$2,$3)',[crypto.randomUUID(),active.version,'verified exact maintenance errors for GET POST PATCH DELETE and RPC']);
    const confirmed=(await db.query('select version from maintenance_private.maintenance_state where singleton')).rows[0];await db.query('select maintenance_private.disable($1,$2,$3)',[crypto.randomUUID(),confirmed.version,'isolated integration normal disable']);
    assert.equal((await db.query('select active from maintenance_private.maintenance_state where singleton')).rows[0].active,false);
    await expectSuccess(await fetch(`${base}/storage/v1/object/product-images/${blockedPath}`,{method:'POST',headers:{...headers(service),'Content-Type':'text/plain','x-upsert':'true'},body:'after maintenance'}),'post-disable service-role Storage upload');
    assert.equal((await db.query('select count(*) n from storage.objects where bucket_id=$1 and name=$2',['product-images',blockedPath])).rows[0].n,'1');
  } catch(error){testError=error;} finally {await db.end().catch(()=>{});if(identityVerified){try{await ensureInactiveAndCleanup({probeTable,storagePaths});}catch(cleanupError){testError=testError?new AggregateError([testError,cleanupError],'test failed and mandatory cleanup did not complete'):cleanupError;}}}
  if(testError) throw testError;
});

test('Supabase integration refuses incomplete or unconfirmed identity configuration',{skip:enabled},()=>{if(configured)assert.notEqual(process.env.MAINTENANCE_CONFIRM_DISPOSABLE_SUPABASE,destructiveConfirmation);});

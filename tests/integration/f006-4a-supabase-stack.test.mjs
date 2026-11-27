import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const required=['MAINTENANCE_SUPABASE_URL','MAINTENANCE_SUPABASE_ANON_KEY','MAINTENANCE_SUPABASE_SERVICE_KEY','MAINTENANCE_SUPABASE_OWNER_DATABASE_URL','MAINTENANCE_TEST_PROJECT_REF','MAINTENANCE_TEST_ENVIRONMENT_ID','MAINTENANCE_TEST_DATABASE_SYSTEM_IDENTIFIER'];
const destructiveConfirmation='I_CONFIRM_DISPOSABLE_SUPABASE_STACK';
const configured=required.every(name=>process.env[name]);
const enabled=configured&&process.env.MAINTENANCE_CONFIRM_DISPOSABLE_SUPABASE===destructiveConfirmation;
const ownerUrl=process.env.MAINTENANCE_SUPABASE_OWNER_DATABASE_URL;
const base=configured?process.env.MAINTENANCE_SUPABASE_URL.replace(/\/$/,''):null;
function ownerClient(){
  const url=new URL(ownerUrl);
  for(const name of ['sslmode','ssl','sslcert','sslkey','sslrootcert','sslpassword']){
    if(url.searchParams.has(name)) throw new Error('Use NODE_EXTRA_CA_CERTS for TLS configuration');
  }
  return new pg.Client({connectionString:url.href,ssl:{rejectUnauthorized:true},connectionTimeoutMillis:10000});
}

const diagnosticMessages={
  '42501':'Insufficient database privilege',
  '42P01':'Database relation missing',
  '42883':'Database function missing or signature mismatch',
  '55P03':'Database lock unavailable',
  '57014':'Database statement canceled',
  '55000':'Database prerequisite or state check failed',
  '23505':'Database uniqueness check failed',
  'P0001':'Database rejected the operation',
  'ECONNRESET':'Connection reset',
  'ETIMEDOUT':'Connection timed out',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE':'TLS certificate chain could not be verified',
  'SELF_SIGNED_CERT_IN_CHAIN':'TLS certificate chain is not trusted',
  'ERR_TLS_CERT_ALTNAME_INVALID':'TLS server name did not match certificate'
};

function diagnostic(stage,error){
  const code=error?.code ?? error?.cause?.code;
  const sqlstate=/^[0-9A-Z]{5}$/.test(code??'') ? code : null;
  const messages=new Set(['maintenance_mode_active','maintenance_version_conflict','maintenance_already_active',
    'maintenance_transaction_drain_incomplete','database_owner_direct_session_required','postgrest_request_context_required',
    'Maintenance ownership uncertain; owner recovery required','Use NODE_EXTRA_CA_CERTS for TLS configuration']);
  const knownMessage=messages.has(error?.message) ? error.message : null;
  return {stage,sqlstate,message:knownMessage ?? diagnosticMessages[code] ??
    (error?.name==='TimeoutError'?'HTTP request timed out':'Operation failed (raw details omitted)')};
}

test('diagnostics retain SQLSTATE without leaking error payload or credentials',()=>{
  const secret='postgresql://postgres:PASSWORD@example.invalid/postgres Authorization: Bearer JWT';
  assert.deepEqual(diagnostic('cleanup.connect',{code:'42501',message:secret,detail:secret}),
    {stage:'cleanup.connect',sqlstate:'42501',message:'Insufficient database privilege'});
  assert.doesNotMatch(JSON.stringify(diagnostic('http',{cause:{message:secret}})),/PASSWORD|JWT|Authorization/);
});

const headers=key=>({apikey:key,Authorization:`Bearer ${key}`});
const fetch=(url,options={})=>globalThis.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});
const bodyText=async response=>(await response.text()).slice(0,1000);
async function expectSuccess(response,label){const body=await bodyText(response);assert.ok(response.ok,`${label}: expected success, got HTTP ${response.status}`);return body;}

async function readIdentityResponse(request,pause){
  for(let attempt=1;attempt<=10;attempt++){
    const response=await request();
    if(response.status!==404 || attempt===10) return response;
    await response.body?.cancel();
    await pause();
  }
}

test('a persistent identity HTTP 404 keeps the final response readable',async()=>{
  let attempts=0;
  const response=await readIdentityResponse(async()=>{
    attempts++;
    return new Response('missing fixture',{status:404});
  },async()=>{});
  assert.equal(attempts,10);
  await assert.rejects(expectSuccess(response,'identity'),/HTTP 404/);
});
async function expectMaintenance(response,label,evidence){
  const body=await bodyText(response);
  let payload;
  try { payload=JSON.parse(body); } catch {}
  const rest=label.startsWith('active ');
  const blocked=response.status>=400 && (rest
    ? payload?.code==='55000' && payload?.message==='maintenance_mode_active'
    : /\bmaintenance_mode_active\b/.test(body));
  evidence.push({probe:label,method:label.startsWith('active ') ? label.split(' ')[1] : 'POST',
    status:response.status,code:rest&&blocked?'55000':null,maintenanceError:blocked?'maintenance_mode_active':null});
  assert.ok(blocked,`${label}: expected maintenance_mode_active (HTTP ${response.status})`);
}

function ownsMaintenance(state,audit,operationId,versions){
  return state?.active===true && state.enabled_operation_id===operationId
    && audit?.new_version===versions[0] && versions.includes(state.version);
}

async function removeAndVerify(db,path){
  const serviceHeaders=headers(process.env.MAINTENANCE_SUPABASE_SERVICE_KEY);
  const url=`${base}/storage/v1/object/product-images/${path}`;
  const exists=async()=> (await db.query(
    "select count(*)::int n from storage.objects where bucket_id='product-images' and name=$1",[path]
  )).rows[0].n;
  if(await exists()){
    const deletion=await fetch(`${base}/storage/v1/object/product-images`,{
      method:'DELETE',headers:{...serviceHeaders,'Content-Type':'application/json'},
      body:JSON.stringify({prefixes:[path]})
    });
    assert.ok(deletion.ok,`Storage DELETE failed (HTTP ${deletion.status})`);
  }
  assert.equal(await exists(),0,'Storage metadata remains');
  assert.equal((await fetch(url,{headers:serviceHeaders,cache:'no-store'})).status,404,'Storage GET did not confirm absence');
  const prefix=path.slice(0,path.lastIndexOf('/'));
  const list=await fetch(`${base}/storage/v1/object/list/product-images`,{
    method:'POST',headers:{...serviceHeaders,'Content-Type':'application/json'},
    body:JSON.stringify({prefix,limit:100})
  });
  const entries=JSON.parse(await expectSuccess(list,'cleanup Storage list'));
  assert.ok(Array.isArray(entries)&&!entries.some(entry=>entry.name===path.split('/').at(-1)),'Storage list did not confirm absence');
}

test('cleanup requires matching enable audit, operation and version',()=>{
  const state={active:true,enabled_operation_id:'run',version:'2'};
  assert.equal(ownsMaintenance(state,{new_version:'1'},'run',['1','2']),true);
  assert.equal(ownsMaintenance(state,null,'run',['1','2']),false);
  assert.equal(ownsMaintenance(state,{new_version:'1'},'other',['1','2']),false);
  assert.equal(ownsMaintenance({...state,version:'3'},{new_version:'1'},'run',['1','2']),false);
});

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

async function ensureInactiveAndCleanup({probeTable,storagePaths,operationId,versions,apiVerified,setStage}){
  setStage('cleanup.connect');
  const recovery=ownerClient();
  try{
    await recovery.connect();
    setStage('cleanup.identity');
    await verifyDisposableIdentity(recovery);
    setStage('cleanup.ownership');
    const state=(await recovery.query('select active,version,enabled_operation_id from maintenance_private.maintenance_state where singleton')).rows[0];
    if(state?.active){
      const audit=(await recovery.query("select new_version from maintenance_private.maintenance_events where operation_id=$1 and action='enabled'",[operationId])).rows[0];
      if(!ownsMaintenance(state,audit,operationId,versions)) throw new Error('Maintenance ownership uncertain; owner recovery required');
      setStage('cleanup.disable');
      await recovery.query('select maintenance_private.disable($1,$2,$3)',[crypto.randomUUID(),state.version,'isolated integration mandatory cleanup']);}
    setStage('cleanup.verify_inactive');
    const restored=(await recovery.query('select active from maintenance_private.maintenance_state where singleton')).rows;
    assert.equal(restored.length,1,'maintenance state missing after cleanup');assert.equal(restored[0].active,false,'cleanup did not restore inactive state');
    if(probeTable){
      setStage('cleanup.drop_probe_objects');
      await recovery.query(`begin; drop table if exists public.${probeTable}; drop function if exists public.${probeTable}();
        select maintenance_private.reconcile_protected_relations(); commit;`);
    }
  } finally {await recovery.end();}
  if(!apiVerified || storagePaths.size===0) return;
  setStage('cleanup.storage_connect');
  const db=ownerClient();
  try {
    await db.connect();
    await verifyDisposableIdentity(db);
    setStage('cleanup.storage_verify');
    for(const path of storagePaths) await removeAndVerify(db,path);
  } finally { await db.end(); }
}

test('F006-4a isolated Supabase Data API and Storage integration',{skip:!enabled},async()=>{
  let db;
  let stage='connection.configuration';
  const runId=crypto.randomUUID().replaceAll('-','');const probeTable=`maintenance_http_probe_${runId}`;
  const beforePath=`maintenance-tests/${runId}/before.txt`;const blockedPath=`maintenance-tests/${runId}/blocked.txt`;let testError;let started=false;let apiVerified=false;
  const operationId=crypto.randomUUID();const versions=[];const attemptedPaths=new Set();
  const evidence={origin:null,time:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    operationId,runId,http:[],storage:{metadata:'UNVERIFIED',apiVisible:'UNVERIFIED',s3Visible:'UNVERIFIED',physical:'UNVERIFIED'},cleanup:'NOT_STARTED'};
  try{
    db=ownerClient();
    stage='connection.open';
    await db.connect();
    stage='identity';
    await verifyDisposableIdentity(db); // No test write occurs before this multi-factor DB identity check.
    evidence.origin=new URL(base).origin;
    stage='initial_state';
    const state=(await db.query('select active,version from maintenance_private.maintenance_state where singleton')).rows[0];assert.equal(state.active,false,'test refuses an active environment');
    started=true;
    versions.push(String(BigInt(state.version)+1n));
    stage='fixture.create_table';
    await db.query(`create table public.${probeTable}(id integer primary key,value text not null)`);
    stage='fixture.insert_nonce';
    await db.query(`insert into public.${probeTable} values(1,$1)`,[runId]);
    stage='fixture.grants';
    await db.query(`grant select,insert,update,delete on public.${probeTable} to anon,authenticated,service_role`);
    stage='fixture.reconcile';
    await db.query('select maintenance_private.reconcile_protected_relations()');
    stage='fixture.create_rpc_and_reload_schema';
    await db.query(`create function public.${probeTable}() returns boolean language sql stable as 'select true';
      revoke all on function public.${probeTable}() from public,anon,authenticated;
      grant execute on function public.${probeTable}() to service_role;
      notify pgrst,'reload schema';`);
    const service=process.env.MAINTENANCE_SUPABASE_SERVICE_KEY;const serviceHeaders={...headers(service),'Content-Type':'application/json'};const tableUrl=`${base}/rest/v1/${probeTable}`;
    const rpcUrl=`${base}/rest/v1/rpc/${probeTable}`;
    const observed=async (label,method,request)=>{
      stage=label;
      const response=await request();
      evidence.http.push({probe:label,method,status:response.status});
      return response;
    };
    const linked=await readIdentityResponse(
      ()=>observed('api_identity','GET',()=>fetch(`${tableUrl}?id=eq.1&select=value`,{headers:headers(service)})),
      ()=>new Promise(resolve=>setTimeout(resolve,500)));
    assert.match(await expectSuccess(linked,'API/DB identity probe'),new RegExp(runId));
    apiVerified=true;
    await expectSuccess(await observed('inactive POST','POST',()=>fetch(tableUrl,{method:'POST',headers:{...serviceHeaders,Prefer:'return=minimal'},body:'{"id":2,"value":"post"}'})),'inactive POST');
    await expectSuccess(await observed('inactive PATCH','PATCH',()=>fetch(`${tableUrl}?id=eq.2`,{method:'PATCH',headers:{...serviceHeaders,Prefer:'return=minimal'},body:'{"value":"patch"}'})),'inactive PATCH');
    await expectSuccess(await observed('inactive DELETE','DELETE',()=>fetch(`${tableUrl}?id=eq.2`,{method:'DELETE',headers:serviceHeaders})),'inactive DELETE');
    await expectSuccess(await observed('inactive GET RPC','GET',()=>fetch(rpcUrl,{method:'GET',headers:headers(service)})),'inactive GET RPC');
    await expectSuccess(await observed('inactive POST RPC','POST',()=>fetch(rpcUrl,{method:'POST',headers:serviceHeaders,body:'{}'})),'inactive POST RPC');
    attemptedPaths.add(beforePath);
    await expectSuccess(await observed('inactive service-role Storage upload','POST',()=>fetch(`${base}/storage/v1/object/product-images/${beforePath}`,{method:'POST',headers:{...headers(service),'Content-Type':'text/plain','x-upsert':'true'},body:'before maintenance'})),'inactive service-role Storage upload');
    assert.equal((await db.query('select count(*) n from storage.objects where bucket_id=$1 and name=$2',['product-images',beforePath])).rows[0].n,'1');
    stage='storage.inactive_delete_verify';
    await removeAndVerify(db,beforePath);

    stage='maintenance.enable';
    await db.query('select maintenance_private.enable($1,$2,$3,1800,$4,true,true,true)',[operationId,state.version,'isolated Supabase integration',`integration-${runId}`]);
    for(const [label,request] of [
      ['active GET',()=>fetch(`${tableUrl}?select=id`,{headers:headers(service)})],['active POST',()=>fetch(tableUrl,{method:'POST',headers:serviceHeaders,body:'{"id":3,"value":"blocked"}'})],
      ['active PATCH',()=>fetch(`${tableUrl}?id=eq.1`,{method:'PATCH',headers:serviceHeaders,body:'{"value":"blocked"}'})],['active DELETE',()=>fetch(`${tableUrl}?id=eq.1`,{method:'DELETE',headers:serviceHeaders})],
      ['active GET RPC',()=>fetch(rpcUrl,{method:'GET',headers:headers(service)})],['active POST RPC',()=>fetch(rpcUrl,{method:'POST',headers:serviceHeaders,body:'{}'})]
    ]) {
      stage=label;
      await expectMaintenance(await request(),label,evidence.http);
    }

    stage='storage.active_upload';
    attemptedPaths.add(blockedPath);
    await expectMaintenance(await fetch(`${base}/storage/v1/object/product-images/${blockedPath}`,{method:'POST',headers:{...headers(service),'Content-Type':'text/plain','x-upsert':'true'},body:'must not persist'}),'service-role Storage upload',evidence.http);
    assert.equal((await db.query('select count(*) n from storage.objects where bucket_id=$1 and name=$2',['product-images',blockedPath])).rows[0].n,'0','blocked upload created metadata');
    assert.equal((await fetch(`${base}/storage/v1/object/product-images/${blockedPath}`,{headers:headers(service)})).status,404,'blocked upload left an API-accessible orphan');
    const list=await fetch(`${base}/storage/v1/object/list/product-images`,{method:'POST',headers:serviceHeaders,body:JSON.stringify({prefix:`maintenance-tests/${runId}`,limit:100})});assert.doesNotMatch(await expectSuccess(list,'Storage orphan listing'),/blocked\.txt/);
    evidence.storage.metadata='ABSENT';
    evidence.storage.apiVisible='ABSENT';

    stage='maintenance.confirm';
    const active=(await db.query('select version from maintenance_private.maintenance_state where singleton')).rows[0];
    assert.equal(active.version,versions[0],'maintenance version changed during test');
    const confirmId=crypto.randomUUID();
    await db.query('select maintenance_private.confirm_postgrest_runtime_gate($1,$2,$3)',[confirmId,active.version,'verified exact maintenance errors for GET POST PATCH DELETE and RPC']);
    const confirmedVersion=String(BigInt(active.version)+1n);
    versions.push(confirmedVersion);
    stage='maintenance.disable';
    await db.query('select maintenance_private.disable($1,$2,$3)',[crypto.randomUUID(),confirmedVersion,'isolated integration normal disable']);
    assert.equal((await db.query('select active from maintenance_private.maintenance_state where singleton')).rows[0].active,false);
    await expectSuccess(await observed('post-disable service-role Storage upload','POST',()=>fetch(`${base}/storage/v1/object/product-images/${blockedPath}`,{method:'POST',headers:{...headers(service),'Content-Type':'text/plain','x-upsert':'true'},body:'after maintenance'})),'post-disable service-role Storage upload');
    assert.equal((await db.query('select count(*) n from storage.objects where bucket_id=$1 and name=$2',['product-images',blockedPath])).rows[0].n,'1');
  } catch(error){testError=error;evidence.failure=diagnostic(stage,error);} finally {
    await db?.end().catch(()=>{});
    if(started){
      try {
        await ensureInactiveAndCleanup({probeTable,storagePaths:attemptedPaths,operationId,versions,apiVerified,setStage:value=>{stage=value;}});
        evidence.cleanup='PASS';
      } catch(error) {
        evidence.cleanupFailure=diagnostic(stage,error);
        evidence.cleanup='FAIL_OWNER_REVIEW_REQUIRED';
        testError??=error;
      }
    }
    evidence.result=testError?'FAIL':'PASS';
    console.log(JSON.stringify(evidence));
  }
  if(testError) throw new Error('Cloud integration failed; inspect the sanitized evidence and disposable project logs');
});

test('Supabase integration refuses incomplete or unconfirmed identity configuration',{skip:enabled},()=>{if(configured)assert.notEqual(process.env.MAINTENANCE_CONFIRM_DISPOSABLE_SUPABASE,destructiveConfirmation);});

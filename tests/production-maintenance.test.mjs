import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {maintenanceConfig,maintenanceHtml} from '../lib/maintenance.mjs';

const source=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');

test('maintenance application defaults inactive with 1800 second retry',()=>{
  assert.deepEqual(maintenanceConfig({NODE_ENV:'production'}),{
    active:false,retryAfterSeconds:1800,lineUrl:null,invalidMode:false
  });
});

test('invalid production mode fails closed and LINE must be HTTPS',()=>{
  const bad=maintenanceConfig({NODE_ENV:'production',MAINTENANCE_MODE:'maybe',MAINTENANCE_LINE_URL:'javascript:alert(1)'});
  assert.equal(bad.active,true);
  assert.equal(bad.invalidMode,true);
  assert.equal(bad.lineUrl,null);
  const ok=maintenanceConfig({NODE_ENV:'production',MAINTENANCE_MODE:'on',MAINTENANCE_RETRY_AFTER_SECONDS:'900',MAINTENANCE_LINE_URL:'https://line.me/R/ti/p/test'});
  assert.equal(ok.active,true); assert.equal(ok.retryAfterSeconds,900); assert.match(maintenanceHtml(ok),/line\.me/);
});

test('maintenance page is self-contained and middleware returns hardened 503',()=>{
  const html=maintenanceHtml(maintenanceConfig({MAINTENANCE_MODE:'on'}));
  assert.match(html,/韓九嚴選生鮮/); assert.doesNotMatch(html,/supabase|<script|<img/i);
  const middleware=source('middleware.ts');
  assert.match(middleware,/status:\s*503/); assert.match(middleware,/Retry-After/);
  assert.match(middleware,/no-store/); assert.match(middleware,/api\/healthz/);
  assert.doesNotMatch(source('app/api/healthz/route.ts'),/supabase/i);
});

test('verification scripts are read-only',()=>{
  for(const file of ['supabase/f006-4a-production-maintenance-preflight.sql','supabase/f006-4a-production-maintenance-post-verify.sql','supabase/operations/maintenance-verify.sql','supabase/operations/maintenance-drain-verify.sql']){
    const sql=source(file).replace(/^\s*--.*$/gm,'').replace(/'(?:''|[^'])*'/g,"''");
    assert.doesNotMatch(sql,/\b(create|alter|drop|insert|update|delete|truncate|grant|revoke|call|do)\b/i,file);
  }
});

test('migration is forward-only, inactive, guards DML/TRUNCATE and never snapshots ACLs',()=>{
  const sql=source('supabase/f006-4a-production-maintenance-foundation.sql');
  assert.match(sql,/active boolean not null default false/);
  assert.match(sql,/before insert or update or delete/);
  assert.match(sql,/before truncate/);
  assert.match(sql,/pg_advisory_xact_lock_shared/);
  assert.match(sql,/enforce_api_request\(\)[\s\S]*security invoker/);
  assert.match(sql,/session_user=maintenance_private\.database_owner_name/);
  assert.doesNotMatch(sql,/acl.*snapshot|default_transaction_read_only/i);
  assert.match(sql,/f006_5_must_not_precede_maintenance_foundation/);
});


import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import pg from 'pg';

const url=process.env.F0064A_DATABASE_URL;
const enabled=Boolean(url)&&process.env.F0064A_CONFIRM_DISPOSABLE_POSTGRES==='I_CONFIRM_DISPOSABLE_POSTGRES'
  &&Boolean(process.env.F0064A_TEST_ENVIRONMENT_ID)&&Boolean(process.env.F0064A_TEST_DATABASE_SYSTEM_IDENTIFIER);
const migration=readFileSync(new URL('../../supabase/f006-4a-production-maintenance-foundation.sql',import.meta.url),'utf8');
const sqlFile=name=>readFileSync(new URL(`../../supabase/${name}`,import.meta.url),'utf8');
const connectAs=async user=>{const u=new URL(url);u.username=user;u.password='';const c=new pg.Client({connectionString:u.href});await c.connect();return c;};

async function expectMaintenance(promise){
  await assert.rejects(promise,/maintenance_mode_active/);
}

test('F006-4a real PostgreSQL multi-session gate and drain', {skip:!enabled}, async()=>{
  const owner=new pg.Client({connectionString:url}); await owner.connect();
  const identity=(await owner.query(`select current_database() db,(pg_control_system()).system_identifier::text system_identifier,
    shobj_description(oid,'pg_database') marker from pg_database where datname=current_database()`)).rows[0];
  assert.equal(identity.system_identifier,process.env.F0064A_TEST_DATABASE_SYSTEM_IDENTIFIER,'database cluster identity mismatch');
  assert.equal(identity.marker,`hanjiu-disposable-maintenance-test:${process.env.F0064A_TEST_ENVIRONMENT_ID}`,'database marker mismatch');
  await owner.query(`
    drop schema if exists maintenance_private cascade; drop schema if exists storage cascade;
    drop table if exists public.maintenance_probe cascade;
    drop function if exists public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid) cascade;
    drop function if exists public.is_hanjiu_admin() cascade;
    do $$begin
      if not exists(select 1 from pg_roles where rolname='authenticator') then create role authenticator login; else alter role authenticator login; end if;
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon login; else alter role anon login; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated login; else alter role authenticated login; end if;
      if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role login bypassrls; else alter role service_role login bypassrls; end if;
    end$$;
    create schema storage;
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null);
    alter table storage.objects enable row level security;
    create function public.is_hanjiu_admin() returns boolean language sql stable as $$select true$$;
    create policy "admin upload product images" on storage.objects for insert to authenticated with check(bucket_id='product-images' and public.is_hanjiu_admin());
    create table public.maintenance_probe(id integer primary key,value text);
    create table public.orders(id integer); create table public.order_items(id integer);
    create table public.product_variants(id integer); create table public.inventory_movements(id integer);
    create table public.order_payments(id integer); create table public.order_payment_reversals(id integer);
    create table public.phase2_weighted_stock(id integer);
    create table public.prehook_log(session_name text,current_name text);
    insert into public.maintenance_probe values(1,'before');
    create function public.maintenance_probe_security_definer(integer) returns void language sql security definer as $$insert into public.maintenance_probe values($1,'security-definer')$$;
    create function public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid) returns uuid language sql as $$select gen_random_uuid()$$;
    create function public.maintenance_previous_hook() returns void language sql security invoker as $$insert into public.prehook_log values(session_user,current_user)$$;
    grant usage on schema public,storage to authenticated,service_role;
    grant select,insert,update,delete,truncate on public.maintenance_probe to authenticated;
    grant execute on function public.maintenance_probe_security_definer(integer) to authenticated;
    grant insert on public.prehook_log to authenticated;
    grant execute on function public.maintenance_previous_hook() to authenticated;
    grant select,insert,update,delete on storage.objects to authenticated,service_role;
  `);
  await owner.query(`do $$begin execute format('alter role authenticator in database %I set pgrst.db_pre_request=%L',current_database(),'public.maintenance_previous_hook');end$$`);
  const pre=await owner.query(sqlFile('f006-4a-production-maintenance-preflight.sql'));
  const preRows=(Array.isArray(pre)?pre:[pre]).flatMap(result=>result.rows??[]);
  assert.equal(preRows.some(row=>row.check_name==='SUMMARY'&&row.result==='BLOCKER'),false);
  await owner.query(migration);
  const post=await owner.query(sqlFile('f006-4a-production-maintenance-post-verify.sql'));
  const postRows=(Array.isArray(post)?post:[post]).flatMap(result=>result.rows??[]);
  assert.equal(postRows.some(row=>row.check_name==='SUMMARY'&&row.result==='BLOCKER'),false);
  const initial=(await owner.query('select active,version from maintenance_private.maintenance_state')).rows[0];
  assert.equal(initial.active,false); assert.equal(initial.version,'0');
  assert.equal((await owner.query('select count(*) n from maintenance_private.protection_gaps()')).rows[0].n,'0');

  const app=await connectAs('authenticated');
  await app.query("insert into public.maintenance_probe values(2,'inactive')");
  const service=await connectAs('service_role');
  await service.query("insert into storage.objects(bucket_id,name) values('product-images','existing.jpg')");
  const op=crypto.randomUUID();
  await owner.query('select maintenance_private.enable($1,0,$2,1800,$3,true,true,true)',[op,'integration test','test-revision']);
  await owner.query('select maintenance_private.enable($1,0,$2,1800,$3,true,true,true)',[op,'integration test replay','test-revision']);

  await expectMaintenance(app.query("insert into public.maintenance_probe values(3,'blocked')"));
  await expectMaintenance(app.query("update public.maintenance_probe set value='x' where id=1"));
  await expectMaintenance(app.query('delete from public.maintenance_probe where id=1'));
  await expectMaintenance(app.query('truncate public.maintenance_probe'));
  await expectMaintenance(app.query('select public.maintenance_probe_security_definer(30)'));
  await assert.rejects(app.query('set role postgres'),/permission denied/);
  await app.query("select set_config('request.method','GET',false),set_config('request.jwt.claims','{\"role\":\"authenticated\"}',false)");
  await expectMaintenance(app.query('select maintenance_private.enforce_api_request()'));
  await assert.rejects(app.query('select maintenance_private.confirm_postgrest_runtime_gate($1,1,$2)',[crypto.randomUUID(),'forged confirmation']),/permission denied/);
  const confirmOp=crypto.randomUUID();
  await owner.query('select maintenance_private.confirm_postgrest_runtime_gate($1,1,$2)',[confirmOp,'simulated hook invocation completed']);
  await owner.query('select maintenance_private.confirm_postgrest_runtime_gate($1,1,$2)',[confirmOp,'idempotent replay']);

  await expectMaintenance(service.query("insert into storage.objects(bucket_id,name) values('product-images','blocked.jpg')"));
  await expectMaintenance(service.query("update storage.objects set name='changed.jpg' where name='existing.jpg'"));
  await expectMaintenance(service.query("delete from storage.objects where name='existing.jpg'"));
  assert.equal((await owner.query("select count(*) n from storage.objects where name='blocked.jpg'")).rows[0].n,'0');
  assert.equal((await owner.query("select count(*) n from maintenance_private.maintenance_events where action='enabled'")).rows[0].n,'1');
  await assert.rejects(owner.query("update maintenance_private.maintenance_events set reason='rewrite'"),/maintenance_audit_append_only/);

  const disableOp=crypto.randomUUID();
  await owner.query('select maintenance_private.disable($1,2,$2)',[disableOp,'first cycle complete']);
  await owner.query('select maintenance_private.disable($1,2,$2)',[disableOp,'idempotent replay']);
  await app.query('select maintenance_private.enforce_api_request()');
  const hookActor=(await owner.query('select * from public.prehook_log order by ctid desc limit 1')).rows[0];
  assert.equal(hookActor.session_name,'authenticated'); assert.equal(hookActor.current_name,'authenticated');
  await app.query("select set_config('request.method','',false),set_config('request.jwt.claims','',false)");
  await app.query('begin isolation level repeatable read');
  await app.query('select * from public.maintenance_probe');
  const reenable=owner.query('select maintenance_private.enable($1,3,$2,1800,$3,true,true,true)',[crypto.randomUUID(),'drain test','test-revision']);
  await new Promise(resolve=>setTimeout(resolve,150));
  const pending=await Promise.race([reenable.then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),100))]);
  assert.equal(pending,true,'enable must wait for the old relation snapshot/lock');
  await app.query('rollback');
  await reenable;
  await owner.query('select maintenance_private.recover_fail_closed($1,4,$2)',[crypto.randomUUID(),'prove recovery remains active']);
  assert.equal((await owner.query('select active from maintenance_private.maintenance_state')).rows[0].active,true);
  await owner.query('select maintenance_private.disable($1,5,$2)',[crypto.randomUUID(),'integration complete']);
  assert.equal((await owner.query('select active from maintenance_private.maintenance_state')).rows[0].active,false);
  await assert.rejects(owner.query('select maintenance_private.recover_fail_closed($1,6,$2)',[crypto.randomUUID(),'must remain inactive']),/recovery_must_not_enable/);
  assert.equal((await owner.query('select count(*) n from maintenance_private.maintenance_events')).rows[0].n,'6');

  await app.query("insert into public.maintenance_probe values(4,'after')");
  await Promise.all([app.end(),service.end(),owner.end()]);
});


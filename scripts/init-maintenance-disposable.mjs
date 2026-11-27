import { readFileSync } from 'node:fs';
import pg from 'pg';

const mode = process.argv.slice(2);
const apply = mode.length === 1 && mode[0] === '--apply';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const sql = name => read('supabase/' + name);
let stage = 'configuration';
const report = [];
const require = (condition, message) => { if (!condition) throw new Error(message); };
let db;
try {
  require(!mode.length || apply, 'invalid_arguments');
  require(!apply || process.env.MAINTENANCE_INITIALIZE_CONFIRM === 'INITIALIZE_DISPOSABLE_DATABASE', 'owner_confirmation_missing');
  const manifest = read('docs/production/MIGRATION_MANIFEST.md');
  const files = [...manifest.matchAll(/^\d+\. `supabase\/([\w.-]+\.sql)`/gm)].map(match => match[1]);
  const end = files.indexOf('f006-4a-production-maintenance-foundation.sql');
  require(end > 0 && files[end+1]?.startsWith('f006-5-') && new Set(files).size === files.length, 'invalid_manifest');
  const steps = files.slice(0,end+1);
  require(steps.filter(name=>name.startsWith('f006-')).map(name=>name.split('-')[1]).join(',') === '1,2,3,4,4a', 'invalid_phase_order');
  const config = process.env;
  const origin = 'https://' + config.MAINTENANCE_TEST_PROJECT_REF + '.supabase.co';
  require(/^[a-z0-9]+$/.test(config.MAINTENANCE_TEST_PROJECT_REF ?? '') && config.MAINTENANCE_SUPABASE_URL === origin, 'invalid_test_origin');
  const url = new URL(config.MAINTENANCE_SUPABASE_OWNER_DATABASE_URL);
  const ref = config.MAINTENANCE_TEST_PROJECT_REF;
  const user = decodeURIComponent(url.username);
  const rehearsal = config.MAINTENANCE_LOCAL_REHEARSAL === '1' && url.hostname === '127.0.0.1' && user === 'postgres';
  require(url.protocol === 'postgresql:' && (rehearsal || (url.pathname === '/postgres' && url.port === '5432' &&
    ((url.hostname === 'db.'+ref+'.supabase.co' && user === 'postgres') ||
    (url.hostname.endsWith('.pooler.supabase.com') && user === 'postgres.'+ref)))), 'connection_project_mismatch');
  stage = 'identity';
  db = new pg.Client({connectionString:url.href,ssl:rehearsal?false:{rejectUnauthorized:true},connectionTimeoutMillis:10000});
  await db.connect();
  await db.query('begin read only');
  const identity = (await db.query(`
    select e.*, current_database() actual_database, session_user actual_session,
      current_user actual_user, pg_get_userbyid(d.datdba) actual_owner,
      (pg_control_system()).system_identifier::text actual_system,
      expires_at > now() valid
    from maintenance_test_identity.environment e
    join pg_database d on d.datname=current_database() where e.singleton
  `)).rows;
  const i = identity[0];
  require(identity.length===1 && i.valid && i.allow_destructive && i.purpose==='disposable_maintenance_integration'
    && i.environment_id===config.MAINTENANCE_TEST_ENVIRONMENT_ID && i.project_ref===ref && i.api_origin===origin
    && i.actual_database===i.database_name && i.actual_system===i.database_system_identifier
    && i.actual_system===config.MAINTENANCE_TEST_DATABASE_SYSTEM_IDENTIFIER
    && i.actual_session==='postgres' && i.actual_user==='postgres' && i.actual_owner==='postgres', 'identity_mismatch');
  stage = 'empty_database';
  const empty = (await db.query(`
    select not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','maintenance_private') and c.relkind in ('r','p','v','m','S','f')
      and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e'))
      and not exists(select 1 from storage.buckets where id='product-images') as ok
  `)).rows[0].ok;
  require(empty,'target_not_empty_manual_review_required');
  await db.query('commit');
  if (apply) {
    stage = 'bootstrap';
    const bootstrap = sql('schema.sql').split(/^insert into public.products\(/m)[0];
    await db.query('begin;\n'+bootstrap+`
      alter table public.product_variants enable row level security;
      grant select on public.products,public.product_variants to anon,authenticated;
      commit;
    `);
    report.push({stage,result:'APPLIED'});
    for (const name of steps) {
      const stem = name.match(/^f006-(1|2|3|4a|4)-/)?.[1];
      const checks = {
        '1':'f006-1-phase2-pr-a','2':'f006-2-phase2-pr-b',
        '3':'f006-3-phase2-weighted-stock-availability-actions',
        '4':'f006-4-phase2-weighted-checkout','4a':'f006-4a-production-maintenance'
      };
      let baseline = [];
      const verify = async suffix => {
        stage = checks[stem]+suffix;
        await db.query('begin read only');
        let source = sql(stage);
        if (suffix.startsWith('-post')) {
          const find = key => baseline.find(row=>row[key]!=null)?.[key];
          const quote = value => {
            require(value!=null,'baseline_missing');
            return "'" + String(value).replaceAll("'","''") + "'";
          };
          source = source.replace(/\('([a-z0-9_]+)',null::bigint\)/g,(_,key)=>
            "("+quote(key)+","+quote(baseline.find(r=>(r.entity??r.object_name)===key)?.row_count)+"::bigint)");
          const fill = (pattern, values) => { source=source.replace(pattern,values.map(quote).join(',')); };
          if(stem==='1'){
            source=source.replace('(null::text,null::text)',baseline.filter(r=>r.function_key).map(r=>
              "("+quote(r.function_key)+","+quote(r.definition_md5)+")").join(','));
            for(const [slot,key] of [['rows','rows_md5'],['schema','schema_md5'],['index','index_definition_md5']])
              source=source.replace('null::text)) v(before_'+slot+'_md5)',quote(find(key))+'::text)) v(before_'+slot+'_md5)');
          }
          if(stem==='2'){
            source=source.replace('null::bigint,null::text',quote(find('weighted_stock_baseline_count'))+'::bigint,'+quote(find('weighted_stock_f0061_business_md5'))+'::text');
            source=source.replace('null::jsonb',quote(JSON.stringify(find('protected_function_definition_md5_by_signature')))+'::jsonb');
            fill(/null::text,null::text/,['inventory_movements_schema_md5','inventory_movements_rows_md5'].map(find));
            source=source.replace('(null::text)', '('+quote(find('phase2_configuration_md5'))+'::text)');
          }
          if(stem==='4'||stem==='4a'){
            const row=baseline.find(r=>r.orders_count!=null);
            const fields=stem==='4'
              ? ['products','product_variants','orders','order_items','inventory_movements','order_payments','order_payment_reversals','weighted_stock']
              : ['orders','order_items','product_variants','inventory_movements','order_payments','payment_reversals','weighted_stock'];
            source=source.replace(/null::bigint(?:,null::bigint)+/,fields.map(k=>quote(row?.[k+'_count'])+'::bigint').join(','));
            if(stem==='4'){
              fill(/null::text,null::text,null::text/,['orders_business_md5','order_items_business_md5','weighted_stock_business_md5'].map(find));
              source=source.replace(/\('([^']+\))',null::text\)/g,(_,signature)=>
                "("+quote(signature)+","+quote(baseline.find(r=>r.signature===signature)?.definition_md5)+")");
            }
          }
        }
        const output = await db.query(source);
        const rows = [output].flat().flatMap(result=>result.rows);
        await db.query('commit');
        require(!rows.some(row=>Object.values(row).some(value=>typeof value==='string' && /^(BLOCKER|UNVERIFIED)(:|$)/.test(value))), 'verification_blocker');
        if (suffix.startsWith('-pre')) baseline=rows;
        report.push({stage,result:'PASS'});
      };
      if (stem) await verify('-preflight.sql');
      stage = name;
      await db.query(sql(name));
      report.push({stage,result:'APPLIED',at:new Date().toISOString()});
      if (stem && stem!=='3') await verify('-post-verify.sql');
      if (stem==='3') {
        stage = 'F006-3 postcondition';
        require((await db.query("select to_regclass('public.phase2_weighted_stock_action_tokens') is not null ok")).rows[0].ok,'missing_action_tokens');
        report.push({stage,result:'PASS'});
      }
    }
  }
  console.log(JSON.stringify({mode:apply?'apply':'dry-run',origin,steps,report},null,2));
} catch(error) {
  console.error(JSON.stringify({result:'FAIL',stage,code:/^[A-Z0-9]{5}$/.test(error.code ?? '')?error.code:undefined,report}));
  process.exitCode=1;
} finally {
  await db?.end().catch(()=>{});
}

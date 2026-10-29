-- F006-3 Production preflight. READ ONLY. Run before, never instead of, F006-3.
-- F006-1 and F006-2 must already be applied. Any existing F006-3 object is a
-- BLOCKER: this forward-only migration is not a rerunnable repair script.
with checks(check_name,result,detail) as (
  select 'f0062_weighted_stock_exists',
    case when to_regclass('public.phase2_weighted_stock') is not null then 'PASS' else 'BLOCKER' end,
    'public.phase2_weighted_stock must exist from F006-1/F006-2'
  union all
  select 'f0062_audit_events_exists',
    case when to_regclass('public.phase2_audit_events') is not null then 'PASS' else 'BLOCKER' end,
    'append-only Phase 2 audit table must exist'
  union all
  select 'f0062_freshness_tables_exist',
    case when to_regclass('public.phase2_freshness_policy') is not null
           and to_regclass('public.phase2_freshness_days') is not null then 'PASS' else 'BLOCKER' end,
    'current freshness policy and day multipliers are relist prerequisites'
  union all
  select 'weighted_stock_action_columns_exist',
    case when (
      select count(*)=8 from (values
        ('id','uuid'),('product_id','uuid'),('fish_date','date'),('status','text'),
        ('order_id','uuid'),('order_item_id','uuid'),('t0_base_price','integer'),('version','integer')
      ) expected(name,type_name)
      join pg_attribute a on a.attrelid=to_regclass('public.phase2_weighted_stock')
        and a.attname=expected.name and a.attnum>0 and not a.attisdropped
        and format_type(a.atttypid,a.atttypmod)=expected.type_name
    ) then 'PASS' else 'BLOCKER' end,
    'F006-3 stock columns must match the reviewed F006-2 schema'
  union all
  select 'weighted_stock_status_constraint_supports_canonical_states',
    case when exists (
      select 1 from pg_constraint c
      where c.conrelid=to_regclass('public.phase2_weighted_stock') and c.contype='c' and c.convalidated
        and pg_get_constraintdef(c.oid) like '%sellable%'
        and pg_get_constraintdef(c.oid) like '%manually_unlisted%'
        and pg_get_constraintdef(c.oid) like '%reserved%'
        and pg_get_constraintdef(c.oid) like '%sold%'
        and pg_get_constraintdef(c.oid) like '%externally_sold%'
        and pg_get_constraintdef(c.oid) like '%expired%'
    ) then 'PASS' else 'BLOCKER' end,
    'existing canonical status CHECK must include the states reviewed by F006-3'
  union all
  select 'weighted_stock_required_triggers_exist',
    case when (
      select count(*)=2 from (values
        ('phase2_stock_update_guard','phase2_guard_weighted_stock_update()'),
        ('phase2_stock_no_delete','phase2_no_foundation_delete()')
      ) expected(trigger_name,function_name)
      join pg_trigger t on t.tgrelid=to_regclass('public.phase2_weighted_stock')
        and t.tgname=expected.trigger_name and not t.tgisinternal and t.tgenabled<>'D'
      join pg_proc p on p.oid=t.tgfoid
        and p.oid=to_regprocedure('public.'||expected.function_name)
    ) then 'PASS' else 'BLOCKER' end,
    'update guard and hard-delete guard must remain enabled'
  union all
  select 'weighted_stock_guard_is_reviewed_f0062_source',
    case when (
      select md5(regexp_replace(p.prosrc,E'\r\n?',E'\n','g'))='24766cd7f78bd591e439f29bc388039f'
      from pg_proc p where p.oid=to_regprocedure('public.phase2_guard_weighted_stock_update()')
    ) then 'PASS' else 'BLOCKER' end,
    'F006-3 replaces only the reviewed F006-2 guard body'
  union all
  select 'weighted_stock_browser_direct_update_denied',
    case when not coalesce(has_table_privilege('anon','public.phase2_weighted_stock','UPDATE'),false)
           and not coalesce(has_table_privilege('authenticated','public.phase2_weighted_stock','UPDATE'),false)
      then 'PASS' else 'BLOCKER' end,
    'browser roles must not have direct UPDATE before F006-3'
  union all
  select 'phase2_audit_is_append_only',
    case when exists (
      select 1 from pg_trigger t
      where t.tgrelid=to_regclass('public.phase2_audit_events')
        and t.tgname='phase2_audit_no_update_delete' and not t.tgisinternal and t.tgenabled<>'D'
        and t.tgfoid=to_regprocedure('public.phase2_audit_immutable()')
    ) then 'PASS' else 'BLOCKER' end,
    'action audit depends on the existing append-only guard'
  union all
  select 'f0063_objects_absent',
    case when to_regclass('public.phase2_weighted_stock_action_tokens') is null
           and to_regprocedure('public.admin_unlist_weighted_stock(uuid,integer,text)') is null
           and to_regprocedure('public.admin_relist_weighted_stock(uuid,integer,text)') is null
      then 'PASS' else 'BLOCKER' end,
    'all F006-3 objects must be absent; do not rerun or overwrite a partial deployment'
), ordered_results as (
  select check_name,result,detail from checks
  union all
  select 'SUMMARY',
    case when exists(select 1 from checks where result='BLOCKER') then 'BLOCKER' else 'PASS' end,
    case when exists(select 1 from checks where result='BLOCKER')
      then 'resolve every BLOCKER before running F006-3'
      else 'F006-3 prerequisites satisfied; owner may review the migration for manual execution' end
)
select check_name,result,detail
from ordered_results
order by case when check_name='SUMMARY' then 2 else 1 end,check_name;

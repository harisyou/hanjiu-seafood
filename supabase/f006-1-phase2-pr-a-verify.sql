-- Read-only operator checks AFTER the owner has manually applied F006-1.
-- Do not interpret this file as authorization for Codex to run Production SQL.
select column_name,data_type,is_nullable,column_default
from information_schema.columns
where table_schema='public' and table_name='products' and column_name='inventory_mode';

select table_name,column_name,data_type,is_nullable
from information_schema.columns
where table_schema='public' and table_name in
  ('phase2_weight_pricing_tiers','phase2_weighted_stock','phase2_freshness_policy',
   'phase2_freshness_days','phase2_audit_events')
order by table_name,ordinal_position;

select p.proname,pg_get_function_identity_arguments(p.oid) arguments,p.prosecdef
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in
  ('create_checkout_order','admin_create_weighted_stock','phase2_current_weighted_stock_price')
order by p.proname,arguments;

select policyname,tablename,roles,cmd,qual,with_check
from pg_policies where schemaname='public' and tablename like 'phase2_%'
order by tablename,policyname;

select grantee,table_name,privilege_type
from information_schema.role_table_grants
where table_schema='public' and table_name like 'phase2_%'
  and grantee in ('anon','authenticated')
order by table_name,grantee,privilege_type;

select (select count(*) from public.orders) orders,
       (select count(*) from public.order_items) order_items,
       (select count(*) from public.inventory_movements) inventory_movements,
       (select count(*) from public.order_payments) order_payments,
       (select count(*) from public.order_payment_reversals) order_payment_reversals;

select id,max_sale_day,version from public.phase2_freshness_policy;
select day_offset,multiplier from public.phase2_freshness_days order by day_offset;

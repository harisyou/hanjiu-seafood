-- READ ONLY. User runs manually in Supabase SQL Editor AFTER f005-1 migration.
-- Expected: three product columns with correct types, image/FAQ RLS true.
select table_name,column_name,data_type,is_nullable from information_schema.columns
where table_schema='public' and ((table_name='products' and column_name in ('texture_description','storage_instructions','updated_at'))
  or table_name in ('product_images','product_faqs')) order by table_name,ordinal_position;
select relname,relrowsecurity from pg_class where oid in ('public.product_images'::regclass,'public.product_faqs'::regclass);

-- Expected: zero rows. Exactly one primary for every nonempty gallery.
select product_id,count(*) as images,count(*) filter(where is_primary) as primaries
from public.product_images group by product_id having count(*) filter(where is_primary)<>1;

-- Expected: zero rows immediately after backfill (and after editor saves).
select p.id,p.image_url from public.products p
where nullif(btrim(p.image_url),'') is not null and not exists
 (select 1 from public.product_images i where i.product_id=p.id and i.is_primary
  and coalesce(i.legacy_url,i.public_url)=p.image_url);

-- Expected: zero rows (cover projection and gallery must agree).
select p.id from public.products p join public.product_images i on i.product_id=p.id and i.is_primary
where p.image_url is distinct from coalesce(i.legacy_url,i.public_url);

-- Duplicates are informational, NOT migration failure and NOT permission to merge.
select fish_catalog_id,count(*),array_agg(id) as product_ids from public.products
where fish_catalog_id is not null group by fish_catalog_id having count(*)>1;

-- Expected: public SELECT only, no direct writes for either client role.
select r.role_name,t.table_name,
 has_table_privilege(r.role_name,'public.'||t.table_name,'SELECT') as can_select,
 has_table_privilege(r.role_name,'public.'||t.table_name,'INSERT') as can_insert,
 has_table_privilege(r.role_name,'public.'||t.table_name,'UPDATE') as can_update,
 has_table_privilege(r.role_name,'public.'||t.table_name,'DELETE') as can_delete
from (values('anon'),('authenticated')) r(role_name)
cross join (values('product_images'),('product_faqs')) t(table_name);

-- Expected: SECURITY DEFINER true, fixed search_path for both admin RPCs;
-- authenticated EXECUTE true, anon false. RPC additionally checks admin identity.
select p.proname,p.prosecdef,p.proconfig,
 has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
 has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('admin_save_product_catalog','admin_create_phase1_product');

-- Expected: all false; old browser editors cannot change or delete canonical images.
select has_function_privilege('authenticated','public.admin_update_catalog_product(uuid,text,text,text,text,text,boolean,integer,uuid)','EXECUTE') as old_update,
 has_function_privilege('authenticated','public.admin_create_catalog_product(text,text,text,text,text,boolean,integer,uuid)','EXECUTE') as old_create,
 has_column_privilege('authenticated','public.products','image_url','UPDATE') as direct_image_update;
select policyname,cmd,roles,qual,with_check from pg_policies
where (schemaname='public' and tablename in ('product_images','product_faqs'))
   or (schemaname='storage' and tablename='objects' and cmd in ('DELETE','ALL'));
-- Review Storage policy result: no policy should permit browser deletion of product-images.

-- Save the equivalent output BEFORE migration and compare AFTER, while admin writes
-- are paused. These transaction row counts and function definitions must not change.
select 'orders' as table_name,count(*) from public.orders union all
select 'order_items',count(*) from public.order_items union all
select 'inventory_movements',count(*) from public.inventory_movements union all
select 'order_payments',count(*) from public.order_payments union all
select 'order_payment_reversals',count(*) from public.order_payment_reversals;
select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,md5(pg_get_functiondef(p.oid)) as definition_hash
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('create_checkout_order','admin_cancel_order','admin_confirm_fish_request_order_draft','admin_record_order_payment','admin_reverse_order_payment')
order by p.proname,arguments;

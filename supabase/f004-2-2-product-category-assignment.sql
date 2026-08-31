-- F004-2.2 Product Category Assignment UX
-- Run manually after F004-2.1. Does not alter existing table privileges or RLS policies.

begin;

create or replace function public.admin_create_catalog_product(
  p_name text,
  p_description text,
  p_cooking text,
  p_image_url text,
  p_status text,
  p_featured boolean,
  p_sort_order integer,
  p_category_id uuid
)
returns public.products
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_category_active boolean;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if v_name = '' or char_length(v_name) > 120 then raise exception 'invalid_product_name'; end if;
  if p_status is null or p_status not in ('available', 'sold_out', 'hidden') then raise exception 'invalid_product_status'; end if;
  if p_featured is null then raise exception 'invalid_product_featured'; end if;
  if p_sort_order is null then raise exception 'invalid_product_sort_order'; end if;
  if p_category_id is null then raise exception 'product_category_required'; end if;
  select active into v_category_active from public.product_categories where id = p_category_id for share;
  if not found then raise exception 'product_category_not_found'; end if;
  if not v_category_active then raise exception 'product_category_inactive'; end if;

  insert into public.products (name, description, cooking, image_url, status, featured, sort_order, category_id)
  values (
    v_name,
    nullif(btrim(coalesce(p_description, '')), ''),
    nullif(btrim(coalesce(p_cooking, '')), ''),
    nullif(btrim(coalesce(p_image_url, '')), ''),
    p_status,
    p_featured,
    p_sort_order,
    p_category_id
  )
  returning * into v_product;
  return v_product;
end;
$$;

create or replace function public.admin_update_catalog_product(
  p_product_id uuid,
  p_name text,
  p_description text,
  p_cooking text,
  p_image_url text,
  p_status text,
  p_featured boolean,
  p_sort_order integer,
  p_category_id uuid
)
returns public.products
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product public.products;
  v_category_active boolean;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_product_id is null then raise exception 'product_not_found'; end if;
  if v_name = '' or char_length(v_name) > 120 then raise exception 'invalid_product_name'; end if;
  if p_status is null or p_status not in ('available', 'sold_out', 'hidden') then raise exception 'invalid_product_status'; end if;
  if p_featured is null then raise exception 'invalid_product_featured'; end if;
  if p_sort_order is null then raise exception 'invalid_product_sort_order'; end if;
  if p_category_id is null then raise exception 'product_category_required'; end if;
  perform 1 from public.products where id = p_product_id for update;
  if not found then raise exception 'product_not_found'; end if;
  select active into v_category_active from public.product_categories where id = p_category_id for share;
  if not found then raise exception 'product_category_not_found'; end if;
  if not v_category_active then raise exception 'product_category_inactive'; end if;

  update public.products
  set
    name = v_name,
    description = nullif(btrim(coalesce(p_description, '')), ''),
    cooking = nullif(btrim(coalesce(p_cooking, '')), ''),
    image_url = nullif(btrim(coalesce(p_image_url, '')), ''),
    status = p_status,
    featured = p_featured,
    sort_order = p_sort_order,
    category_id = p_category_id
  where id = p_product_id
  returning * into v_product;
  return v_product;
end;
$$;

revoke all on function public.admin_create_catalog_product(text, text, text, text, text, boolean, integer, uuid) from public, anon, authenticated;
revoke all on function public.admin_update_catalog_product(uuid, text, text, text, text, text, boolean, integer, uuid) from public, anon, authenticated;
grant execute on function public.admin_create_catalog_product(text, text, text, text, text, boolean, integer, uuid) to authenticated;
grant execute on function public.admin_update_catalog_product(uuid, text, text, text, text, text, boolean, integer, uuid) to authenticated;

commit;

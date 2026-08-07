-- F003-4: secure daily product and inventory management.
-- Run once after F003-3. Uses the existing products.status field for product
-- availability; no redundant products.active column is introduced.

alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.processing_options enable row level security;
alter table public.processing_presets enable row level security;
alter table public.processing_preset_options enable row level security;
alter table public.product_processing_options enable row level security;
alter table public.product_processing_presets enable row level security;

drop policy if exists "public read visible products" on public.products;
create policy "public read visible products" on public.products for select to anon, authenticated
using (status <> 'hidden');
drop policy if exists "admin read all products" on public.products;
create policy "admin read all products" on public.products for select to authenticated
using ((select public.is_hanjiu_admin()));
drop policy if exists "admin insert products" on public.products;
create policy "admin insert products" on public.products for insert to authenticated
with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin update products" on public.products;
create policy "admin update products" on public.products for update to authenticated
using ((select public.is_hanjiu_admin())) with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin delete products" on public.products;

drop policy if exists "public read active product variants" on public.product_variants;
create policy "public read active product variants" on public.product_variants for select to anon, authenticated
using (
  active and exists (
    select 1 from public.products product
    where product.id = product_id and product.status <> 'hidden'
  )
);
drop policy if exists "admin read all product variants" on public.product_variants;
create policy "admin read all product variants" on public.product_variants for select to authenticated
using ((select public.is_hanjiu_admin()));
drop policy if exists "admin insert product variants" on public.product_variants;
create policy "admin insert product variants" on public.product_variants for insert to authenticated
with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin update product variants" on public.product_variants;
create policy "admin update product variants" on public.product_variants for update to authenticated
using ((select public.is_hanjiu_admin())) with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin delete product variants" on public.product_variants;

drop policy if exists "public read active processing options" on public.processing_options;
create policy "public read active processing options" on public.processing_options for select to anon, authenticated
using (active);
drop policy if exists "admin manage processing options" on public.processing_options;
drop policy if exists "admin read all processing options" on public.processing_options;
create policy "admin read all processing options" on public.processing_options for select to authenticated
using ((select public.is_hanjiu_admin()));

drop policy if exists "public read active processing presets" on public.processing_presets;
create policy "public read active processing presets" on public.processing_presets for select to anon, authenticated
using (active);
drop policy if exists "admin manage processing presets" on public.processing_presets;
drop policy if exists "admin read all processing presets" on public.processing_presets;
create policy "admin read all processing presets" on public.processing_presets for select to authenticated
using ((select public.is_hanjiu_admin()));

drop policy if exists "admin manage preset composition" on public.processing_preset_options;
drop policy if exists "admin read preset composition" on public.processing_preset_options;
create policy "admin read preset composition" on public.processing_preset_options for select to authenticated
using ((select public.is_hanjiu_admin()));

drop policy if exists "admin manage product processing options" on public.product_processing_options;
create policy "admin manage product processing options" on public.product_processing_options for all to authenticated
using ((select public.is_hanjiu_admin())) with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin manage product processing presets" on public.product_processing_presets;
create policy "admin manage product processing presets" on public.product_processing_presets for all to authenticated
using ((select public.is_hanjiu_admin())) with check ((select public.is_hanjiu_admin()));

revoke insert, update, delete on public.products from anon, authenticated;
revoke insert, update, delete on public.product_variants from anon, authenticated;
revoke insert, update, delete on public.processing_options, public.processing_presets,
  public.processing_preset_options from anon, authenticated;
revoke insert, update, delete on public.product_processing_options,
  public.product_processing_presets from anon, authenticated;

grant insert on public.products to authenticated;
grant update (name, description, cooking, image_url, status, featured, sort_order, processing_enabled)
  on public.products to authenticated;
grant insert on public.product_variants to authenticated;
grant update (name, price, inventory, active, sort_order) on public.product_variants to authenticated;
grant insert, update, delete on public.product_processing_options,
  public.product_processing_presets to authenticated;

drop policy if exists "authenticated upload product images" on storage.objects;
drop policy if exists "admin upload product images" on storage.objects;
create policy "admin upload product images" on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and (select public.is_hanjiu_admin()));
drop policy if exists "admin delete product images" on storage.objects;
create policy "admin delete product images" on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and (select public.is_hanjiu_admin()));

create or replace function public.admin_create_inventory_product(
  p_product_name text,
  p_processing_enabled boolean,
  p_product_status text,
  p_variant_name text,
  p_price integer,
  p_inventory integer,
  p_variant_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_id uuid;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if nullif(btrim(p_product_name), '') is null then raise exception 'product_name_required'; end if;
  if nullif(btrim(p_variant_name), '') is null then raise exception 'variant_name_required'; end if;
  if length(btrim(p_product_name)) > 120 or length(btrim(p_variant_name)) > 120 then raise exception 'invalid_length'; end if;
  if p_product_status is null or p_product_status not in ('available', 'sold_out', 'hidden') then raise exception 'invalid_product_status'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if;
  if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if;

  insert into public.products (name, status, processing_enabled)
  values (btrim(p_product_name), p_product_status, coalesce(p_processing_enabled, false))
  returning id into v_product_id;

  insert into public.product_variants (product_id, name, price, inventory, active)
  values (v_product_id, btrim(p_variant_name), p_price, p_inventory, coalesce(p_variant_active, true));

  return v_product_id;
end;
$$;

revoke all on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean)
  to authenticated;

create or replace function public.enforce_order_item_variant_availability()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant record;
begin
  if new.variant_id is null then return new; end if;
  select variant.active, variant.inventory, product.status as product_status
  into v_variant
  from public.product_variants variant
  join public.products product on product.id = variant.product_id
  where variant.id = new.variant_id;

  if not found or not v_variant.active or v_variant.product_status <> 'available'
    or new.quantity > v_variant.inventory then
    raise exception 'variant_unavailable';
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_enforce_variant_availability on public.order_items;
create trigger order_items_enforce_variant_availability
before insert on public.order_items
for each row execute function public.enforce_order_item_variant_availability();

revoke all on function public.enforce_order_item_variant_availability()
  from public, anon, authenticated;

-- Recovery: disabling this feature does not require deleting data. Product and
-- variant availability can be restored by status/active/inventory updates.
-- The trigger can be dropped independently if rollback is required.

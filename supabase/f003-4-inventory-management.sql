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

create or replace function public.admin_update_inventory_variants(
  p_product_id uuid,
  p_variants jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_variant_id uuid;
  v_variant_id_text text;
  v_variant_name text;
  v_price bigint;
  v_inventory bigint;
  v_seen_ids uuid[] := '{}';
  v_expected integer;
  v_updated integer;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_product_id is null then raise exception 'product_id_required'; end if;
  if jsonb_typeof(p_variants) is distinct from 'array' or jsonb_array_length(p_variants) = 0 then
    raise exception 'variants_required';
  end if;
  if jsonb_array_length(p_variants) > 200 then raise exception 'too_many_variants'; end if;

  v_expected := jsonb_array_length(p_variants);
  for v_item in select value from jsonb_array_elements(p_variants) loop
    if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'invalid_variant'; end if;

    v_variant_id_text := v_item->>'id';
    if v_variant_id_text is null or v_variant_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_variant_id';
    end if;
    v_variant_id := v_variant_id_text::uuid;
    if v_variant_id = any(v_seen_ids) then raise exception 'duplicate_variant_id'; end if;
    v_seen_ids := array_append(v_seen_ids, v_variant_id);

    if jsonb_typeof(v_item->'name') is distinct from 'string' then raise exception 'variant_name_required'; end if;
    v_variant_name := btrim(v_item->>'name');
    if v_variant_name is null or v_variant_name = '' then raise exception 'variant_name_required'; end if;
    if length(v_variant_name) > 120 then raise exception 'invalid_length'; end if;

    if jsonb_typeof(v_item->'price') is distinct from 'number' or (v_item->>'price') is null
      or (v_item->>'price') !~ '^-?[0-9]+$' then
      raise exception 'invalid_price';
    end if;
    v_price := (v_item->>'price')::bigint;
    if v_price < 0 or v_price > 2147483647 then raise exception 'invalid_price'; end if;

    if jsonb_typeof(v_item->'inventory') is distinct from 'number' or (v_item->>'inventory') is null
      or (v_item->>'inventory') !~ '^-?[0-9]+$' then
      raise exception 'invalid_inventory';
    end if;
    v_inventory := (v_item->>'inventory')::bigint;
    if v_inventory < 0 or v_inventory > 2147483647 then raise exception 'invalid_inventory'; end if;

    if jsonb_typeof(v_item->'active') is distinct from 'boolean' then raise exception 'invalid_active'; end if;
    if not exists (
      select 1 from public.product_variants variant
      where variant.id = v_variant_id and variant.product_id = p_product_id
    ) then
      raise exception 'variant_product_mismatch';
    end if;
  end loop;

  with payload as (
    select id, btrim(name) as name, price, inventory, active
    from jsonb_to_recordset(p_variants)
      as item(id uuid, name text, price integer, inventory integer, active boolean)
  )
  update public.product_variants variant
  set name = payload.name,
      price = payload.price,
      inventory = payload.inventory,
      active = payload.active
  from payload
  where variant.id = payload.id
    and variant.product_id = p_product_id;

  get diagnostics v_updated = row_count;
  if v_updated <> v_expected then raise exception 'batch_update_incomplete'; end if;
  return v_updated;
end;
$$;

revoke all on function public.admin_update_inventory_variants(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.admin_update_inventory_variants(uuid, jsonb)
  to authenticated;

-- Preserve the production Checkout API while making inventory reservation
-- atomic. The conditional UPDATE obtains a row lock and only succeeds when
-- the requested quantity is still available at the instant of deduction.
create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_item jsonb;
  v_variant record;
  v_variant_id uuid;
  v_quantity integer;
  v_preset_id text;
  v_preset_name text;
  v_option_ids text[];
  v_option_names text[];
  v_expected_count integer;
  v_note text;
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and length(v_email) > 254 then raise exception 'invalid_email'; end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;

  v_customer_id := public.find_or_create_customer(p_customer_name, v_phone, v_email, null);

  insert into public.orders (customer_id, customer_name, phone, email, line_id, fulfillment, processing, note)
  values (v_customer_id, btrim(p_customer_name), v_phone, v_email, null, p_fulfillment, '依品項', nullif(p_note, ''))
  returning id into v_order_id;

  -- A stable variant order prevents opposite cart ordering from creating
  -- avoidable lock-order deadlocks in concurrent multi-item checkouts.
  for v_item in
    select value from jsonb_array_elements(p_items)
    order by value->>'variant_id'
  loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(v_item->>'processing_preset_id', '');
    v_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}') into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    if v_quantity is null or v_quantity < 1 then raise exception 'invalid_quantity'; end if;

    -- Read only stable product/configuration metadata here. Inventory is not
    -- trusted until the conditional UPDATE below acquires the row lock.
    select variant.id as variant_id, variant.product_id, product.name as product_name,
      product.processing_enabled, product.status as product_status,
      variant.name as variant_name, variant.price, variant.active
    into v_variant
    from public.product_variants variant
    join public.products product on product.id = variant.product_id
    where variant.id = v_variant_id;
    if not found or not v_variant.active or v_variant.product_status <> 'available' then
      raise exception 'variant_unavailable';
    end if;

    if not v_variant.processing_enabled then
      v_preset_id := 'none'; v_preset_name := '不處理'; v_option_ids := '{}'; v_option_names := '{}'; v_note := null;
    else
      if v_preset_id is not null then
        select preset.name into v_preset_name
        from public.product_processing_presets config
        join public.processing_presets preset on preset.id = config.preset_id
        where config.product_id = v_variant.product_id and config.preset_id = v_preset_id
          and config.active and preset.active;
        if not found then raise exception 'processing_updated'; end if;
      end if;
      select count(*), coalesce(array_agg(option_catalog.name order by option_config.sort_order), '{}')
      into v_expected_count, v_option_names
      from unnest(v_option_ids) selected_id
      join public.product_processing_options option_config on option_config.product_id = v_variant.product_id
        and option_config.processing_option_id = selected_id and option_config.active
      join public.processing_options option_catalog on option_catalog.id = option_config.processing_option_id and option_catalog.active;
      if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;
      if v_preset_id is not null and not exists (
        select 1 from (select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids
          from public.processing_preset_options where preset_id = v_preset_id) preset_options
        where preset_options.ids = v_option_ids
      ) then v_preset_name := '客製化處理'; end if;
      if v_preset_id is null then v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end; end if;
    end if;

    update public.product_variants variant
    set inventory = variant.inventory - v_quantity
    from public.products product
    where variant.id = v_variant_id
      and product.id = variant.product_id
      and product.status = 'available'
      and variant.active
      and variant.inventory >= v_quantity
    returning variant.id as variant_id, variant.product_id,
      product.name as product_name, product.processing_enabled,
      variant.name as variant_name, variant.price, variant.active
    into v_variant;
    if not found then raise exception 'variant_unavailable'; end if;

    insert into public.order_items (
      order_id, product_id, product_name, variant_id, variant_name, price, quantity,
      processing_preset_id, processing_preset_name, processing_option_ids, processing_option_names, processing_note
    ) values (
      v_order_id, v_variant.product_id, v_variant.product_name, v_variant.variant_id,
      v_variant.variant_name, v_variant.price, v_quantity, v_preset_id,
      v_preset_name, v_option_ids, v_option_names, v_note
    );
  end loop;
  return v_order_id;
end;
$$;

-- Keep the five-parameter compatibility overload for existing callers.
create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.create_checkout_order(
    p_customer_name, p_phone, p_fulfillment, p_note, p_items, null::text
  );
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke insert on public.orders, public.order_items from anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text)
  to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb)
  to anon, authenticated;

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
  select variant.active, product.status as product_status
  into v_variant
  from public.product_variants variant
  join public.products product on product.id = variant.product_id
  where variant.id = new.variant_id;

  -- Checkout already deducted inventory atomically before inserting the
  -- snapshot. This trigger independently protects active/product status only;
  -- comparing against the post-deduction balance would reject the last unit.
  if not found or not v_variant.active or v_variant.product_status <> 'available' then
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

-- F003-12 Phase A: compatibility migration. Run before deploying the new UI.
-- It intentionally preserves legacy product_variants INSERT/UPDATE grants.

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  inventory_delta integer not null check (inventory_delta <> 0),
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after integer not null check (quantity_after >= 0),
  movement_type text not null check (movement_type in ('checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment')),
  order_id uuid references public.orders(id) on delete restrict,
  fish_request_id uuid references public.fish_requests(id) on delete restrict,
  actor_id uuid,
  created_at timestamptz not null default now(),
  check (quantity_after - quantity_before = inventory_delta)
);
create index if not exists inventory_movements_variant_created_at_idx on public.inventory_movements (variant_id, created_at desc);
create index if not exists inventory_movements_product_created_at_idx on public.inventory_movements (product_id, created_at desc);
create index if not exists inventory_movements_order_id_idx on public.inventory_movements (order_id) where order_id is not null;
alter table public.inventory_movements enable row level security;
revoke all on public.inventory_movements from public, anon, authenticated;
drop policy if exists "admin read inventory movements" on public.inventory_movements;
create policy "admin read inventory movements" on public.inventory_movements for select to authenticated using ((select public.is_hanjiu_admin()));
grant select on public.inventory_movements to authenticated;

create or replace function public.log_inventory_movement()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_type text := coalesce(nullif(current_setting('app.inventory_movement_type', true), ''), 'admin_adjustment');
  v_order_text text := nullif(current_setting('app.inventory_movement_order_id', true), '');
  v_request_text text := nullif(current_setting('app.inventory_movement_fish_request_id', true), '');
  v_order_id uuid;
  v_request_id uuid;
begin
  if tg_op = 'INSERT' then
    if new.inventory = 0 then return new; end if;
    if v_type <> 'admin_adjustment' then raise exception 'inventory_movement_context_invalid'; end if;
    insert into public.inventory_movements (variant_id, product_id, inventory_delta, quantity_before, quantity_after, movement_type, actor_id)
    values (new.id, new.product_id, new.inventory, 0, new.inventory, 'admin_adjustment', auth.uid());
    return new;
  end if;
  if new.inventory = old.inventory then return new; end if;
  if v_type not in ('checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment') then raise exception 'inventory_movement_context_invalid'; end if;
  if v_order_text is not null then v_order_id := v_order_text::uuid; end if;
  if v_request_text is not null then v_request_id := v_request_text::uuid; end if;
  if v_type = 'checkout_sale' and v_order_id is null then raise exception 'inventory_movement_context_invalid'; end if;
  if v_type = 'fish_request_order_confirmation' and (v_order_id is null or v_request_id is null) then raise exception 'inventory_movement_context_invalid'; end if;
  if v_type = 'admin_adjustment' and (v_order_id is not null or v_request_id is not null) then raise exception 'inventory_movement_context_invalid'; end if;
  insert into public.inventory_movements (variant_id, product_id, inventory_delta, quantity_before, quantity_after, movement_type, order_id, fish_request_id, actor_id)
  values (new.id, new.product_id, new.inventory - old.inventory, old.inventory, new.inventory, v_type, v_order_id, v_request_id, auth.uid());
  return new;
end;
$$;
drop trigger if exists inventory_variant_movement_ledger on public.product_variants;
drop trigger if exists checkout_order_item_movement_ledger on public.order_items;
drop trigger if exists draft_confirmation_movement_ledger on public.orders;
create trigger inventory_variant_movement_ledger after insert or update of inventory on public.product_variants for each row execute function public.log_inventory_movement();

-- Preserve the production checkout contract; only set local ledger context before the existing conditional update.
create or replace function public.create_checkout_order(
  p_customer_name text, p_phone text, p_fulfillment text, p_note text, p_items jsonb, p_email text
) returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order_id uuid; v_customer_id uuid; v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_item jsonb; v_variant record; v_variant_id uuid; v_quantity integer; v_preset_id text; v_preset_name text;
  v_option_ids text[]; v_option_names text[]; v_expected_count integer; v_note text;
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then raise exception 'invalid_email'; end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;
  v_customer_id := public.find_or_create_customer(p_customer_name, v_phone, v_email, null);
  insert into public.orders (customer_id, customer_name, phone, email, line_id, fulfillment, processing, note)
  values (v_customer_id, btrim(p_customer_name), v_phone, v_email, null, p_fulfillment, '依品項', nullif(p_note, '')) returning id into v_order_id;
  perform set_config('app.inventory_movement_type', 'checkout_sale', true);
  perform set_config('app.inventory_movement_order_id', v_order_id::text, true);
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'variant_id' loop
    v_variant_id := (v_item->>'variant_id')::uuid; v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(v_item->>'processing_preset_id', ''); v_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}') into v_option_ids from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    if v_quantity is null or v_quantity < 1 then raise exception 'invalid_quantity'; end if;
    select variant.id as variant_id, variant.product_id, product.name as product_name, product.processing_enabled, product.status as product_status, variant.name as variant_name, variant.price, variant.active into v_variant from public.product_variants variant join public.products product on product.id = variant.product_id where variant.id = v_variant_id;
    if not found or not v_variant.active or v_variant.product_status <> 'available' then raise exception 'variant_unavailable'; end if;
    if not v_variant.processing_enabled then
      v_preset_id := 'none'; v_preset_name := '不處理'; v_option_ids := '{}'; v_option_names := '{}'; v_note := null;
    else
      if v_preset_id is not null then select preset.name into v_preset_name from public.product_processing_presets config join public.processing_presets preset on preset.id = config.preset_id where config.product_id = v_variant.product_id and config.preset_id = v_preset_id and config.active and preset.active; if not found then raise exception 'processing_updated'; end if; end if;
      select count(*), coalesce(array_agg(option_catalog.name order by option_config.sort_order), '{}') into v_expected_count, v_option_names from unnest(v_option_ids) selected_id join public.product_processing_options option_config on option_config.product_id = v_variant.product_id and option_config.processing_option_id = selected_id and option_config.active join public.processing_options option_catalog on option_catalog.id = option_config.processing_option_id and option_catalog.active;
      if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;
      if v_preset_id is not null and not exists (select 1 from (select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids from public.processing_preset_options where preset_id = v_preset_id) preset_options where preset_options.ids = v_option_ids) then v_preset_name := '客製化處理'; end if;
      if v_preset_id is null then v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end; end if;
    end if;
    update public.product_variants variant set inventory = variant.inventory - v_quantity from public.products product where variant.id = v_variant_id and product.id = variant.product_id and product.status = 'available' and variant.active and variant.inventory >= v_quantity returning variant.id as variant_id, variant.product_id, product.name as product_name, product.processing_enabled, variant.name as variant_name, variant.price, variant.active into v_variant;
    if not found then raise exception 'variant_unavailable'; end if;
    insert into public.order_items (order_id, product_id, product_name, variant_id, variant_name, price, quantity, processing_preset_id, processing_preset_name, processing_option_ids, processing_option_names, processing_note) values (v_order_id, v_variant.product_id, v_variant.product_name, v_variant.variant_id, v_variant.variant_name, v_variant.price, v_quantity, v_preset_id, v_preset_name, v_option_ids, v_option_names, v_note);
  end loop;
  return v_order_id;
end;
$$;
create or replace function public.create_checkout_order(p_customer_name text, p_phone text, p_fulfillment text, p_note text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$ begin return public.create_checkout_order(p_customer_name, p_phone, p_fulfillment, p_note, p_items, null::text); end; $$;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;

-- F003-10 confirmation contract is retained; its inventory update now carries trusted ledger context.
create or replace function public.admin_confirm_fish_request_order_draft(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order public.orders; v_request public.fish_requests; v_item record; v_item_count integer; v_expected_count integer; v_variant record;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status <> 'draft' then raise exception 'order_not_draft'; end if;
  if v_order.fish_request_id is null then raise exception 'fish_request_relation_missing'; end if;
  if v_order.fulfillment is null or v_order.fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if v_order.processing <> '依品項' then raise exception 'processing_updated'; end if;
  select count(*) into v_item_count from public.order_items where order_id = v_order.id; if v_item_count <> 1 then raise exception 'invalid_draft_order'; end if;
  select item.*, product.processing_enabled, product.status as product_status into v_item from public.order_items item join public.products product on product.id = item.product_id where item.order_id = v_order.id for update of item, product;
  if not found or v_item.variant_id is null or v_item.quantity < 1 then raise exception 'invalid_draft_order'; end if;
  select * into v_request from public.fish_requests where id = v_order.fish_request_id for update;
  if not found then raise exception 'fish_request_relation_missing'; end if;
  if v_request.status not in ('waiting', 'contacted') then raise exception 'fish_request_not_eligible'; end if;
  if not v_item.processing_enabled then
    if v_item.processing_preset_id <> 'none' or coalesce(cardinality(v_item.processing_option_ids), 0) <> 0 then raise exception 'processing_updated'; end if;
  else
    if v_item.processing_preset_id is not null and not exists (select 1 from public.product_processing_presets config join public.processing_presets preset on preset.id = config.preset_id where config.product_id = v_item.product_id and config.preset_id = v_item.processing_preset_id and config.active and preset.active) then raise exception 'processing_updated'; end if;
    select count(*) into v_expected_count from unnest(coalesce(v_item.processing_option_ids, '{}'::text[])) selected_id join public.product_processing_options option_config on option_config.product_id = v_item.product_id and option_config.processing_option_id = selected_id and option_config.active join public.processing_options option_catalog on option_catalog.id = option_config.processing_option_id and option_catalog.active;
    if v_expected_count <> coalesce(cardinality(v_item.processing_option_ids), 0) then raise exception 'processing_updated'; end if;
  end if;
  perform set_config('app.inventory_movement_type', 'fish_request_order_confirmation', true);
  perform set_config('app.inventory_movement_order_id', v_order.id::text, true);
  perform set_config('app.inventory_movement_fish_request_id', v_request.id::text, true);
  update public.product_variants variant set inventory = variant.inventory - v_item.quantity from public.products product where variant.id = v_item.variant_id and product.id = variant.product_id and product.status = 'available' and variant.active and variant.inventory >= v_item.quantity returning variant.id, variant.inventory into v_variant;
  if not found then raise exception 'variant_unavailable'; end if;
  update public.orders set status = 'new' where id = v_order.id and status = 'draft' returning * into v_order; if not found then raise exception 'order_not_draft'; end if;
  update public.fish_requests set status = 'converted' where id = v_request.id and status in ('waiting', 'contacted'); if not found then raise exception 'fish_request_not_eligible'; end if;
  return v_order;
end;
$$;
revoke all on function public.admin_confirm_fish_request_order_draft(uuid) from public, anon, authenticated;
grant execute on function public.admin_confirm_fish_request_order_draft(uuid) to authenticated;

-- Admin RPCs set explicit local context. Existing direct writes remain compatible in Phase A and default to admin_adjustment.
create or replace function public.admin_update_inventory_variants(p_product_id uuid, p_variants jsonb)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare v_item jsonb; v_variant_id uuid; v_variant_name text; v_price bigint; v_inventory bigint; v_seen_ids uuid[] := '{}'; v_expected integer; v_updated integer;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_product_id is null then raise exception 'product_id_required'; end if;
  if jsonb_typeof(p_variants) is distinct from 'array' or jsonb_array_length(p_variants) = 0 then raise exception 'variants_required'; end if;
  if jsonb_array_length(p_variants) > 200 then raise exception 'too_many_variants'; end if;
  v_expected := jsonb_array_length(p_variants);
  for v_item in select value from jsonb_array_elements(p_variants) loop
    if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'invalid_variant'; end if;
    if (v_item->>'id') is null or (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_variant_id'; end if;
    v_variant_id := (v_item->>'id')::uuid; if v_variant_id = any(v_seen_ids) then raise exception 'duplicate_variant_id'; end if; v_seen_ids := array_append(v_seen_ids, v_variant_id);
    if jsonb_typeof(v_item->'name') is distinct from 'string' then raise exception 'variant_name_required'; end if;
    v_variant_name := btrim(v_item->>'name'); if v_variant_name = '' or length(v_variant_name) > 120 then raise exception 'variant_name_required'; end if;
    if jsonb_typeof(v_item->'price') is distinct from 'number' or (v_item->>'price') !~ '^-?[0-9]+$' then raise exception 'invalid_price'; end if;
    v_price := (v_item->>'price')::bigint; if v_price < 0 or v_price > 2147483647 then raise exception 'invalid_price'; end if;
    if jsonb_typeof(v_item->'inventory') is distinct from 'number' or (v_item->>'inventory') !~ '^-?[0-9]+$' then raise exception 'invalid_inventory'; end if;
    v_inventory := (v_item->>'inventory')::bigint; if v_inventory < 0 or v_inventory > 2147483647 then raise exception 'invalid_inventory'; end if;
    if jsonb_typeof(v_item->'active') is distinct from 'boolean' then raise exception 'invalid_active'; end if;
    if not exists (select 1 from public.product_variants where id = v_variant_id and product_id = p_product_id) then raise exception 'variant_product_mismatch'; end if;
  end loop;
  perform set_config('app.inventory_movement_type', 'admin_adjustment', true);
  with payload as (select id, btrim(name) as name, price, inventory, active from jsonb_to_recordset(p_variants) as item(id uuid, name text, price integer, inventory integer, active boolean))
  update public.product_variants variant set name = payload.name, price = payload.price, inventory = payload.inventory, active = payload.active from payload where variant.id = payload.id and variant.product_id = p_product_id;
  get diagnostics v_updated = row_count; if v_updated <> v_expected then raise exception 'batch_update_incomplete'; end if; return v_updated;
end;
$$;
create or replace function public.admin_create_inventory_product(p_product_name text, p_processing_enabled boolean, p_product_status text, p_variant_name text, p_price integer, p_inventory integer, p_variant_active boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_product_id uuid;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if nullif(btrim(p_product_name), '') is null then raise exception 'product_name_required'; end if;
  if nullif(btrim(p_variant_name), '') is null then raise exception 'variant_name_required'; end if;
  if length(btrim(p_product_name)) > 120 or length(btrim(p_variant_name)) > 120 then raise exception 'invalid_length'; end if;
  if p_product_status is null or p_product_status not in ('available', 'sold_out', 'hidden') then raise exception 'invalid_product_status'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if;
  if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if;
  insert into public.products (name, status, processing_enabled) values (btrim(p_product_name), p_product_status, coalesce(p_processing_enabled, false)) returning id into v_product_id;
  perform set_config('app.inventory_movement_type', 'admin_adjustment', true);
  insert into public.product_variants (product_id, name, price, inventory, active) values (v_product_id, btrim(p_variant_name), p_price, p_inventory, coalesce(p_variant_active, true));
  return v_product_id;
end;
$$;
create or replace function public.admin_adjust_inventory_variant(p_variant_id uuid, p_inventory integer)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
declare v_variant public.product_variants;
begin if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if; if p_variant_id is null then raise exception 'variant_not_found'; end if; if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if; perform set_config('app.inventory_movement_type', 'admin_adjustment', true); update public.product_variants set inventory = p_inventory where id = p_variant_id returning * into v_variant; if not found then raise exception 'variant_not_found'; end if; return v_variant; end;
$$;
create or replace function public.admin_create_inventory_variant(p_product_id uuid, p_name text, p_price integer, p_inventory integer, p_active boolean, p_sort_order integer default 100)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
declare v_variant public.product_variants;
begin if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if; if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then raise exception 'product_not_found'; end if; if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then raise exception 'variant_name_required'; end if; if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if; if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if; if p_sort_order is null then raise exception 'invalid_sort_order'; end if; perform set_config('app.inventory_movement_type', 'admin_adjustment', true); insert into public.product_variants (product_id, name, price, inventory, active, sort_order) values (p_product_id, btrim(p_name), p_price, p_inventory, coalesce(p_active, true), p_sort_order) returning * into v_variant; return v_variant; end;
$$;
create or replace function public.admin_update_inventory_variant(p_variant_id uuid, p_name text, p_price integer, p_inventory integer, p_active boolean, p_sort_order integer)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
declare v_variant public.product_variants;
begin if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if; if p_variant_id is null then raise exception 'variant_not_found'; end if; if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then raise exception 'variant_name_required'; end if; if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if; if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if; if p_sort_order is null then raise exception 'invalid_sort_order'; end if; perform set_config('app.inventory_movement_type', 'admin_adjustment', true); update public.product_variants set name = btrim(p_name), price = p_price, inventory = p_inventory, active = coalesce(p_active, true), sort_order = p_sort_order where id = p_variant_id returning * into v_variant; if not found then raise exception 'variant_not_found'; end if; return v_variant; end;
$$;
revoke all on function public.log_inventory_movement() from public, anon, authenticated;
revoke all on function public.admin_update_inventory_variants(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.admin_adjust_inventory_variant(uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, integer) from public, anon, authenticated;
grant execute on function public.admin_adjust_inventory_variant(uuid, integer) to authenticated;
grant execute on function public.admin_update_inventory_variants(uuid, jsonb) to authenticated;
grant execute on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean) to authenticated;
grant execute on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, integer) to authenticated;
grant execute on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, integer) to authenticated;

-- F004-3.3: In-stock + preorder product model.
-- Run once after F004-1 and the approved F003 migrations. Do not run from the client.
begin;

alter table public.product_variants
  add column if not exists preorder_enabled boolean not null default false;

alter table public.order_items
  add column if not exists supply_type text not null default 'in_stock';

alter table public.order_items
  drop constraint if exists order_items_supply_type_check;
alter table public.order_items
  add constraint order_items_supply_type_check
  check (supply_type in ('in_stock', 'preorder'));

comment on column public.product_variants.preorder_enabled is
  'An active variant with this flag may be purchased as preorder when the requested quantity exceeds its current inventory. Inventory remains available-on-hand information and is not a preorder limit.';
comment on column public.order_items.supply_type is
  'Immutable checkout snapshot: in_stock decremented inventory; preorder did not reserve or decrement inventory.';

-- Historical checkout items were all inventory-backed before F004-3.3, so the non-null
-- default records their existing in_stock classification. No historical price, quantity,
-- payment, timestamp, or inventory movement fact is rewritten.

create or replace function public.enforce_order_item_supply_type_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.supply_type is distinct from old.supply_type then
    raise exception 'order_item_supply_type_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_supply_type_snapshot_guard on public.order_items;
create trigger order_items_supply_type_snapshot_guard
before update of supply_type on public.order_items
for each row execute function public.enforce_order_item_supply_type_snapshot();

create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb,
  p_email text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_existing_order record;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_customer_name text := nullif(left(btrim(coalesce(p_customer_name, '')), 100), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_item jsonb;
  v_variant record;
  v_variant_id uuid;
  v_quantity integer;
  v_supply_type text;
  v_preset_id text;
  v_preset_name text;
  v_option_ids text[];
  v_option_names text[];
  v_expected_count integer;
  v_processing_note text;
  v_canonical_items jsonb := '[]'::jsonb;
  v_seen_variant_ids uuid[] := '{}'::uuid[];
  v_fingerprint text;
begin
  if p_idempotency_key is null then raise exception 'checkout_idempotency_key_required'; end if;
  if v_customer_name is null then raise exception 'customer_name_required'; end if;
  if v_phone = '' then raise exception 'phone_required'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then raise exception 'invalid_email'; end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;

  -- Canonicalization represents only the customer's request. The database derives
  -- supply_type later from the locked current variant; a client cannot fingerprint
  -- or forge an inventory-bypassing supply decision.
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'variant_id')::uuid loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'invalid_checkout_item'; end if;
    if jsonb_typeof(coalesce(v_item->'processing_option_ids', '[]'::jsonb)) <> 'array' then raise exception 'invalid_processing_options'; end if;
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(btrim(coalesce(v_item->>'processing_preset_id', '')), '');
    v_processing_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}') into v_option_ids
    from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    if v_quantity is null or v_quantity < 1 then raise exception 'invalid_quantity'; end if;
    if v_variant_id = any(v_seen_variant_ids) then raise exception 'duplicate_variant_item'; end if;
    v_seen_variant_ids := array_append(v_seen_variant_ids, v_variant_id);
    v_canonical_items := v_canonical_items || jsonb_build_array(jsonb_build_object(
      'variant_id', v_variant_id::text,
      'quantity', v_quantity,
      'processing_preset_id', v_preset_id,
      'processing_option_ids', to_jsonb(v_option_ids),
      'processing_note', v_processing_note
    ));
  end loop;

  v_fingerprint := md5(jsonb_build_object(
    'customer_name', v_customer_name, 'phone', v_phone, 'email', v_email,
    'fulfillment', p_fulfillment, 'note', v_note, 'items', v_canonical_items
  )::text);

  select id, checkout_request_fingerprint into v_existing_order
  from public.orders where checkout_idempotency_key = p_idempotency_key;
  if found then
    if v_existing_order.checkout_request_fingerprint is distinct from v_fingerprint then raise exception 'checkout_idempotency_conflict'; end if;
    return v_existing_order.id;
  end if;

  v_customer_id := public.find_or_create_customer(v_customer_name, v_phone, v_email, null);
  -- The unique index serializes concurrent retries before any inventory mutation.
  begin
    insert into public.orders (
      customer_id, customer_name, phone, email, line_id, fulfillment, processing, note,
      checkout_idempotency_key, checkout_request_fingerprint
    ) values (
      v_customer_id, v_customer_name, v_phone, v_email, null, p_fulfillment, '依品項', v_note,
      p_idempotency_key, v_fingerprint
    ) returning id into v_order_id;
  exception when unique_violation then
    select id, checkout_request_fingerprint into v_existing_order
    from public.orders where checkout_idempotency_key = p_idempotency_key;
    if not found then raise; end if;
    if v_existing_order.checkout_request_fingerprint is distinct from v_fingerprint then raise exception 'checkout_idempotency_conflict'; end if;
    return v_existing_order.id;
  end;

  perform set_config('app.inventory_movement_type', 'checkout_sale', true);
  perform set_config('app.inventory_movement_order_id', v_order_id::text, true);
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'variant_id')::uuid loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(btrim(coalesce(v_item->>'processing_preset_id', '')), '');
    v_processing_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}') into v_option_ids
    from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    select variant.id as variant_id, variant.product_id, product.name as product_name,
      product.processing_enabled, product.status as product_status, variant.name as variant_name,
      variant.price, variant.active, variant.inventory, variant.preorder_enabled
    into v_variant
    from public.product_variants variant join public.products product on product.id = variant.product_id
    where variant.id = v_variant_id
    for update of variant;
    if not found or not v_variant.active or v_variant.product_status <> 'available' then raise exception 'variant_unavailable'; end if;

    -- The locked row is authoritative. Never trust a client-supplied supply_type:
    -- a whole line is in_stock only when the requested quantity fits current stock;
    -- otherwise an enabled preorder variant remains one preorder line with no split.
    if v_quantity <= v_variant.inventory then
      v_supply_type := 'in_stock';
    elsif v_variant.preorder_enabled then
      v_supply_type := 'preorder';
    else
      raise exception 'variant_unavailable';
    end if;

    if not v_variant.processing_enabled then
      v_preset_id := 'none'; v_preset_name := '不處理'; v_option_ids := '{}'; v_option_names := '{}'; v_processing_note := null;
    else
      if v_preset_id is not null then
        select preset.name into v_preset_name from public.product_processing_presets config
        join public.processing_presets preset on preset.id = config.preset_id
        where config.product_id = v_variant.product_id and config.preset_id = v_preset_id and config.active and preset.active;
        if not found then raise exception 'processing_updated'; end if;
      end if;
      select count(*), coalesce(array_agg(option_catalog.name order by option_config.sort_order), '{}')
      into v_expected_count, v_option_names
      from unnest(v_option_ids) selected_id
      join public.product_processing_options option_config on option_config.product_id = v_variant.product_id and option_config.processing_option_id = selected_id and option_config.active
      join public.processing_options option_catalog on option_catalog.id = option_config.processing_option_id and option_catalog.active;
      if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;
      if v_preset_id is not null and not exists (
        select 1 from (select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids from public.processing_preset_options where preset_id = v_preset_id) preset_options
        where preset_options.ids = v_option_ids
      ) then v_preset_name := '客製化處理'; end if;
      if v_preset_id is null then v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end; end if;
    end if;

    if v_supply_type = 'in_stock' then
      update public.product_variants variant set inventory = variant.inventory - v_quantity
      from public.products product
      where variant.id = v_variant_id and product.id = variant.product_id
        and product.status = 'available' and variant.active and variant.inventory >= v_quantity
      returning variant.id as variant_id, variant.product_id, product.name as product_name,
        variant.name as variant_name, variant.price into v_variant;
      if not found then raise exception 'variant_unavailable'; end if;
    end if;

    insert into public.order_items (
      order_id, product_id, product_name, variant_id, variant_name, price, quantity, supply_type,
      processing_preset_id, processing_preset_name, processing_option_ids, processing_option_names, processing_note
    ) values (
      v_order_id, v_variant.product_id, v_variant.product_name, v_variant.variant_id, v_variant.variant_name,
      v_variant.price, v_quantity, v_supply_type, v_preset_id, v_preset_name, v_option_ids, v_option_names, v_processing_note
    );
  end loop;
  return v_order_id;
end;
$$;

-- Keep public checkout callers backward-compatible during deployment. The modern
-- seven-argument caller supplies the retry key. Supply snapshots are always decided
-- server-side from the locked inventory row and requested quantity.
create or replace function public.create_checkout_order(p_customer_name text, p_phone text, p_fulfillment text, p_note text, p_items jsonb, p_email text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.create_checkout_order(p_customer_name, p_phone, p_fulfillment, p_note, p_items, p_email, gen_random_uuid()); end;
$$;
create or replace function public.create_checkout_order(p_customer_name text, p_phone text, p_fulfillment text, p_note text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin return public.create_checkout_order(p_customer_name, p_phone, p_fulfillment, p_note, p_items, null::text, gen_random_uuid()); end;
$$;

-- Batch admin save accepts preorder_enabled when supplied; old clients leaving it
-- absent preserve the existing value instead of accidentally disabling preorder.
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
    if v_item ? 'preorder_enabled' and jsonb_typeof(v_item->'preorder_enabled') is distinct from 'boolean' then raise exception 'invalid_preorder_enabled'; end if;
    if not exists (select 1 from public.product_variants where id = v_variant_id and product_id = p_product_id) then raise exception 'variant_product_mismatch'; end if;
  end loop;
  perform set_config('app.inventory_movement_type', 'admin_adjustment', true);
  with payload as (select id, btrim(name) as name, price, inventory, active, preorder_enabled from jsonb_to_recordset(p_variants) as item(id uuid, name text, price integer, inventory integer, active boolean, preorder_enabled boolean))
  update public.product_variants variant set name = payload.name, price = payload.price, inventory = payload.inventory, active = payload.active, preorder_enabled = coalesce(payload.preorder_enabled, variant.preorder_enabled)
  from payload where variant.id = payload.id and variant.product_id = p_product_id;
  get diagnostics v_updated = row_count; if v_updated <> v_expected then raise exception 'batch_update_incomplete'; end if; return v_updated;
end;
$$;

create or replace function public.admin_create_inventory_product(p_product_name text, p_processing_enabled boolean, p_product_status text, p_variant_name text, p_price integer, p_inventory integer, p_variant_active boolean, p_preorder_enabled boolean, p_category_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_product_id uuid; v_category_active boolean;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if nullif(btrim(p_product_name), '') is null then raise exception 'product_name_required'; end if;
  if nullif(btrim(p_variant_name), '') is null then raise exception 'variant_name_required'; end if;
  if length(btrim(p_product_name)) > 120 or length(btrim(p_variant_name)) > 120 then raise exception 'invalid_length'; end if;
  if p_product_status is null or p_product_status not in ('available', 'sold_out', 'hidden') then raise exception 'invalid_product_status'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if;
  if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if;
  if p_category_id is null then raise exception 'product_category_required'; end if;
  select active into v_category_active from public.product_categories where id = p_category_id for share;
  if not found then raise exception 'product_category_not_found'; end if;
  if not v_category_active then raise exception 'product_category_inactive'; end if;
  insert into public.products (name, status, processing_enabled, category_id) values (btrim(p_product_name), p_product_status, coalesce(p_processing_enabled, false), p_category_id) returning id into v_product_id;
  perform set_config('app.inventory_movement_type', 'admin_adjustment', true);
  insert into public.product_variants (product_id, name, price, inventory, active, preorder_enabled) values (v_product_id, btrim(p_variant_name), p_price, p_inventory, coalesce(p_variant_active, true), coalesce(p_preorder_enabled, false));
  return v_product_id;
end;
$$;
-- Compatibility callers predate category assignment. They use the active seeded
-- 「其他」 category; the new application always sends an explicit category ID.
create or replace function public.admin_create_inventory_product(p_product_name text, p_processing_enabled boolean, p_product_status text, p_variant_name text, p_price integer, p_inventory integer, p_variant_active boolean, p_preorder_enabled boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_category_id uuid;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  select id into v_category_id from public.product_categories where name = '其他' and active order by sort_order, id limit 1;
  if not found then raise exception 'product_category_required'; end if;
  return public.admin_create_inventory_product(p_product_name, p_processing_enabled, p_product_status, p_variant_name, p_price, p_inventory, p_variant_active, p_preorder_enabled, v_category_id);
end;
$$;
create or replace function public.admin_create_inventory_product(p_product_name text, p_processing_enabled boolean, p_product_status text, p_variant_name text, p_price integer, p_inventory integer, p_variant_active boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  return public.admin_create_inventory_product(p_product_name, p_processing_enabled, p_product_status, p_variant_name, p_price, p_inventory, p_variant_active, false);
end;
$$;

create or replace function public.admin_create_inventory_variant(p_product_id uuid, p_name text, p_price integer, p_inventory integer, p_preorder_enabled boolean, p_active boolean, p_sort_order integer)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
declare v_variant public.product_variants;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then raise exception 'product_not_found'; end if;
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then raise exception 'variant_name_required'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if; if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if; if p_sort_order is null then raise exception 'invalid_sort_order'; end if;
  perform set_config('app.inventory_movement_type', 'admin_adjustment', true);
  insert into public.product_variants (product_id, name, price, inventory, preorder_enabled, active, sort_order) values (p_product_id, btrim(p_name), p_price, p_inventory, coalesce(p_preorder_enabled, false), coalesce(p_active, true), p_sort_order) returning * into v_variant;
  return v_variant;
end;
$$;
create or replace function public.admin_create_inventory_variant(p_product_id uuid, p_name text, p_price integer, p_inventory integer, p_active boolean, p_sort_order integer)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  return public.admin_create_inventory_variant(p_product_id, p_name, p_price, p_inventory, false, p_active, p_sort_order);
end;
$$;

create or replace function public.admin_update_inventory_variant(p_variant_id uuid, p_name text, p_price integer, p_inventory integer, p_preorder_enabled boolean, p_active boolean, p_sort_order integer)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
declare v_variant public.product_variants;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_variant_id is null then raise exception 'variant_not_found'; end if;
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then raise exception 'variant_name_required'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if; if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if; if p_sort_order is null then raise exception 'invalid_sort_order'; end if;
  perform set_config('app.inventory_movement_type', 'admin_adjustment', true);
  update public.product_variants set name = btrim(p_name), price = p_price, inventory = p_inventory, preorder_enabled = coalesce(p_preorder_enabled, false), active = coalesce(p_active, true), sort_order = p_sort_order where id = p_variant_id returning * into v_variant;
  if not found then raise exception 'variant_not_found'; end if; return v_variant;
end;
$$;
create or replace function public.admin_update_inventory_variant(p_variant_id uuid, p_name text, p_price integer, p_inventory integer, p_active boolean, p_sort_order integer)
returns public.product_variants language plpgsql security definer set search_path = public, pg_temp as $$
declare v_preorder_enabled boolean;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  select preorder_enabled into v_preorder_enabled from public.product_variants where id = p_variant_id;
  if not found then raise exception 'variant_not_found'; end if;
  return public.admin_update_inventory_variant(p_variant_id, p_name, p_price, p_inventory, v_preorder_enabled, p_active, p_sort_order);
end;
$$;

-- Cancellation restores only facts that originally decremented inventory. A preorder
-- item has no checkout_sale movement and must never manufacture a reversal movement.
create or replace function public.admin_cancel_order(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order public.orders; v_item record; v_restored public.product_variants; v_deducted_quantity bigint;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'draft' then raise exception 'order_not_cancellable_draft'; end if;
  if v_order.status = 'cancelled' then raise exception 'order_already_cancelled'; end if;
  if v_order.payment_status = 'paid' then raise exception 'paid_order_requires_payment_reversal'; end if;
  if exists (select 1 from public.order_payments payment where payment.order_id = v_order.id and not exists (select 1 from public.order_payment_reversals reversal where reversal.payment_id = payment.id)) then raise exception 'active_payment_requires_reversal'; end if;
  if v_order.status not in ('new', 'processing', 'ready', 'completed', 'contacted', 'confirmed', 'paid', 'shipped') then raise exception 'order_not_cancellable'; end if;
  if not exists (select 1 from public.order_items where order_id = v_order.id) then raise exception 'order_items_missing'; end if;
  perform set_config('app.inventory_movement_type', 'order_cancel_restore', true);
  perform set_config('app.inventory_movement_order_id', v_order.id::text, true);
  perform set_config('app.inventory_movement_fish_request_id', coalesce(v_order.fish_request_id::text, ''), true);
  for v_item in select variant_id, product_id, sum(quantity)::integer as quantity from public.order_items where order_id = v_order.id and supply_type = 'in_stock' group by variant_id, product_id order by variant_id nulls first, product_id nulls first loop
    if v_item.variant_id is null or v_item.product_id is null or v_item.quantity is null or v_item.quantity < 1 then raise exception 'order_item_variant_unrestorable'; end if;
    select coalesce(sum(-inventory_delta), 0) into v_deducted_quantity from public.inventory_movements where order_id = v_order.id and variant_id = v_item.variant_id and product_id = v_item.product_id and movement_type in ('checkout_sale', 'fish_request_order_confirmation');
    if v_deducted_quantity <> v_item.quantity then raise exception 'order_inventory_provenance_missing'; end if;
    if exists (select 1 from public.inventory_movements where order_id = v_order.id and variant_id = v_item.variant_id and product_id = v_item.product_id and movement_type = 'order_cancel_restore') then raise exception 'order_already_restored'; end if;
    update public.product_variants variant set inventory = variant.inventory + v_item.quantity where variant.id = v_item.variant_id and variant.product_id = v_item.product_id returning * into v_restored;
    if not found then raise exception 'order_item_variant_unrestorable'; end if;
  end loop;
  perform set_config('app.order_cancellation_authorized', 'true', true);
  update public.orders set status = 'cancelled' where id = v_order.id and status <> 'cancelled' returning * into v_order;
  if not found then raise exception 'order_already_cancelled'; end if;
  return v_order;
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text, uuid) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;
revoke insert on public.orders, public.order_items from anon, authenticated;
revoke all on function public.enforce_order_item_supply_type_snapshot() from public, anon, authenticated;

revoke all on function public.admin_update_inventory_variants(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean, boolean, uuid) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean, boolean) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.admin_update_inventory_variants(uuid, jsonb) to authenticated;
grant execute on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean, boolean, uuid) to authenticated;
grant execute on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean, boolean) to authenticated;
grant execute on function public.admin_create_inventory_product(text, boolean, text, text, integer, integer, boolean) to authenticated;
grant execute on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, boolean, integer) to authenticated;
grant execute on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, integer) to authenticated;
grant execute on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, boolean, integer) to authenticated;
grant execute on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, integer) to authenticated;
grant execute on function public.admin_cancel_order(uuid) to authenticated;

commit;

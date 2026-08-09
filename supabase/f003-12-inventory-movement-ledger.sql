-- F003-12: immutable audit ledger for every inventory mutation after deployment.
-- Run once after F003-11. Historical inventory changes are intentionally not backfilled.

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  inventory_delta integer not null check (inventory_delta <> 0),
  quantity_before integer not null check (quantity_before >= 0),
  quantity_after integer not null check (quantity_after >= 0),
  movement_type text not null check (movement_type in ('checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment')),
  order_id uuid null references public.orders(id) on delete restrict,
  fish_request_id uuid null references public.fish_requests(id) on delete restrict,
  actor_id uuid null,
  created_at timestamptz not null default now(),
  check (quantity_after - quantity_before = inventory_delta)
);

create index if not exists inventory_movements_variant_created_at_idx
  on public.inventory_movements (variant_id, created_at desc);
create index if not exists inventory_movements_product_created_at_idx
  on public.inventory_movements (product_id, created_at desc);
create index if not exists inventory_movements_order_id_idx
  on public.inventory_movements (order_id) where order_id is not null;

alter table public.inventory_movements enable row level security;
revoke all on public.inventory_movements from public, anon, authenticated;

drop policy if exists "admin read inventory movements" on public.inventory_movements;
create policy "admin read inventory movements" on public.inventory_movements for select to authenticated
using ((select public.is_hanjiu_admin()));

grant select on public.inventory_movements to authenticated;

create or replace function public.write_inventory_movement(
  p_variant_id uuid,
  p_product_id uuid,
  p_before integer,
  p_after integer,
  p_movement_type text,
  p_order_id uuid default null,
  p_fish_request_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_before < 0 or p_after < 0 then raise exception 'invalid_inventory'; end if;
  if p_before = p_after then return; end if;
  if p_movement_type not in ('checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment') then
    raise exception 'invalid_inventory_movement_type';
  end if;

  insert into public.inventory_movements (
    variant_id, product_id, inventory_delta, quantity_before, quantity_after,
    movement_type, order_id, fish_request_id, actor_id
  ) values (
    p_variant_id, p_product_id, p_after - p_before, p_before, p_after,
    p_movement_type, p_order_id, p_fish_request_id, auth.uid()
  );
end;
$$;

create or replace function public.log_inventory_variant_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.inventory_ledger_admin_adjustment', true) is distinct from 'true' then return new; end if;
  if tg_op = 'INSERT' then
    if new.inventory > 0 then
      perform public.write_inventory_movement(new.id, new.product_id, 0, new.inventory, 'admin_adjustment');
    end if;
    return new;
  end if;

  if new.inventory is distinct from old.inventory then
    perform public.write_inventory_movement(new.id, new.product_id, old.inventory, new.inventory, 'admin_adjustment');
  end if;
  return new;
end;
$$;

-- Replaces the F003-4 batch editor with the same validation/atomic semantics,
-- while opting in to the ledger only for genuine inventory changes.
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
  v_variant_name text;
  v_price bigint;
  v_inventory bigint;
  v_seen_ids uuid[] := '{}';
  v_expected integer;
  v_updated integer;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_product_id is null then raise exception 'product_id_required'; end if;
  if jsonb_typeof(p_variants) is distinct from 'array' or jsonb_array_length(p_variants) = 0 then raise exception 'variants_required'; end if;
  if jsonb_array_length(p_variants) > 200 then raise exception 'too_many_variants'; end if;
  v_expected := jsonb_array_length(p_variants);

  for v_item in select value from jsonb_array_elements(p_variants) loop
    if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'invalid_variant'; end if;
    if (v_item->>'id') is null or (v_item->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'invalid_variant_id'; end if;
    v_variant_id := (v_item->>'id')::uuid;
    if v_variant_id = any(v_seen_ids) then raise exception 'duplicate_variant_id'; end if;
    v_seen_ids := array_append(v_seen_ids, v_variant_id);
    if jsonb_typeof(v_item->'name') is distinct from 'string' then raise exception 'variant_name_required'; end if;
    v_variant_name := btrim(v_item->>'name');
    if v_variant_name = '' or length(v_variant_name) > 120 then raise exception 'variant_name_required'; end if;
    if jsonb_typeof(v_item->'price') is distinct from 'number' or (v_item->>'price') !~ '^-?[0-9]+$' then raise exception 'invalid_price'; end if;
    v_price := (v_item->>'price')::bigint;
    if v_price < 0 or v_price > 2147483647 then raise exception 'invalid_price'; end if;
    if jsonb_typeof(v_item->'inventory') is distinct from 'number' or (v_item->>'inventory') !~ '^-?[0-9]+$' then raise exception 'invalid_inventory'; end if;
    v_inventory := (v_item->>'inventory')::bigint;
    if v_inventory < 0 or v_inventory > 2147483647 then raise exception 'invalid_inventory'; end if;
    if jsonb_typeof(v_item->'active') is distinct from 'boolean' then raise exception 'invalid_active'; end if;
    if not exists (select 1 from public.product_variants where id = v_variant_id and product_id = p_product_id) then raise exception 'variant_product_mismatch'; end if;
  end loop;

  perform set_config('app.inventory_ledger_admin_adjustment', 'true', true);
  with payload as (
    select id, btrim(name) as name, price, inventory, active
    from jsonb_to_recordset(p_variants) as item(id uuid, name text, price integer, inventory integer, active boolean)
  )
  update public.product_variants variant
  set name = payload.name, price = payload.price, inventory = payload.inventory, active = payload.active
  from payload where variant.id = payload.id and variant.product_id = p_product_id;
  get diagnostics v_updated = row_count;
  if v_updated <> v_expected then raise exception 'batch_update_incomplete'; end if;
  return v_updated;
end;
$$;

create or replace function public.admin_create_inventory_product(
  p_product_name text, p_processing_enabled boolean, p_product_status text,
  p_variant_name text, p_price integer, p_inventory integer, p_variant_active boolean
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
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
  perform set_config('app.inventory_ledger_admin_adjustment', 'true', true);
  insert into public.product_variants (product_id, name, price, inventory, active) values (v_product_id, btrim(p_variant_name), p_price, p_inventory, coalesce(p_variant_active, true));
  return v_product_id;
end;
$$;

drop trigger if exists inventory_variant_movement_ledger on public.product_variants;
create trigger inventory_variant_movement_ledger
after insert or update of inventory on public.product_variants
for each row execute function public.log_inventory_variant_change();

create or replace function public.log_checkout_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inventory integer;
  v_order_status text;
begin
  if new.variant_id is null then return new; end if;
  select status into v_order_status from public.orders where id = new.order_id;
  if not found or v_order_status = 'draft' then return new; end if;
  select inventory into v_inventory from public.product_variants where id = new.variant_id;
  if not found or v_inventory < 0 or new.quantity < 1 then raise exception 'inventory_ledger_source_invalid'; end if;
  perform public.write_inventory_movement(
    new.variant_id, new.product_id, v_inventory + new.quantity, v_inventory,
    'checkout_sale', new.order_id, null
  );
  return new;
end;
$$;

drop trigger if exists checkout_order_item_movement_ledger on public.order_items;
create trigger checkout_order_item_movement_ledger
after insert on public.order_items
for each row when (new.variant_id is not null)
execute function public.log_checkout_inventory_movement();

create or replace function public.log_draft_confirmation_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item record;
  v_inventory integer;
begin
  if old.status <> 'draft' or new.status <> 'new' or new.fish_request_id is null then return new; end if;
  for v_item in select product_id, variant_id, quantity from public.order_items where order_id = new.id loop
    if v_item.variant_id is null or v_item.quantity < 1 then raise exception 'inventory_ledger_source_invalid'; end if;
    select inventory into v_inventory from public.product_variants where id = v_item.variant_id;
    if not found or v_inventory < 0 then raise exception 'inventory_ledger_source_invalid'; end if;
    perform public.write_inventory_movement(
      v_item.variant_id, v_item.product_id, v_inventory + v_item.quantity, v_inventory,
      'fish_request_order_confirmation', new.id, new.fish_request_id
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists draft_confirmation_movement_ledger on public.orders;
create trigger draft_confirmation_movement_ledger
after update of status on public.orders
for each row
execute function public.log_draft_confirmation_inventory_movement();

-- Clients must not be able to bypass the ledger by changing inventory directly.
revoke insert, update on public.product_variants from anon, authenticated;
revoke update (name, price, inventory, active, sort_order) on public.product_variants from anon, authenticated;

create or replace function public.admin_adjust_inventory_variant(
  p_variant_id uuid,
  p_inventory integer
)
returns public.product_variants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant public.product_variants;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_variant_id is null then raise exception 'variant_not_found'; end if;
  if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if;

  perform set_config('app.inventory_ledger_admin_adjustment', 'true', true);
  update public.product_variants
  set inventory = p_inventory
  where id = p_variant_id
  returning * into v_variant;
  if not found then raise exception 'variant_not_found'; end if;
  return v_variant;
end;
$$;

create or replace function public.admin_create_inventory_variant(
  p_product_id uuid,
  p_name text,
  p_price integer,
  p_inventory integer,
  p_active boolean,
  p_sort_order integer default 100
)
returns public.product_variants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant public.product_variants;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_product_id is null or not exists (select 1 from public.products where id = p_product_id) then raise exception 'product_not_found'; end if;
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then raise exception 'variant_name_required'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if;
  if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if;
  if p_sort_order is null then raise exception 'invalid_sort_order'; end if;

  perform set_config('app.inventory_ledger_admin_adjustment', 'true', true);
  insert into public.product_variants (product_id, name, price, inventory, active, sort_order)
  values (p_product_id, btrim(p_name), p_price, p_inventory, coalesce(p_active, true), p_sort_order)
  returning * into v_variant;
  return v_variant;
end;
$$;

create or replace function public.admin_update_inventory_variant(
  p_variant_id uuid,
  p_name text,
  p_price integer,
  p_inventory integer,
  p_active boolean,
  p_sort_order integer
)
returns public.product_variants
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_variant public.product_variants;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_variant_id is null then raise exception 'variant_not_found'; end if;
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 120 then raise exception 'variant_name_required'; end if;
  if p_price is null or p_price < 0 then raise exception 'invalid_price'; end if;
  if p_inventory is null or p_inventory < 0 then raise exception 'invalid_inventory'; end if;
  if p_sort_order is null then raise exception 'invalid_sort_order'; end if;

  perform set_config('app.inventory_ledger_admin_adjustment', 'true', true);
  update public.product_variants
  set name = btrim(p_name), price = p_price, inventory = p_inventory,
      active = coalesce(p_active, true), sort_order = p_sort_order
  where id = p_variant_id
  returning * into v_variant;
  if not found then raise exception 'variant_not_found'; end if;
  return v_variant;
end;
$$;

revoke all on function public.write_inventory_movement(uuid, uuid, integer, integer, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.log_inventory_variant_change() from public, anon, authenticated;
revoke all on function public.log_checkout_inventory_movement() from public, anon, authenticated;
revoke all on function public.log_draft_confirmation_inventory_movement() from public, anon, authenticated;
revoke all on function public.admin_adjust_inventory_variant(uuid, integer) from public, anon, authenticated;
revoke all on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, integer) from public, anon, authenticated;
grant execute on function public.admin_adjust_inventory_variant(uuid, integer) to authenticated;
grant execute on function public.admin_create_inventory_variant(uuid, text, integer, integer, boolean, integer) to authenticated;
grant execute on function public.admin_update_inventory_variant(uuid, text, integer, integer, boolean, integer) to authenticated;

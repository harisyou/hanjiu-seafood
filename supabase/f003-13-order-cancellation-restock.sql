-- F003-13: cancel a formal order and atomically restore only proven inventory deductions.
-- Run once after F003-12 Phase A. This migration does not backfill or modify historical data.

begin;

alter table public.inventory_movements
  drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type in (
    'checkout_sale',
    'fish_request_order_confirmation',
    'admin_adjustment',
    'order_cancel_restore'
  ));

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
  if v_type not in ('checkout_sale', 'fish_request_order_confirmation', 'admin_adjustment', 'order_cancel_restore') then
    raise exception 'inventory_movement_context_invalid';
  end if;
  if v_order_text is not null then v_order_id := v_order_text::uuid; end if;
  if v_request_text is not null then v_request_id := v_request_text::uuid; end if;
  if v_type = 'checkout_sale' and v_order_id is null then raise exception 'inventory_movement_context_invalid'; end if;
  if v_type = 'fish_request_order_confirmation' and (v_order_id is null or v_request_id is null) then
    raise exception 'inventory_movement_context_invalid';
  end if;
  if v_type = 'order_cancel_restore' and v_order_id is null then raise exception 'inventory_movement_context_invalid'; end if;
  if v_type = 'admin_adjustment' and (v_order_id is not null or v_request_id is not null) then
    raise exception 'inventory_movement_context_invalid';
  end if;
  if v_request_id is not null and v_type not in ('fish_request_order_confirmation', 'order_cancel_restore') then
    raise exception 'inventory_movement_context_invalid';
  end if;

  insert into public.inventory_movements (variant_id, product_id, inventory_delta, quantity_before, quantity_after, movement_type, order_id, fish_request_id, actor_id)
  values (new.id, new.product_id, new.inventory - old.inventory, old.inventory, new.inventory, v_type, v_order_id, v_request_id, auth.uid());
  return new;
end;
$$;

create or replace function public.enforce_order_cancellation_flow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    raise exception 'order_cancelled_terminal';
  end if;
  if new.status = 'cancelled'
    and old.status is distinct from 'cancelled'
    and current_setting('app.order_cancellation_authorized', true) is distinct from 'true' then
    raise exception 'order_cancellation_rpc_required';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_cancellation_guard on public.orders;
create trigger orders_cancellation_guard
before update of status on public.orders
for each row execute function public.enforce_order_cancellation_flow();

create or replace function public.admin_cancel_order(p_order_id uuid)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_item record;
  v_restored public.product_variants;
  v_deducted_quantity bigint;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'draft' then raise exception 'order_not_cancellable_draft'; end if;
  if v_order.status = 'cancelled' then raise exception 'order_already_cancelled'; end if;
  if v_order.status not in ('new', 'processing', 'ready', 'completed', 'contacted', 'confirmed', 'paid', 'shipped') then
    raise exception 'order_not_cancellable';
  end if;
  if not exists (select 1 from public.order_items where order_id = v_order.id) then
    raise exception 'order_items_missing';
  end if;

  -- The order lock makes retries/concurrent cancellation serialize. Aggregate and sort
  -- by original variant ID so every affected inventory row is locked deterministically.
  perform set_config('app.inventory_movement_type', 'order_cancel_restore', true);
  perform set_config('app.inventory_movement_order_id', v_order.id::text, true);
  perform set_config('app.inventory_movement_fish_request_id', coalesce(v_order.fish_request_id::text, ''), true);

  for v_item in
    select variant_id, product_id, sum(quantity)::integer as quantity
    from public.order_items
    where order_id = v_order.id
    group by variant_id, product_id
    order by variant_id nulls first, product_id nulls first
  loop
    if v_item.variant_id is null or v_item.product_id is null or v_item.quantity is null or v_item.quantity < 1 then
      raise exception 'order_item_variant_unrestorable';
    end if;

    select coalesce(sum(-inventory_delta), 0)
    into v_deducted_quantity
    from public.inventory_movements
    where order_id = v_order.id
      and variant_id = v_item.variant_id
      and product_id = v_item.product_id
      and movement_type in ('checkout_sale', 'fish_request_order_confirmation');
    if v_deducted_quantity <> v_item.quantity then
      raise exception 'order_inventory_provenance_missing';
    end if;
    if exists (
      select 1
      from public.inventory_movements
      where order_id = v_order.id
        and variant_id = v_item.variant_id
        and product_id = v_item.product_id
        and movement_type = 'order_cancel_restore'
    ) then
      raise exception 'order_already_restored';
    end if;

    update public.product_variants variant
    set inventory = variant.inventory + v_item.quantity
    where variant.id = v_item.variant_id
      and variant.product_id = v_item.product_id
    returning * into v_restored;
    if not found then raise exception 'order_item_variant_unrestorable'; end if;
  end loop;

  perform set_config('app.order_cancellation_authorized', 'true', true);
  update public.orders
  set status = 'cancelled'
  where id = v_order.id
    and status <> 'cancelled'
  returning * into v_order;
  if not found then raise exception 'order_already_cancelled'; end if;

  return v_order;
end;
$$;

revoke all on function public.enforce_order_cancellation_flow() from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.admin_cancel_order(uuid) to authenticated;

commit;

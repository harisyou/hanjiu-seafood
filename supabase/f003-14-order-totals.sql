-- F003-14: immutable order-money snapshots for new orders; historical rows remain NULL.
begin;

alter table public.orders add column if not exists subtotal integer;
alter table public.orders add column if not exists shipping_fee integer;
alter table public.orders add column if not exists discount_amount integer;
alter table public.orders add column if not exists total_amount integer;

alter table public.orders drop constraint if exists orders_totals_snapshot_check;
alter table public.orders add constraint orders_totals_snapshot_check check (
  (subtotal is null and shipping_fee is null and discount_amount is null and total_amount is null)
  or (
    subtotal >= 0 and shipping_fee >= 0 and discount_amount >= 0 and total_amount >= 0
    and total_amount = greatest(subtotal + shipping_fee - discount_amount, 0)
  )
);

create or replace function public.initialize_order_totals()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.subtotal := coalesce(new.subtotal, 0);
  new.shipping_fee := coalesce(new.shipping_fee, 0);
  new.discount_amount := coalesce(new.discount_amount, 0);
  new.total_amount := greatest(new.subtotal + new.shipping_fee - new.discount_amount, 0);
  return new;
end;
$$;

create or replace function public.recalculate_order_totals_from_items()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order_id uuid := coalesce(new.order_id, old.order_id); v_subtotal integer;
begin
  select coalesce(sum(price * quantity), 0)::integer into v_subtotal from public.order_items where order_id = v_order_id;
  update public.orders set subtotal = v_subtotal, total_amount = greatest(v_subtotal + shipping_fee - discount_amount, 0) where id = v_order_id;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists orders_initialize_totals on public.orders;
create trigger orders_initialize_totals before insert on public.orders for each row execute function public.initialize_order_totals();
drop trigger if exists order_items_recalculate_totals on public.order_items;
create trigger order_items_recalculate_totals after insert or update of price, quantity or delete on public.order_items for each row execute function public.recalculate_order_totals_from_items();

create or replace function public.admin_update_order_totals(p_order_id uuid, p_shipping_fee integer, p_discount_amount integer)
returns public.orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order public.orders;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  if p_shipping_fee is null or p_shipping_fee < 0 then raise exception 'invalid_shipping_fee'; end if;
  if p_discount_amount is null or p_discount_amount < 0 then raise exception 'invalid_discount_amount'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'cancelled' then raise exception 'cancelled_order_totals_locked'; end if;
  if v_order.subtotal is null then raise exception 'order_totals_snapshot_missing'; end if;
  update public.orders set shipping_fee = p_shipping_fee, discount_amount = p_discount_amount,
    total_amount = greatest(subtotal + p_shipping_fee - p_discount_amount, 0)
  where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.initialize_order_totals() from public, anon, authenticated;
revoke all on function public.recalculate_order_totals_from_items() from public, anon, authenticated;
revoke all on function public.admin_update_order_totals(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_update_order_totals(uuid, integer, integer) to authenticated;
commit;

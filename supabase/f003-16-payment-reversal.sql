-- F003-16: append-only full payment reversal. No history is backfilled or rewritten.
begin;

create table if not exists public.order_payment_reversals (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.order_payments(id) on delete restrict,
  order_id uuid not null references public.orders(id) on delete restrict,
  amount integer not null check (amount > 0),
  reason text not null check (btrim(reason) <> ''),
  actor_id uuid,
  reversed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists order_payment_reversals_order_id_idx on public.order_payment_reversals(order_id);
create index if not exists order_payment_reversals_reversed_at_idx on public.order_payment_reversals(reversed_at desc);
alter table public.order_payment_reversals enable row level security;
revoke all on public.order_payment_reversals from public, anon, authenticated;
drop policy if exists "admin read order payment reversals" on public.order_payment_reversals;
create policy "admin read order payment reversals" on public.order_payment_reversals
  for select to authenticated using ((select public.is_hanjiu_admin()));
grant select on public.order_payment_reversals to authenticated;

create or replace function public.admin_reverse_order_payment(p_order_id uuid, p_reason text)
returns public.order_payment_reversals
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_payment public.order_payments;
  v_reversal public.order_payment_reversals;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  if v_reason is null then raise exception 'payment_reversal_reason_required'; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'cancelled' then raise exception 'cancelled_order_payment_reversal_not_allowed'; end if;

  select * into v_payment from public.order_payments where order_id = v_order.id;
  if not found then raise exception 'authoritative_payment_not_found'; end if;
  if exists (select 1 from public.order_payment_reversals where payment_id = v_payment.id) then
    raise exception 'payment_already_reversed';
  end if;
  if v_order.payment_status <> 'paid' then raise exception 'order_not_paid'; end if;

  insert into public.order_payment_reversals(payment_id, order_id, amount, reason, actor_id)
  values (v_payment.id, v_order.id, v_payment.amount, v_reason, auth.uid())
  returning * into v_reversal;

  perform set_config('app.order_payment_authorized', 'true', true);
  update public.orders set payment_status = 'unpaid'
  where id = v_order.id and payment_status = 'paid';
  if not found then raise exception 'order_not_paid'; end if;
  return v_reversal;
end;
$$;

-- Preserve F003-13 inventory restoration while requiring paid orders to be reversed first.
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
  if v_order.payment_status = 'paid' then raise exception 'paid_order_requires_payment_reversal'; end if;
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

revoke all on function public.admin_reverse_order_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_reverse_order_payment(uuid, text) to authenticated;
commit;


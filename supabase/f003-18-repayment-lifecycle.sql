-- F003-18: allow append-only re-payment after reversal while preserving one active payment per order.
-- Depends on F003-13 through F003-17. Existing payment/reversal facts are not rewritten or deleted.
begin;

-- F003-15 enforced one lifetime payment per order. F003-18 changes that to one payment attempt per
-- attempt_number, with at most one unreversed active payment enforced by the serialized RPC lifecycle.
alter table public.order_payments
  drop constraint if exists order_payments_order_id_key;

alter table public.order_payments
  add column if not exists attempt_number integer;

alter table public.order_payments
  add column if not exists idempotency_key uuid;

-- Historical F003-15 payments are the first attempt. This is structural migration metadata only;
-- no payment amount, method, timestamp, actor, reversal, or order financial fact is rewritten.
update public.order_payments
set attempt_number = 1
where attempt_number is null;

alter table public.order_payments
  alter column attempt_number set not null;

alter table public.order_payments
  add constraint order_payments_attempt_number_check check (attempt_number > 0);

create unique index if not exists order_payments_order_attempt_uidx
  on public.order_payments(order_id, attempt_number);

create unique index if not exists order_payments_order_idempotency_uidx
  on public.order_payments(order_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists order_payments_order_id_idx
  on public.order_payments(order_id);

create or replace function public.admin_record_order_payment(
  p_order_id uuid,
  p_amount integer,
  p_payment_method text,
  p_idempotency_key uuid
)
returns public.order_payments
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_payment public.order_payments;
  v_method text := nullif(btrim(coalesce(p_payment_method, '')), '');
  v_attempt_number integer;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_payment_amount'; end if;
  if v_method not in ('cash', 'bank_transfer', 'other') then raise exception 'invalid_payment_method'; end if;
  if p_idempotency_key is null then raise exception 'payment_idempotency_key_required'; end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then raise exception 'order_not_found'; end if;

  -- A retry with the same key returns the original immutable fact. The payload must match.
  select * into v_payment
  from public.order_payments
  where order_id = v_order.id
    and idempotency_key = p_idempotency_key;
  if found then
    if v_payment.amount <> p_amount or v_payment.payment_method <> v_method then
      raise exception 'payment_idempotency_conflict';
    end if;
    return v_payment;
  end if;

  if v_order.status = 'draft' then raise exception 'draft_order_payment_not_allowed'; end if;
  if v_order.status = 'cancelled' then raise exception 'cancelled_order_payment_not_allowed'; end if;
  if v_order.total_amount is null then raise exception 'order_totals_snapshot_missing'; end if;
  if v_order.payment_status = 'paid' then raise exception 'order_already_paid'; end if;

  -- Re-payment is allowed only when every prior payment attempt has a reversal.
  if exists (
    select 1
    from public.order_payments payment
    where payment.order_id = v_order.id
      and not exists (
        select 1
        from public.order_payment_reversals reversal
        where reversal.payment_id = payment.id
      )
  ) then
    raise exception 'active_payment_exists';
  end if;

  if p_amount <> v_order.total_amount then raise exception 'payment_amount_mismatch'; end if;

  select coalesce(max(payment.attempt_number), 0) + 1
  into v_attempt_number
  from public.order_payments payment
  where payment.order_id = v_order.id;

  insert into public.order_payments(
    order_id, amount, payment_method, actor_id, attempt_number, idempotency_key
  ) values (
    v_order.id, p_amount, v_method, auth.uid(), v_attempt_number, p_idempotency_key
  ) returning * into v_payment;

  perform set_config('app.order_payment_authorized', 'true', true);
  update public.orders
  set payment_status = 'paid'
  where id = v_order.id
    and payment_status = 'unpaid';
  if not found then raise exception 'order_already_paid'; end if;

  return v_payment;
end;
$$;

-- Reversal always targets the one unreversed payment attempt, never an arbitrary historical payment.
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

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'cancelled' then raise exception 'cancelled_order_payment_reversal_not_allowed'; end if;

  select payment.* into v_payment
  from public.order_payments payment
  where payment.order_id = v_order.id
    and not exists (
      select 1
      from public.order_payment_reversals reversal
      where reversal.payment_id = payment.id
    )
  order by payment.attempt_number desc
  limit 1;

  if not found then raise exception 'active_payment_not_found'; end if;
  if v_order.payment_status <> 'paid' then raise exception 'order_not_paid'; end if;

  insert into public.order_payment_reversals(payment_id, order_id, amount, reason, actor_id)
  values (v_payment.id, v_order.id, v_payment.amount, v_reason, auth.uid())
  returning * into v_reversal;

  perform set_config('app.order_payment_authorized', 'true', true);
  update public.orders
  set payment_status = 'unpaid'
  where id = v_order.id
    and payment_status = 'paid';
  if not found then raise exception 'order_not_paid'; end if;

  return v_reversal;
end;
$$;

-- Cancellation still requires no active payment. Inventory restoration remains exactly F003-16 behavior.
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

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'draft' then raise exception 'order_not_cancellable_draft'; end if;
  if v_order.status = 'cancelled' then raise exception 'order_already_cancelled'; end if;
  if v_order.payment_status = 'paid' then raise exception 'paid_order_requires_payment_reversal'; end if;
  if exists (
    select 1 from public.order_payments payment
    where payment.order_id = v_order.id
      and not exists (
        select 1 from public.order_payment_reversals reversal
        where reversal.payment_id = payment.id
      )
  ) then raise exception 'active_payment_requires_reversal'; end if;
  if v_order.status not in ('new', 'processing', 'ready', 'completed', 'contacted', 'confirmed', 'paid', 'shipped') then raise exception 'order_not_cancellable'; end if;
  if not exists (select 1 from public.order_items where order_id = v_order.id) then raise exception 'order_items_missing'; end if;

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
    if v_item.variant_id is null or v_item.product_id is null or v_item.quantity is null or v_item.quantity < 1 then raise exception 'order_item_variant_unrestorable'; end if;

    select coalesce(sum(-inventory_delta), 0) into v_deducted_quantity
    from public.inventory_movements
    where order_id = v_order.id
      and variant_id = v_item.variant_id
      and product_id = v_item.product_id
      and movement_type in ('checkout_sale', 'fish_request_order_confirmation');
    if v_deducted_quantity <> v_item.quantity then raise exception 'order_inventory_provenance_missing'; end if;
    if exists (
      select 1 from public.inventory_movements
      where order_id = v_order.id
        and variant_id = v_item.variant_id
        and product_id = v_item.product_id
        and movement_type = 'order_cancel_restore'
    ) then raise exception 'order_already_restored'; end if;

    update public.product_variants variant
    set inventory = variant.inventory + v_item.quantity
    where variant.id = v_item.variant_id
      and variant.product_id = v_item.product_id
    returning * into v_restored;
    if not found then raise exception 'order_item_variant_unrestorable'; end if;
  end loop;

  perform set_config('app.order_cancellation_authorized', 'true', true);
  update public.orders set status = 'cancelled'
  where id = v_order.id and status <> 'cancelled'
  returning * into v_order;
  if not found then raise exception 'order_already_cancelled'; end if;
  return v_order;
end;
$$;

revoke all on function public.admin_record_order_payment(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_record_order_payment(uuid, integer, text, uuid) to authenticated;
revoke all on function public.admin_record_order_payment(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.admin_reverse_order_payment(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_reverse_order_payment(uuid, text) to authenticated;
revoke all on function public.admin_cancel_order(uuid) from public, anon, authenticated;
grant execute on function public.admin_cancel_order(uuid) to authenticated;

commit;

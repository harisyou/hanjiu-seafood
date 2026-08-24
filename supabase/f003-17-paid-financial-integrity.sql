-- F003-17: lock paid-order monetary snapshots and expose a read-only integrity audit.
-- Depends on F003-13 through F003-16. No historical rows are repaired or backfilled.
begin;

create or replace function public.enforce_paid_order_financial_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.payment_status = 'paid' and (
    new.subtotal is distinct from old.subtotal
    or new.shipping_fee is distinct from old.shipping_fee
    or new.discount_amount is distinct from old.discount_amount
    or new.total_amount is distinct from old.total_amount
  ) then
    raise exception 'paid_order_totals_locked';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_paid_financial_guard on public.orders;
create trigger orders_paid_financial_guard
before update of subtotal, shipping_fee, discount_amount, total_amount on public.orders
for each row execute function public.enforce_paid_order_financial_lock();

-- This is the latest F003-14 function plus the paid-order guard. The order lock
-- serializes this RPC with payment record, reversal, and cancellation RPCs.
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
  if v_order.payment_status = 'paid' then raise exception 'paid_order_totals_locked'; end if;
  if v_order.subtotal is null then raise exception 'order_totals_snapshot_missing'; end if;
  update public.orders set shipping_fee = p_shipping_fee, discount_amount = p_discount_amount,
    total_amount = greatest(subtotal + p_shipping_fee - p_discount_amount, 0)
  where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

-- Client status updates remain available, but payment_status is RPC-only.
revoke update (payment_status) on public.orders from anon, authenticated;

create or replace function public.admin_audit_order_financial_integrity()
returns table (
  issue_code text,
  order_id uuid,
  payment_id uuid,
  reversal_id uuid,
  payment_status text,
  total_amount integer,
  payment_amount integer
)
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;

  return query
  with payment_facts as (
    select
      payment.id as payment_id,
      payment.order_id as payment_order_id,
      payment.amount as payment_amount,
      reversal.id as reversal_id,
      reversal.order_id as reversal_order_id
    from public.order_payments payment
    left join public.order_payment_reversals reversal on reversal.payment_id = payment.id
  )
  select 'paid_without_authoritative_payment'::text, orders.id, null::uuid, null::uuid,
    orders.payment_status, orders.total_amount, null::integer
  from public.orders orders
  where orders.payment_status = 'paid'
    and not exists (select 1 from payment_facts facts where facts.payment_order_id = orders.id)
  union all
  select 'unpaid_with_active_payment', orders.id, facts.payment_id, null::uuid,
    orders.payment_status, orders.total_amount, facts.payment_amount
  from public.orders orders
  join payment_facts facts on facts.payment_order_id = orders.id and facts.reversal_id is null
  where orders.payment_status = 'unpaid'
  union all
  select 'paid_active_payment_amount_mismatch', orders.id, facts.payment_id, null::uuid,
    orders.payment_status, orders.total_amount, facts.payment_amount
  from public.orders orders
  join payment_facts facts on facts.payment_order_id = orders.id and facts.reversal_id is null
  where orders.payment_status = 'paid'
    and orders.total_amount is distinct from facts.payment_amount
  union all
  select 'reversed_payment_order_still_paid', orders.id, facts.payment_id, facts.reversal_id,
    orders.payment_status, orders.total_amount, facts.payment_amount
  from public.orders orders
  join payment_facts facts on facts.payment_order_id = orders.id and facts.reversal_id is not null
  where orders.payment_status = 'paid'
  union all
  select 'cancelled_order_paid_or_active_payment', orders.id, facts.payment_id, facts.reversal_id,
    orders.payment_status, orders.total_amount, facts.payment_amount
  from public.orders orders
  left join payment_facts facts on facts.payment_order_id = orders.id and facts.reversal_id is null
  where orders.status = 'cancelled'
    and (orders.payment_status = 'paid' or facts.payment_id is not null)
  union all
  select 'reversal_order_mismatch', facts.reversal_order_id, facts.payment_id, facts.reversal_id,
    orders.payment_status, orders.total_amount, facts.payment_amount
  from payment_facts facts
  left join public.orders orders on orders.id = facts.reversal_order_id
  where facts.reversal_id is not null
    and facts.reversal_order_id is distinct from facts.payment_order_id
  order by 1, 2;
end;
$$;

revoke all on function public.enforce_paid_order_financial_lock() from public, anon, authenticated;
revoke all on function public.admin_update_order_totals(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_update_order_totals(uuid, integer, integer) to authenticated;
revoke all on function public.admin_audit_order_financial_integrity() from public, anon, authenticated;
grant execute on function public.admin_audit_order_financial_integrity() to authenticated;

commit;


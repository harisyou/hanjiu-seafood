-- F003-18 companion: make the F003-17 integrity audit aware of multiple append-only payment attempts.
-- Run immediately after f003-18-repayment-lifecycle.sql. Read-only audit behavior only; no business rows are modified.
begin;

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
      payment.attempt_number,
      reversal.id as reversal_id,
      reversal.order_id as reversal_order_id
    from public.order_payments payment
    left join public.order_payment_reversals reversal on reversal.payment_id = payment.id
  ),
  active_payments as (
    select * from payment_facts where reversal_id is null
  ),
  active_counts as (
    select payment_order_id, count(*)::integer as active_count
    from active_payments
    group by payment_order_id
  )
  select 'paid_without_active_payment'::text, orders.id, null::uuid, null::uuid,
    orders.payment_status, orders.total_amount, null::integer
  from public.orders orders
  where orders.payment_status = 'paid'
    and not exists (
      select 1 from active_payments active where active.payment_order_id = orders.id
    )

  union all

  select 'unpaid_with_active_payment', orders.id, active.payment_id, null::uuid,
    orders.payment_status, orders.total_amount, active.payment_amount
  from public.orders orders
  join active_payments active on active.payment_order_id = orders.id
  where orders.payment_status = 'unpaid'

  union all

  select 'paid_active_payment_amount_mismatch', orders.id, active.payment_id, null::uuid,
    orders.payment_status, orders.total_amount, active.payment_amount
  from public.orders orders
  join active_payments active on active.payment_order_id = orders.id
  where orders.payment_status = 'paid'
    and orders.total_amount is distinct from active.payment_amount

  union all

  select 'multiple_active_payments', orders.id, active.payment_id, null::uuid,
    orders.payment_status, orders.total_amount, active.payment_amount
  from public.orders orders
  join active_counts counts on counts.payment_order_id = orders.id and counts.active_count > 1
  join active_payments active on active.payment_order_id = orders.id

  union all

  select 'cancelled_order_paid_or_active_payment', orders.id, active.payment_id, null::uuid,
    orders.payment_status, orders.total_amount, active.payment_amount
  from public.orders orders
  left join active_payments active on active.payment_order_id = orders.id
  where orders.status = 'cancelled'
    and (orders.payment_status = 'paid' or active.payment_id is not null)

  union all

  select 'reversal_order_mismatch', facts.reversal_order_id, facts.payment_id, facts.reversal_id,
    orders.payment_status, orders.total_amount, facts.payment_amount
  from payment_facts facts
  left join public.orders orders on orders.id = facts.reversal_order_id
  where facts.reversal_id is not null
    and facts.reversal_order_id is distinct from facts.payment_order_id

  order by 1, 2, 3;
end;
$$;

revoke all on function public.admin_audit_order_financial_integrity() from public, anon, authenticated;
grant execute on function public.admin_audit_order_financial_integrity() to authenticated;

commit;

-- F003-15: one authoritative payment fact per eligible order. Historical paid rows are untouched.
begin;

create table if not exists public.order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders(id) on delete restrict,
  amount integer not null check (amount > 0),
  payment_method text not null check (payment_method in ('cash', 'bank_transfer', 'other')),
  paid_at timestamptz not null default now(),
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists order_payments_paid_at_idx on public.order_payments(paid_at desc);
alter table public.order_payments enable row level security;
revoke all on public.order_payments from public, anon, authenticated;
drop policy if exists "admin read order payments" on public.order_payments;
create policy "admin read order payments" on public.order_payments for select to authenticated using ((select public.is_hanjiu_admin()));
grant select on public.order_payments to authenticated;

create or replace function public.enforce_order_payment_flow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.payment_status is distinct from old.payment_status
    and current_setting('app.order_payment_authorized', true) is distinct from 'true' then
    raise exception 'order_payment_rpc_required';
  end if;
  return new;
end;
$$;
drop trigger if exists orders_payment_guard on public.orders;
create trigger orders_payment_guard before update of payment_status on public.orders for each row execute function public.enforce_order_payment_flow();

create or replace function public.admin_record_order_payment(p_order_id uuid, p_amount integer, p_payment_method text)
returns public.order_payments language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order public.orders; v_payment public.order_payments; v_method text := nullif(btrim(coalesce(p_payment_method, '')), '');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invalid_payment_amount'; end if;
  if v_method not in ('cash', 'bank_transfer', 'other') then raise exception 'invalid_payment_method'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status = 'draft' then raise exception 'draft_order_payment_not_allowed'; end if;
  if v_order.status = 'cancelled' then raise exception 'cancelled_order_payment_not_allowed'; end if;
  if v_order.total_amount is null then raise exception 'order_totals_snapshot_missing'; end if;
  if v_order.payment_status = 'paid' or exists (select 1 from public.order_payments where order_id = v_order.id) then raise exception 'order_already_paid'; end if;
  if p_amount <> v_order.total_amount then raise exception 'payment_amount_mismatch'; end if;
  perform set_config('app.order_payment_authorized', 'true', true);
  insert into public.order_payments(order_id, amount, payment_method, actor_id) values (v_order.id, p_amount, v_method, auth.uid()) returning * into v_payment;
  update public.orders set payment_status = 'paid' where id = v_order.id and payment_status = 'unpaid';
  if not found then raise exception 'order_already_paid'; end if;
  return v_payment;
end;
$$;
revoke all on function public.enforce_order_payment_flow() from public, anon, authenticated;
revoke all on function public.admin_record_order_payment(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.admin_record_order_payment(uuid, integer, text) to authenticated;
commit;

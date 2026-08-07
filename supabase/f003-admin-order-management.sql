-- F003-1: operational order management with verified admin-only access.
-- Run once in Supabase SQL Editor after the F002 migrations.
--
-- Admin authorization rule:
--   auth.jwt() -> 'app_metadata' ->> 'role' = 'admin'
--
-- The role must be stored in app_metadata by a trusted server/dashboard action.
-- Customers cannot grant this claim to themselves through user_metadata.

alter table public.orders
  add column if not exists payment_status text not null default 'unpaid';

alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('unpaid', 'paid'));

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in (
    'new', 'processing', 'ready', 'completed', 'cancelled',
    'contacted', 'confirmed', 'paid', 'shipped'
  ));

-- Legacy values remain valid so this migration does not reject or rewrite
-- historical orders. New F003 updates use only the five current workflow values.
-- The legacy status 'paid' is retained for compatibility; payment_status is the
-- authoritative paid/unpaid field for new updates.

create index if not exists orders_created_at_desc_idx
  on public.orders(created_at desc);
create index if not exists orders_status_created_at_idx
  on public.orders(status, created_at desc);
create index if not exists orders_payment_status_idx
  on public.orders(payment_status, created_at desc);
create index if not exists orders_fulfillment_idx
  on public.orders(fulfillment, created_at desc);
create index if not exists order_items_order_id_idx
  on public.order_items(order_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create or replace function public.is_hanjiu_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

revoke all on function public.is_hanjiu_admin() from public;
revoke all on function public.is_hanjiu_admin() from anon;
grant execute on function public.is_hanjiu_admin() to authenticated;

drop policy if exists "admin read orders" on public.orders;
create policy "admin read orders"
on public.orders
for select
to authenticated
using ((select public.is_hanjiu_admin()));

drop policy if exists "admin update orders" on public.orders;
create policy "admin update orders"
on public.orders
for update
to authenticated
using ((select public.is_hanjiu_admin()))
with check ((select public.is_hanjiu_admin()));

drop policy if exists "admin read order items" on public.order_items;
create policy "admin read order items"
on public.order_items
for select
to authenticated
using ((select public.is_hanjiu_admin()));

-- Keep direct table access closed. Public checkout continues through the
-- security-definer create_checkout_order RPC created by F002.
revoke select, insert, update, delete on public.orders from anon;
revoke select, insert, update, delete on public.order_items from anon;
revoke select, insert, update, delete on public.orders from authenticated;
revoke select, insert, update, delete on public.order_items from authenticated;

grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant update (status, payment_status) on public.orders to authenticated;

-- Preserve the existing F002 public checkout entry point without granting
-- direct INSERT, SELECT, UPDATE, or DELETE privileges on order tables.
grant execute on function public.create_checkout_order(text, text, text, text, jsonb)
  to anon, authenticated;

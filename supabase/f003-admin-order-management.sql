-- F003-1: operational order management fields and authenticated access.
-- Run once in Supabase SQL Editor after the F002 migrations.

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

create index if not exists orders_created_at_desc_idx on public.orders(created_at desc);
create index if not exists orders_status_created_at_idx on public.orders(status, created_at desc);
create index if not exists orders_payment_status_idx on public.orders(payment_status, created_at desc);
create index if not exists orders_fulfillment_idx on public.orders(fulfillment, created_at desc);
create index if not exists order_items_order_id_idx on public.order_items(order_id);

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "admin read orders" on public.orders;
create policy "admin read orders" on public.orders
  for select to authenticated using (true);

drop policy if exists "admin update orders" on public.orders;
create policy "admin update orders" on public.orders
  for update to authenticated using (true) with check (true);

drop policy if exists "admin read order items" on public.order_items;
create policy "admin read order items" on public.order_items
  for select to authenticated using (true);

grant select, update on public.orders to authenticated;
grant select on public.order_items to authenticated;

-- No anon SELECT/UPDATE/DELETE policy is created. Public checkout continues to
-- use the security-definer create_checkout_order RPC from F002.


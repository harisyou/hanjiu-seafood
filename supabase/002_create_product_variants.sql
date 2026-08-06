-- Haris OS F001: Product variants
-- Run once in Supabase SQL Editor before testing the F001 branch.

create extension if not exists pgcrypto;

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  weight_liang numeric(6,2),
  price integer not null check (price >= 0),
  stock integer not null default 0 check (stock >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists product_variants_product_id_idx
  on public.product_variants(product_id);

create index if not exists product_variants_active_sort_idx
  on public.product_variants(product_id, is_active, sort_order);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_product_variants_updated_at on public.product_variants;
create trigger set_product_variants_updated_at
before update on public.product_variants
for each row execute function public.set_updated_at();

alter table public.product_variants enable row level security;

drop policy if exists "public read active product variants" on public.product_variants;
create policy "public read active product variants"
on public.product_variants
for select
to anon, authenticated
using (is_active = true);

drop policy if exists "authenticated read all product variants" on public.product_variants;
create policy "authenticated read all product variants"
on public.product_variants
for select
to authenticated
using (true);

drop policy if exists "authenticated insert product variants" on public.product_variants;
create policy "authenticated insert product variants"
on public.product_variants
for insert
to authenticated
with check (true);

drop policy if exists "authenticated update product variants" on public.product_variants;
create policy "authenticated update product variants"
on public.product_variants
for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete product variants" on public.product_variants;
create policy "authenticated delete product variants"
on public.product_variants
for delete
to authenticated
using (true);

comment on table public.product_variants is 'Haris OS product weight/price/stock variants';
comment on column public.product_variants.weight_liang is 'Weight in Taiwan liang; 16 liang = 1台斤';

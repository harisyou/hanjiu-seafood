-- F001 Product Variants
create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null,
  price integer not null check (price >= 0),
  inventory integer not null default 0 check (inventory >= 0),
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create index if not exists product_variants_product_id_idx
  on public.product_variants(product_id, sort_order);

alter table public.product_variants enable row level security;

drop policy if exists "public read active product variants" on public.product_variants;
create policy "public read active product variants"
on public.product_variants for select to anon, authenticated
using (active = true or auth.role() = 'authenticated');

drop policy if exists "admin insert product variants" on public.product_variants;
create policy "admin insert product variants"
on public.product_variants for insert to authenticated
with check (true);

drop policy if exists "admin update product variants" on public.product_variants;
create policy "admin update product variants"
on public.product_variants for update to authenticated
using (true) with check (true);

drop policy if exists "admin delete product variants" on public.product_variants;
create policy "admin delete product variants"
on public.product_variants for delete to authenticated
using (true);

alter table public.order_items
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null,
  add column if not exists variant_name text,
  add column if not exists price integer check (price is null or price >= 0);


-- F004-2.1 Product Category Management
-- Run manually in Supabase SQL Editor after the current production migrations.
-- This migration is transactional and does not delete products or cascade category deletion.

begin;

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_categories_name_not_blank check (nullif(btrim(name), '') is not null),
  constraint product_categories_name_length check (char_length(btrim(name)) <= 100),
  constraint product_categories_sort_order_range check (sort_order between 0 and 1000000)
);

create unique index if not exists product_categories_normalized_name_key
  on public.product_categories ((lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))));

create index if not exists product_categories_storefront_order_idx
  on public.product_categories (active, sort_order, name);

create or replace function public.set_product_category_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists product_categories_set_updated_at on public.product_categories;
create trigger product_categories_set_updated_at
before update on public.product_categories
for each row execute function public.set_product_category_updated_at();

insert into public.product_categories (name, sort_order, active)
select seed.name, seed.sort_order, true
from (values
  ('現流魚'::text, 100),
  ('蝦蟹'::text, 200),
  ('貝類'::text, 300),
  ('冷凍'::text, 400),
  ('其他'::text, 500)
) as seed(name, sort_order)
where not exists (
  select 1
  from public.product_categories category
  where lower(regexp_replace(btrim(category.name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(seed.name), '\s+', ' ', 'g'))
);

alter table public.products add column if not exists category_id uuid;

-- This one-time backfill mirrors the former F004-2 name rules. It only fills NULL values.
with category_ids as (
  select
    (select id from public.product_categories where name = '現流魚' order by created_at, id limit 1) as live_fish_id,
    (select id from public.product_categories where name = '蝦蟹' order by created_at, id limit 1) as shrimp_crab_id,
    (select id from public.product_categories where name = '貝類' order by created_at, id limit 1) as shellfish_id,
    (select id from public.product_categories where name = '冷凍' order by created_at, id limit 1) as frozen_id,
    (select id from public.product_categories where name = '其他' order by created_at, id limit 1) as other_id
)
update public.products product
set category_id = case
  -- Fish catalog can also contain cephalopods; keep them in 其他 until a formal category exists.
  when btrim(coalesce(product.name, '')) ~* '透抽|小卷|花枝|魷' then category_ids.other_id
  when btrim(coalesce(product.name, '')) ~* '冷凍|冷藏|急凍|凍品|冰鮮' then category_ids.frozen_id
  when btrim(coalesce(product.name, '')) ~* '蝦|蟹|龍蝦|螯' then category_ids.shrimp_crab_id
  when btrim(coalesce(product.name, '')) ~* '貝|蛤|蠔|牡蠣|蚵|蜆|鮑' then category_ids.shellfish_id
  when product.fish_catalog_id is not null or btrim(coalesce(product.name, '')) ~* '魚|鯛|鱸|鯖|鯧|鰹|鮭|石斑|白帶|午仔|馬頭' then category_ids.live_fish_id
  else category_ids.other_id
end
from category_ids
where product.category_id is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass and conname = 'products_category_id_fkey'
  ) then
    alter table public.products
      add constraint products_category_id_fkey
      foreign key (category_id) references public.product_categories(id) on delete restrict;
  end if;
end;
$$;

alter table public.products alter column category_id set not null;
create index if not exists products_category_id_idx on public.products (category_id);

alter table public.product_categories enable row level security;

drop policy if exists "public read active product categories" on public.product_categories;
create policy "public read active product categories"
on public.product_categories for select to anon, authenticated
using (active or (select public.is_hanjiu_admin()));

revoke all on table public.product_categories from public, anon, authenticated;
grant select on table public.product_categories to anon, authenticated;

create or replace function public.admin_create_product_category(
  p_name text,
  p_sort_order integer default 100
)
returns public.product_categories
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category public.product_categories;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if v_name = '' or char_length(v_name) > 100 then raise exception 'invalid_category_name'; end if;
  if p_sort_order is null or p_sort_order < 0 or p_sort_order > 1000000 then raise exception 'invalid_category_sort_order'; end if;
  insert into public.product_categories (name, sort_order)
  values (v_name, p_sort_order)
  returning * into v_category;
  return v_category;
exception when unique_violation then
  raise exception 'duplicate_category_name';
end;
$$;

create or replace function public.admin_update_product_category(
  p_category_id uuid,
  p_name text,
  p_active boolean,
  p_sort_order integer
)
returns public.product_categories
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category public.product_categories;
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_category_id is null then raise exception 'category_not_found'; end if;
  if v_name = '' or char_length(v_name) > 100 then raise exception 'invalid_category_name'; end if;
  if p_active is null then raise exception 'invalid_category_active'; end if;
  if p_sort_order is null or p_sort_order < 0 or p_sort_order > 1000000 then raise exception 'invalid_category_sort_order'; end if;
  update public.product_categories
  set name = v_name, active = p_active, sort_order = p_sort_order
  where id = p_category_id
  returning * into v_category;
  if not found then raise exception 'category_not_found'; end if;
  return v_category;
exception when unique_violation then
  raise exception 'duplicate_category_name';
end;
$$;

create or replace function public.admin_delete_product_category(p_category_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_category_id is null then raise exception 'category_not_found'; end if;
  perform 1 from public.product_categories where id = p_category_id for update;
  if not found then raise exception 'category_not_found'; end if;
  if exists (select 1 from public.products where category_id = p_category_id) then raise exception 'category_in_use'; end if;
  delete from public.product_categories where id = p_category_id;
end;
$$;

revoke all on function public.set_product_category_updated_at() from public, anon, authenticated;
revoke all on function public.admin_create_product_category(text, integer) from public, anon, authenticated;
revoke all on function public.admin_update_product_category(uuid, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.admin_delete_product_category(uuid) from public, anon, authenticated;
grant execute on function public.admin_create_product_category(text, integer) to authenticated;
grant execute on function public.admin_update_product_category(uuid, text, boolean, integer) to authenticated;
grant execute on function public.admin_delete_product_category(uuid) to authenticated;

commit;

-- F003-6: independent fish catalog, aliases, and catalog-aware fish requests.
-- Run once after F003-5. Historical requests/products intentionally remain unclassified.

create table if not exists public.fish_catalog (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fish_catalog_name_not_blank check (nullif(btrim(name), '') is not null),
  constraint fish_catalog_name_length check (length(btrim(name)) <= 100)
);

create table if not exists public.fish_aliases (
  id uuid primary key default gen_random_uuid(),
  fish_catalog_id uuid not null references public.fish_catalog(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  constraint fish_alias_not_blank check (nullif(btrim(alias), '') is not null),
  constraint fish_alias_length check (length(btrim(alias)) <= 100)
);

create unique index if not exists fish_catalog_normalized_name_unique_idx
  on public.fish_catalog (lower(regexp_replace(btrim(name), '[[:space:]　]+', ' ', 'g')));
create unique index if not exists fish_aliases_normalized_alias_unique_idx
  on public.fish_aliases (lower(regexp_replace(btrim(alias), '[[:space:]　]+', ' ', 'g')));
create index if not exists fish_catalog_active_sort_idx on public.fish_catalog(active, sort_order, name);
create index if not exists fish_aliases_catalog_idx on public.fish_aliases(fish_catalog_id);

alter table public.fish_requests add column if not exists fish_catalog_id uuid;
alter table public.products add column if not exists fish_catalog_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'fish_requests_fish_catalog_id_fkey'
      and conrelid = 'public.fish_requests'::regclass
  ) then
    alter table public.fish_requests add constraint fish_requests_fish_catalog_id_fkey
      foreign key (fish_catalog_id) references public.fish_catalog(id) on delete set null not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_fish_catalog_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products add constraint products_fish_catalog_id_fkey
      foreign key (fish_catalog_id) references public.fish_catalog(id) on delete set null not valid;
  end if;
end;
$$;

create index if not exists fish_requests_catalog_status_idx
  on public.fish_requests(fish_catalog_id, status, created_at desc)
  where fish_catalog_id is not null;
create index if not exists products_fish_catalog_idx
  on public.products(fish_catalog_id) where fish_catalog_id is not null;

create or replace function public.set_fish_catalog_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists fish_catalog_set_updated_at on public.fish_catalog;
create trigger fish_catalog_set_updated_at before update on public.fish_catalog
for each row execute function public.set_fish_catalog_updated_at();

alter table public.fish_catalog enable row level security;
alter table public.fish_aliases enable row level security;

drop policy if exists "public read active fish catalog" on public.fish_catalog;
create policy "public read active fish catalog" on public.fish_catalog for select to anon, authenticated
using (active);
drop policy if exists "admin read all fish catalog" on public.fish_catalog;
create policy "admin read all fish catalog" on public.fish_catalog for select to authenticated
using ((select public.is_hanjiu_admin()));
drop policy if exists "admin insert fish catalog" on public.fish_catalog;
create policy "admin insert fish catalog" on public.fish_catalog for insert to authenticated
with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin update fish catalog" on public.fish_catalog;
create policy "admin update fish catalog" on public.fish_catalog for update to authenticated
using ((select public.is_hanjiu_admin())) with check ((select public.is_hanjiu_admin()));

drop policy if exists "admin read fish aliases" on public.fish_aliases;
create policy "admin read fish aliases" on public.fish_aliases for select to authenticated
using ((select public.is_hanjiu_admin()));
drop policy if exists "admin insert fish aliases" on public.fish_aliases;
create policy "admin insert fish aliases" on public.fish_aliases for insert to authenticated
with check ((select public.is_hanjiu_admin()));
drop policy if exists "admin delete fish aliases" on public.fish_aliases;
create policy "admin delete fish aliases" on public.fish_aliases for delete to authenticated
using ((select public.is_hanjiu_admin()));

revoke all on public.fish_catalog, public.fish_aliases from public, anon, authenticated;
revoke all on function public.set_fish_catalog_updated_at() from public, anon, authenticated;
grant select (id, name, sort_order) on public.fish_catalog to anon;
grant select on public.fish_catalog to authenticated;
grant insert, update (name, active, sort_order) on public.fish_catalog to authenticated;
grant select, insert, delete on public.fish_aliases to authenticated;
grant update (fish_catalog_id) on public.fish_requests to authenticated;
grant update (fish_catalog_id) on public.products to authenticated;

create or replace function public.create_fish_request(
  p_customer_name text, p_phone text, p_email text, p_fish_name text,
  p_quantity_request text, p_size_preference text, p_budget text, p_wanted_by date,
  p_purpose text, p_note text, p_preferred_notification_channel text,
  p_fish_catalog_id uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request_id uuid;
  v_customer_id uuid;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
  v_fish_name text;
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if nullif(btrim(p_quantity_request), '') is null then raise exception 'quantity_required'; end if;
  if p_wanted_by is not null and p_wanted_by < current_date then raise exception 'wanted_by_in_past'; end if;
  if length(btrim(p_customer_name)) > 100 or length(btrim(p_phone)) > 40
    or length(btrim(p_quantity_request)) > 100 then raise exception 'invalid_length'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if p_purpose is not null and p_purpose not in ('家庭料理', '聚餐', '送禮', '餐廳', '其他') then raise exception 'invalid_purpose'; end if;
  if p_preferred_notification_channel not in ('line', 'email', 'phone') then raise exception 'invalid_notification_channel'; end if;

  if p_fish_catalog_id is not null then
    select name into v_fish_name from public.fish_catalog
    where id = p_fish_catalog_id and active;
    if not found then raise exception 'fish_catalog_unavailable'; end if;
    v_fish_name := btrim(v_fish_name);
  else
    v_fish_name := nullif(btrim(coalesce(p_fish_name, '')), '');
    if v_fish_name is null then raise exception 'fish_name_required'; end if;
    if length(v_fish_name) > 100 then raise exception 'invalid_length'; end if;
  end if;

  v_customer_id := public.find_or_create_customer(p_customer_name, v_phone, v_email, p_preferred_notification_channel);
  insert into public.fish_requests (
    customer_id, customer_name, phone, email, line_user_id, fish_catalog_id, fish_name,
    quantity_request, size_preference, budget, wanted_by, purpose, note,
    preferred_notification_channel
  ) values (
    v_customer_id, left(btrim(p_customer_name), 100), v_phone, v_email, null,
    p_fish_catalog_id, left(v_fish_name, 100), left(btrim(p_quantity_request), 100),
    nullif(left(btrim(coalesce(p_size_preference, '')), 200), ''),
    nullif(left(btrim(coalesce(p_budget, '')), 100), ''), p_wanted_by,
    nullif(p_purpose, ''), nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
    p_preferred_notification_channel
  ) returning id into v_request_id;
  return v_request_id;
end;
$$;

-- Preserve the production 11-parameter public API for existing callers.
create or replace function public.create_fish_request(
  p_customer_name text, p_phone text, p_email text, p_fish_name text,
  p_quantity_request text, p_size_preference text, p_budget text, p_wanted_by date,
  p_purpose text, p_note text, p_preferred_notification_channel text
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.create_fish_request(
    p_customer_name, p_phone, p_email, p_fish_name, p_quantity_request,
    p_size_preference, p_budget, p_wanted_by, p_purpose, p_note,
    p_preferred_notification_channel, null::uuid
  );
end;
$$;

revoke all on function public.create_fish_request(
  text, text, text, text, text, text, text, date, text, text, text, uuid
) from public, anon, authenticated;
revoke all on function public.create_fish_request(
  text, text, text, text, text, text, text, date, text, text, text
) from public, anon, authenticated;
revoke insert on public.fish_requests from anon, authenticated;
grant execute on function public.create_fish_request(
  text, text, text, text, text, text, text, date, text, text, text, uuid
) to anon, authenticated;
grant execute on function public.create_fish_request(
  text, text, text, text, text, text, text, date, text, text, text
) to anon, authenticated;

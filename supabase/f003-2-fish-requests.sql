-- F003-2: customer fish requests and admin workflow.
-- Run once after F003-1. Requires public.is_hanjiu_admin().

create table if not exists public.fish_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid,
  customer_name text not null,
  phone text not null,
  email text,
  line_user_id text,
  fish_name text not null,
  quantity_request text not null,
  size_preference text,
  budget text,
  wanted_by date,
  purpose text check (purpose is null or purpose in ('家庭料理', '聚餐', '送禮', '餐廳', '其他')),
  note text,
  preferred_notification_channel text not null
    check (preferred_notification_channel in ('line', 'email', 'phone')),
  status text not null default 'waiting'
    check (status in ('waiting', 'matched', 'contacted', 'converted', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.fish_requests.customer_id is
  'Reserved for a future customers table; intentionally has no foreign key in V1.';

create index if not exists fish_requests_status_created_idx
  on public.fish_requests(status, created_at desc);
create index if not exists fish_requests_fish_name_idx
  on public.fish_requests(fish_name);
create index if not exists fish_requests_wanted_by_idx
  on public.fish_requests(wanted_by) where wanted_by is not null;
create index if not exists fish_requests_customer_id_idx
  on public.fish_requests(customer_id) where customer_id is not null;

alter table public.fish_requests enable row level security;

create or replace function public.set_fish_request_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists fish_requests_set_updated_at on public.fish_requests;
create trigger fish_requests_set_updated_at
before update on public.fish_requests
for each row execute function public.set_fish_request_updated_at();

drop policy if exists "admin read fish requests" on public.fish_requests;
create policy "admin read fish requests"
on public.fish_requests
for select
to authenticated
using ((select public.is_hanjiu_admin()));

drop policy if exists "admin update fish requests" on public.fish_requests;
create policy "admin update fish requests"
on public.fish_requests
for update
to authenticated
using ((select public.is_hanjiu_admin()))
with check ((select public.is_hanjiu_admin()));

revoke all on public.fish_requests from public;
revoke all on public.fish_requests from anon;
revoke all on public.fish_requests from authenticated;
revoke all on function public.set_fish_request_updated_at() from public;
revoke all on function public.set_fish_request_updated_at() from anon;
revoke all on function public.set_fish_request_updated_at() from authenticated;
grant select on public.fish_requests to authenticated;
grant update (status) on public.fish_requests to authenticated;

create or replace function public.create_fish_request(
  p_customer_name text,
  p_phone text,
  p_email text,
  p_fish_name text,
  p_quantity_request text,
  p_size_preference text,
  p_budget text,
  p_wanted_by date,
  p_purpose text,
  p_note text,
  p_preferred_notification_channel text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if nullif(btrim(p_fish_name), '') is null then raise exception 'fish_name_required'; end if;
  if nullif(btrim(p_quantity_request), '') is null then raise exception 'quantity_required'; end if;
  if length(btrim(p_customer_name)) > 100 or length(btrim(p_phone)) > 40
    or length(btrim(p_fish_name)) > 100 or length(btrim(p_quantity_request)) > 100 then
    raise exception 'invalid_length';
  end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;
  if p_purpose is not null and p_purpose not in ('家庭料理', '聚餐', '送禮', '餐廳', '其他') then
    raise exception 'invalid_purpose';
  end if;
  if p_preferred_notification_channel not in ('line', 'email', 'phone') then
    raise exception 'invalid_notification_channel';
  end if;

  insert into public.fish_requests (
    customer_name, phone, email, line_user_id, fish_name, quantity_request,
    size_preference, budget, wanted_by, purpose, note,
    preferred_notification_channel
  ) values (
    left(btrim(p_customer_name), 100), left(btrim(p_phone), 40), v_email, null,
    left(btrim(p_fish_name), 100), left(btrim(p_quantity_request), 100),
    nullif(left(btrim(coalesce(p_size_preference, '')), 200), ''),
    nullif(left(btrim(coalesce(p_budget, '')), 100), ''), p_wanted_by,
    nullif(p_purpose, ''), nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
    p_preferred_notification_channel
  ) returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.create_fish_request(
  text, text, text, text, text, text, text, date, text, text, text
) from public;
grant execute on function public.create_fish_request(
  text, text, text, text, text, text, text, date, text, text, text
) to anon, authenticated;

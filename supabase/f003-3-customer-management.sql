-- F003-3: central customer profiles.
-- Run once after all F002, F003-1, F003-2, and checkout Email migrations.

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text not null,
  email text,
  line_user_id text,
  customer_type text not null default 'household'
    check (customer_type in ('household', 'restaurant')),
  business_name text,
  preferred_notification_channel text
    check (preferred_notification_channel is null or preferred_notification_channel in ('line', 'email', 'phone')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_normalized_phone_check check (phone ~ '^09[0-9]{8}$'),
  constraint customers_email_length_check check (email is null or length(email) <= 254)
);

create unique index if not exists customers_phone_unique_idx on public.customers(phone);
create index if not exists customers_name_idx on public.customers(name);
create index if not exists customers_email_idx on public.customers(email) where email is not null;
create index if not exists customers_business_name_idx on public.customers(business_name) where business_name is not null;
create index if not exists customers_type_created_idx on public.customers(customer_type, created_at desc);

alter table public.orders add column if not exists customer_id uuid;
create index if not exists orders_customer_id_created_idx
  on public.orders(customer_id, created_at desc) where customer_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_customer_id_fkey' and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders add constraint orders_customer_id_fkey
      foreign key (customer_id) references public.customers(id) on delete set null not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'fish_requests_customer_id_fkey' and conrelid = 'public.fish_requests'::regclass
  ) then
    alter table public.fish_requests add constraint fish_requests_customer_id_fkey
      foreign key (customer_id) references public.customers(id) on delete set null not valid;
  end if;
end;
$$;

create or replace function public.set_customer_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at before update on public.customers
for each row execute function public.set_customer_updated_at();

alter table public.customers enable row level security;

drop policy if exists "admin read customers" on public.customers;
create policy "admin read customers" on public.customers for select to authenticated
using ((select public.is_hanjiu_admin()));

drop policy if exists "admin update customers" on public.customers;
create policy "admin update customers" on public.customers for update to authenticated
using ((select public.is_hanjiu_admin()))
with check ((select public.is_hanjiu_admin()));

revoke all on public.customers from public, anon, authenticated;
revoke all on function public.set_customer_updated_at() from public, anon, authenticated;
grant select on public.customers to authenticated;
grant update (name, email, line_user_id, customer_type, business_name,
  preferred_notification_channel, admin_note) on public.customers to authenticated;

create or replace function public.find_or_create_customer(
  p_name text,
  p_phone text,
  p_email text,
  p_preferred_notification_channel text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_name text := nullif(left(btrim(coalesce(p_name, '')), 100), '');
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
begin
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;
  if p_preferred_notification_channel is not null
    and p_preferred_notification_channel not in ('line', 'email', 'phone') then
    raise exception 'invalid_notification_channel';
  end if;

  insert into public.customers (name, phone, email, preferred_notification_channel)
  values (v_name, v_phone, v_email, p_preferred_notification_channel)
  on conflict (phone) do update set
    name = case when nullif(btrim(public.customers.name), '') is null then excluded.name else public.customers.name end,
    email = case when nullif(btrim(public.customers.email), '') is null then excluded.email else public.customers.email end,
    preferred_notification_channel = coalesce(public.customers.preferred_notification_channel, excluded.preferred_notification_channel)
  returning id into v_customer_id;

  return v_customer_id;
end;
$$;

revoke all on function public.find_or_create_customer(text, text, text, text) from public, anon, authenticated;

create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb,
  p_email text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_item jsonb;
  v_variant record;
  v_variant_id uuid;
  v_quantity integer;
  v_preset_id text;
  v_preset_name text;
  v_option_ids text[];
  v_option_names text[];
  v_expected_count integer;
  v_note text;
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and length(v_email) > 254 then raise exception 'invalid_email'; end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;

  v_customer_id := public.find_or_create_customer(p_customer_name, v_phone, v_email, null);

  insert into public.orders (customer_id, customer_name, phone, email, line_id, fulfillment, processing, note)
  values (v_customer_id, btrim(p_customer_name), v_phone, v_email, null, p_fulfillment, '依品項', nullif(p_note, ''))
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(v_item->>'processing_preset_id', '');
    v_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}') into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    if v_quantity is null or v_quantity < 1 then raise exception 'invalid_quantity'; end if;

    select variant.id as variant_id, variant.product_id, product.name as product_name,
      product.processing_enabled, variant.name as variant_name, variant.price,
      variant.inventory, variant.active into v_variant
    from public.product_variants variant
    join public.products product on product.id = variant.product_id
    where variant.id = v_variant_id;
    if not found or not v_variant.active or v_quantity > v_variant.inventory then raise exception 'variant_unavailable'; end if;

    if not v_variant.processing_enabled then
      v_preset_id := 'none'; v_preset_name := '不處理'; v_option_ids := '{}'; v_option_names := '{}'; v_note := null;
    else
      if v_preset_id is not null then
        select preset.name into v_preset_name
        from public.product_processing_presets config
        join public.processing_presets preset on preset.id = config.preset_id
        where config.product_id = v_variant.product_id and config.preset_id = v_preset_id
          and config.active and preset.active;
        if not found then raise exception 'processing_updated'; end if;
      end if;
      select count(*), coalesce(array_agg(option_catalog.name order by option_config.sort_order), '{}')
      into v_expected_count, v_option_names
      from unnest(v_option_ids) selected_id
      join public.product_processing_options option_config on option_config.product_id = v_variant.product_id
        and option_config.processing_option_id = selected_id and option_config.active
      join public.processing_options option_catalog on option_catalog.id = option_config.processing_option_id and option_catalog.active;
      if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;
      if v_preset_id is not null and not exists (
        select 1 from (select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids
          from public.processing_preset_options where preset_id = v_preset_id) preset_options
        where preset_options.ids = v_option_ids
      ) then v_preset_name := '客製化處理'; end if;
      if v_preset_id is null then v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end; end if;
    end if;

    insert into public.order_items (
      order_id, product_id, product_name, variant_id, variant_name, price, quantity,
      processing_preset_id, processing_preset_name, processing_option_ids, processing_option_names, processing_note
    ) values (
      v_order_id, v_variant.product_id, v_variant.product_name, v_variant.variant_id,
      v_variant.variant_name, v_variant.price, v_quantity, v_preset_id,
      v_preset_name, v_option_ids, v_option_names, v_note
    );
  end loop;
  return v_order_id;
end;
$$;

create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.create_checkout_order(
    p_customer_name, p_phone, p_fulfillment, p_note, p_items, null::text
  );
end;
$$;

create or replace function public.create_fish_request(
  p_customer_name text, p_phone text, p_email text, p_fish_name text,
  p_quantity_request text, p_size_preference text, p_budget text, p_wanted_by date,
  p_purpose text, p_note text, p_preferred_notification_channel text
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_request_id uuid;
  v_customer_id uuid;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_email text := nullif(left(btrim(coalesce(p_email, '')), 254), '');
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if nullif(btrim(p_fish_name), '') is null then raise exception 'fish_name_required'; end if;
  if nullif(btrim(p_quantity_request), '') is null then raise exception 'quantity_required'; end if;
  if p_wanted_by is not null and p_wanted_by < current_date then raise exception 'wanted_by_in_past'; end if;
  if length(btrim(p_customer_name)) > 100 or length(btrim(p_phone)) > 40
    or length(btrim(p_fish_name)) > 100 or length(btrim(p_quantity_request)) > 100 then
    raise exception 'invalid_length';
  end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if p_purpose is not null and p_purpose not in ('家庭料理', '聚餐', '送禮', '餐廳', '其他') then raise exception 'invalid_purpose'; end if;
  if p_preferred_notification_channel not in ('line', 'email', 'phone') then raise exception 'invalid_notification_channel'; end if;

  v_customer_id := public.find_or_create_customer(p_customer_name, v_phone, v_email, p_preferred_notification_channel);
  insert into public.fish_requests (
    customer_id, customer_name, phone, email, line_user_id, fish_name, quantity_request,
    size_preference, budget, wanted_by, purpose, note, preferred_notification_channel
  ) values (
    v_customer_id, left(btrim(p_customer_name), 100), v_phone, v_email, null,
    left(btrim(p_fish_name), 100), left(btrim(p_quantity_request), 100),
    nullif(left(btrim(coalesce(p_size_preference, '')), 200), ''),
    nullif(left(btrim(coalesce(p_budget, '')), 100), ''), p_wanted_by,
    nullif(p_purpose, ''), nullif(left(btrim(coalesce(p_note, '')), 1000), ''),
    p_preferred_notification_channel
  ) returning id into v_request_id;
  return v_request_id;
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text) from public;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public;
revoke all on function public.create_fish_request(text, text, text, text, text, text, text, date, text, text, text) from public;
revoke insert on public.customers, public.orders, public.order_items, public.fish_requests from anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.create_fish_request(text, text, text, text, text, text, text, date, text, text, text) to anon, authenticated;

-- Historical rows intentionally remain nullable. Review matches before any backfill:
-- select o.id, o.customer_name, o.phone, c.id customer_id
-- from public.orders o join public.customers c
--   on regexp_replace(o.phone, '[^0-9]', '', 'g') = c.phone
-- where o.customer_id is null;
-- Apply reviewed IDs individually; do not bulk merge customers by name.

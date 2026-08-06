-- F002-3: configurable per-product fish processing.
-- Run this file once in the Supabase SQL Editor after F002-2 migration.

alter table public.products
  add column if not exists processing_enabled boolean not null default false;

create table if not exists public.processing_options (
  id text primary key,
  name text not null unique,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists public.processing_presets (
  id text primary key,
  name text not null unique,
  description text,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists public.processing_preset_options (
  preset_id text not null references public.processing_presets(id) on delete restrict,
  processing_option_id text not null references public.processing_options(id) on delete restrict,
  primary key (preset_id, processing_option_id)
);

create table if not exists public.product_processing_options (
  product_id uuid not null references public.products(id) on delete cascade,
  processing_option_id text not null references public.processing_options(id) on delete restrict,
  active boolean not null default true,
  recommended boolean not null default false,
  sort_order integer not null default 100,
  primary key (product_id, processing_option_id)
);

create table if not exists public.product_processing_presets (
  product_id uuid not null references public.products(id) on delete cascade,
  preset_id text not null references public.processing_presets(id) on delete restrict,
  active boolean not null default true,
  recommended boolean not null default false,
  is_default boolean not null default false,
  sort_order integer not null default 100,
  primary key (product_id, preset_id)
);

create index if not exists product_processing_options_product_sort_idx
  on public.product_processing_options(product_id, sort_order);
create index if not exists product_processing_presets_product_sort_idx
  on public.product_processing_presets(product_id, sort_order);
create unique index if not exists product_processing_presets_one_default_idx
  on public.product_processing_presets(product_id) where is_default and active;

alter table public.order_items add column if not exists processing_preset_id text;
alter table public.order_items add column if not exists processing_preset_name text;
alter table public.order_items add column if not exists processing_option_ids text[] not null default '{}';
alter table public.order_items add column if not exists processing_option_names text[] not null default '{}';
alter table public.order_items add column if not exists processing_note text;

insert into public.processing_options (id, name, sort_order) values
  ('scale', '去魚鱗', 10),
  ('gut', '去內臟', 20),
  ('gill', '去魚鰓', 30),
  ('head', '去頭', 40),
  ('tail', '去尾', 50),
  ('butterfly', '剖開', 60),
  ('half', '對半切', 70),
  ('small-pieces', '切小塊', 80),
  ('sections', '切段', 90),
  ('skin', '去皮', 100),
  ('bone', '去骨', 110),
  ('steak', '切魚排', 120)
on conflict (id) do update set name = excluded.name, sort_order = excluded.sort_order;

insert into public.processing_presets (id, name, description, sort_order) values
  ('none', '不處理', '保留原魚狀態', 10),
  ('three-clean', '三清', '去魚鱗、去內臟、去魚鰓', 20),
  ('three-remove', '三去', '去頭、去尾、去內臟', 30)
on conflict (id) do update set name = excluded.name, description = excluded.description, sort_order = excluded.sort_order;

insert into public.processing_preset_options (preset_id, processing_option_id) values
  ('three-clean', 'scale'), ('three-clean', 'gut'), ('three-clean', 'gill'),
  ('three-remove', 'head'), ('three-remove', 'tail'), ('three-remove', 'gut')
on conflict do nothing;

alter table public.processing_options enable row level security;
alter table public.processing_presets enable row level security;
alter table public.processing_preset_options enable row level security;
alter table public.product_processing_options enable row level security;
alter table public.product_processing_presets enable row level security;

drop policy if exists "public read active processing options" on public.processing_options;
create policy "public read active processing options" on public.processing_options
  for select to anon, authenticated using (active or auth.role() = 'authenticated');
drop policy if exists "admin manage processing options" on public.processing_options;
create policy "admin manage processing options" on public.processing_options
  for all to authenticated using (true) with check (true);

drop policy if exists "public read active processing presets" on public.processing_presets;
create policy "public read active processing presets" on public.processing_presets
  for select to anon, authenticated using (active or auth.role() = 'authenticated');
drop policy if exists "admin manage processing presets" on public.processing_presets;
create policy "admin manage processing presets" on public.processing_presets
  for all to authenticated using (true) with check (true);

drop policy if exists "public read preset composition" on public.processing_preset_options;
create policy "public read preset composition" on public.processing_preset_options
  for select to anon, authenticated using (
    exists (select 1 from public.processing_presets p where p.id = preset_id and p.active)
  );
drop policy if exists "admin manage preset composition" on public.processing_preset_options;
create policy "admin manage preset composition" on public.processing_preset_options
  for all to authenticated using (true) with check (true);

drop policy if exists "public read product processing options" on public.product_processing_options;
create policy "public read product processing options" on public.product_processing_options
  for select to anon, authenticated using (
    active and exists (
      select 1 from public.products p
      where p.id = product_id and p.processing_enabled and p.status <> 'hidden'
    )
  );
drop policy if exists "admin manage product processing options" on public.product_processing_options;
create policy "admin manage product processing options" on public.product_processing_options
  for all to authenticated using (true) with check (true);

drop policy if exists "public read product processing presets" on public.product_processing_presets;
create policy "public read product processing presets" on public.product_processing_presets
  for select to anon, authenticated using (
    active and exists (
      select 1 from public.products p
      where p.id = product_id and p.processing_enabled and p.status <> 'hidden'
    )
  );
drop policy if exists "admin manage product processing presets" on public.product_processing_presets;
create policy "admin manage product processing presets" on public.product_processing_presets
  for all to authenticated using (true) with check (true);

grant select on public.processing_options, public.processing_presets,
  public.processing_preset_options, public.product_processing_options,
  public.product_processing_presets to anon, authenticated;
grant insert, update, delete on public.processing_options, public.processing_presets,
  public.processing_preset_options, public.product_processing_options,
  public.product_processing_presets to authenticated;

create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
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
begin
  if nullif(btrim(p_customer_name), '') is null then raise exception 'customer_name_required'; end if;
  if nullif(btrim(p_phone), '') is null then raise exception 'phone_required'; end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then
    raise exception 'invalid_fulfillment';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;

  insert into public.orders (customer_name, phone, line_id, fulfillment, processing, note)
  values (btrim(p_customer_name), btrim(p_phone), null, p_fulfillment, '依品項', nullif(p_note, ''))
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(v_item->>'processing_preset_id', '');
    v_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}')
      into v_option_ids from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));

    if v_quantity is null or v_quantity < 1 then raise exception 'invalid_quantity'; end if;
    select variant.id as variant_id, variant.product_id, product.name as product_name,
      product.processing_enabled, variant.name as variant_name, variant.price,
      variant.inventory, variant.active
    into v_variant
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
      join public.product_processing_options option_config
        on option_config.product_id = v_variant.product_id
        and option_config.processing_option_id = selected_id and option_config.active
      join public.processing_options option_catalog
        on option_catalog.id = option_config.processing_option_id and option_catalog.active;
      if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;

      if v_preset_id is not null and not exists (
        select 1
        from (
          select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids
          from public.processing_preset_options where preset_id = v_preset_id
        ) preset_options
        where preset_options.ids = v_option_ids
      ) then
        v_preset_name := '客製化處理';
      end if;
      if v_preset_id is null then v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end; end if;
    end if;

    insert into public.order_items (
      order_id, product_id, product_name, variant_id, variant_name, price, quantity,
      processing_preset_id, processing_preset_name, processing_option_ids,
      processing_option_names, processing_note
    ) values (
      v_order_id, v_variant.product_id, v_variant.product_name, v_variant.variant_id,
      v_variant.variant_name, v_variant.price, v_quantity, v_preset_id,
      v_preset_name, v_option_ids, v_option_names, v_note
    );
  end loop;
  return v_order_id;
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;


-- Phase 2 PR-B. Forward-only after owner-applied F006-1. Owner runs manually.
-- No legacy checkout, orders, payments, cancellation, or movement rows are changed.
begin;

alter table public.products
  add column common_weight_min_g integer,
  add column common_weight_max_g integer;
alter table public.products add constraint products_common_weight_range_check
  check ((common_weight_min_g is null and common_weight_max_g is null)
    or (common_weight_min_g > 0 and common_weight_max_g >= common_weight_min_g));

create table public.phase2_stock_batch_daily_counters (
  batch_date date primary key,
  latest_number integer not null check (latest_number > 0)
);
create table public.phase2_stock_batches (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{32}$'),
  batch_date date not null,
  sequence_no integer,
  name text not null,
  source text check (source is null or char_length(source) between 1 and 80),
  note text check (note is null or char_length(note) between 1 and 1000),
  stock_count integer not null default 0 check (stock_count >= 0),
  actor_id uuid,
  created_at timestamptz not null default now(),
  unique (batch_date,sequence_no)
);
create index phase2_batches_created_idx on public.phase2_stock_batches(created_at desc);

-- A missing enabled tier is representable only with an explicitly confirmed
-- positive manual T+0 price. Existing tier-backed stock rows remain untouched.
alter table public.phase2_weighted_stock
  alter column pricing_tier_id drop not null,
  alter column price_per_jin_snapshot drop not null,
  alter column system_base_price drop not null,
  add column batch_id uuid references public.phase2_stock_batches(id) on delete restrict,
  add column batch_line_no integer check (batch_line_no is null or batch_line_no > 0),
  add constraint phase2_stock_batch_line_pair_check
    check ((batch_id is null and batch_line_no is null) or (batch_id is not null and batch_line_no is not null)),
  add constraint phase2_stock_batch_line_unique unique (batch_id,batch_line_no);
alter table public.phase2_weighted_stock add constraint phase2_stock_price_origin_check
  check ((pricing_tier_id is not null and price_per_jin_snapshot is not null
          and system_base_price is not null)
    or (pricing_tier_id is null and price_per_jin_snapshot is null
        and system_base_price is null and manual_base_price is not null
        and manual_price_confirmed));
create index phase2_stock_batch_idx on public.phase2_weighted_stock(batch_id) where batch_id is not null;

create table public.phase2_stock_photos (
  stock_id uuid primary key references public.phase2_weighted_stock(id) on delete restrict,
  storage_bucket text not null default 'product-images' check (storage_bucket='product-images'),
  storage_path text not null unique,
  actor_id uuid,
  created_at timestamptz not null default now()
);

create or replace function public.phase2_initialize_weighted_stock()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_tier public.phase2_weight_pricing_tiers; v_mode text; v_product_status text;
        v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
        v_max_day integer;
begin
  select inventory_mode,status into v_mode,v_product_status from public.products where id=new.product_id for update;
  if v_mode is distinct from 'SINGLE_WEIGHTED' then raise exception 'weighted_inventory_mode_required'; end if;
  if v_product_status is distinct from 'available' then raise exception 'weighted_product_not_available'; end if;
  if new.raw_weight_g is null or new.raw_weight_g <= 0 then raise exception 'invalid_raw_weight_g'; end if;
  if new.manual_base_price is not null and new.manual_base_price <= 0 then raise exception 'invalid_manual_base_price'; end if;
  if new.stock_code is not null then raise exception 'stock_code_server_generated'; end if;
  if new.status <> 'sellable' or new.order_id is not null or new.order_item_id is not null then
    raise exception 'weighted_stock_initial_state_required';
  end if;
  if new.fish_date is null or new.fish_date > v_today then raise exception 'weighted_stock_future_fish_date'; end if;
  select max_sale_day into v_max_day from public.phase2_freshness_policy where id=1 for share;
  if not found or v_today-new.fish_date > v_max_day
     or not exists(select 1 from public.phase2_freshness_days where day_offset=v_today-new.fish_date) then
    raise exception 'weighted_stock_freshness_not_sellable';
  end if;
  if new.representative_image_id is not null and not exists
    (select 1 from public.product_images i where i.id=new.representative_image_id and i.product_id=new.product_id) then
    raise exception 'representative_image_product_mismatch';
  end if;
  select * into v_tier from public.phase2_weight_pricing_tiers t
    where t.product_id=new.product_id and t.enabled
      and new.raw_weight_g >= t.lower_bound_g and new.raw_weight_g < t.upper_bound_g;
  if found then
    new.pricing_tier_id := v_tier.id;
    new.price_per_jin_snapshot := v_tier.price_per_jin;
    new.system_base_price := round(new.raw_weight_g::numeric*v_tier.price_per_jin/600)::integer;
    if new.system_base_price <= 0 then raise exception 'computed_base_price_too_small'; end if;
    if public.phase2_manual_price_requires_confirmation(new.system_base_price,new.manual_base_price)
       and not new.manual_price_confirmed then raise exception 'manual_price_confirmation_required'; end if;
  else
    if new.manual_base_price is null then raise exception 'weight_pricing_tier_not_found'; end if;
    if not new.manual_price_confirmed then raise exception 'manual_price_confirmation_required'; end if;
    new.pricing_tier_id := null;
    new.price_per_jin_snapshot := null;
    new.system_base_price := null;
  end if;
  if new.manual_base_price is null and new.manual_price_confirmed then
    raise exception 'manual_price_confirmation_without_override';
  end if;
  new.stock_code := 'F-'||to_char(new.fish_date,'YYMMDD')||'-'||lpad(nextval('public.phase2_stock_code_seq')::text,8,'0');
  new.t0_base_price := coalesce(new.manual_base_price,new.system_base_price);
  new.version := 1;
  return new;
end; $$;

create or replace function public.phase2_guard_weighted_stock_update()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.product_id is distinct from old.product_id or new.stock_code is distinct from old.stock_code
     or new.fish_date is distinct from old.fish_date or new.raw_weight_g is distinct from old.raw_weight_g
     or new.pricing_tier_id is distinct from old.pricing_tier_id
     or new.price_per_jin_snapshot is distinct from old.price_per_jin_snapshot
     or new.system_base_price is distinct from old.system_base_price
     or new.manual_base_price is distinct from old.manual_base_price
     or new.manual_price_confirmed is distinct from old.manual_price_confirmed
     or new.t0_base_price is distinct from old.t0_base_price
     or new.batch_id is distinct from old.batch_id
     or new.batch_line_no is distinct from old.batch_line_no
     or new.status is distinct from old.status or new.order_id is distinct from old.order_id
     or new.order_item_id is distinct from old.order_item_id then
    raise exception 'weighted_stock_action_or_correction_required';
  end if;
  if new.representative_image_id is not null and not exists
     (select 1 from public.product_images i where i.id=new.representative_image_id and i.product_id=new.product_id) then
    raise exception 'representative_image_product_mismatch';
  end if;
  new.version := old.version+1;
  new.updated_at := clock_timestamp();
  return new;
end; $$;

-- Existing mode guard still decides whether a transition is legal. Browser
-- direct writes to the two new product settings are denied independently.
create or replace function public.phase2_guard_weighted_product_settings()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.common_weight_min_g,new.common_weight_max_g) is distinct from
     (old.common_weight_min_g,old.common_weight_max_g)
     and current_user in ('anon','authenticated') then
    raise exception 'weighted_product_settings_action_required';
  end if;
  return new;
end; $$;
create trigger phase2_weighted_product_settings_guard before update of common_weight_min_g,common_weight_max_g
  on public.products for each row execute function public.phase2_guard_weighted_product_settings();

create or replace function public.phase2_audit_weighted_product_settings()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text := nullif(btrim(current_setting('app.phase2_reason',true)),'');
begin
  if (new.inventory_mode,new.common_weight_min_g,new.common_weight_max_g) is not distinct from
     (old.inventory_mode,old.common_weight_min_g,old.common_weight_max_g) then return new; end if;
  if v_reason is null then raise exception 'phase2_change_reason_required'; end if;
  insert into public.phase2_audit_events(actor_id,action,entity_type,entity_id,old_value,new_value,reason)
  values(auth.uid(),'weighted_product_settings_update','product',new.id,
    jsonb_build_object('inventory_mode',old.inventory_mode,'common_weight_min_g',old.common_weight_min_g,'common_weight_max_g',old.common_weight_max_g),
    jsonb_build_object('inventory_mode',new.inventory_mode,'common_weight_min_g',new.common_weight_min_g,'common_weight_max_g',new.common_weight_max_g),v_reason);
  return new;
end; $$;
create trigger phase2_weighted_product_settings_audit after update of inventory_mode,common_weight_min_g,common_weight_max_g
  on public.products for each row execute function public.phase2_audit_weighted_product_settings();

create or replace function public.admin_update_weighted_product_settings(
  p_product_id uuid,p_expected_updated_at timestamptz,p_mode text,
  p_common_weight_min_g integer,p_common_weight_max_g integer,p_reason text)
returns public.products language plpgsql security definer set search_path = public, pg_temp as $$
declare v_product public.products; v_previous text := current_setting('app.phase2_reason',true);
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'phase2_change_reason_required'; end if;
  if p_mode not in ('SINGLE_WEIGHTED','QUANTITY_VARIANT') and p_mode is not null then
    raise exception 'invalid_inventory_mode';
  end if;
  perform set_config('app.phase2_reason',btrim(p_reason),true);
  update public.products set inventory_mode=p_mode,common_weight_min_g=p_common_weight_min_g,
    common_weight_max_g=p_common_weight_max_g
  where id=p_product_id and updated_at=p_expected_updated_at returning * into v_product;
  if not found then raise exception 'weighted_product_settings_conflict'; end if;
  perform set_config('app.phase2_reason',coalesce(v_previous,''),true);
  return v_product;
end; $$;

create or replace function public.admin_save_weight_pricing_tier(
  p_product_id uuid,p_lower_bound_g integer,p_upper_bound_g integer,
  p_price_per_jin integer,p_sort_order integer,p_enabled boolean,p_reason text,
  p_tier_id uuid default null,p_expected_updated_at timestamptz default null)
returns public.phase2_weight_pricing_tiers language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tier public.phase2_weight_pricing_tiers; v_previous text := current_setting('app.phase2_reason',true);
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if nullif(btrim(p_reason),'') is null then raise exception 'phase2_change_reason_required'; end if;
  if not exists(select 1 from public.products where id=p_product_id and inventory_mode='SINGLE_WEIGHTED') then
    raise exception 'weighted_inventory_mode_required'; end if;
  perform set_config('app.phase2_reason',btrim(p_reason),true);
  if p_tier_id is null then
    insert into public.phase2_weight_pricing_tiers(product_id,lower_bound_g,upper_bound_g,price_per_jin,sort_order,enabled)
    values(p_product_id,p_lower_bound_g,p_upper_bound_g,p_price_per_jin,p_sort_order,p_enabled)
    returning * into v_tier;
  else
    update public.phase2_weight_pricing_tiers set lower_bound_g=p_lower_bound_g,
      upper_bound_g=p_upper_bound_g,price_per_jin=p_price_per_jin,sort_order=p_sort_order,enabled=p_enabled
    where id=p_tier_id and product_id=p_product_id and updated_at=p_expected_updated_at
    returning * into v_tier;
    if not found then raise exception 'weight_pricing_tier_conflict'; end if;
  end if;
  perform set_config('app.phase2_reason',coalesce(v_previous,''),true);
  return v_tier;
end; $$;

-- Canonical request rows, independent of JSON object key order and harmless
-- representation differences. Array order is identity: it assigns batch_line_no.
-- Reject unknown fields instead of silently discarding possibly meaningful input.
create or replace function public.phase2_normalize_weighted_batch_items(p_items jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare v_item jsonb; v_items jsonb := '[]'::jsonb; v_unknown text;
        v_product_id uuid; v_fish_date date; v_date_text text; v_weight integer;
        v_manual integer; v_expected_tier uuid; v_expected_system integer;
        v_confirm boolean; v_number numeric; v_text text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'quick_entry_items_required'; end if;
  if jsonb_array_length(p_items)=0 then raise exception 'quick_entry_items_required'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'quick_entry_invalid_item'; end if;
    select key into v_unknown from jsonb_object_keys(v_item) key where key not in
      ('product_id','raw_weight_g','fish_date','manual_base_price',
       'manual_price_confirmed','expected_tier_id','expected_system_base_price') limit 1;
    if v_unknown is not null then raise exception 'quick_entry_unknown_item_field: %',v_unknown; end if;
    v_product_id := nullif(btrim(v_item->>'product_id'),'')::uuid;
    v_date_text := v_item->>'fish_date';
    if v_product_id is null or v_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'quick_entry_invalid_item'; end if;
    v_fish_date := v_date_text::date;
    if to_char(v_fish_date,'YYYY-MM-DD') <> v_date_text then raise exception 'quick_entry_invalid_item'; end if;

    v_text := nullif(btrim(v_item->>'raw_weight_g'),'');
    v_number := v_text::numeric;
    if v_number is null or v_number <> trunc(v_number) or v_number not between -2147483648 and 2147483647 then
      raise exception 'quick_entry_invalid_integer'; end if;
    v_weight := v_number::integer;
    v_text := nullif(btrim(v_item->>'manual_base_price'),'');
    v_manual := null;
    if v_text is not null then
      v_number := v_text::numeric;
      if v_number <> trunc(v_number) or v_number not between -2147483648 and 2147483647 then
        raise exception 'quick_entry_invalid_integer'; end if;
      v_manual := v_number::integer;
    end if;
    v_text := nullif(btrim(v_item->>'expected_system_base_price'),'');
    v_expected_system := null;
    if v_text is not null then
      v_number := v_text::numeric;
      if v_number <> trunc(v_number) or v_number not between -2147483648 and 2147483647 then
        raise exception 'quick_entry_invalid_integer'; end if;
      v_expected_system := v_number::integer;
    end if;
    v_expected_tier := nullif(btrim(v_item->>'expected_tier_id'),'')::uuid;
    v_confirm := coalesce(nullif(btrim(v_item->>'manual_price_confirmed'),'')::boolean,false);
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'product_id',v_product_id,'raw_weight_g',v_weight,'fish_date',v_fish_date::text,
      'manual_base_price',v_manual,'manual_price_confirmed',v_confirm,
      'expected_tier_id',v_expected_tier,'expected_system_base_price',v_expected_system));
  end loop;
  return v_items;
end; $$;

create or replace function public.admin_create_weighted_stock_batch(
  p_submission_id uuid,p_items jsonb,p_expected_freshness_version integer,
  p_source text default null,p_note text default null)
returns public.phase2_stock_batches language plpgsql security definer set search_path = public, pg_temp as $$
declare v_batch public.phase2_stock_batches; v_hash text; v_items jsonb; v_source text := nullif(btrim(p_source),'');
        v_note text := nullif(btrim(p_note),''); v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
        v_policy public.phase2_freshness_policy; v_item jsonb; v_stock public.phase2_weighted_stock;
        v_number integer; v_line_no integer := 0; v_fish_date date; v_product_id uuid; v_weight integer;
        v_expected_tier uuid; v_expected_system integer; v_manual integer; v_confirm boolean;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_submission_id is null then raise exception 'quick_entry_submission_required'; end if;
  v_items := public.phase2_normalize_weighted_batch_items(p_items);
  v_hash := md5(jsonb_build_object('items',v_items,'freshness_version',p_expected_freshness_version,
    'source',v_source,'note',v_note)::text);
  select * into v_batch from public.phase2_stock_batches where submission_id=p_submission_id for update;
  if found then
    if v_batch.payload_hash <> v_hash then raise exception 'quick_entry_idempotency_conflict'; end if;
    return v_batch;
  end if;
  insert into public.phase2_stock_batches(submission_id,payload_hash,batch_date,name,source,note,actor_id)
  values(p_submission_id,v_hash,v_today,'pending',v_source,v_note,auth.uid())
  on conflict (submission_id) do nothing returning * into v_batch;
  if not found then
    select * into v_batch from public.phase2_stock_batches where submission_id=p_submission_id for update;
    if v_batch.payload_hash <> v_hash then raise exception 'quick_entry_idempotency_conflict'; end if;
    return v_batch;
  end if;
  select * into v_policy from public.phase2_freshness_policy where id=1 for share;
  if not found or p_expected_freshness_version is distinct from v_policy.version then
    raise exception 'quick_entry_freshness_conflict'; end if;
  insert into public.phase2_stock_batch_daily_counters(batch_date,latest_number)
  values(v_today,1) on conflict (batch_date) do update
  set latest_number=public.phase2_stock_batch_daily_counters.latest_number+1
  returning latest_number into v_number;
  update public.phase2_stock_batches set sequence_no=v_number,
    name=to_char(v_today,'YYYY/MM/DD')||' '||coalesce(v_source||' ','')||'魚貨 #'||v_number
  where id=v_batch.id returning * into v_batch;
  for v_item in select value from jsonb_array_elements(v_items) loop
    v_line_no := v_line_no+1;
    if jsonb_typeof(v_item) <> 'object' then raise exception 'quick_entry_invalid_item'; end if;
    v_product_id := (v_item->>'product_id')::uuid;
    v_weight := (v_item->>'raw_weight_g')::integer;
    v_fish_date := (v_item->>'fish_date')::date;
    v_manual := nullif(v_item->>'manual_base_price','')::integer;
    v_confirm := coalesce((v_item->>'manual_price_confirmed')::boolean,false);
    v_expected_tier := nullif(v_item->>'expected_tier_id','')::uuid;
    v_expected_system := nullif(v_item->>'expected_system_base_price','')::integer;
    if v_fish_date is null or v_fish_date>v_today then raise exception 'weighted_stock_future_fish_date'; end if;
    if v_today-v_fish_date>v_policy.max_sale_day or not exists
      (select 1 from public.phase2_freshness_days where day_offset=v_today-v_fish_date) then
      raise exception 'weighted_stock_freshness_not_sellable'; end if;
    insert into public.phase2_weighted_stock(product_id,fish_date,raw_weight_g,
      batch_reference,batch_id,batch_line_no,manual_base_price,manual_price_confirmed)
    values(v_product_id,v_fish_date,v_weight,v_batch.name,v_batch.id,v_line_no,v_manual,v_confirm)
    returning * into v_stock;
    if v_stock.pricing_tier_id is distinct from v_expected_tier
       or v_stock.system_base_price is distinct from v_expected_system then
      raise exception 'quick_entry_price_changed'; end if;
  end loop;
  update public.phase2_stock_batches set stock_count=jsonb_array_length(v_items)
    where id=v_batch.id returning * into v_batch;
  return v_batch;
end; $$;

create or replace function public.admin_link_weighted_stock_photo(p_stock_id uuid,p_storage_path text)
returns public.phase2_stock_photos language plpgsql security definer set search_path = public, pg_temp as $$
declare v_photo public.phase2_stock_photos;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_storage_path !~ ('^weighted-stock/'||p_stock_id::text||'/[0-9a-f-]{36}[.]webp$') then
    raise exception 'weighted_stock_photo_path_invalid'; end if;
  perform 1 from public.phase2_weighted_stock where id=p_stock_id for update;
  if not found then raise exception 'weighted_stock_not_found'; end if;
  if not exists(select 1 from storage.objects where bucket_id='product-images' and name=p_storage_path) then
    raise exception 'weighted_stock_photo_object_missing'; end if;
  insert into public.phase2_stock_photos(stock_id,storage_path,actor_id)
  values(p_stock_id,p_storage_path,auth.uid())
  on conflict (stock_id) do nothing returning * into v_photo;
  if not found then
    select * into v_photo from public.phase2_stock_photos where stock_id=p_stock_id;
    if v_photo.storage_path <> p_storage_path then raise exception 'weighted_stock_photo_already_linked'; end if;
  end if;
  return v_photo;
end; $$;

alter table public.phase2_stock_batch_daily_counters enable row level security;
alter table public.phase2_stock_batches enable row level security;
alter table public.phase2_stock_photos enable row level security;
create policy phase2_admin_batches_read on public.phase2_stock_batches for select to authenticated
  using ((select public.is_hanjiu_admin()));
create policy phase2_admin_stock_photos_read on public.phase2_stock_photos for select to authenticated
  using ((select public.is_hanjiu_admin()));
revoke all on public.phase2_stock_batch_daily_counters,public.phase2_stock_batches,
  public.phase2_stock_photos from public,anon,authenticated;
grant select on public.phase2_stock_batches,public.phase2_stock_photos to authenticated;
revoke all on function public.phase2_guard_weighted_product_settings(),
  public.phase2_audit_weighted_product_settings(),
  public.phase2_normalize_weighted_batch_items(jsonb) from public,anon,authenticated;
revoke all on function public.admin_update_weighted_product_settings(uuid,timestamptz,text,integer,integer,text),
  public.admin_save_weight_pricing_tier(uuid,integer,integer,integer,integer,boolean,text,uuid,timestamptz),
  public.admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text),
  public.admin_link_weighted_stock_photo(uuid,text) from public,anon,authenticated;
grant execute on function public.admin_update_weighted_product_settings(uuid,timestamptz,text,integer,integer,text),
  public.admin_save_weight_pricing_tier(uuid,integer,integer,integer,integer,boolean,text,uuid,timestamptz),
  public.admin_create_weighted_stock_batch(uuid,jsonb,integer,text,text),
  public.admin_link_weighted_stock_photo(uuid,text) to authenticated;

commit;

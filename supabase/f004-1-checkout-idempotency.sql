-- F004-1: checkout idempotency. Run once after the currently approved F003 migrations.
-- Historical orders intentionally retain NULL checkout idempotency metadata.
begin;

alter table public.orders
  add column if not exists checkout_idempotency_key uuid,
  add column if not exists checkout_request_fingerprint text;

alter table public.orders
  drop constraint if exists orders_checkout_request_fingerprint_check;
alter table public.orders
  add constraint orders_checkout_request_fingerprint_check
  check (checkout_request_fingerprint is null or checkout_request_fingerprint ~ '^[0-9a-f]{32}$');

create unique index if not exists orders_checkout_idempotency_key_unique_idx
  on public.orders(checkout_idempotency_key)
  where checkout_idempotency_key is not null;

comment on column public.orders.checkout_idempotency_key is
  'Client-generated UUID used only to make one public checkout submission idempotent.';
comment on column public.orders.checkout_request_fingerprint is
  'Server-generated MD5 of the canonical checkout payload for idempotency conflict detection.';

create or replace function public.create_checkout_order(
  p_customer_name text,
  p_phone text,
  p_fulfillment text,
  p_note text,
  p_items jsonb,
  p_email text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order_id uuid;
  v_customer_id uuid;
  v_existing_order record;
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_customer_name text := nullif(left(btrim(coalesce(p_customer_name, '')), 100), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_item jsonb;
  v_variant record;
  v_variant_id uuid;
  v_quantity integer;
  v_preset_id text;
  v_preset_name text;
  v_option_ids text[];
  v_option_names text[];
  v_expected_count integer;
  v_processing_note text;
  v_canonical_items jsonb := '[]'::jsonb;
  v_seen_variant_ids uuid[] := '{}'::uuid[];
  v_fingerprint text;
begin
  if p_idempotency_key is null then raise exception 'checkout_idempotency_key_required'; end if;
  if v_customer_name is null then raise exception 'customer_name_required'; end if;
  if v_phone = '' then raise exception 'phone_required'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then raise exception 'invalid_email'; end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;

  -- Canonicalize every business input before touching customers, orders, or inventory.
  -- Array order, option order, blank strings, phone punctuation, and email case do not
  -- change the payload identity. Duplicate variants are rejected rather than deducted twice.
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'variant_id')::uuid loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'invalid_checkout_item'; end if;
    if jsonb_typeof(coalesce(v_item->'processing_option_ids', '[]'::jsonb)) <> 'array' then raise exception 'invalid_processing_options'; end if;
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(btrim(coalesce(v_item->>'processing_preset_id', '')), '');
    v_processing_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}')
      into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    if v_quantity is null or v_quantity < 1 then raise exception 'invalid_quantity'; end if;
    if v_variant_id = any(v_seen_variant_ids) then raise exception 'duplicate_variant_item'; end if;
    v_seen_variant_ids := array_append(v_seen_variant_ids, v_variant_id);
    v_canonical_items := v_canonical_items || jsonb_build_array(jsonb_build_object(
      'variant_id', v_variant_id::text,
      'quantity', v_quantity,
      'processing_preset_id', v_preset_id,
      'processing_option_ids', to_jsonb(v_option_ids),
      'processing_note', v_processing_note
    ));
  end loop;

  v_fingerprint := md5(jsonb_build_object(
    'customer_name', v_customer_name,
    'phone', v_phone,
    'email', v_email,
    'fulfillment', p_fulfillment,
    'note', v_note,
    'items', v_canonical_items
  )::text);

  select id, checkout_request_fingerprint into v_existing_order
  from public.orders
  where checkout_idempotency_key = p_idempotency_key;
  if found then
    if v_existing_order.checkout_request_fingerprint is distinct from v_fingerprint then
      raise exception 'checkout_idempotency_conflict';
    end if;
    return v_existing_order.id;
  end if;

  v_customer_id := public.find_or_create_customer(v_customer_name, v_phone, v_email, null);

  -- The partial unique index serializes concurrent requests with the same key. This
  -- nested exception block is deliberately before any inventory mutation.
  begin
    insert into public.orders (
      customer_id, customer_name, phone, email, line_id, fulfillment, processing, note,
      checkout_idempotency_key, checkout_request_fingerprint
    ) values (
      v_customer_id, v_customer_name, v_phone, v_email, null, p_fulfillment, '依品項', v_note,
      p_idempotency_key, v_fingerprint
    ) returning id into v_order_id;
  exception when unique_violation then
    select id, checkout_request_fingerprint into v_existing_order
    from public.orders
    where checkout_idempotency_key = p_idempotency_key;
    if not found then raise; end if;
    if v_existing_order.checkout_request_fingerprint is distinct from v_fingerprint then
      raise exception 'checkout_idempotency_conflict';
    end if;
    return v_existing_order.id;
  end;

  perform set_config('app.inventory_movement_type', 'checkout_sale', true);
  perform set_config('app.inventory_movement_order_id', v_order_id::text, true);
  for v_item in select value from jsonb_array_elements(p_items) order by (value->>'variant_id')::uuid loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;
    v_preset_id := nullif(btrim(coalesce(v_item->>'processing_preset_id', '')), '');
    v_processing_note := nullif(left(btrim(coalesce(v_item->>'processing_note', '')), 500), '');
    select coalesce(array_agg(distinct value order by value), '{}')
      into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids', '[]'::jsonb));
    select variant.id as variant_id, variant.product_id, product.name as product_name,
      product.processing_enabled, product.status as product_status, variant.name as variant_name,
      variant.price, variant.active
      into v_variant
      from public.product_variants variant
      join public.products product on product.id = variant.product_id
      where variant.id = v_variant_id;
    if not found or not v_variant.active or v_variant.product_status <> 'available' then raise exception 'variant_unavailable'; end if;
    if not v_variant.processing_enabled then
      v_preset_id := 'none'; v_preset_name := '不處理'; v_option_ids := '{}'; v_option_names := '{}'; v_processing_note := null;
    else
      if v_preset_id is not null then
        select preset.name into v_preset_name
        from public.product_processing_presets config
        join public.processing_presets preset on preset.id = config.preset_id
        where config.product_id = v_variant.product_id and config.preset_id = v_preset_id and config.active and preset.active;
        if not found then raise exception 'processing_updated'; end if;
      end if;
      select count(*), coalesce(array_agg(option_catalog.name order by option_config.sort_order), '{}')
        into v_expected_count, v_option_names
        from unnest(v_option_ids) selected_id
        join public.product_processing_options option_config on option_config.product_id = v_variant.product_id and option_config.processing_option_id = selected_id and option_config.active
        join public.processing_options option_catalog on option_catalog.id = option_config.processing_option_id and option_catalog.active;
      if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;
      if v_preset_id is not null and not exists (
        select 1 from (
          select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids
          from public.processing_preset_options where preset_id = v_preset_id
        ) preset_options where preset_options.ids = v_option_ids
      ) then v_preset_name := '客製化處理'; end if;
      if v_preset_id is null then v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end; end if;
    end if;
    update public.product_variants variant
      set inventory = variant.inventory - v_quantity
      from public.products product
      where variant.id = v_variant_id
        and product.id = variant.product_id
        and product.status = 'available'
        and variant.active
        and variant.inventory >= v_quantity
      returning variant.id as variant_id, variant.product_id, product.name as product_name,
        product.processing_enabled, variant.name as variant_name, variant.price, variant.active
      into v_variant;
    if not found then raise exception 'variant_unavailable'; end if;
    insert into public.order_items (
      order_id, product_id, product_name, variant_id, variant_name, price, quantity,
      processing_preset_id, processing_preset_name, processing_option_ids,
      processing_option_names, processing_note
    ) values (
      v_order_id, v_variant.product_id, v_variant.product_name, v_variant.variant_id,
      v_variant.variant_name, v_variant.price, v_quantity, v_preset_id, v_preset_name,
      v_option_ids, v_option_names, v_processing_note
    );
  end loop;
  return v_order_id;
end;
$$;

-- Temporary compatibility overloads keep currently deployed six/five-argument
-- storefront callers working during rollout. They generate a fresh key per call,
-- so only the new seven-argument caller supplies retry-safe idempotency.
create or replace function public.create_checkout_order(
  p_customer_name text, p_phone text, p_fulfillment text, p_note text, p_items jsonb, p_email text
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.create_checkout_order(p_customer_name, p_phone, p_fulfillment, p_note, p_items, p_email, gen_random_uuid());
end;
$$;

create or replace function public.create_checkout_order(
  p_customer_name text, p_phone text, p_fulfillment text, p_note text, p_items jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.create_checkout_order(p_customer_name, p_phone, p_fulfillment, p_note, p_items, null::text, gen_random_uuid());
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public, anon, authenticated;
revoke insert on public.orders, public.order_items from anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text, uuid) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;

commit;

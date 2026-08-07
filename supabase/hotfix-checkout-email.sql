-- PR #8 hotfix: persist optional checkout Email on orders.
-- Run once after the current F002 and F003 migrations.

alter table public.orders
  add column if not exists email text null;

comment on column public.orders.email is
  'Optional customer contact Email supplied during checkout.';

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
  if v_email is not null and length(v_email) > 254 then raise exception 'invalid_email'; end if;
  -- The escaped dot requires a literal dot between the domain labels.
  if v_email is not null and v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then
    raise exception 'invalid_fulfillment';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'items_required'; end if;

  insert into public.orders (customer_name, phone, email, line_id, fulfillment, processing, note)
  values (btrim(p_customer_name), btrim(p_phone), v_email, null, p_fulfillment, '依品項', nullif(p_note, ''))
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

-- Preserve the existing five-parameter API for older storefront/API callers.
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
begin
  return public.create_checkout_order(
    p_customer_name,
    p_phone,
    p_fulfillment,
    p_note,
    p_items,
    null::text
  );
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb, text) from public;
revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public;
revoke insert on table public.orders from anon, authenticated;
revoke insert on table public.order_items from anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb, text) to anon, authenticated;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;

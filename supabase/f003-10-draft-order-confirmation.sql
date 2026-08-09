-- F003-10: save and atomically confirm F003-9 fish-request order drafts.
-- Run once after F003-9. No table or column changes are required.

create or replace function public.admin_save_fish_request_order_draft_metadata(
  p_order_id uuid,
  p_fulfillment text,
  p_processing_preset_id text,
  p_processing_option_ids text[],
  p_processing_note text,
  p_note text
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_item record;
  v_item_count integer;
  v_fulfillment text := nullif(btrim(coalesce(p_fulfillment, '')), '');
  v_option_ids text[];
  v_option_names text[];
  v_preset_id text := nullif(btrim(coalesce(p_processing_preset_id, '')), '');
  v_preset_name text;
  v_expected_count integer;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_processing_note text := nullif(left(btrim(coalesce(p_processing_note, '')), 500), '');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  if v_fulfillment is not null and v_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then
    raise exception 'invalid_fulfillment';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status <> 'draft' then raise exception 'order_not_draft'; end if;

  select count(*) into v_item_count from public.order_items where order_id = v_order.id;
  if v_item_count <> 1 then raise exception 'invalid_draft_order'; end if;

  select item.id, item.product_id, product.processing_enabled
  into v_item
  from public.order_items item
  join public.products product on product.id = item.product_id
  where item.order_id = v_order.id
  for update of item, product;
  if not found then raise exception 'invalid_draft_order'; end if;

  select coalesce(array_agg(distinct option_id order by option_id), '{}')
  into v_option_ids
  from unnest(coalesce(p_processing_option_ids, '{}'::text[])) option_id;

  if not v_item.processing_enabled then
    v_preset_id := 'none';
    v_preset_name := '不處理';
    v_option_ids := '{}';
    v_option_names := '{}';
    v_processing_note := null;
  else
    if v_preset_id is not null then
      select preset.name into v_preset_name
      from public.product_processing_presets config
      join public.processing_presets preset on preset.id = config.preset_id
      where config.product_id = v_item.product_id and config.preset_id = v_preset_id
        and config.active and preset.active;
      if not found then raise exception 'processing_updated'; end if;
    end if;

    select count(*), coalesce(array_agg(option_catalog.name order by option_config.sort_order), '{}')
    into v_expected_count, v_option_names
    from unnest(v_option_ids) selected_id
    join public.product_processing_options option_config
      on option_config.product_id = v_item.product_id
      and option_config.processing_option_id = selected_id and option_config.active
    join public.processing_options option_catalog
      on option_catalog.id = option_config.processing_option_id and option_catalog.active;
    if v_expected_count <> cardinality(v_option_ids) then raise exception 'processing_updated'; end if;

    if v_preset_id is not null and not exists (
      select 1 from (
        select coalesce(array_agg(processing_option_id order by processing_option_id), '{}') ids
        from public.processing_preset_options where preset_id = v_preset_id
      ) preset_options where preset_options.ids = v_option_ids
    ) then
      v_preset_name := '客製化處理';
    end if;
    if v_preset_id is null then
      v_preset_name := case when cardinality(v_option_ids) = 0 then '不處理' else '客製化處理' end;
    end if;
  end if;

  update public.order_items
  set processing_preset_id = v_preset_id,
      processing_preset_name = v_preset_name,
      processing_option_ids = v_option_ids,
      processing_option_names = v_option_names,
      processing_note = v_processing_note
  where id = v_item.id;

  update public.orders
  set fulfillment = v_fulfillment,
      processing = '依品項',
      note = v_note
  where id = v_order.id
  returning * into v_order;

  return v_order;
end;
$$;

create or replace function public.admin_confirm_fish_request_order_draft(
  p_order_id uuid
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders;
  v_request public.fish_requests;
  v_item record;
  v_item_count integer;
  v_expected_count integer;
  v_variant record;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status <> 'draft' then raise exception 'order_not_draft'; end if;
  if v_order.fish_request_id is null then raise exception 'fish_request_relation_missing'; end if;
  if v_order.fulfillment is null or v_order.fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then
    raise exception 'invalid_fulfillment';
  end if;
  if v_order.processing <> '依品項' then raise exception 'processing_updated'; end if;

  select count(*) into v_item_count from public.order_items where order_id = v_order.id;
  if v_item_count <> 1 then raise exception 'invalid_draft_order'; end if;

  select item.*, product.processing_enabled, product.status as product_status
  into v_item
  from public.order_items item
  join public.products product on product.id = item.product_id
  where item.order_id = v_order.id
  for update of item, product;
  if not found or v_item.variant_id is null or v_item.quantity < 1 then
    raise exception 'invalid_draft_order';
  end if;

  select * into v_request
  from public.fish_requests
  where id = v_order.fish_request_id
  for update;
  if not found then raise exception 'fish_request_relation_missing'; end if;
  if v_request.status not in ('waiting', 'contacted') then
    raise exception 'fish_request_not_eligible';
  end if;

  if not v_item.processing_enabled then
    if v_item.processing_preset_id <> 'none'
      or coalesce(cardinality(v_item.processing_option_ids), 0) <> 0 then
      raise exception 'processing_updated';
    end if;
  else
    if v_item.processing_preset_id is not null and not exists (
      select 1
      from public.product_processing_presets config
      join public.processing_presets preset on preset.id = config.preset_id
      where config.product_id = v_item.product_id
        and config.preset_id = v_item.processing_preset_id
        and config.active and preset.active
    ) then
      raise exception 'processing_updated';
    end if;

    select count(*) into v_expected_count
    from unnest(coalesce(v_item.processing_option_ids, '{}'::text[])) selected_id
    join public.product_processing_options option_config
      on option_config.product_id = v_item.product_id
      and option_config.processing_option_id = selected_id and option_config.active
    join public.processing_options option_catalog
      on option_catalog.id = option_config.processing_option_id and option_catalog.active;
    if v_expected_count <> coalesce(cardinality(v_item.processing_option_ids), 0) then
      raise exception 'processing_updated';
    end if;
  end if;

  update public.product_variants variant
  set inventory = variant.inventory - v_item.quantity
  from public.products product
  where variant.id = v_item.variant_id
    and product.id = variant.product_id
    and product.status = 'available'
    and variant.active
    and variant.inventory >= v_item.quantity
  returning variant.id, variant.inventory into v_variant;
  if not found then raise exception 'variant_unavailable'; end if;

  update public.orders
  set status = 'new'
  where id = v_order.id and status = 'draft'
  returning * into v_order;
  if not found then raise exception 'order_not_draft'; end if;

  update public.fish_requests
  set status = 'converted'
  where id = v_request.id and status in ('waiting', 'contacted');
  if not found then raise exception 'fish_request_not_eligible'; end if;

  return v_order;
end;
$$;

revoke all on function public.admin_save_fish_request_order_draft_metadata(uuid, text, text, text[], text, text)
  from public, anon, authenticated;
revoke all on function public.admin_confirm_fish_request_order_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.admin_save_fish_request_order_draft_metadata(uuid, text, text, text[], text, text)
  to authenticated;
grant execute on function public.admin_confirm_fish_request_order_draft(uuid)
  to authenticated;

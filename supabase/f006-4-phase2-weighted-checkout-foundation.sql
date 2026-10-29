-- F006-4 / Phase 2 PR-C1: weighted checkout transaction foundation.
-- Forward-only after owner-applied F006-1, F006-2 and F006-3.
-- This migration does NOT grant the mixed checkout or expiry RPC to browser roles.
begin;

alter table public.orders
  add column weighted_hold_expires_at timestamptz,
  add column weighted_hold_released_at timestamptz;

alter table public.orders add constraint orders_weighted_hold_window_check check (
  weighted_hold_released_at is null or weighted_hold_expires_at is not null
);

alter table public.order_items
  add column weighted_stock_id uuid references public.phase2_weighted_stock(id) on delete restrict,
  add column weighted_stock_code text,
  add column weighted_raw_weight_g integer,
  add column weighted_t0_base_price integer,
  add column weighted_freshness_day integer,
  add column weighted_freshness_multiplier numeric(8,5),
  add column weighted_freshness_version integer;

alter table public.order_items add constraint order_items_weighted_snapshot_check check (
  (weighted_stock_id is null and weighted_stock_code is null and weighted_raw_weight_g is null
    and weighted_t0_base_price is null and weighted_freshness_day is null
    and weighted_freshness_multiplier is null and weighted_freshness_version is null)
  or
  (weighted_stock_id is not null and variant_id is null and quantity = 1 and supply_type = 'in_stock'
    and weighted_stock_code is not null and char_length(btrim(weighted_stock_code)) > 0
    and weighted_raw_weight_g > 0 and weighted_t0_base_price > 0
    and weighted_freshness_day >= 0 and weighted_freshness_multiplier > 0
    and weighted_freshness_version > 0 and price > 0)
);
create index order_items_weighted_stock_idx on public.order_items(weighted_stock_id)
  where weighted_stock_id is not null;
create index orders_weighted_hold_expiry_idx on public.orders(weighted_hold_expires_at)
  where weighted_hold_expires_at is not null and weighted_hold_released_at is null and payment_status = 'unpaid';

alter table public.phase2_weighted_stock_action_tokens
  add column old_order_id uuid,
  add column new_order_id uuid,
  add column old_order_item_id uuid,
  add column new_order_item_id uuid;

create or replace function public.phase2_guard_weighted_stock_update()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_action_authorized boolean := false;
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
     or new.batch_line_no is distinct from old.batch_line_no then
    raise exception 'weighted_stock_action_or_correction_required';
  end if;
  if new.status is distinct from old.status or new.order_id is distinct from old.order_id
     or new.order_item_id is distinct from old.order_item_id then
    select exists(select 1 from public.phase2_weighted_stock_action_tokens a
      where a.backend_pid=pg_backend_pid() and a.transaction_id=txid_current() and a.stock_id=old.id
        and a.old_status=old.status and a.new_status=new.status
        and a.old_order_id is not distinct from old.order_id and a.new_order_id is not distinct from new.order_id
        and a.old_order_item_id is not distinct from old.order_item_id
        and a.new_order_item_id is not distinct from new.order_item_id)
    into v_action_authorized;
    if not v_action_authorized then raise exception 'weighted_stock_action_or_correction_required'; end if;
  end if;
  if new.representative_image_id is not null and not exists
     (select 1 from public.product_images i where i.id=new.representative_image_id and i.product_id=new.product_id) then
    raise exception 'representative_image_product_mismatch';
  end if;
  new.version := old.version+1;
  new.updated_at := clock_timestamp();
  return new;
end; $$;

create or replace function public.phase2_transition_weighted_stock(
  p_stock_id uuid,p_old_status text,p_new_status text,
  p_old_order_id uuid,p_new_order_id uuid,p_old_order_item_id uuid,p_new_order_item_id uuid,
  p_action text,p_reason text,p_actor_id uuid default null)
returns public.phase2_weighted_stock language plpgsql security definer set search_path=public,pg_temp as $$
declare v_token uuid:=gen_random_uuid(); v_stock public.phase2_weighted_stock; v_reason text:=nullif(btrim(p_reason),'');
begin
  if v_reason is null then raise exception 'phase2_change_reason_required'; end if;
  insert into public.phase2_weighted_stock_action_tokens(
    token,backend_pid,transaction_id,stock_id,old_status,new_status,
    old_order_id,new_order_id,old_order_item_id,new_order_item_id)
  values(v_token,pg_backend_pid(),txid_current(),p_stock_id,p_old_status,p_new_status,
    p_old_order_id,p_new_order_id,p_old_order_item_id,p_new_order_item_id);
  update public.phase2_weighted_stock set status=p_new_status,order_id=p_new_order_id,order_item_id=p_new_order_item_id
  where id=p_stock_id and status=p_old_status
    and order_id is not distinct from p_old_order_id and order_item_id is not distinct from p_old_order_item_id
  returning * into v_stock;
  if not found then raise exception 'weighted_stock_transition_conflict'; end if;
  delete from public.phase2_weighted_stock_action_tokens where token=v_token;
  insert into public.phase2_audit_events(actor_id,action,entity_type,entity_id,old_value,new_value,reason)
  values(p_actor_id,p_action,'weighted_stock',p_stock_id,
    jsonb_build_object('status',p_old_status,'order_id',p_old_order_id,'order_item_id',p_old_order_item_id),
    jsonb_build_object('status',p_new_status,'order_id',p_new_order_id,'order_item_id',p_new_order_item_id),v_reason);
  return v_stock;
end; $$;

create or replace function public.phase2_enforce_weighted_order_item_snapshot()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.weighted_stock_id is distinct from old.weighted_stock_id
     or new.weighted_stock_code is distinct from old.weighted_stock_code
     or new.weighted_raw_weight_g is distinct from old.weighted_raw_weight_g
     or new.weighted_t0_base_price is distinct from old.weighted_t0_base_price
     or new.weighted_freshness_day is distinct from old.weighted_freshness_day
     or new.weighted_freshness_multiplier is distinct from old.weighted_freshness_multiplier
     or new.weighted_freshness_version is distinct from old.weighted_freshness_version then
    raise exception 'weighted_order_item_snapshot_immutable';
  end if;
  return new;
end; $$;
create trigger order_items_weighted_snapshot_guard before update on public.order_items
for each row execute function public.phase2_enforce_weighted_order_item_snapshot();

-- C1 foundation entry point. C2 may expose a reviewed wrapper later; browser roles
-- intentionally receive no EXECUTE grant in this migration.
create or replace function public.phase2_create_checkout_order(
  p_customer_name text,p_phone text,p_fulfillment text,p_note text,
  p_variant_items jsonb,p_weighted_items jsonb,p_email text,p_idempotency_key uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order_id uuid; v_customer_id uuid; v_existing record; v_internal_key uuid:=gen_random_uuid();
        v_phone text:=regexp_replace(coalesce(p_phone,''),'[^0-9]','','g');
        v_name text:=nullif(left(btrim(coalesce(p_customer_name,'')),100),'');
        v_email text:=nullif(lower(btrim(coalesce(p_email,''))),'');
        v_note text:=nullif(btrim(coalesce(p_note,'')),'');
        v_item jsonb; v_stock public.phase2_weighted_stock; v_product record; v_order_item_id uuid;
        v_stock_id uuid; v_day integer; v_multiplier numeric; v_price integer; v_policy record;
        v_preset_id text; v_preset_name text; v_option_ids text[]; v_option_names text[];
        v_expected integer; v_processing_note text; v_seen uuid[]:='{}';
        v_canonical_variants jsonb:='[]'; v_canonical_weighted jsonb:='[]'; v_fingerprint text;
        v_today date:=(clock_timestamp() at time zone 'Asia/Taipei')::date;
begin
  if p_idempotency_key is null then raise exception 'checkout_idempotency_key_required'; end if;
  if v_name is null then raise exception 'customer_name_required'; end if;
  if v_phone !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  if v_email is not null and (length(v_email)>254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$') then raise exception 'invalid_email'; end if;
  if p_fulfillment not in ('永春市場自取','台北市配送','冷凍宅配','7-ELEVEN 冷凍交貨便') then raise exception 'invalid_fulfillment'; end if;
  if jsonb_typeof(p_variant_items) is distinct from 'array' or jsonb_typeof(p_weighted_items) is distinct from 'array'
     or jsonb_array_length(p_variant_items)+jsonb_array_length(p_weighted_items)=0 then raise exception 'items_required'; end if;

  -- Canonicalize the existing variant request contract for mixed-cart identity.
  for v_item in select value from jsonb_array_elements(p_variant_items) order by (value->>'variant_id')::uuid loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(coalesce(v_item->'processing_option_ids','[]'::jsonb)) is distinct from 'array' then raise exception 'invalid_checkout_item'; end if;
    select coalesce(array_agg(distinct value order by value),'{}') into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids','[]'::jsonb));
    if (v_item->>'quantity')::integer<1 then raise exception 'invalid_quantity'; end if;
    v_canonical_variants:=v_canonical_variants||jsonb_build_array(jsonb_build_object(
      'variant_id',(v_item->>'variant_id')::uuid::text,'quantity',(v_item->>'quantity')::integer,
      'processing_preset_id',nullif(btrim(coalesce(v_item->>'processing_preset_id','')),''),
      'processing_option_ids',to_jsonb(v_option_ids),
      'processing_note',nullif(left(btrim(coalesce(v_item->>'processing_note','')),500),'')));
  end loop;
  for v_item in select value from jsonb_array_elements(p_weighted_items) order by (value->>'weighted_stock_id')::uuid loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(coalesce(v_item->'processing_option_ids','[]'::jsonb)) is distinct from 'array' then raise exception 'invalid_weighted_checkout_item'; end if;
    v_stock_id:=(v_item->>'weighted_stock_id')::uuid;
    if v_stock_id=any(v_seen) then raise exception 'duplicate_weighted_stock_item'; end if;
    v_seen:=array_append(v_seen,v_stock_id);
    select coalesce(array_agg(distinct value order by value),'{}') into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids','[]'::jsonb));
    v_canonical_weighted:=v_canonical_weighted||jsonb_build_array(jsonb_build_object(
      'weighted_stock_id',v_stock_id::text,
      'processing_preset_id',nullif(btrim(coalesce(v_item->>'processing_preset_id','')),''),
      'processing_option_ids',to_jsonb(v_option_ids),
      'processing_note',nullif(left(btrim(coalesce(v_item->>'processing_note','')),500),'')));
  end loop;
  v_fingerprint:=md5(jsonb_build_object('customer_name',v_name,'phone',v_phone,'email',v_email,
    'fulfillment',p_fulfillment,'note',v_note,'variant_items',v_canonical_variants,
    'weighted_items',v_canonical_weighted)::text);

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text,0));
  select id,checkout_request_fingerprint into v_existing from public.orders where checkout_idempotency_key=p_idempotency_key;
  if found then
    if v_existing.checkout_request_fingerprint is distinct from v_fingerprint then raise exception 'checkout_idempotency_conflict'; end if;
    return v_existing.id;
  end if;

  if jsonb_array_length(p_variant_items)>0 then
    v_order_id:=public.create_checkout_order(v_name,v_phone,p_fulfillment,v_note,p_variant_items,v_email,v_internal_key);
    update public.orders set checkout_idempotency_key=p_idempotency_key,checkout_request_fingerprint=v_fingerprint,
      weighted_hold_expires_at=clock_timestamp()+interval '30 minutes'
    where id=v_order_id;
  else
    v_customer_id:=public.find_or_create_customer(v_name,v_phone,v_email,null);
    insert into public.orders(customer_id,customer_name,phone,email,line_id,fulfillment,processing,note,
      checkout_idempotency_key,checkout_request_fingerprint,weighted_hold_expires_at)
    values(v_customer_id,v_name,v_phone,v_email,null,p_fulfillment,'依品項',v_note,
      p_idempotency_key,v_fingerprint,clock_timestamp()+interval '30 minutes') returning id into v_order_id;
  end if;

  -- Match F006-3's stock-first lock order before taking product/policy locks.
  perform s.id from public.phase2_weighted_stock s
    join jsonb_array_elements(p_weighted_items) item on s.id=(item->>'weighted_stock_id')::uuid
    order by s.id for update of s;
  perform p.id from public.products p join public.phase2_weighted_stock s on s.product_id=p.id
    join jsonb_array_elements(p_weighted_items) item on s.id=(item->>'weighted_stock_id')::uuid
    order by p.id for share of p;
  select * into v_policy from public.phase2_freshness_policy where id=1 for share;
  if not found then raise exception 'weighted_stock_freshness_policy_missing'; end if;
  for v_item in select value from jsonb_array_elements(p_weighted_items) order by (value->>'weighted_stock_id')::uuid loop
    v_stock_id:=(v_item->>'weighted_stock_id')::uuid;
    select * into v_stock from public.phase2_weighted_stock where id=v_stock_id for update;
    if not found or v_stock.status<>'sellable' or v_stock.order_id is not null or v_stock.order_item_id is not null then raise exception 'weighted_stock_unavailable'; end if;
    select p.name,p.status,p.inventory_mode,p.processing_enabled into v_product from public.products p where p.id=v_stock.product_id for share;
    if not found or v_product.status<>'available' or v_product.inventory_mode is distinct from 'SINGLE_WEIGHTED' then raise exception 'weighted_stock_unavailable'; end if;
    v_day:=v_today-v_stock.fish_date;
    if v_day<0 or v_day>v_policy.max_sale_day then raise exception 'weighted_stock_freshness_expired'; end if;
    select multiplier into v_multiplier from public.phase2_freshness_days where day_offset=v_day for share;
    if not found then raise exception 'weighted_stock_freshness_day_missing'; end if;
    v_price:=round(v_stock.t0_base_price::numeric*v_multiplier)::integer;
    if v_price<=0 then raise exception 'weighted_stock_price_invalid'; end if;

    v_preset_id:=nullif(btrim(coalesce(v_item->>'processing_preset_id','')),'');
    v_processing_note:=nullif(left(btrim(coalesce(v_item->>'processing_note','')),500),'');
    select coalesce(array_agg(distinct value order by value),'{}') into v_option_ids
      from jsonb_array_elements_text(coalesce(v_item->'processing_option_ids','[]'::jsonb));
    if not v_product.processing_enabled then
      v_preset_id:='none';v_preset_name:='不處理';v_option_ids:='{}';v_option_names:='{}';v_processing_note:=null;
    else
      if v_preset_id is not null then
        select preset.name into v_preset_name from public.product_processing_presets config
        join public.processing_presets preset on preset.id=config.preset_id
        where config.product_id=v_stock.product_id and config.preset_id=v_preset_id and config.active and preset.active;
        if not found then raise exception 'processing_updated'; end if;
      end if;
      select count(*),coalesce(array_agg(c.name order by cfg.sort_order),'{}') into v_expected,v_option_names
      from unnest(v_option_ids) selected_id
      join public.product_processing_options cfg on cfg.product_id=v_stock.product_id and cfg.processing_option_id=selected_id and cfg.active
      join public.processing_options c on c.id=cfg.processing_option_id and c.active;
      if v_expected<>cardinality(v_option_ids) then raise exception 'processing_updated'; end if;
      if v_preset_id is null then v_preset_name:=case when cardinality(v_option_ids)=0 then '不處理' else '客製化處理' end; end if;
    end if;
    insert into public.order_items(order_id,product_id,product_name,variant_id,variant_name,price,quantity,supply_type,
      processing_preset_id,processing_preset_name,processing_option_ids,processing_option_names,processing_note,
      weighted_stock_id,weighted_stock_code,weighted_raw_weight_g,weighted_t0_base_price,
      weighted_freshness_day,weighted_freshness_multiplier,weighted_freshness_version)
    values(v_order_id,v_stock.product_id,v_product.name,null,v_stock.stock_code,v_price,1,'in_stock',
      v_preset_id,v_preset_name,v_option_ids,v_option_names,v_processing_note,
      v_stock.id,v_stock.stock_code,v_stock.raw_weight_g,v_stock.t0_base_price,v_day,v_multiplier,v_policy.version)
    returning id into v_order_item_id;
    perform public.phase2_transition_weighted_stock(v_stock.id,'sellable','reserved',null,v_order_id,null,v_order_item_id,
      'weighted_stock_reserved','checkout reservation',null);
  end loop;
  return v_order_id;
end; $$;

create or replace function public.phase2_finalize_weighted_hold_on_payment()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_stock public.phase2_weighted_stock;
begin
  if new.payment_status='paid' and old.payment_status is distinct from 'paid'
     and new.weighted_hold_expires_at is not null then
    if clock_timestamp()>=new.weighted_hold_expires_at or new.weighted_hold_released_at is not null then
      raise exception 'order_payment_hold_expired';
    end if;
    if exists(select 1 from public.order_items i where i.order_id=new.id and i.weighted_stock_id is not null
      and not exists(select 1 from public.phase2_weighted_stock s where s.id=i.weighted_stock_id
        and s.order_id=new.id and s.order_item_id=i.id and s.status='reserved')) then
      raise exception 'weighted_order_reservation_inconsistent';
    end if;
    for v_stock in select * from public.phase2_weighted_stock where order_id=new.id and status='reserved' order by id for update loop
      perform public.phase2_transition_weighted_stock(v_stock.id,'reserved','sold',new.id,new.id,
        v_stock.order_item_id,v_stock.order_item_id,'weighted_stock_sold','payment recorded',auth.uid());
    end loop;
    if not found then raise exception 'weighted_order_reservation_missing'; end if;
  end if;
  return new;
end; $$;
create trigger orders_finalize_weighted_hold_after_payment
after update of payment_status on public.orders for each row
execute function public.phase2_finalize_weighted_hold_on_payment();

-- Internal expiration worker primitive. It serializes on the order row, restores
-- every legacy in-stock deduction, and releases every weighted reservation in the
-- same transaction. C1 intentionally grants it to no browser role.
create or replace function public.phase2_release_expired_checkout_hold(p_order_id uuid,p_as_of timestamptz default clock_timestamp())
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_item record; v_stock public.phase2_weighted_stock; v_restored public.product_variants;
        v_deducted bigint; v_today date; v_policy record; v_multiplier numeric; v_next text;
begin
  if p_as_of is null then raise exception 'release_time_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.weighted_hold_expires_at is null then raise exception 'weighted_order_hold_missing'; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_hold_not_releasable'; end if;
  if v_order.weighted_hold_released_at is not null then return v_order; end if;
  if p_as_of<v_order.weighted_hold_expires_at then raise exception 'weighted_order_hold_not_expired'; end if;
  if v_order.status='cancelled' then raise exception 'weighted_order_cancelled_without_release_marker'; end if;
  if exists(select 1 from public.order_items i where i.order_id=v_order.id and i.weighted_stock_id is not null
    and not exists(select 1 from public.phase2_weighted_stock s where s.id=i.weighted_stock_id
      and s.order_id=v_order.id and s.order_item_id=i.id and s.status='reserved')) then
    raise exception 'weighted_order_reservation_inconsistent';
  end if;

  perform set_config('app.inventory_movement_type','order_cancel_restore',true);
  perform set_config('app.inventory_movement_order_id',v_order.id::text,true);
  perform set_config('app.inventory_movement_fish_request_id',coalesce(v_order.fish_request_id::text,''),true);
  for v_item in select variant_id,product_id,sum(quantity)::integer quantity from public.order_items
    where order_id=v_order.id and weighted_stock_id is null and supply_type='in_stock'
    group by variant_id,product_id order by variant_id,product_id loop
    if v_item.variant_id is null or v_item.product_id is null then raise exception 'order_item_variant_unrestorable'; end if;
    select coalesce(sum(-inventory_delta),0) into v_deducted from public.inventory_movements
      where order_id=v_order.id and variant_id=v_item.variant_id and product_id=v_item.product_id
        and movement_type in ('checkout_sale','fish_request_order_confirmation');
    if v_deducted<>v_item.quantity then raise exception 'order_inventory_provenance_missing'; end if;
    if exists(select 1 from public.inventory_movements where order_id=v_order.id and variant_id=v_item.variant_id
      and product_id=v_item.product_id and movement_type='order_cancel_restore') then raise exception 'order_already_restored'; end if;
    update public.product_variants set inventory=inventory+v_item.quantity
      where id=v_item.variant_id and product_id=v_item.product_id returning * into v_restored;
    if not found then raise exception 'order_item_variant_unrestorable'; end if;
  end loop;

  perform s.id from public.phase2_weighted_stock s where s.order_id=v_order.id and s.status='reserved'
    order by s.id for update of s;
  perform p.id from public.products p join public.phase2_weighted_stock s on s.product_id=p.id
    where s.order_id=v_order.id and s.status='reserved' order by p.id for share of p;
  select * into v_policy from public.phase2_freshness_policy where id=1 for share;
  if not found then raise exception 'weighted_stock_freshness_policy_missing'; end if;
  v_today:=(p_as_of at time zone 'Asia/Taipei')::date;
  for v_stock in select * from public.phase2_weighted_stock where order_id=v_order.id and status='reserved' order by id for update loop
    select d.multiplier into v_multiplier from public.phase2_freshness_days d
      join public.products p on p.id=v_stock.product_id
      where d.day_offset=v_today-v_stock.fish_date and p.status='available' and p.inventory_mode='SINGLE_WEIGHTED';
    v_next:=case when v_today-v_stock.fish_date between 0 and v_policy.max_sale_day
      and v_multiplier is not null and round(v_stock.t0_base_price::numeric*v_multiplier)>0 then 'sellable' else 'expired' end;
    perform public.phase2_transition_weighted_stock(v_stock.id,'reserved',v_next,v_order.id,null,v_stock.order_item_id,null,
      case when v_next='sellable' then 'weighted_stock_hold_released' else 'weighted_stock_expired_on_release' end,
      'payment hold expired',null);
  end loop;
  if not found then raise exception 'weighted_order_reservation_missing'; end if;
  perform set_config('app.order_cancellation_authorized','true',true);
  update public.orders set status='cancelled',weighted_hold_released_at=p_as_of
    where id=v_order.id and payment_status='unpaid' and weighted_hold_released_at is null returning * into v_order;
  if not found then raise exception 'weighted_order_release_conflict'; end if;
  return v_order;
end; $$;

-- Existing admin cancellation semantics are preserved for legacy items; weighted
-- reservations are released atomically instead of being mistaken for variant rows.
create or replace function public.admin_cancel_order(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_item record; v_stock public.phase2_weighted_stock;
        v_restored public.product_variants; v_deducted_quantity bigint; v_policy record;
        v_today date:=(clock_timestamp() at time zone 'Asia/Taipei')::date; v_multiplier numeric; v_next text;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status='draft' then raise exception 'order_not_cancellable_draft'; end if;
  if v_order.status='cancelled' then raise exception 'order_already_cancelled'; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_requires_payment_reversal'; end if;
  if exists(select 1 from public.order_payments p where p.order_id=v_order.id and not exists
    (select 1 from public.order_payment_reversals r where r.payment_id=p.id)) then raise exception 'active_payment_requires_reversal'; end if;
  if v_order.status not in ('new','processing','ready','completed','contacted','confirmed','paid','shipped') then raise exception 'order_not_cancellable'; end if;
  if not exists(select 1 from public.order_items where order_id=v_order.id) then raise exception 'order_items_missing'; end if;
  if exists(select 1 from public.order_items i where i.order_id=v_order.id and i.weighted_stock_id is not null
    and not exists(select 1 from public.phase2_weighted_stock s where s.id=i.weighted_stock_id
      and s.order_id=v_order.id and s.order_item_id=i.id and s.status in ('reserved','sold'))) then
    raise exception 'weighted_order_reservation_inconsistent';
  end if;
  perform set_config('app.inventory_movement_type','order_cancel_restore',true);
  perform set_config('app.inventory_movement_order_id',v_order.id::text,true);
  perform set_config('app.inventory_movement_fish_request_id',coalesce(v_order.fish_request_id::text,''),true);
  for v_item in select variant_id,product_id,sum(quantity)::integer quantity from public.order_items
    where order_id=v_order.id and weighted_stock_id is null and supply_type='in_stock'
    group by variant_id,product_id order by variant_id nulls first,product_id nulls first loop
    if v_item.variant_id is null or v_item.product_id is null or v_item.quantity<1 then raise exception 'order_item_variant_unrestorable'; end if;
    select coalesce(sum(-inventory_delta),0) into v_deducted_quantity from public.inventory_movements
      where order_id=v_order.id and variant_id=v_item.variant_id and product_id=v_item.product_id
        and movement_type in ('checkout_sale','fish_request_order_confirmation');
    if v_deducted_quantity<>v_item.quantity then raise exception 'order_inventory_provenance_missing'; end if;
    if exists(select 1 from public.inventory_movements where order_id=v_order.id and variant_id=v_item.variant_id
      and product_id=v_item.product_id and movement_type='order_cancel_restore') then raise exception 'order_already_restored'; end if;
    update public.product_variants set inventory=inventory+v_item.quantity
      where id=v_item.variant_id and product_id=v_item.product_id returning * into v_restored;
    if not found then raise exception 'order_item_variant_unrestorable'; end if;
  end loop;
  if exists(select 1 from public.phase2_weighted_stock where order_id=v_order.id and status in ('reserved','sold')) then
    perform s.id from public.phase2_weighted_stock s where s.order_id=v_order.id and s.status in ('reserved','sold')
      order by s.id for update of s;
    perform p.id from public.products p join public.phase2_weighted_stock s on s.product_id=p.id
      where s.order_id=v_order.id and s.status in ('reserved','sold') order by p.id for share of p;
    select * into v_policy from public.phase2_freshness_policy where id=1 for share;
    for v_stock in select * from public.phase2_weighted_stock where order_id=v_order.id and status in ('reserved','sold') order by id for update loop
      select d.multiplier into v_multiplier from public.phase2_freshness_days d join public.products p on p.id=v_stock.product_id
        where d.day_offset=v_today-v_stock.fish_date and p.status='available' and p.inventory_mode='SINGLE_WEIGHTED';
      v_next:=case when v_today-v_stock.fish_date between 0 and v_policy.max_sale_day and v_multiplier is not null
        and round(v_stock.t0_base_price::numeric*v_multiplier)>0 then 'sellable' else 'expired' end;
      perform public.phase2_transition_weighted_stock(v_stock.id,v_stock.status,v_next,v_order.id,null,v_stock.order_item_id,null,
        case when v_next='sellable' then 'weighted_stock_cancel_released' else 'weighted_stock_expired_on_cancel' end,'order cancelled',auth.uid());
    end loop;
  end if;
  perform set_config('app.order_cancellation_authorized','true',true);
  update public.orders set status='cancelled',weighted_hold_released_at=case when weighted_hold_expires_at is null then weighted_hold_released_at else clock_timestamp() end
    where id=v_order.id and status<>'cancelled' returning * into v_order;
  if not found then raise exception 'order_already_cancelled'; end if;
  return v_order;
end; $$;

revoke all on function public.phase2_transition_weighted_stock(uuid,text,text,uuid,uuid,uuid,uuid,text,text,uuid),
  public.phase2_enforce_weighted_order_item_snapshot(),
  public.phase2_create_checkout_order(text,text,text,text,jsonb,jsonb,text,uuid),
  public.phase2_finalize_weighted_hold_on_payment(),
  public.phase2_release_expired_checkout_hold(uuid,timestamptz)
from public,anon,authenticated;
revoke insert,update,delete on public.order_items from anon,authenticated;
revoke update (weighted_hold_expires_at,weighted_hold_released_at) on public.orders from anon,authenticated;
-- Preserve the existing admin cancellation grant; no new public checkout grant.
revoke all on function public.admin_cancel_order(uuid) from public,anon,authenticated;
grant execute on function public.admin_cancel_order(uuid) to authenticated;

commit;

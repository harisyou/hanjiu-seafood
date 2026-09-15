-- Phase 2 PR-A foundation. Review and run ONCE after F005-1a; never from the app.
-- This file creates new facts only. No legacy transaction, checkout or ledger rows are changed.
begin;

-- NULL means legacy product behaviour. No fabricated mode is assigned to existing products.
alter table public.products add column inventory_mode text;
alter table public.products add constraint products_inventory_mode_check
  check (inventory_mode is null or inventory_mode in ('SINGLE_WEIGHTED','QUANTITY_VARIANT'));
comment on column public.products.inventory_mode is 'NULL = legacy variant checkout; Phase 2 mode is opt-in and does not alter historical orders.';

create or replace function public.phase2_guard_inventory_mode()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.inventory_mode is not distinct from old.inventory_mode then return new; end if;
  if current_user in ('anon','authenticated') then raise exception 'inventory_mode_action_required'; end if;
  -- Stock rows cannot be orphaned into another mode. Future action RPCs must reconcile them first.
  if exists (select 1 from public.phase2_weighted_stock s where s.product_id = old.id
             and s.status in ('sellable','reserved')) then
    raise exception 'inventory_mode_active_weighted_stock';
  end if;
  if exists (select 1 from public.product_variants v where v.product_id = old.id
             and v.active and v.inventory > 0) then
    raise exception 'inventory_mode_active_variant_stock';
  end if;
  if exists (select 1 from public.order_items i join public.orders o on o.id = i.order_id
             where i.product_id = old.id and i.supply_type = 'in_stock'
               and o.status not in ('cancelled','completed')) then
    raise exception 'inventory_mode_open_stock_order';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end; $$;

-- Tier ranges are half-open: [lower_bound_g, upper_bound_g). Gaps are allowed.
create table public.phase2_weight_pricing_tiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  lower_bound_g integer not null check (lower_bound_g > 0),
  upper_bound_g integer not null check (upper_bound_g > lower_bound_g),
  price_per_jin integer not null check (price_per_jin > 0),
  sort_order integer not null default 0,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index phase2_tier_product_bounds_idx on public.phase2_weight_pricing_tiers(product_id, lower_bound_g, upper_bound_g);

create or replace function public.phase2_guard_tier_overlap()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  -- Serialize concurrent tier edits for the same product without a new extension.
  if tg_op = 'UPDATE' and new.product_id is distinct from old.product_id then
    raise exception 'weight_pricing_tier_product_immutable';
  end if;
  perform 1 from public.products where id = new.product_id for update;
  if not found then raise exception 'product_not_found'; end if;
  -- Disabled tiers are retained history, not effective price intervals. Turning
  -- one back on runs this same check against every other enabled interval.
  if new.enabled then
    if exists (select 1 from public.phase2_weight_pricing_tiers t
               where t.product_id = new.product_id and t.id <> new.id and t.enabled
                 and t.lower_bound_g < new.upper_bound_g and new.lower_bound_g < t.upper_bound_g) then
      raise exception 'weight_pricing_tier_overlap';
    end if;
  end if;
  if tg_op = 'UPDATE' then new.updated_at := clock_timestamp(); end if;
  return new;
end; $$;
create trigger phase2_tier_overlap before insert or update on public.phase2_weight_pricing_tiers
  for each row execute function public.phase2_guard_tier_overlap();

-- One global live policy. Percentages are stored as 0..1 multipliers, NOT stock snapshots.
create table public.phase2_freshness_policy (
  id smallint primary key check (id = 1),
  max_sale_day integer not null check (max_sale_day >= 0 and max_sale_day <= 30),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
create table public.phase2_freshness_days (
  day_offset integer primary key check (day_offset >= 0 and day_offset <= 30),
  multiplier numeric(7,4) not null check (multiplier > 0 and multiplier <= 1),
  updated_at timestamptz not null default now()
);
insert into public.phase2_freshness_policy(id,max_sale_day) values (1,2);
insert into public.phase2_freshness_days(day_offset,multiplier) values (0,1),(1,0.95),(2,0.90);

create or replace function public.phase2_touch_freshness_configuration()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'phase2_freshness_policy' then new.version := old.version + 1; end if;
  new.updated_at := clock_timestamp();
  return new;
end; $$;
create trigger phase2_policy_touch before update on public.phase2_freshness_policy
  for each row execute function public.phase2_touch_freshness_configuration();
create trigger phase2_day_touch before update on public.phase2_freshness_days
  for each row execute function public.phase2_touch_freshness_configuration();

-- Existing F003 inventory_movements remains the quantity-variant history ledger.
-- This new stock table is a different physical-unit model, not a backfill of variants.
create sequence public.phase2_stock_code_seq;
create table public.phase2_weighted_stock (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  stock_code text not null unique,
  fish_date date not null,
  batch_reference text check (batch_reference is null or char_length(btrim(batch_reference)) between 1 and 120),
  raw_weight_g integer not null check (raw_weight_g > 0),
  status text not null default 'sellable' check (status in (
    'sellable','reserved','sold','manually_unlisted','externally_sold','expired','unavailable','needs_manual_review')),
  representative_image_id uuid references public.product_images(id) on delete set null,
  order_id uuid references public.orders(id) on delete restrict,
  order_item_id uuid unique references public.order_items(id) on delete restrict,
  pricing_tier_id uuid not null references public.phase2_weight_pricing_tiers(id) on delete restrict,
  price_per_jin_snapshot integer not null check (price_per_jin_snapshot > 0),
  system_base_price integer not null check (system_base_price > 0),
  manual_base_price integer check (manual_base_price is null or manual_base_price > 0),
  t0_base_price integer not null check (t0_base_price > 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (t0_base_price = coalesce(manual_base_price,system_base_price)),
  check (order_item_id is null or order_id is not null)
);
create index phase2_stock_product_status_idx on public.phase2_weighted_stock(product_id,status,fish_date);
create index phase2_stock_order_idx on public.phase2_weighted_stock(order_id) where order_id is not null;

create or replace function public.phase2_initialize_weighted_stock()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_tier public.phase2_weight_pricing_tiers; v_mode text;
begin
  select inventory_mode into v_mode from public.products where id = new.product_id for update;
  if v_mode is distinct from 'SINGLE_WEIGHTED' then raise exception 'weighted_inventory_mode_required'; end if;
  if new.raw_weight_g is null or new.raw_weight_g <= 0 then raise exception 'invalid_raw_weight_g'; end if;
  if new.manual_base_price is not null and new.manual_base_price <= 0 then raise exception 'invalid_manual_base_price'; end if;
  if new.stock_code is not null then raise exception 'stock_code_server_generated'; end if;
  if new.status <> 'sellable' or new.order_id is not null or new.order_item_id is not null then
    raise exception 'weighted_stock_initial_state_required';
  end if;
  if new.representative_image_id is not null and not exists
     (select 1 from public.product_images i where i.id = new.representative_image_id and i.product_id = new.product_id) then
    raise exception 'representative_image_product_mismatch';
  end if;
  select * into v_tier from public.phase2_weight_pricing_tiers t
  where t.product_id = new.product_id and t.enabled
    and new.raw_weight_g >= t.lower_bound_g and new.raw_weight_g < t.upper_bound_g;
  if not found then raise exception 'weight_pricing_tier_not_found'; end if;
  new.stock_code := 'F-' || to_char(new.fish_date,'YYMMDD') || '-' || lpad(nextval('public.phase2_stock_code_seq')::text,8,'0');
  new.pricing_tier_id := v_tier.id;
  new.price_per_jin_snapshot := v_tier.price_per_jin;
  -- numeric round() is half-away-from-zero. All inputs are positive, matching TS Math.round().
  new.system_base_price := round(new.raw_weight_g::numeric * v_tier.price_per_jin / 600)::integer;
  if new.system_base_price <= 0 then raise exception 'computed_base_price_too_small'; end if;
  new.t0_base_price := coalesce(new.manual_base_price,new.system_base_price);
  new.version := 1;
  return new;
end; $$;
create trigger phase2_stock_initialize before insert on public.phase2_weighted_stock
  for each row execute function public.phase2_initialize_weighted_stock();

create or replace function public.phase2_guard_weighted_stock_update()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.product_id is distinct from old.product_id or new.stock_code is distinct from old.stock_code
     or new.fish_date is distinct from old.fish_date or new.raw_weight_g is distinct from old.raw_weight_g
     or new.pricing_tier_id is distinct from old.pricing_tier_id
     or new.price_per_jin_snapshot is distinct from old.price_per_jin_snapshot
     or new.system_base_price is distinct from old.system_base_price
     or new.manual_base_price is distinct from old.manual_base_price
     or new.t0_base_price is distinct from old.t0_base_price
     or new.status is distinct from old.status or new.order_id is distinct from old.order_id
     or new.order_item_id is distinct from old.order_item_id then
    raise exception 'weighted_stock_action_or_correction_required';
  end if;
  if new.representative_image_id is not null and not exists
     (select 1 from public.product_images i where i.id = new.representative_image_id and i.product_id = new.product_id) then
    raise exception 'representative_image_product_mismatch';
  end if;
  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  return new;
end; $$;
create trigger phase2_stock_update_guard before update on public.phase2_weighted_stock
  for each row execute function public.phase2_guard_weighted_stock_update();
create or replace function public.phase2_no_foundation_delete()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'phase2_foundation_delete_not_allowed'; end; $$;
create trigger phase2_stock_no_delete before delete on public.phase2_weighted_stock
  for each row execute function public.phase2_no_foundation_delete();
create trigger phase2_tier_no_delete before delete on public.phase2_weight_pricing_tiers
  for each row execute function public.phase2_no_foundation_delete();
create trigger phase2_policy_no_delete before delete on public.phase2_freshness_policy
  for each row execute function public.phase2_no_foundation_delete();
create trigger phase2_days_no_delete before delete on public.phase2_freshness_days
  for each row execute function public.phase2_no_foundation_delete();
create trigger phase2_inventory_mode_guard before update of inventory_mode on public.products
  for each row execute function public.phase2_guard_inventory_mode();

-- A generic immutable correction/action record, separate from transaction movement/payment facts.
create table public.phase2_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null check (char_length(btrim(action)) between 1 and 120),
  entity_type text not null check (char_length(btrim(entity_type)) between 1 and 120),
  entity_id uuid not null,
  old_value jsonb,
  new_value jsonb,
  reason text not null check (char_length(btrim(reason)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index phase2_audit_entity_idx on public.phase2_audit_events(entity_type,entity_id,created_at desc);
create or replace function public.phase2_audit_immutable()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'phase2_audit_append_only'; end; $$;
create trigger phase2_audit_no_update_delete before update or delete on public.phase2_audit_events
  for each row execute function public.phase2_audit_immutable();

-- Baseline stock creation is itself a permanent fact; later corrections append new events.
create or replace function public.phase2_audit_stock_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.phase2_audit_events(actor_id,action,entity_type,entity_id,old_value,new_value,reason)
  values(auth.uid(),'stock_created','weighted_stock',new.id,null,to_jsonb(new),'initial_stock_entry');
  return new;
end; $$;
create trigger phase2_stock_creation_audit after insert on public.phase2_weighted_stock
  for each row execute function public.phase2_audit_stock_insert();

-- Policy/tier corrections are distinct append-only records; the current mutable row
-- is not a history substitute. Later admin action RPCs must supply a nonblank reason.
create or replace function public.phase2_audit_foundation_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_reason text := nullif(btrim(current_setting('app.phase2_reason',true)),'');
        v_entity_id uuid; v_entity_type text; v_action text;
begin
  -- A freshness-day edit advances the global version internally; its day audit
  -- is the single business-change record, not a second policy-edit audit.
  if tg_table_name = 'phase2_freshness_policy'
     and current_setting('app.phase2_day_version_bump',true) = 'true' then
    return new;
  end if;
  if tg_table_name = 'phase2_freshness_days' and tg_op = 'UPDATE' then
    if new.day_offset = old.day_offset
       and new.multiplier is not distinct from old.multiplier then
      return new;
    end if;
  end if;
  if v_reason is null then raise exception 'phase2_change_reason_required'; end if;
  if tg_table_name = 'phase2_weight_pricing_tiers' then
    v_entity_id := new.id; v_entity_type := 'weight_pricing_tier'; v_action := 'pricing_tier_' || lower(tg_op);
  elsif tg_table_name = 'phase2_freshness_policy' then
    v_entity_id := '00000000-0000-4000-8000-000000000001'::uuid;
    v_entity_type := 'freshness_policy'; v_action := 'freshness_policy_' || lower(tg_op);
  else
    v_entity_id := ('00000000-0000-4000-8000-' || lpad(new.day_offset::text,12,'0'))::uuid;
    v_entity_type := 'freshness_day'; v_action := 'freshness_day_' || lower(tg_op);
  end if;
  insert into public.phase2_audit_events(actor_id,action,entity_type,entity_id,old_value,new_value,reason)
  values(auth.uid(),v_action,v_entity_type,v_entity_id,
         case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new),
         v_reason);
  return new;
end; $$;
create trigger phase2_tier_change_audit after insert or update on public.phase2_weight_pricing_tiers
  for each row execute function public.phase2_audit_foundation_change();
create trigger phase2_policy_change_audit after update on public.phase2_freshness_policy
  for each row execute function public.phase2_audit_foundation_change();
create trigger phase2_day_change_audit after insert or update on public.phase2_freshness_days
  for each row execute function public.phase2_audit_foundation_change();

-- The policy touch trigger owns version increments. A day change invokes it
-- once, without updating days from policy (no trigger cycle). Restore the
-- transaction-local context before a later explicit policy edit can be audited.
create or replace function public.phase2_advance_freshness_version_from_day()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_prior text := current_setting('app.phase2_day_version_bump',true);
begin
  if tg_op = 'UPDATE' and new.day_offset = old.day_offset
     and new.multiplier is not distinct from old.multiplier then
    return new;
  end if;
  perform set_config('app.phase2_day_version_bump','true',true);
  update public.phase2_freshness_policy set updated_at = clock_timestamp() where id = 1;
  perform set_config('app.phase2_day_version_bump',coalesce(v_prior,''),true);
  return new;
end; $$;
create trigger phase2_day_version_advance after insert or update on public.phase2_freshness_days
  for each row execute function public.phase2_advance_freshness_version_from_day();

-- Taiwan calendar days, not elapsed 24-hour intervals. Missing policy day fails closed.
create or replace function public.phase2_current_weighted_stock_price(p_stock_id uuid, p_as_of timestamptz default now())
returns integer language sql stable security invoker set search_path = public, pg_temp as $$
  select case when s.status <> 'sellable' or p_as_of is null
                    or (p_as_of at time zone 'Asia/Taipei')::date < s.fish_date
                    or ((p_as_of at time zone 'Asia/Taipei')::date - s.fish_date) > p.max_sale_day
               then null
               else nullif(round(s.t0_base_price::numeric * d.multiplier)::integer,0) end
  from public.phase2_weighted_stock s
  cross join public.phase2_freshness_policy p
  left join public.phase2_freshness_days d
    on d.day_offset = ((p_as_of at time zone 'Asia/Taipei')::date - s.fish_date)
  where s.id = p_stock_id and p.id = 1;
$$;

-- Browser/authenticated callers can read admin facts only with the existing trusted JWT claim.
-- Neither anon nor authenticated receives direct write privileges on new tables or sequence.
alter table public.phase2_weight_pricing_tiers enable row level security;
alter table public.phase2_freshness_policy enable row level security;
alter table public.phase2_freshness_days enable row level security;
alter table public.phase2_weighted_stock enable row level security;
alter table public.phase2_audit_events enable row level security;
create policy phase2_admin_tiers_read on public.phase2_weight_pricing_tiers for select to authenticated using ((select public.is_hanjiu_admin()));
create policy phase2_admin_policy_read on public.phase2_freshness_policy for select to authenticated using ((select public.is_hanjiu_admin()));
create policy phase2_admin_days_read on public.phase2_freshness_days for select to authenticated using ((select public.is_hanjiu_admin()));
create policy phase2_admin_stock_read on public.phase2_weighted_stock for select to authenticated using ((select public.is_hanjiu_admin()));
create policy phase2_admin_audit_read on public.phase2_audit_events for select to authenticated using ((select public.is_hanjiu_admin()));
revoke all on public.phase2_weight_pricing_tiers,public.phase2_freshness_policy,public.phase2_freshness_days,
  public.phase2_weighted_stock,public.phase2_audit_events from public,anon,authenticated;
grant select on public.phase2_weight_pricing_tiers,public.phase2_freshness_policy,public.phase2_freshness_days,
  public.phase2_weighted_stock,public.phase2_audit_events to authenticated;
revoke all on sequence public.phase2_stock_code_seq from public,anon,authenticated;
revoke all on function public.phase2_current_weighted_stock_price(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.phase2_current_weighted_stock_price(uuid,timestamptz) to authenticated;

-- This narrow creation RPC supplies snapshots through the DB trigger; no arbitrary price/status input.
create or replace function public.admin_create_weighted_stock(
  p_product_id uuid,p_fish_date date,p_raw_weight_g integer,p_batch_reference text default null,
  p_representative_image_id uuid default null,p_manual_base_price integer default null)
returns public.phase2_weighted_stock language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stock public.phase2_weighted_stock;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_fish_date is null then raise exception 'fish_date_required'; end if;
  if p_representative_image_id is not null and not exists
     (select 1 from public.product_images where id = p_representative_image_id and product_id = p_product_id)
     then raise exception 'representative_image_product_mismatch'; end if;
  insert into public.phase2_weighted_stock(product_id,fish_date,raw_weight_g,batch_reference,representative_image_id,manual_base_price)
  values(p_product_id,p_fish_date,p_raw_weight_g,p_batch_reference,p_representative_image_id,p_manual_base_price)
  returning * into v_stock;
  return v_stock;
end; $$;
revoke all on function public.admin_create_weighted_stock(uuid,date,integer,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.admin_create_weighted_stock(uuid,date,integer,text,uuid,integer) to authenticated;

-- Trigger helpers are not RPC endpoints.
revoke all on function public.phase2_guard_inventory_mode(),public.phase2_guard_tier_overlap(),
  public.phase2_initialize_weighted_stock(),public.phase2_guard_weighted_stock_update(),
  public.phase2_audit_immutable(),public.phase2_audit_stock_insert(),
  public.phase2_audit_foundation_change(),public.phase2_touch_freshness_configuration(),
  public.phase2_advance_freshness_version_from_day(),
  public.phase2_no_foundation_delete() from public,anon,authenticated;

commit;

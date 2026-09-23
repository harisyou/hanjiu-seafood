-- Phase 2 PR-B follow-up. Forward-only after owner-applied F006-2.
-- Adds only controlled sellable <-> manually_unlisted actions. Owner runs manually.
begin;

-- Authorization is an unguessable, transaction-scoped private capability row.
-- Caller SET/set_config values are not consulted by the trigger.
create table public.phase2_weighted_stock_action_tokens (
  token uuid primary key,
  backend_pid integer not null,
  transaction_id bigint not null,
  stock_id uuid not null references public.phase2_weighted_stock(id) on delete restrict,
  old_status text not null,
  new_status text not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.phase2_weighted_stock_action_tokens enable row level security;
revoke all on public.phase2_weighted_stock_action_tokens from public,anon,authenticated;

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
     or new.batch_line_no is distinct from old.batch_line_no
     or new.order_id is distinct from old.order_id
     or new.order_item_id is distinct from old.order_item_id then
    raise exception 'weighted_stock_action_or_correction_required';
  end if;
  if new.status is distinct from old.status then
    select exists(select 1 from public.phase2_weighted_stock_action_tokens a
      where a.backend_pid=pg_backend_pid() and a.transaction_id=txid_current() and a.stock_id=old.id
        and a.old_status=old.status and a.new_status=new.status)
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

create or replace function public.admin_unlist_weighted_stock(
  p_stock_id uuid,p_expected_version integer,p_reason text)
returns public.phase2_weighted_stock language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.phase2_weighted_stock; v_new public.phase2_weighted_stock;
        v_token uuid := gen_random_uuid();
        v_reason text := nullif(btrim(p_reason),'');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if v_reason is null then raise exception 'phase2_change_reason_required'; end if;
  select * into v_old from public.phase2_weighted_stock where id=p_stock_id for update;
  if not found then raise exception 'weighted_stock_not_found'; end if;
  if p_expected_version is null or v_old.version<>p_expected_version then raise exception 'weighted_stock_version_conflict'; end if;
  if v_old.status<>'sellable' then raise exception 'weighted_stock_unlist_invalid_status: %',v_old.status; end if;
  insert into public.phase2_weighted_stock_action_tokens(token,backend_pid,transaction_id,stock_id,old_status,new_status)
  values(v_token,pg_backend_pid(),txid_current(),v_old.id,v_old.status,'manually_unlisted');
  update public.phase2_weighted_stock set status='manually_unlisted' where id=v_old.id returning * into v_new;
  delete from public.phase2_weighted_stock_action_tokens where token=v_token;
  insert into public.phase2_audit_events(actor_id,action,entity_type,entity_id,old_value,new_value,reason)
  values(auth.uid(),'weighted_stock_manually_unlisted','weighted_stock',v_new.id,
    jsonb_build_object('status',v_old.status,'version',v_old.version),
    jsonb_build_object('status',v_new.status,'version',v_new.version),v_reason);
  return v_new;
end; $$;

create or replace function public.admin_relist_weighted_stock(
  p_stock_id uuid,p_expected_version integer,p_reason text)
returns public.phase2_weighted_stock language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old public.phase2_weighted_stock; v_new public.phase2_weighted_stock;
        v_token uuid := gen_random_uuid();
        v_policy public.phase2_freshness_policy; v_multiplier numeric; v_current_price integer;
        v_today date := (clock_timestamp() at time zone 'Asia/Taipei')::date;
        v_day_offset integer; v_mode text; v_product_status text;
        v_reason text := nullif(btrim(p_reason),'');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if v_reason is null then raise exception 'phase2_change_reason_required'; end if;
  select * into v_old from public.phase2_weighted_stock where id=p_stock_id for update;
  if not found then raise exception 'weighted_stock_not_found'; end if;
  if p_expected_version is null or v_old.version<>p_expected_version then raise exception 'weighted_stock_version_conflict'; end if;
  if v_old.status<>'manually_unlisted' then raise exception 'weighted_stock_relist_invalid_status: %',v_old.status; end if;
  select inventory_mode,status into v_mode,v_product_status from public.products where id=v_old.product_id for share;
  if v_mode is distinct from 'SINGLE_WEIGHTED' then raise exception 'weighted_inventory_mode_required'; end if;
  if v_product_status is distinct from 'available' then raise exception 'weighted_product_not_available'; end if;
  select * into v_policy from public.phase2_freshness_policy where id=1 for share;
  if not found then raise exception 'weighted_stock_freshness_policy_missing'; end if;
  v_day_offset := v_today-v_old.fish_date;
  if v_day_offset<0 or v_day_offset>v_policy.max_sale_day then raise exception 'weighted_stock_relist_outside_freshness_window'; end if;
  select multiplier into v_multiplier from public.phase2_freshness_days where day_offset=v_day_offset for share;
  if not found then raise exception 'weighted_stock_relist_freshness_day_missing'; end if;
  v_current_price := round(v_old.t0_base_price::numeric*v_multiplier)::integer;
  if v_current_price<=0 then raise exception 'weighted_stock_relist_price_invalid'; end if;
  insert into public.phase2_weighted_stock_action_tokens(token,backend_pid,transaction_id,stock_id,old_status,new_status)
  values(v_token,pg_backend_pid(),txid_current(),v_old.id,v_old.status,'sellable');
  update public.phase2_weighted_stock set status='sellable' where id=v_old.id returning * into v_new;
  delete from public.phase2_weighted_stock_action_tokens where token=v_token;
  insert into public.phase2_audit_events(actor_id,action,entity_type,entity_id,old_value,new_value,reason)
  values(auth.uid(),'weighted_stock_relisted','weighted_stock',v_new.id,
    jsonb_build_object('status',v_old.status,'version',v_old.version),
    jsonb_build_object('status',v_new.status,'version',v_new.version,'day_offset',v_day_offset,
      'freshness_version',v_policy.version,'multiplier',v_multiplier,'current_price',v_current_price),v_reason);
  return v_new;
end; $$;

revoke all on function public.phase2_guard_weighted_stock_update(),
  public.admin_unlist_weighted_stock(uuid,integer,text),
  public.admin_relist_weighted_stock(uuid,integer,text) from public,anon,authenticated;
grant execute on function public.admin_unlist_weighted_stock(uuid,integer,text),
  public.admin_relist_weighted_stock(uuid,integer,text) to authenticated;

commit;

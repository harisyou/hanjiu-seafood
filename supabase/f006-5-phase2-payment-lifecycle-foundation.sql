-- F006-5 / Phase 2 PR-C2.1: payment-report and guest-order lifecycle foundation.
-- Forward-only after owner-applied F006-1 through F006-4.
-- This migration creates no browser checkout grant and sends no email.
begin;

alter table public.orders
  add column payment_reporting_required boolean not null default false,
  add column payment_slot_active boolean not null default false,
  add column payment_report_status text,
  add column payment_reported_at timestamptz,
  add column current_payment_report_id uuid,
  add column payment_review_updated_at timestamptz,
  add column checkout_phone_normalized text,
  add column customer_email_revision integer not null default 0,
  add column customer_email_changed_at timestamptz;

alter table public.orders add constraint orders_payment_report_status_check
  check (payment_report_status is null or payment_report_status in ('pending','exception','confirmed','cancelled'));
alter table public.orders add constraint orders_checkout_phone_normalized_check
  check (checkout_phone_normalized is null or checkout_phone_normalized ~ '^09[0-9]{8}$');
alter table public.orders add constraint orders_customer_email_revision_check check (customer_email_revision >= 0);
alter table public.orders add constraint orders_payment_report_shape_check check (
  (payment_report_status is null and payment_reported_at is null and current_payment_report_id is null)
  or
  (payment_report_status is not null and payment_reported_at is not null and current_payment_report_id is not null)
);

create unique index orders_one_unfinished_payment_per_phone_uidx
  on public.orders(checkout_phone_normalized)
  where payment_reporting_required and payment_slot_active;
create index orders_payment_review_queue_idx
  on public.orders(payment_report_status,payment_reported_at)
  where payment_report_status in ('pending','exception') and payment_status='unpaid' and status<>'cancelled';

create table public.order_customer_access_tokens (
  order_id uuid primary key references public.orders(id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz
);

create table public.order_payment_reports (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  version smallint not null check (version in (1,2)),
  account_last5 text not null check (account_last5 ~ '^[0-9]{5}$'),
  reported_amount integer not null check (reported_amount > 0),
  submitted_at timestamptz not null default clock_timestamp(),
  supersedes_report_id uuid references public.order_payment_reports(id) on delete restrict,
  idempotency_key uuid not null,
  unique(order_id,version),
  unique(order_id,idempotency_key),
  unique(id,order_id)
);
alter table public.orders add constraint orders_current_payment_report_fk
  foreign key(current_payment_report_id,id) references public.order_payment_reports(id,order_id)
  deferrable initially deferred;

create table public.order_customer_contact_revisions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  revision integer not null check (revision > 0),
  old_email text,
  new_email text not null check (length(new_email)<=254),
  changed_at timestamptz not null default clock_timestamp(),
  idempotency_key uuid not null,
  unique(order_id,revision),
  unique(order_id,idempotency_key)
);

create table public.order_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  payment_report_id uuid references public.order_payment_reports(id) on delete restrict,
  event_type text not null check (event_type in (
    'payment_report_submitted','payment_report_amended','payment_marked_exception',
    'payment_confirmed','customer_cancelled','admin_reported_order_cancelled',
    'expired_order_cancelled','customer_email_changed','payment_review_reminder_created'
  )),
  actor_type text not null check (actor_type in ('customer','admin','system')),
  actor_id uuid,
  old_value jsonb,
  new_value jsonb,
  reason text,
  idempotency_key uuid,
  created_at timestamptz not null default clock_timestamp()
);
create unique index order_lifecycle_events_idempotency_uidx
  on public.order_lifecycle_events(order_id,event_type,idempotency_key)
  where idempotency_key is not null;

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  notification_type text not null check (notification_type in (
    'customer_payment_report_received','customer_payment_report_email_changed',
    'admin_payment_review_pending_24h','admin_payment_review_exception_24h'
  )),
  order_id uuid not null references public.orders(id) on delete restrict,
  recipient_kind text not null check (recipient_kind in ('customer','admin')),
  recipient_email text check (recipient_email is null or length(recipient_email)<=254),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','sent','dead')),
  attempts integer not null default 0 check (attempts>=0),
  available_at timestamptz not null default clock_timestamp(),
  lease_token uuid,
  leased_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((status='sent')=(sent_at is not null))
);
create index notification_outbox_pending_idx on public.notification_outbox(available_at,created_at)
  where status in ('pending','processing');

create table public.phase2_order_action_tokens (
  token uuid primary key default gen_random_uuid(),
  backend_pid integer not null,
  transaction_id bigint not null,
  order_id uuid not null,
  action text not null,
  payment_report_id uuid,
  created_at timestamptz not null default clock_timestamp()
);

alter table public.order_customer_access_tokens enable row level security;
alter table public.order_payment_reports enable row level security;
alter table public.order_customer_contact_revisions enable row level security;
alter table public.order_lifecycle_events enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.phase2_order_action_tokens enable row level security;

create policy order_payment_reports_admin_read on public.order_payment_reports for select to authenticated
  using ((select public.is_hanjiu_admin()));
create policy order_contact_revisions_admin_read on public.order_customer_contact_revisions for select to authenticated
  using ((select public.is_hanjiu_admin()));
create policy order_lifecycle_events_admin_read on public.order_lifecycle_events for select to authenticated
  using ((select public.is_hanjiu_admin()));
create policy notification_outbox_admin_read on public.notification_outbox for select to authenticated
  using ((select public.is_hanjiu_admin()));
grant select on public.order_payment_reports,public.order_customer_contact_revisions,
  public.order_lifecycle_events,public.notification_outbox to authenticated;

create or replace function public.phase2_normalize_tw_mobile(p_phone text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare v text:=regexp_replace(coalesce(p_phone,''),'[[:space:]().-]','','g');
begin
  if v ~ '^[+]8869[0-9]{8}$' then v:='0'||substr(v,5);
  elsif v ~ '^8869[0-9]{8}$' then v:='0'||substr(v,4);
  end if;
  if v !~ '^09[0-9]{8}$' then raise exception 'invalid_phone'; end if;
  return v;
end; $$;

create or replace function public.phase2_assert_access_hash(p_hash text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
begin
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_order_access_token_hash'; end if;
  return p_hash;
end; $$;

create or replace function public.phase2_create_checkout_order_with_access(
  p_customer_name text,p_phone text,p_fulfillment text,p_note text,
  p_variant_items jsonb,p_weighted_items jsonb,p_email text,p_idempotency_key uuid,p_access_token_hash text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_phone text:=public.phase2_normalize_tw_mobile(p_phone); v_email text:=nullif(lower(btrim(coalesce(p_email,''))),'');
        v_hash text:=public.phase2_assert_access_hash(p_access_token_hash); v_order_id uuid; v_existing record;
begin
  if v_email is null or length(v_email)>254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  if p_idempotency_key is null then raise exception 'checkout_idempotency_key_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('phase2-phone:'||v_phone,0));
  select o.id,o.checkout_phone_normalized,t.token_hash into v_existing
    from public.orders o left join public.order_customer_access_tokens t on t.order_id=o.id
    where o.checkout_idempotency_key=p_idempotency_key;
  if found then
    v_order_id:=public.phase2_create_checkout_order(p_customer_name,v_phone,p_fulfillment,p_note,
      p_variant_items,p_weighted_items,v_email,p_idempotency_key);
    if v_existing.checkout_phone_normalized is distinct from v_phone or v_existing.token_hash is distinct from v_hash
      then raise exception 'checkout_access_identity_conflict'; end if;
    return v_order_id;
  end if;
  if exists(select 1 from public.orders o where o.payment_reporting_required
      and o.checkout_phone_normalized=v_phone and o.payment_slot_active)
    then raise exception 'phone_has_unfinished_payment_order'; end if;
  v_order_id:=public.phase2_create_checkout_order(p_customer_name,v_phone,p_fulfillment,p_note,
    p_variant_items,p_weighted_items,v_email,p_idempotency_key);
  update public.orders set payment_reporting_required=true,payment_slot_active=true,checkout_phone_normalized=v_phone where id=v_order_id;
  insert into public.order_customer_access_tokens(order_id,token_hash) values(v_order_id,v_hash);
  return v_order_id;
end; $$;

create or replace function public.phase2_submit_payment_report(
  p_access_token_hash text,p_account_last5 text,p_amount integer,p_idempotency_key uuid)
returns public.order_payment_reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_report public.order_payment_reports; v_hash text:=public.phase2_assert_access_hash(p_access_token_hash);
begin
  if p_idempotency_key is null then raise exception 'payment_report_idempotency_key_required'; end if;
  select o.* into v_order from public.orders o join public.order_customer_access_tokens t on t.order_id=o.id
    where t.token_hash=v_hash and t.revoked_at is null for update of o;
  if not found then raise exception 'order_access_denied'; end if;
  select * into v_report from public.order_payment_reports where order_id=v_order.id and idempotency_key=p_idempotency_key;
  if found then
    if v_report.account_last5 is distinct from p_account_last5 or v_report.reported_amount is distinct from p_amount
      then raise exception 'payment_report_idempotency_conflict'; end if;
    return v_report;
  end if;
  if not v_order.payment_reporting_required then raise exception 'payment_reporting_not_enabled'; end if;
  if v_order.status='cancelled' or v_order.weighted_hold_released_at is not null then raise exception 'cancelled_order_payment_report_not_allowed'; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_payment_report_not_allowed'; end if;
  if v_order.payment_report_status is not null then raise exception 'payment_report_already_submitted'; end if;
  if v_order.weighted_hold_expires_at is null or clock_timestamp()>=v_order.weighted_hold_expires_at then raise exception 'payment_report_deadline_expired'; end if;
  if p_account_last5 is null or p_account_last5 !~ '^[0-9]{5}$' then raise exception 'invalid_transfer_account_last5'; end if;
  if p_amount is null or p_amount is distinct from v_order.total_amount then raise exception 'payment_report_amount_mismatch'; end if;
  insert into public.order_payment_reports(order_id,version,account_last5,reported_amount,idempotency_key)
    values(v_order.id,1,p_account_last5,p_amount,p_idempotency_key) returning * into v_report;
  update public.orders set payment_report_status='pending',payment_reported_at=v_report.submitted_at,
    current_payment_report_id=v_report.id,payment_review_updated_at=v_report.submitted_at where id=v_order.id;
  insert into public.order_lifecycle_events(order_id,payment_report_id,event_type,actor_type,new_value,idempotency_key)
    values(v_order.id,v_report.id,'payment_report_submitted','customer',
      jsonb_build_object('version',1,'amount',p_amount,'account_last5',p_account_last5),p_idempotency_key);
  insert into public.notification_outbox(dedupe_key,notification_type,order_id,recipient_kind,recipient_email,payload)
    values('order:'||v_order.id||':payment-report-submitted:v1:email-revision:'||v_order.customer_email_revision,
      'customer_payment_report_received',v_order.id,'customer',v_order.email,
      jsonb_build_object('order_id',v_order.id,'amount',v_order.total_amount,'email_revision',v_order.customer_email_revision))
    on conflict(dedupe_key) do nothing;
  return v_report;
end; $$;

create or replace function public.phase2_amend_payment_report(
  p_access_token_hash text,p_account_last5 text,p_idempotency_key uuid)
returns public.order_payment_reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_current public.order_payment_reports; v_report public.order_payment_reports;
        v_hash text:=public.phase2_assert_access_hash(p_access_token_hash);
begin
  if p_idempotency_key is null then raise exception 'payment_report_idempotency_key_required'; end if;
  select o.* into v_order from public.orders o join public.order_customer_access_tokens t on t.order_id=o.id
    where t.token_hash=v_hash and t.revoked_at is null for update of o;
  if not found then raise exception 'order_access_denied'; end if;
  select * into v_report from public.order_payment_reports where order_id=v_order.id and idempotency_key=p_idempotency_key;
  if found then
    if v_report.account_last5 is distinct from p_account_last5 then raise exception 'payment_report_idempotency_conflict'; end if;
    return v_report;
  end if;
  if p_account_last5 is null or p_account_last5 !~ '^[0-9]{5}$' then raise exception 'invalid_transfer_account_last5'; end if;
  if v_order.status='cancelled' then raise exception 'cancelled_order_payment_report_not_allowed'; end if;
  if v_order.payment_status='paid' or v_order.payment_report_status='confirmed' then raise exception 'paid_order_payment_report_not_allowed'; end if;
  if v_order.payment_report_status not in ('pending','exception') or v_order.current_payment_report_id is null
    then raise exception 'payment_report_not_found'; end if;
  select * into v_current from public.order_payment_reports where id=v_order.current_payment_report_id and order_id=v_order.id;
  if v_current.account_last5=p_account_last5 then return v_current; end if;
  if v_current.version>=2 then raise exception 'payment_report_amendment_limit_reached'; end if;
  insert into public.order_payment_reports(order_id,version,account_last5,reported_amount,supersedes_report_id,idempotency_key)
    values(v_order.id,2,p_account_last5,v_current.reported_amount,v_current.id,p_idempotency_key) returning * into v_report;
  update public.orders set current_payment_report_id=v_report.id,payment_review_updated_at=clock_timestamp() where id=v_order.id;
  insert into public.order_lifecycle_events(order_id,payment_report_id,event_type,actor_type,old_value,new_value,idempotency_key)
    values(v_order.id,v_report.id,'payment_report_amended','customer',
      jsonb_build_object('version',v_current.version,'account_last5',v_current.account_last5),
      jsonb_build_object('version',2,'account_last5',p_account_last5),p_idempotency_key);
  return v_report;
end; $$;

create or replace function public.phase2_update_order_email(
  p_access_token_hash text,p_email text,p_idempotency_key uuid)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_revision public.order_customer_contact_revisions;
        v_hash text:=public.phase2_assert_access_hash(p_access_token_hash); v_email text:=lower(btrim(coalesce(p_email,'')));
begin
  if p_idempotency_key is null then raise exception 'email_change_idempotency_key_required'; end if;
  if v_email='' or length(v_email)>254 or v_email !~* '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then raise exception 'invalid_email'; end if;
  select o.* into v_order from public.orders o join public.order_customer_access_tokens t on t.order_id=o.id
    where t.token_hash=v_hash and t.revoked_at is null for update of o;
  if not found then raise exception 'order_access_denied'; end if;
  if v_order.status='cancelled' then raise exception 'cancelled_order_email_change_not_allowed'; end if;
  select * into v_revision from public.order_customer_contact_revisions where order_id=v_order.id and idempotency_key=p_idempotency_key;
  if found then
    if v_revision.new_email<>v_email then raise exception 'email_change_idempotency_conflict'; end if;
    return v_order;
  end if;
  if lower(coalesce(v_order.email,''))=v_email then return v_order; end if;
  insert into public.order_customer_contact_revisions(order_id,revision,old_email,new_email,idempotency_key)
    values(v_order.id,v_order.customer_email_revision+1,v_order.email,v_email,p_idempotency_key) returning * into v_revision;
  update public.orders set email=v_email,customer_email_revision=v_revision.revision,
    customer_email_changed_at=v_revision.changed_at where id=v_order.id returning * into v_order;
  insert into public.order_lifecycle_events(order_id,event_type,actor_type,old_value,new_value,idempotency_key)
    values(v_order.id,'customer_email_changed','customer',jsonb_build_object('email',v_revision.old_email),
      jsonb_build_object('email',v_email,'revision',v_revision.revision),p_idempotency_key);
  if v_order.payment_report_status is not null then
    insert into public.notification_outbox(dedupe_key,notification_type,order_id,recipient_kind,recipient_email,payload)
      values('order:'||v_order.id||':email-revision:'||v_revision.revision||':payment-report-notice',
        'customer_payment_report_email_changed',v_order.id,'customer',v_email,
        jsonb_build_object('order_id',v_order.id,'amount',v_order.total_amount,'email_revision',v_revision.revision))
      on conflict(dedupe_key) do nothing;
  end if;
  return v_order;
end; $$;

-- Central cancellation primitive for new checkout holds. All callers lock the order
-- first; stock locks remain in F006-4's order -> stock -> product -> policy order.
create or replace function public.phase2_cancel_checkout_hold(
  p_order_id uuid,p_effective_at timestamptz,p_reason text)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_item record; v_stock public.phase2_weighted_stock; v_restored public.product_variants;
        v_deducted bigint; v_today date; v_policy record; v_multiplier numeric; v_next text; v_has_weighted boolean;
begin
  if p_effective_at is null or nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'cancellation_reason_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status='cancelled' and v_order.weighted_hold_released_at is not null then return v_order; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_hold_not_releasable'; end if;
  if v_order.weighted_hold_expires_at is null then raise exception 'weighted_order_hold_missing'; end if;
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
  select exists(select 1 from public.order_items where order_id=v_order.id and weighted_stock_id is not null) into v_has_weighted;
  if v_has_weighted then
    if exists(select 1 from public.order_items i where i.order_id=v_order.id and i.weighted_stock_id is not null
      and not exists(select 1 from public.phase2_weighted_stock s where s.id=i.weighted_stock_id
        and s.order_id=v_order.id and s.order_item_id=i.id and s.status='reserved')) then
      raise exception 'weighted_order_reservation_inconsistent';
    end if;
    perform s.id from public.phase2_weighted_stock s where s.order_id=v_order.id and s.status='reserved'
      order by s.id for update of s;
    perform p.id from public.products p join public.phase2_weighted_stock s on s.product_id=p.id
      where s.order_id=v_order.id and s.status='reserved' order by p.id for share of p;
    select * into v_policy from public.phase2_freshness_policy where id=1 for share;
    if not found then raise exception 'weighted_stock_freshness_policy_missing'; end if;
    v_today:=(p_effective_at at time zone 'Asia/Taipei')::date;
    for v_stock in select * from public.phase2_weighted_stock where order_id=v_order.id and status='reserved' order by id for update loop
      select d.multiplier into v_multiplier from public.phase2_freshness_days d join public.products p on p.id=v_stock.product_id
        where d.day_offset=v_today-v_stock.fish_date and p.status='available' and p.inventory_mode='SINGLE_WEIGHTED';
      v_next:=case when v_today-v_stock.fish_date between 0 and v_policy.max_sale_day and v_multiplier is not null
        and round(v_stock.t0_base_price::numeric*v_multiplier)>0 then 'sellable' else 'expired' end;
      perform public.phase2_transition_weighted_stock(v_stock.id,'reserved',v_next,v_order.id,null,v_stock.order_item_id,null,
        case when v_next='sellable' then 'weighted_stock_hold_released' else 'weighted_stock_expired_on_release' end,p_reason,null);
    end loop;
  end if;
  perform set_config('app.order_cancellation_authorized','true',true);
  update public.orders set status='cancelled',weighted_hold_released_at=p_effective_at,
    payment_slot_active=false,
    payment_report_status=case when payment_report_status is null then null else 'cancelled' end,
    payment_review_updated_at=case when payment_report_status is null then payment_review_updated_at else p_effective_at end
    where id=v_order.id and payment_status='unpaid' and weighted_hold_released_at is null returning * into v_order;
  if not found then raise exception 'weighted_order_release_conflict'; end if;
  return v_order;
end; $$;

create or replace function public.phase2_customer_cancel_order(p_access_token_hash text,p_idempotency_key uuid)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_hash text:=public.phase2_assert_access_hash(p_access_token_hash);
begin
  if p_idempotency_key is null then raise exception 'customer_cancel_idempotency_key_required'; end if;
  select o.* into v_order from public.orders o join public.order_customer_access_tokens t on t.order_id=o.id
    where t.token_hash=v_hash and t.revoked_at is null for update of o;
  if not found then raise exception 'order_access_denied'; end if;
  if exists(select 1 from public.order_lifecycle_events where order_id=v_order.id and event_type='customer_cancelled'
      and idempotency_key=p_idempotency_key) then return v_order; end if;
  if v_order.status='cancelled' and v_order.weighted_hold_released_at is not null then return v_order; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_customer_cancel_not_allowed'; end if;
  if v_order.payment_report_status is not null then raise exception 'reported_order_customer_cancel_not_allowed'; end if;
  v_order:=public.phase2_cancel_checkout_hold(v_order.id,clock_timestamp(),'customer cancelled before payment report');
  insert into public.order_lifecycle_events(order_id,event_type,actor_type,reason,idempotency_key)
    values(v_order.id,'customer_cancelled','customer','customer cancelled before payment report',p_idempotency_key);
  return v_order;
end; $$;

create or replace function public.phase2_release_expired_checkout_hold(p_order_id uuid,p_as_of timestamptz default clock_timestamp())
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders;
begin
  if p_as_of is null then raise exception 'release_time_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_hold_not_releasable'; end if;
  if v_order.weighted_hold_released_at is not null then return v_order; end if;
  if v_order.payment_report_status in ('pending','exception','confirmed') then raise exception 'reported_order_hold_not_releasable'; end if;
  if v_order.weighted_hold_expires_at is null then raise exception 'weighted_order_hold_missing'; end if;
  if p_as_of<v_order.weighted_hold_expires_at then raise exception 'weighted_order_hold_not_expired'; end if;
  v_order:=public.phase2_cancel_checkout_hold(v_order.id,p_as_of,'payment hold expired');
  insert into public.order_lifecycle_events(order_id,event_type,actor_type,reason)
    values(v_order.id,'expired_order_cancelled','system','payment hold expired');
  return v_order;
end; $$;

create or replace function public.phase2_finalize_weighted_hold_on_payment()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_stock public.phase2_weighted_stock; v_has_weighted boolean; v_authorized boolean;
begin
  if new.payment_status='paid' and old.payment_status is distinct from 'paid' and new.weighted_hold_expires_at is not null then
    if new.weighted_hold_released_at is not null then raise exception 'order_payment_hold_expired'; end if;
    if clock_timestamp()>=new.weighted_hold_expires_at then
      select exists(select 1 from public.phase2_order_action_tokens t where t.backend_pid=pg_backend_pid()
        and t.transaction_id=txid_current() and t.order_id=new.id and t.action='confirm_reported_payment'
        and t.payment_report_id=new.current_payment_report_id) into v_authorized;
      if not (new.payment_reporting_required and new.payment_report_status in ('pending','exception') and v_authorized)
        then raise exception 'order_payment_hold_expired'; end if;
    end if;
    select exists(select 1 from public.order_items where order_id=new.id and weighted_stock_id is not null) into v_has_weighted;
    if v_has_weighted then
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
  end if;
  return new;
end; $$;

create or replace function public.admin_record_order_payment(
  p_order_id uuid,p_amount integer,p_payment_method text,p_idempotency_key uuid)
returns public.order_payments language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_payment public.order_payments; v_method text:=nullif(btrim(coalesce(p_payment_method,'')),''); v_attempt integer; v_authorized boolean;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_order_id is null then raise exception 'order_not_found'; end if;
  if p_amount is null or p_amount<=0 then raise exception 'invalid_payment_amount'; end if;
  if v_method not in ('cash','bank_transfer','other') then raise exception 'invalid_payment_method'; end if;
  if p_idempotency_key is null then raise exception 'payment_idempotency_key_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  select * into v_payment from public.order_payments where order_id=v_order.id and idempotency_key=p_idempotency_key;
  if found then
    if v_payment.amount<>p_amount or v_payment.payment_method<>v_method then raise exception 'payment_idempotency_conflict'; end if;
    return v_payment;
  end if;
  select exists(select 1 from public.phase2_order_action_tokens t where t.backend_pid=pg_backend_pid()
    and t.transaction_id=txid_current() and t.order_id=v_order.id and t.action='confirm_reported_payment'
    and t.payment_report_id=v_order.current_payment_report_id) into v_authorized;
  if v_order.payment_reporting_required and not v_authorized then raise exception 'reported_payment_confirmation_rpc_required'; end if;
  if v_order.status='draft' then raise exception 'draft_order_payment_not_allowed'; end if;
  if v_order.status='cancelled' then raise exception 'cancelled_order_payment_not_allowed'; end if;
  if v_order.total_amount is null then raise exception 'order_totals_snapshot_missing'; end if;
  if v_order.payment_status='paid' then raise exception 'order_already_paid'; end if;
  if exists(select 1 from public.order_payments p where p.order_id=v_order.id and not exists
      (select 1 from public.order_payment_reversals r where r.payment_id=p.id)) then raise exception 'active_payment_exists'; end if;
  if p_amount<>v_order.total_amount then raise exception 'payment_amount_mismatch'; end if;
  select coalesce(max(attempt_number),0)+1 into v_attempt from public.order_payments where order_id=v_order.id;
  insert into public.order_payments(order_id,amount,payment_method,actor_id,attempt_number,idempotency_key)
    values(v_order.id,p_amount,v_method,auth.uid(),v_attempt,p_idempotency_key) returning * into v_payment;
  perform set_config('app.order_payment_authorized','true',true);
  update public.orders set payment_status='paid' where id=v_order.id and payment_status='unpaid';
  if not found then raise exception 'order_already_paid'; end if;
  return v_payment;
end; $$;

create or replace function public.admin_confirm_reported_order_payment(
  p_order_id uuid,p_expected_report_id uuid,p_idempotency_key uuid)
returns public.order_payments language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_report public.order_payment_reports; v_payment public.order_payments; v_token uuid;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status='cancelled' then raise exception 'cancelled_order_payment_not_allowed'; end if;
  if v_order.payment_status='paid' then
    select * into v_payment from public.order_payments where order_id=v_order.id and idempotency_key=p_idempotency_key;
    if found then return v_payment; end if;
    raise exception 'order_already_paid';
  end if;
  if v_order.payment_report_status not in ('pending','exception') or v_order.current_payment_report_id is distinct from p_expected_report_id
    then raise exception 'payment_report_review_conflict'; end if;
  select * into v_report from public.order_payment_reports where id=p_expected_report_id and order_id=v_order.id;
  if not found or v_order.payment_reported_at>=v_order.weighted_hold_expires_at then raise exception 'timely_payment_report_required'; end if;
  insert into public.phase2_order_action_tokens(backend_pid,transaction_id,order_id,action,payment_report_id)
    values(pg_backend_pid(),txid_current(),v_order.id,'confirm_reported_payment',v_report.id) returning token into v_token;
  v_payment:=public.admin_record_order_payment(v_order.id,v_order.total_amount,'bank_transfer',p_idempotency_key);
  update public.orders set payment_report_status='confirmed',payment_slot_active=false,
    payment_review_updated_at=clock_timestamp() where id=v_order.id;
  insert into public.order_lifecycle_events(order_id,payment_report_id,event_type,actor_type,actor_id,old_value,new_value,idempotency_key)
    values(v_order.id,v_report.id,'payment_confirmed','admin',auth.uid(),
      jsonb_build_object('payment_report_status',v_order.payment_report_status),jsonb_build_object('payment_report_status','confirmed'),p_idempotency_key);
  delete from public.phase2_order_action_tokens where token=v_token;
  return v_payment;
end; $$;

create or replace function public.admin_mark_payment_report_exception(
  p_order_id uuid,p_expected_report_id uuid,p_reason text,p_idempotency_key uuid)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if v_reason is null then raise exception 'payment_exception_reason_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if exists(select 1 from public.order_lifecycle_events where order_id=v_order.id and event_type='payment_marked_exception'
      and idempotency_key=p_idempotency_key) then return v_order; end if;
  if v_order.payment_status='paid' or v_order.status='cancelled' then raise exception 'payment_report_review_not_allowed'; end if;
  if v_order.payment_report_status not in ('pending','exception') or v_order.current_payment_report_id is distinct from p_expected_report_id
    then raise exception 'payment_report_review_conflict'; end if;
  if v_order.payment_report_status='exception' then return v_order; end if;
  update public.orders set payment_report_status='exception',payment_review_updated_at=clock_timestamp() where id=v_order.id returning * into v_order;
  insert into public.order_lifecycle_events(order_id,payment_report_id,event_type,actor_type,actor_id,old_value,new_value,reason,idempotency_key)
    values(v_order.id,p_expected_report_id,'payment_marked_exception','admin',auth.uid(),
      jsonb_build_object('payment_report_status','pending'),jsonb_build_object('payment_report_status','exception'),v_reason,p_idempotency_key);
  return v_order;
end; $$;

create or replace function public.admin_cancel_reported_order(
  p_order_id uuid,p_expected_report_id uuid,p_reason text,p_idempotency_key uuid)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_reason text:=nullif(btrim(coalesce(p_reason,'')),''); v_token uuid;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if v_reason is null then raise exception 'reported_order_cancel_reason_required'; end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if exists(select 1 from public.order_lifecycle_events where order_id=v_order.id and event_type='admin_reported_order_cancelled'
      and idempotency_key=p_idempotency_key) then return v_order; end if;
  if v_order.payment_status='paid' then raise exception 'paid_order_requires_payment_reversal'; end if;
  if v_order.payment_report_status not in ('pending','exception') or v_order.current_payment_report_id is distinct from p_expected_report_id
    then raise exception 'payment_report_review_conflict'; end if;
  insert into public.phase2_order_action_tokens(backend_pid,transaction_id,order_id,action,payment_report_id)
    values(pg_backend_pid(),txid_current(),v_order.id,'cancel_reported_order',p_expected_report_id) returning token into v_token;
  v_order:=public.phase2_cancel_checkout_hold(v_order.id,clock_timestamp(),v_reason);
  insert into public.order_lifecycle_events(order_id,payment_report_id,event_type,actor_type,actor_id,reason,idempotency_key)
    values(v_order.id,p_expected_report_id,'admin_reported_order_cancelled','admin',auth.uid(),v_reason,p_idempotency_key);
  delete from public.phase2_order_action_tokens where token=v_token;
  return v_order;
end; $$;

create or replace function public.phase2_enqueue_payment_review_reminders(p_as_of timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_count integer;
begin
  if p_as_of is null then raise exception 'reminder_time_required'; end if;
  with candidates as (
    select o.id,o.payment_report_status from public.orders o
    where o.payment_status='unpaid' and o.status<>'cancelled'
      and o.payment_report_status in ('pending','exception')
      and o.payment_reported_at<=p_as_of-interval '24 hours'
    order by o.payment_reported_at,o.id for update skip locked
  )
  insert into public.notification_outbox(dedupe_key,notification_type,order_id,recipient_kind,payload)
    select 'order:'||id||':payment-review-'||payment_report_status||'-overdue-24h',
      case payment_report_status when 'pending' then 'admin_payment_review_pending_24h' else 'admin_payment_review_exception_24h' end,
      id,'admin',jsonb_build_object('order_id',id,'payment_report_status',payment_report_status)
    from candidates on conflict(dedupe_key) do nothing;
  get diagnostics v_count=row_count;
  insert into public.order_lifecycle_events(order_id,event_type,actor_type,new_value)
    select n.order_id,'payment_review_reminder_created','system',jsonb_build_object('notification_type',n.notification_type)
    from public.notification_outbox n
    where n.notification_type in ('admin_payment_review_pending_24h','admin_payment_review_exception_24h')
      and not exists(select 1 from public.order_lifecycle_events e where e.order_id=n.order_id
        and e.event_type='payment_review_reminder_created'
        and e.new_value->>'notification_type'=n.notification_type);
  return v_count;
end; $$;

create or replace function public.phase2_claim_notification_outbox(
  p_limit integer,p_lease_token uuid,p_as_of timestamptz default clock_timestamp())
returns setof public.notification_outbox language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid_outbox_claim_limit'; end if;
  if p_lease_token is null or p_as_of is null then raise exception 'outbox_lease_required'; end if;
  return query
  with candidates as (
    select id from public.notification_outbox
    where (status='pending' and available_at<=p_as_of)
       or (status='processing' and leased_at<=p_as_of-interval '5 minutes')
    order by available_at,created_at,id for update skip locked limit p_limit
  )
  update public.notification_outbox n set status='processing',attempts=n.attempts+1,
    lease_token=p_lease_token,leased_at=p_as_of,updated_at=p_as_of
  from candidates c where n.id=c.id returning n.*;
end; $$;

create or replace function public.phase2_complete_notification_outbox(
  p_id uuid,p_lease_token uuid,p_provider_message_id text,p_as_of timestamptz default clock_timestamp())
returns public.notification_outbox language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.notification_outbox;
begin
  if p_id is null or p_lease_token is null or p_as_of is null then raise exception 'outbox_lease_required'; end if;
  update public.notification_outbox set status='sent',sent_at=p_as_of,
    provider_message_id=nullif(left(btrim(coalesce(p_provider_message_id,'')),500),''),
    lease_token=null,leased_at=null,last_error_code=null,updated_at=p_as_of
  where id=p_id and status='processing' and lease_token=p_lease_token returning * into v_row;
  if not found then
    select * into v_row from public.notification_outbox where id=p_id and status='sent';
    if not found then raise exception 'outbox_lease_conflict'; end if;
  end if;
  return v_row;
end; $$;

create or replace function public.phase2_fail_notification_outbox(
  p_id uuid,p_lease_token uuid,p_error_code text,p_retry_at timestamptz,p_terminal boolean default false)
returns public.notification_outbox language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.notification_outbox; v_error text:=nullif(left(btrim(coalesce(p_error_code,'')),200),'');
begin
  if p_id is null or p_lease_token is null or v_error is null then raise exception 'outbox_failure_details_required'; end if;
  if not coalesce(p_terminal,false) and p_retry_at is null then raise exception 'outbox_retry_time_required'; end if;
  update public.notification_outbox set status=case when coalesce(p_terminal,false) then 'dead' else 'pending' end,
    available_at=case when coalesce(p_terminal,false) then available_at else p_retry_at end,
    lease_token=null,leased_at=null,last_error_code=v_error,updated_at=clock_timestamp()
  where id=p_id and status='processing' and lease_token=p_lease_token returning * into v_row;
  if not found then raise exception 'outbox_lease_conflict'; end if;
  return v_row;
end; $$;

create or replace function public.phase2_guard_new_checkout_financials()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if old.payment_reporting_required and (
    new.subtotal is distinct from old.subtotal or new.shipping_fee is distinct from old.shipping_fee
    or new.discount_amount is distinct from old.discount_amount or new.total_amount is distinct from old.total_amount)
  then raise exception 'checkout_order_financials_immutable'; end if;
  return new;
end; $$;
create trigger orders_new_checkout_financial_guard before update of subtotal,shipping_fee,discount_amount,total_amount on public.orders
for each row execute function public.phase2_guard_new_checkout_financials();

create or replace function public.phase2_guard_new_checkout_items()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if exists(select 1 from public.orders where id=case when tg_op='DELETE' then old.order_id else new.order_id end
      and payment_reporting_required)
    then raise exception 'checkout_order_items_immutable'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end; $$;
create trigger order_items_new_checkout_immutable before insert or update or delete on public.order_items
for each row execute function public.phase2_guard_new_checkout_items();

create or replace function public.phase2_guard_reported_order_cancellation()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_authorized boolean;
begin
  if new.status='cancelled' and old.status is distinct from 'cancelled'
     and old.payment_reporting_required and old.payment_report_status in ('pending','exception') then
    select exists(select 1 from public.phase2_order_action_tokens t where t.backend_pid=pg_backend_pid()
      and t.transaction_id=txid_current() and t.order_id=old.id and t.action='cancel_reported_order'
      and t.payment_report_id=old.current_payment_report_id) into v_authorized;
    if not v_authorized then raise exception 'reported_order_cancellation_rpc_required'; end if;
  end if;
  return new;
end; $$;
create trigger orders_reported_cancellation_guard before update of status on public.orders
for each row execute function public.phase2_guard_reported_order_cancellation();

-- Browser roles receive no direct mutation rights or EXECUTE on customer/internal RPCs.
revoke all on public.order_customer_access_tokens,public.order_payment_reports,
  public.order_customer_contact_revisions,public.order_lifecycle_events,
  public.notification_outbox,public.phase2_order_action_tokens from public,anon,authenticated;
grant select on public.order_payment_reports,public.order_customer_contact_revisions,
  public.order_lifecycle_events,public.notification_outbox to authenticated;

revoke all on function public.phase2_normalize_tw_mobile(text),public.phase2_assert_access_hash(text),
  public.phase2_create_checkout_order_with_access(text,text,text,text,jsonb,jsonb,text,uuid,text),
  public.phase2_submit_payment_report(text,text,integer,uuid),public.phase2_amend_payment_report(text,text,uuid),
  public.phase2_update_order_email(text,text,uuid),public.phase2_customer_cancel_order(text,uuid),
  public.phase2_cancel_checkout_hold(uuid,timestamptz,text),
  public.phase2_enqueue_payment_review_reminders(timestamptz),
  public.phase2_claim_notification_outbox(integer,uuid,timestamptz),
  public.phase2_complete_notification_outbox(uuid,uuid,text,timestamptz),
  public.phase2_fail_notification_outbox(uuid,uuid,text,timestamptz,boolean),
  public.phase2_guard_new_checkout_financials(),public.phase2_guard_new_checkout_items(),
  public.phase2_guard_reported_order_cancellation()
from public,anon,authenticated;

revoke all on function public.admin_confirm_reported_order_payment(uuid,uuid,uuid),
  public.admin_mark_payment_report_exception(uuid,uuid,text,uuid),
  public.admin_cancel_reported_order(uuid,uuid,text,uuid)
from public,anon,authenticated;
grant execute on function public.admin_confirm_reported_order_payment(uuid,uuid,uuid),
  public.admin_mark_payment_report_exception(uuid,uuid,text,uuid),
  public.admin_cancel_reported_order(uuid,uuid,text,uuid)
to authenticated;

-- F006-4 internal primitives remain browser-closed; legacy admin payment remains admin-only.
revoke all on function public.phase2_release_expired_checkout_hold(uuid,timestamptz),
  public.phase2_finalize_weighted_hold_on_payment(),
  public.admin_record_order_payment(uuid,integer,text,uuid)
from public,anon,authenticated;
grant execute on function public.admin_record_order_payment(uuid,integer,text,uuid) to authenticated;

commit;

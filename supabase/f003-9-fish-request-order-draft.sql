-- F003-9: admin-created order drafts sourced from fish requests.
-- Run once after F003-8. This migration never updates inventory or historical rows.

alter table public.orders add column if not exists fish_request_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'orders_fish_request_id_fkey'
      and conrelid = 'public.orders'::regclass
  ) then
    alter table public.orders add constraint orders_fish_request_id_fkey
      foreign key (fish_request_id) references public.fish_requests(id)
      on delete set null not valid;
  end if;
end;
$$;

create index if not exists orders_fish_request_id_idx
  on public.orders(fish_request_id) where fish_request_id is not null;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in (
    'draft', 'new', 'processing', 'ready', 'completed', 'cancelled',
    'contacted', 'confirmed', 'paid', 'shipped'
  ));

alter table public.orders alter column fulfillment drop not null;
alter table public.orders alter column processing drop not null;

alter table public.orders drop constraint if exists orders_fulfillment_required_unless_draft_check;
alter table public.orders add constraint orders_fulfillment_required_unless_draft_check
  check (status = 'draft' or fulfillment is not null);
alter table public.orders drop constraint if exists orders_processing_required_unless_draft_check;
alter table public.orders add constraint orders_processing_required_unless_draft_check
  check (status = 'draft' or processing is not null);

create unique index if not exists orders_one_draft_per_fish_request_idx
  on public.orders(fish_request_id)
  where status = 'draft' and fish_request_id is not null;

create or replace function public.admin_create_fish_request_order_draft(
  p_request_id uuid,
  p_variant_id uuid,
  p_quantity integer
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.fish_requests;
  v_variant record;
  v_order public.orders;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_request_id is null then raise exception 'fish_request_not_found'; end if;
  if p_variant_id is null then raise exception 'variant_not_found'; end if;
  if p_quantity is null or p_quantity < 1 then raise exception 'invalid_quantity'; end if;

  select * into v_request
  from public.fish_requests
  where id = p_request_id
  for update;
  if not found then raise exception 'fish_request_not_found'; end if;
  if v_request.status not in ('waiting', 'contacted') then
    raise exception 'fish_request_not_eligible';
  end if;
  if exists (
    select 1 from public.orders
    where fish_request_id = p_request_id and status = 'draft'
  ) then
    raise exception 'fish_request_draft_exists';
  end if;

  select variant.id as variant_id, variant.product_id, variant.name as variant_name,
    variant.price, variant.inventory, variant.active,
    product.name as product_name, product.status as product_status,
    product.fish_catalog_id
  into v_variant
  from public.product_variants variant
  join public.products product on product.id = variant.product_id
  where variant.id = p_variant_id
  for share of variant, product;
  if not found then raise exception 'variant_not_found'; end if;
  if not v_variant.active or v_variant.product_status <> 'available' or v_variant.inventory < 1 then
    raise exception 'variant_unavailable';
  end if;
  if p_quantity > v_variant.inventory then raise exception 'insufficient_inventory'; end if;

  if v_request.fish_catalog_id is not null then
    if v_variant.fish_catalog_id is distinct from v_request.fish_catalog_id then
      raise exception 'fish_request_product_mismatch';
    end if;
  elsif lower(regexp_replace(btrim(v_request.fish_name), '[[:space:]　]+', ' ', 'g'))
    <> lower(regexp_replace(btrim(v_variant.product_name), '[[:space:]　]+', ' ', 'g')) then
    raise exception 'fish_request_product_mismatch';
  end if;

  begin
    insert into public.orders (
      customer_id, customer_name, phone, email, line_id, fish_request_id,
      fulfillment, processing, note, status, payment_status
    ) values (
      v_request.customer_id, v_request.customer_name, v_request.phone,
      v_request.email, v_request.line_user_id, v_request.id,
      null, null, null, 'draft', 'unpaid'
    ) returning * into v_order;
  exception when unique_violation then
    raise exception 'fish_request_draft_exists';
  end;

  insert into public.order_items (
    order_id, product_id, product_name, variant_id, variant_name, price, quantity,
    processing_preset_id, processing_preset_name, processing_option_ids,
    processing_option_names, processing_note
  ) values (
    v_order.id, v_variant.product_id, v_variant.product_name,
    v_variant.variant_id, v_variant.variant_name, v_variant.price, p_quantity,
    null, null, '{}', '{}', null
  );

  return v_order;
end;
$$;

revoke all on function public.admin_create_fish_request_order_draft(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.admin_create_fish_request_order_draft(uuid, uuid, integer)
  to authenticated;

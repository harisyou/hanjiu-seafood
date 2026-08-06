-- F002-2: secure, atomic public checkout order creation.
-- Run this file once in the Supabase SQL Editor.

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

-- Remove the earlier broad direct-insert policies. Public checkout now uses the
-- transaction-safe RPC below; SELECT, UPDATE, and DELETE remain unavailable.
drop policy if exists "public create orders" on public.orders;
drop policy if exists "public create order items" on public.order_items;
drop policy if exists "public checkout inserts orders" on public.orders;
drop policy if exists "public checkout inserts order items" on public.order_items;

revoke insert on table public.orders from anon;
revoke insert on table public.order_items from anon;

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
begin
  if nullif(btrim(p_customer_name), '') is null then
    raise exception 'customer_name_required';
  end if;
  if nullif(btrim(p_phone), '') is null then
    raise exception 'phone_required';
  end if;
  if p_fulfillment not in ('永春市場自取', '台北市配送', '冷凍宅配', '7-ELEVEN 冷凍交貨便') then
    raise exception 'invalid_fulfillment';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'items_required';
  end if;

  insert into public.orders (customer_name, phone, line_id, fulfillment, processing, note)
  values (btrim(p_customer_name), btrim(p_phone), null, p_fulfillment, '不處理', nullif(p_note, ''))
  returning id into v_order_id;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_variant_id := (v_item->>'variant_id')::uuid;
    v_quantity := (v_item->>'quantity')::integer;

    if v_quantity is null or v_quantity < 1 then
      raise exception 'invalid_quantity';
    end if;

    select
      variant.id as variant_id,
      variant.product_id,
      product.name as product_name,
      variant.name as variant_name,
      variant.price,
      variant.inventory,
      variant.active
    into v_variant
    from public.product_variants as variant
    join public.products as product on product.id = variant.product_id
    where variant.id = v_variant_id;

    if not found then
      raise exception 'variant_unavailable';
    end if;
    if not v_variant.active or v_quantity > v_variant.inventory then
      raise exception 'variant_unavailable';
    end if;

    insert into public.order_items (
      order_id, product_id, product_name, variant_id, variant_name, price, quantity
    ) values (
      v_order_id,
      v_variant.product_id,
      v_variant.product_name,
      v_variant.variant_id,
      v_variant.variant_name,
      v_variant.price,
      v_quantity
    );
  end loop;

  return v_order_id;
end;
$$;

revoke all on function public.create_checkout_order(text, text, text, text, jsonb) from public;
grant execute on function public.create_checkout_order(text, text, text, text, jsonb) to anon, authenticated;

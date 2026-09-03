-- Phase 1 catalog only. Run manually after all F004 migrations (see deployment guide).
begin;

alter table public.products
  add column if not exists texture_description text,
  add column if not exists storage_instructions text,
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.catalog_touch_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := clock_timestamp(); return new; end;
$$;
revoke all on function public.catalog_touch_updated_at() from public, anon, authenticated;
create trigger catalog_product_updated before update on public.products
for each row execute function public.catalog_touch_updated_at();

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_bucket text,
  storage_path text,
  legacy_url text,
  public_url text check (public_url is null or public_url ~ '^https?://'),
  alt_text text not null default '' check (char_length(alt_text) <= 500),
  sort_order integer not null default 0 check (sort_order >= 0),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((storage_bucket is not null and storage_bucket = 'product-images' and storage_path is not null and btrim(storage_path) <> '' and legacy_url is null)
    or (storage_bucket is null and storage_path is null and legacy_url is not null and btrim(legacy_url) <> '')),
  unique (storage_bucket, storage_path)
);
create unique index product_images_one_primary on public.product_images(product_id) where is_primary;
create index product_images_order on public.product_images(product_id, sort_order, id);

create table public.product_faqs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  question text not null check (char_length(btrim(question)) between 1 and 200),
  answer text not null check (char_length(btrim(answer)) between 1 and 5000),
  sort_order integer not null default 0 check (sort_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_faqs_order on public.product_faqs(product_id, sort_order, id);
create trigger catalog_image_updated before update on public.product_images
for each row execute function public.catalog_touch_updated_at();
create trigger catalog_faq_updated before update on public.product_faqs
for each row execute function public.catalog_touch_updated_at();

alter table public.product_images enable row level security;
alter table public.product_faqs enable row level security;
create policy catalog_images_public on public.product_images for select to anon, authenticated
using (exists (select 1 from public.products p where p.id = product_id and p.status <> 'hidden'));
create policy catalog_faqs_public on public.product_faqs for select to anon, authenticated
using (active and exists (select 1 from public.products p where p.id = product_id and p.status <> 'hidden'));
create policy catalog_images_admin on public.product_images for select to authenticated using (public.is_hanjiu_admin());
create policy catalog_faqs_admin on public.product_faqs for select to authenticated using (public.is_hanjiu_admin());
revoke all on public.product_images, public.product_faqs from public, anon, authenticated;
grant select on public.product_images, public.product_faqs to anon, authenticated;

insert into public.product_images(product_id, legacy_url, is_primary)
select id, image_url, true from public.products where nullif(btrim(image_url), '') is not null;

-- One versioned, atomic metadata write. Storage cleanup is deliberately separate.
create or replace function public.admin_save_product_catalog(
  p_product_id uuid, p_expected_updated_at timestamptz, p_content jsonb,
  p_images jsonb, p_faqs jsonb
) returns public.products
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_product public.products;
  v_category uuid := (p_content->>'category_id')::uuid;
  v_fish uuid := nullif(p_content->>'fish_catalog_id', '')::uuid;
  v_primary integer;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  select * into v_product from public.products where id = p_product_id for update;
  if not found then raise exception 'product_not_found'; end if;
  if p_expected_updated_at is distinct from v_product.updated_at then raise exception 'catalog_edit_conflict'; end if;
  if char_length(btrim(coalesce(p_content->>'name', ''))) not between 1 and 120 then raise exception 'invalid_product_name'; end if;
  if coalesce(p_content->>'status', '') not in ('available','sold_out','hidden') then raise exception 'invalid_product_status'; end if;
  perform 1 from public.product_categories where id = v_category and (active or id = v_product.category_id) for share;
  if not found then raise exception 'product_category_required'; end if;
  if v_fish is not null then
    perform 1 from public.fish_catalog where id = v_fish for update;
    if not found then raise exception 'fish_catalog_not_found'; end if;
    -- Existing duplicate associations remain editable. No unique constraint or merge.
    if v_fish is distinct from v_product.fish_catalog_id and exists
      (select 1 from public.products where fish_catalog_id = v_fish and id <> p_product_id)
      then raise exception 'fish_catalog_already_used'; end if;
  end if;
  if jsonb_typeof(p_images) is distinct from 'array' or jsonb_typeof(p_faqs) is distinct from 'array'
    then raise exception 'invalid_catalog_collections'; end if;
  if jsonb_array_length(p_images) > 30 or jsonb_array_length(p_faqs) > 50 then raise exception 'catalog_collection_limit'; end if;
  select count(*) into v_primary from jsonb_array_elements(p_images) x where (x->>'is_primary')::boolean;
  if jsonb_array_length(p_images) > 0 and v_primary <> 1 then raise exception 'gallery_primary_required'; end if;
  if exists (select 1 from jsonb_array_elements(p_images) x
    where (x->>'storage_path' is not null and
      (x->>'storage_path' not like 'products/' || p_product_id::text || '/%' or x->>'storage_path' like '%..%'
       or x->>'public_url' is null or x->>'public_url' not like '%/storage/v1/object/public/product-images/' || (x->>'storage_path')))
    or (x->>'legacy_url' is not null and not exists
      (select 1 from public.product_images i where i.product_id = p_product_id and i.id = (x->>'id')::uuid and i.legacy_url = x->>'legacy_url')))
    then raise exception 'invalid_image_source'; end if;

  -- Reject IDs owned by another product; do not reparent metadata.
  if exists (select 1 from public.product_images i join jsonb_array_elements(p_images) x on i.id = (x->>'id')::uuid where i.product_id <> p_product_id)
    or exists (select 1 from public.product_faqs f join jsonb_array_elements(p_faqs) x on f.id = (x->>'id')::uuid where f.product_id <> p_product_id)
    then raise exception 'catalog_ownership_mismatch'; end if;
  delete from public.product_images where product_id = p_product_id and id not in (select (x->>'id')::uuid from jsonb_array_elements(p_images) x);
  update public.product_images set is_primary = false where product_id = p_product_id and is_primary;
  insert into public.product_images(id, product_id, storage_bucket, storage_path, legacy_url, public_url, alt_text, sort_order, is_primary)
  select (x->>'id')::uuid, p_product_id, x->>'storage_bucket', x->>'storage_path', x->>'legacy_url', x->>'public_url', coalesce(x->>'alt_text',''), (n-1)::integer, (x->>'is_primary')::boolean
  from jsonb_array_elements(p_images) with ordinality as a(x,n)
  on conflict(id) do update set storage_bucket = excluded.storage_bucket, storage_path = excluded.storage_path,
    legacy_url = excluded.legacy_url, public_url = excluded.public_url, alt_text = excluded.alt_text, sort_order = excluded.sort_order, is_primary = excluded.is_primary;
  delete from public.product_faqs where product_id = p_product_id and id not in (select (x->>'id')::uuid from jsonb_array_elements(p_faqs) x);
  insert into public.product_faqs(id, product_id, question, answer, sort_order, active)
  select (x->>'id')::uuid, p_product_id, btrim(x->>'question'), btrim(x->>'answer'), (n-1)::integer, (x->>'active')::boolean
  from jsonb_array_elements(p_faqs) with ordinality as a(x,n)
  on conflict(id) do update set question = excluded.question, answer = excluded.answer, sort_order = excluded.sort_order, active = excluded.active;

  update public.products set name = btrim(p_content->>'name'), category_id = v_category,
    description = nullif(btrim(p_content->>'description'), ''), texture_description = nullif(btrim(p_content->>'texture_description'), ''),
    cooking = nullif(btrim(p_content->>'cooking'), ''), storage_instructions = nullif(btrim(p_content->>'storage_instructions'), ''),
    status = p_content->>'status', featured = (p_content->>'featured')::boolean,
    sort_order = (p_content->>'sort_order')::integer, fish_catalog_id = v_fish,
    image_url = (select coalesce(i.legacy_url, i.public_url) from public.product_images i where i.product_id = p_product_id and i.is_primary)
  where id = p_product_id returning * into v_product;
  return v_product;
end;
$$;
revoke all on function public.admin_save_product_catalog(uuid,timestamptz,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.admin_save_product_catalog(uuid,timestamptz,jsonb,jsonb,jsonb) to authenticated;

-- Legacy image editor must fail before its post-save Storage removal runs.
revoke execute on function public.admin_update_catalog_product(uuid,text,text,text,text,text,boolean,integer,uuid) from authenticated;
revoke execute on function public.admin_create_catalog_product(text,text,text,text,text,boolean,integer,uuid) from authenticated;
revoke update(image_url) on public.products from authenticated;
-- Objects are immutable uploads. Removal of gallery metadata does not delete bytes.
-- Disable old browser cleanup during transition; separate reviewed cleanup can follow.
drop policy if exists "admin delete product images" on storage.objects;

create or replace function public.admin_create_phase1_product(p_name text, p_category_id uuid, p_fish_catalog_id uuid)
returns public.products language plpgsql security definer set search_path = public, pg_temp as $$
declare v_product public.products;
begin
  if not public.is_hanjiu_admin() then raise exception 'admin_required'; end if;
  if p_fish_catalog_id is not null then
    perform 1 from public.fish_catalog where id = p_fish_catalog_id and active for update;
    if not found then raise exception 'fish_catalog_not_found'; end if;
    if exists(select 1 from public.products where fish_catalog_id = p_fish_catalog_id) then raise exception 'fish_catalog_already_used'; end if;
  end if;
  select * into v_product from public.admin_create_catalog_product(p_name, null, null, null, 'hidden', false, 100, p_category_id);
  update public.products set fish_catalog_id = p_fish_catalog_id where id = v_product.id returning * into v_product;
  return v_product;
end;
$$;
revoke all on function public.admin_create_phase1_product(text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.admin_create_phase1_product(text,uuid,uuid) to authenticated;

commit;

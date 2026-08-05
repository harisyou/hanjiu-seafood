insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do update set public = true;

drop policy if exists "public read product images" on storage.objects;
create policy "public read product images"
on storage.objects for select to public
using (bucket_id = 'product-images');

drop policy if exists "authenticated upload product images" on storage.objects;
create policy "authenticated upload product images"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images');

drop policy if exists "admin insert products" on public.products;
create policy "admin insert products"
on public.products for insert to authenticated
with check (true);

drop policy if exists "admin update products" on public.products;
create policy "admin update products"
on public.products for update to authenticated
using (true) with check (true);

drop policy if exists "admin delete products" on public.products;
create policy "admin delete products"
on public.products for delete to authenticated
using (true);

drop policy if exists "admin read all products" on public.products;
create policy "admin read all products"
on public.products for select to authenticated
using (true);

drop policy if exists "admin read orders" on public.orders;
create policy "admin read orders"
on public.orders for select to authenticated
using (true);

drop policy if exists "admin update orders" on public.orders;
create policy "admin update orders"
on public.orders for update to authenticated
using (true) with check (true);

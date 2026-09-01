-- F004-3.1 Storefront Product Categories Read Policy
-- Run manually in Supabase SQL Editor after F004-2.1 Product Category Management.
-- Separates anonymous active-category reads from the authenticated admin policy.

begin;

drop policy if exists "public read active product categories" on public.product_categories;
drop policy if exists "admin read all product categories" on public.product_categories;

create policy "public read active product categories"
on public.product_categories
for select
to anon, authenticated
using (active);

create policy "admin read all product categories"
on public.product_categories
for select
to authenticated
using ((select public.is_hanjiu_admin()));

commit;

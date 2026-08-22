-- F003-12 Phase C: run only after the Phase B application deployment is verified.
-- No ledger infrastructure or history is recreated or removed here.
revoke insert, update on public.product_variants from anon, authenticated;
revoke update (name, price, inventory, active, sort_order) on public.product_variants from anon, authenticated;

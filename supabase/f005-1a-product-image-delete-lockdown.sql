-- Forward fix AFTER the already-applied f005-1-product-catalog.sql.
-- Owner executes manually in Supabase SQL Editor. Do not rerun F005-1.
-- Only the reported bucket-specific DELETE policy is removed. Upload/SELECT,
-- other buckets, gallery metadata RPCs and all transaction systems are unchanged.
begin;

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'Allow authenticated delete'
      and (cmd is distinct from 'DELETE'
        or roles is distinct from array['authenticated']::name[]
        or qual is distinct from $qual$(bucket_id = 'product-images'::text)$qual$
        or with_check is not null)
  ) then
    raise exception 'storage_delete_policy_definition_mismatch: review policy before applying F005-1a';
  end if;
end;
$$;

drop policy if exists "Allow authenticated delete" on storage.objects;

commit;

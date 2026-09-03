import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const fix = readFileSync(new URL('../supabase/f005-1a-product-image-delete-lockdown.sql', import.meta.url), 'utf8');
const verification = readFileSync(new URL('../supabase/f005-1-product-catalog-verify.sql', import.meta.url), 'utf8');
const assertion = verification.split('-- BEGIN STORAGE DELETE ASSERTION')[1].split('-- END STORAGE DELETE ASSERTION')[0];

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema storage;
    grant usage on schema storage to anon, authenticated;
    create table storage.objects(id integer primary key, bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant select, insert, delete on storage.objects to anon, authenticated;
    create function public.is_hanjiu_admin() returns boolean language sql as
      $$ select coalesce(current_setting('test.admin', true), 'false') = 'true' $$;
    create policy "public read product images" on storage.objects for select to public
      using (bucket_id = 'product-images');
    create policy "admin upload product images" on storage.objects for insert to authenticated
      with check (bucket_id = 'product-images' and public.is_hanjiu_admin());
    create policy "Allow authenticated delete" on storage.objects for delete to authenticated
      using (bucket_id = 'product-images');
    create policy "other bucket reads" on storage.objects for select to authenticated
      using (bucket_id = 'other-bucket');
    create policy "other bucket deletes" on storage.objects for delete to authenticated
      using (bucket_id = 'other-bucket');
    insert into storage.objects values (1,'product-images','canonical.webp'), (2,'other-bucket','other.txt');
  `);
  return db;
}

test('reported policy fails verification; forward fix blocks browser deletion but preserves uploads/read/other bucket policies', async () => {
  const db = await fixture();
  try {
    // Reproduce the original name-only removal: the differently named grant survives.
    await db.exec('drop policy if exists "admin delete product images" on storage.objects');
    await assert.rejects(db.exec(assertion), /unsafe_product_image_delete_policy/);
    await db.exec('begin; set local role authenticated');
    assert.equal((await db.query("delete from storage.objects where id=1 returning id")).rows.length, 1);
    await db.exec('rollback');
    const unaffected = () => db.query("select * from pg_policies where schemaname='storage' and policyname <> 'Allow authenticated delete' order by policyname");
    const before = (await unaffected()).rows;
    await db.exec(fix);
    await db.exec(assertion);
    assert.deepEqual((await unaffected()).rows, before);
    assert.equal((await db.query('select count(*)::int as n from storage.objects')).rows[0].n, 2);
    for (const admin of [false, true]) {
      await db.exec(`set test.admin='${admin}'; set role authenticated`);
      assert.equal((await db.query('delete from storage.objects where id=1 returning id')).rows.length, 0);
      assert.equal((await db.query('select * from storage.objects where id=1')).rows.length, 1);
      await db.exec('reset role');
    }
    await db.exec("set test.admin='false'; set role authenticated");
    await assert.rejects(db.exec("insert into storage.objects values(3,'product-images','unauthorized.webp')"), /row-level security/);
    await db.exec("reset role; set test.admin='true'; set role authenticated");
    await db.exec("insert into storage.objects values(3,'product-images','new-gallery.webp')");
    assert.equal((await db.query('delete from storage.objects where id=3 returning id')).rows.length, 0);
    assert.equal((await db.query('delete from storage.objects where id=2 returning id')).rows.length, 1);
    await db.exec('reset role; set role anon');
    assert.equal((await db.query('select * from storage.objects where id=3')).rows.length, 1);
    assert.equal((await db.query('delete from storage.objects where id=1 returning id')).rows.length, 0);
    await db.exec('reset role');
    await db.exec(fix); // Already absent is a safe no-op.
    await db.exec(assertion);
  } finally { await db.close(); }
});

test('forward fix refuses a same-named policy with different scope, leaving other buckets untouched', async () => {
  const db = await fixture();
  try {
    await db.exec(`alter policy "Allow authenticated delete" on storage.objects using (bucket_id in ('product-images','other-bucket'))`);
    const before = (await db.query("select * from pg_policies where schemaname='storage' order by policyname")).rows;
    await assert.rejects(db.exec(fix), /storage_delete_policy_definition_mismatch/);
    await db.exec('rollback');
    assert.deepEqual((await db.query("select * from pg_policies where schemaname='storage' order by policyname")).rows, before);
    await assert.rejects(db.exec(assertion), /unsafe_product_image_delete_policy/);
  } finally { await db.close(); }
});

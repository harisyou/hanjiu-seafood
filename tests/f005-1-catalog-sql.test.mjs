import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
// Disposable in-memory PostgreSQL. Tests Phase 1 against an explicit minimal
// catalog baseline, not the full Supabase transaction migration chain.
test('Phase 1 migration, RLS, atomic gallery writes and stale-editor protection',async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create schema storage;
 create table storage.objects(id uuid, bucket_id text, name text);
 create policy "Allow authenticated delete" on storage.objects for delete to authenticated using(bucket_id='product-images');
 create function public.is_hanjiu_admin() returns boolean language sql as $$ select coalesce(current_setting('test.admin',true),'false')='true' $$;
 create table public.product_categories(id uuid primary key, active boolean);
 create table public.fish_catalog(id uuid primary key, active boolean);
 create table public.products(id uuid primary key default gen_random_uuid(),name text not null,category_id uuid references product_categories(id),description text,cooking text,image_url text,status text,featured boolean,sort_order integer,processing_enabled boolean,fish_catalog_id uuid references fish_catalog(id),created_at timestamptz default now());
 alter table products enable row level security;
 create policy visible on products for select using(status<>'hidden' or is_hanjiu_admin());
 grant select on products to anon,authenticated;
 create function public.admin_create_catalog_product(text,text,text,text,text,boolean,integer,uuid) returns products language sql as $$ insert into products(name,description,cooking,image_url,status,featured,sort_order,category_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning * $$;
 create function public.admin_update_catalog_product(uuid,text,text,text,text,text,boolean,integer,uuid) returns products language sql as $$ select * from products where id=$1 $$;
 insert into product_categories values('20000000-0000-4000-8000-000000000001',true);
 insert into products(id,name,category_id,image_url,status,featured,sort_order) values('10000000-0000-4000-8000-000000000001','魚','20000000-0000-4000-8000-000000000001','https://legacy/image.jpg','available',false,100);`);
 await db.exec(readFileSync(new URL('../supabase/f005-1-product-catalog.sql',import.meta.url),'utf8'));
 // Applying F005-1 alone leaves the Production-reported differently named policy.
 assert.equal((await db.query("select * from pg_policies where schemaname='storage' and policyname='Allow authenticated delete'")).rows.length,1);
 await db.exec(readFileSync(new URL('../supabase/f005-1a-product-image-delete-lockdown.sql',import.meta.url),'utf8'));
 // All gallery save/backfill/primary/RLS assertions below now run after both migrations.
 const rows=async(sql,params)=> (await db.query(sql,params)).rows;
 let product=(await rows('select *,updated_at::text as updated_at from products'))[0];
 let images=await rows('select * from product_images');
 assert.equal(images.length,1); assert.equal(images[0].is_primary,true); assert.equal(images[0].legacy_url,product.image_url);
 await db.exec('set role anon');
 assert.equal((await rows('select * from product_images')).length,1);
 await assert.rejects(db.query('select admin_save_product_catalog($1,$2,$3,$4,$5)',[product.id,product.updated_at,product,images,[]]),/permission denied/);
 await assert.rejects(db.query('delete from product_images'),/permission denied/);
 await db.exec('reset role; set role authenticated');
 await assert.rejects(db.query('select admin_save_product_catalog($1,$2,$3,$4,$5)',[product.id,product.updated_at,product,images,[]]),/admin_required/);
 await db.exec("reset role; set test.admin='true'; set role authenticated");
 const faq={id:'50000000-0000-4000-8000-000000000001',question:'可煮湯？',answer:'可以',active:true};
 const save=(p,im,fq)=>db.query('select *,updated_at::text as updated_at from admin_save_product_catalog($1,$2,$3,$4,$5)',[p.id,p.updated_at,p,JSON.stringify(im),JSON.stringify(fq)]);
 const saved=await save({...product,texture_description:'細緻'},images,[faq]);
 assert.equal(saved.rows[0].texture_description,'細緻');
 await assert.rejects(save(product,images,[]),/catalog_edit_conflict/);
 product=saved.rows[0];
 const newImage={id:'40000000-0000-4000-8000-000000000099',product_id:product.id,storage_bucket:'product-images',storage_path:`products/${product.id}/new.webp`,legacy_url:null,public_url:`https://project.supabase.co/storage/v1/object/public/product-images/products/${product.id}/new.webp`,alt_text:'新封面',is_primary:true};
 const replaced=await save(product,[newImage,...images.map(i=>({...i,is_primary:false}))],[faq]);
 product=replaced.rows[0]; assert.equal(product.image_url,newImage.public_url);
 images=await rows('select * from product_images order by sort_order,id');
 assert.equal(images[0].id,newImage.id);assert.equal(images[1].is_primary,false);
 await assert.rejects(save(product,images,[{...faq,answer:''}]),/check constraint/);
 assert.equal((await rows('select * from product_images where is_primary')).length,1);
 await assert.rejects(save(product,images.map(i=>({...i,is_primary:false})),[]),/gallery_primary_required/);
 assert.equal((await rows('select * from product_faqs')).length,1);
 const updated=await save(product,[],[{...faq,active:false}]);
 assert.equal(updated.rows[0].image_url,null); assert.equal((await rows('select * from product_images')).length,0);
 await db.exec("reset role; set test.admin='false'; set role anon");
 assert.equal((await rows('select * from product_faqs')).length,0);
 await db.exec("reset role; update products set status='hidden'; set role anon");
 assert.equal((await rows('select * from products')).length,0);
 await db.exec("reset role; update product_faqs set active=true; insert into product_images(product_id,legacy_url,is_primary) select id,'https://legacy/hidden.jpg',true from products; set role anon");
 assert.equal((await rows('select * from product_images')).length,0);
 assert.equal((await rows('select * from product_faqs')).length,0);
 await db.exec("reset role; set test.admin='true'; insert into fish_catalog values('60000000-0000-4000-8000-000000000001',true); set role authenticated");
 const created=(await rows('select * from admin_create_phase1_product($1,$2,$3)',['新魚',product.category_id,'60000000-0000-4000-8000-000000000001']))[0];
 assert.equal(created.status,'hidden');
 await assert.rejects(db.query('select * from admin_create_phase1_product($1,$2,$3)',['重複魚',product.category_id,'60000000-0000-4000-8000-000000000001']),/fish_catalog_already_used/);
 } finally { await db.close(); }
});

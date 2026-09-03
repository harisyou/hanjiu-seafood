# Phase 1 Catalog: manual deployment and verification

## Scope and safety

Homepage catalog → `/products/[id]` → legacy variants → shared cart → existing
`/#order`. No physical-stock/preorder-demand implementation. No transaction data
cleanup, checkout RPC/payload/fingerprint changes, or processing surcharge.

**Only the repository owner executes Production SQL in Supabase SQL Editor.**
Neither application startup, build, Preview nor CI runs migrations. A Preview
pointed at a database without F005-1 will show content-loading errors; it is not
permission to run SQL automatically. Prefer a separate staging Supabase project.

## Execution order

1. Review `docs/production/MIGRATION_MANIFEST.md`. Confirm the existing F004-1,
   F004-2.1 (including any previously approved correction), F004-2.2, F004-3.1 and
   F004-3.3 schema/permissions. Do not rerun historical files blindly.
2. Back up products, category/processing relationships and Storage references.
   Record transaction counts and transaction RPC definition hashes using the last
   two queries in `supabase/f005-1-product-catalog-verify.sql` BEFORE migration.
   Inventory/checkout activity can change counts; compare during an agreed quiet
   verification window, not by disabling safety triggers.
3. Pause admin catalog/image editing and close old editor tabs. This migration
   revokes the old catalog create/update RPC grants and browser Storage deletion.
   Existing storefront checkout remains unchanged. Keep this maintenance window
   short and deploy the new admin immediately after verification.
4. Manually run **`supabase/f005-1-product-catalog.sql` once**. It wraps all changes
   in a transaction. It is not a rerunnable seed. If a table/trigger already exists,
   stop and reconcile applied state; do not delete it to force a rerun.
5. Manually run **`supabase/f005-1-product-catalog-verify.sql`**. Expected results
   are annotated in the file. Verify Storage has no additional DELETE/ALL policy
   permitting browser deletion of referenced product-images objects.
6. Deploy this application version with its normal Supabase URL/anon key. Confirm
   the metadata schema is visible through the API. Reopen admin tabs.
7. Perform the UI verification below, then reopen catalog editing.

## Schema and image behavior

- Existing products/UUIDs/categories/variants/processing associations stay intact.
- Products gain texture_description, storage_instructions and updated_at.
- product_images/product_faqs have RLS; only versioned admin RPC writes metadata.
- Existing nonblank image_url becomes one primary gallery record. Legacy URLs
  are retained verbatim, including external URLs; no files are downloaded or moved.
- New uploads use `products/<product UUID>/<image UUID>.webp` in product-images.
  Source metadata stores bucket/path/public URL; the public URL is obtained from
  the configured Supabase client. The DB projects primary URL into image_url.
- Primary selection/order/removal, FAQ and content save atomically. updated_at
  conflicts reject stale editors instead of silently overwriting newer content.
- No image bytes are deleted. Failed/abandoned uploads may leave orphan objects;
  a separate reviewed cleanup can remove unreferenced objects after retention.
- Public bucket remains public. Hidden product does not make a known image URL private.
- No UNIQUE(fish_catalog_id), merge, deletion or variant reparenting. New editor
  associations and new catalog creation reject used fish IDs; existing duplicate
  associations remain editable. Legacy operational paths remain, so this is not
  a universal future one-fish-one-product database invariant.
- Existing inactive category assignment may be retained while editing catalog
  content. New assignments/creation require an active category. Public category
  RLS remains unchanged; inactive category labels may be absent, products remain visible.

## Exact UI verification after SQL

Use isolated staging fixtures for writes and checkout tests, not real purchases.

1. Anonymous window: open `/`; confirm search/category/only-in-stock/loading/error/
   empty states and catalog links. No variant, quantity or add button on cards.
2. Open a visible `/products/<UUID>`; verify all content fields, primary/full gallery,
   thumbnail selection, swipe, optional FAQ, available configured processing and
   the pre-processing weight notice. No fake future stock/preorder tabs.
3. Hidden/nonexistent UUID: HTTP 404. sold_out: HTTP 200 with information but no
   enabled legacy purchase. An inactive category must not hide its products.
4. Stock=10/preorder=true: quantity 1 and 10 no extra notice; 11 and 20 show the
   quantity-area overage notice. Stock=0/preorder=true clearly says preorder.
   Stock=10/preorder=false: no overage notice, plus button stops at 10.
5. Add product A → homepage → product B → add B → checkout → refresh. Both lines,
   quantities and processing remain. Same variant with different processing is
   rejected; same processing merges. Cart is refreshed against all products.
6. In staging simulate a transient checkout failure: retry uses the same key;
   cart is retained. Existing checkout integration harness verifies real DB
   locking only when an explicit disposable DB is configured.
7. Admin `/admin`: create a hidden catalog product; used fish ID is blocked.
   `/admin/inventory/<UUID>`: edit content, upload multiple images, reorder, choose
   cover, remove, edit alt text; add/reorder/disable/delete FAQ; save and reload.
   Confirm homepage cover and detail agree. Removing all images clears fallback.
8. Open two editors: save one, save stale second; expect conflict with no overwrite.
   Existing duplicate fish product must still open/save without changing its ID.
9. Signed-out/non-admin users cannot call save/create RPC or directly mutate either
   metadata table. Public API must not return hidden product images/FAQs.
10. At 320/375/390 and 1024/1440 widths verify NT$499 and NT$12,999 are unclipped,
    no document horizontal overflow, gallery scroll stays inside the gallery,
    cart drawer and checkout remain usable.

## Automated checks

`pnpm install --frozen-lockfile`

`node --test tests/*.test.mjs tests/integration/*.test.mjs`

`node node_modules/typescript/bin/tsc --noEmit`

`node node_modules/next/dist/bin/next build`

F005 SQL tests use disposable in-memory PostgreSQL (PGlite) with an explicit minimal
catalog baseline. They do not prove the full Supabase migration chain, Storage API
or concurrent network sessions. Component tests execute the real storefront shell
with mocked data/navigation and exercise route updates, refresh and retry behavior.
The existing two opt-in psql cases remain skipped without a configured isolated DB.

For local browser QA: run `node tests/helpers/catalog-fixture-server.mjs`, then
start Next dev on 3001 with process-only NEXT_PUBLIC_SUPABASE_URL set to
`http://127.0.0.1:54329` and NEXT_PUBLIC_SUPABASE_ANON_KEY=`catalog-fixture-anon`.
The fixture API is local/read-only and refuses checkout writes. Never commit these
values to environment files or use a fixture build as a production artifact.

## Rollback / forward fix

- Migration failure before COMMIT rolls back metadata/schema changes. Inspect the
  error and existing state before retrying; do not drop live tables.
- Prefer a forward fix. Retain new columns/tables, uploaded objects and all
  transaction records. Never disable inventory/payment/RLS guards.
- An emergency app rollback can restore legacy storefront reads because image_url
  is kept in sync. Keep old catalog editors disabled until a reviewed follow-up
  coordinates the writer switch; do not simply restore old image-delete behavior.
- Do not drop gallery/FAQ tables or delete objects on rollback. A later deliberate
  writer rollback needs backups, permission review and reconciliation of primary
  metadata, not an automatic destructive down migration.

## Deferred

Physical fish items, structured raw weight/prices, preorder demand/configuration,
weight sliders, tier pricing, allocation, wallet, new payment architecture,
fulfillment batches/split shipments, transaction cleanup and species uniqueness.

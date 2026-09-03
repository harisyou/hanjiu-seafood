# PR #40: Phase 1 UI cleanup validation

Date: 2026-09-03. Existing branch: `codex/phase1-product-catalog`.
Takeover head: `5ce561471848898c3bc157c61b8a84510197c585`; clean worktree, fetched remote, PR open and Draft.

## Deployment boundary

The owner confirms **F005-1 and F005-1a have both already succeeded in Production**.
This revision is frontend-only: **no migration, no SQL to apply, and no rerun of either migration**.
No Production SQL was executed. No merge was performed.
Earlier deployment instructions describe the historical initial rollout, not an action for this UI revision.

## Changes and confirmed root causes

- Return navigation: shared `.hero nav` used absolute positioning even on detail pages without a hero image. The header occupied no space and its hit area overlapped the return link. Detail/404 headers now occupy normal flow; both return links target `/#catalog`, backed by the real catalog section ID.
- Missing-product purchase shell: the persistent layout rendered its purchase section whenever the URL matched `/products/:id`, even if the server page called `notFound()`. Rendering now requires a matching visible catalog product. Missing, malformed and hidden IDs have no purchase heading, selector, processing controls or add-to-cart button.
- Main catalog/detail photos use a stable 4:3 frame with `object-fit: contain`, including legacy portrait/square assets and placeholders. Gallery slides declare 1600×1200 dimensions; thumbnails are 76px. Admin recommendations are advisory, not a new upload constraint.
- Desktop detail: 500px gallery alongside title, readable introduction, compact attributes and FAQ accordion. Purchase starts at approximately document y=625px in the fixture at 1024/1440. Mobile uses one column and the same asset, without duplicate purchase descriptions.
- Purchase retains existing variant/price/supply/processing/quantity actions, but removes repeated title, description and cooking copy. No purchasable variants produces a compact disabled sold-out notice.
- Catalog keeps three desktop columns, one mobile column, aligned price/CTA slots and 4:3 cards. Hero height is capped through CSS only; hero assets are unchanged. Mobile categories have an explicit swipe hint and compact in-stock toggle. Existing floating cart is smaller with adjusted offsets; drawer/state architecture is untouched.
- Admin image/FAQ actions are compact secondary controls; remove is subtle danger, primary cover and unavailable move actions are disabled. Save remains primary; add FAQ/reload are secondary, with separated status feedback.

## Automated validation

- `node --test tests/*.test.mjs`: **192 passed, 0 failed, 0 skipped**.
- `node --test tests/integration/*.test.mjs`: **2 skipped**, since no explicitly configured disposable external PostgreSQL/psql environment exists. Production was not substituted.
- `node node_modules/typescript/bin/tsc --noEmit`: **passed**.
- `node node_modules/next/dist/bin/next build`: **passed**, Next.js 15.5.22, all 14 static pages generated. Built from a clean staged-source export outside OneDrive with the installed dependencies; latest shell adjustment was included and rebuilt successfully.
- Existing audited-main SHA-256 checks for cart actions and checkout submit still pass. No payload, fingerprint, idempotency, inventory, payment, order or processing snapshot logic changed.
- Existing PGlite migration/RLS/gallery tests pass, including retained Storage objects and disabled browser deletion. These tests execute only in disposable memory; neither migration file was edited.
- Added UI contracts and real rendered-component missing/hidden/sold-out cases. `tests/browser/catalog-ui.mjs` executes real link clicks/navigation, 404 return links, image geometry, card columns and price clipping through the supported Browser tab API, rather than only checking href strings.

## Browser results (local isolated fixture, not a fresh Production audit)

| Width | Catalog/detail/admin horizontal overflow | Detail gallery | Return link |
| --- | --- | --- | --- |
| 320 | none | 273 × 204.75 | passed |
| 375 | none | 328 × 246 | passed |
| 390 | none | 343 × 257.25 | passed |
| 1024 | none | 500 × 375 | passed |
| 1440 | none | 500 × 375 | passed |

The Windows browser reserves a scrollbar gutter, so content width is slightly less than requested viewport width. Ratio is 4:3 at every size; switching between 1600×1200 and legacy 600×1200 images does not change the frame. `contain` retains the whole image. NT$499 / NT$12,999 are unclipped in catalog cards; NT$12,999 purchase price is also unclipped at all five widths.

A. Homepage → detail → actual return-link click reaches `/#catalog`: passed at all five widths.

B. Malformed, nonexistent valid UUID and hidden UUID: not-found UI only, no purchase shell; return link works.

C. Added a fixture item, reloaded, returned to homepage and opened the original drawer: quantity/subtotal and both existing cart lines remained (3 items / NT$13,997). No checkout was submitted.

D. Search for 黑喉 returned one item; only-in-stock returned 馬頭魚/黑喉; 蝦類 returned the empty state; reset restored all four visible products.

E. Disposable admin fixture: edited texture and FAQ answer, moved gallery order, selected another cover, removed a gallery relation, saved, reloaded and verified the remaining cover/content in the public detail page. Buttons measured 54–87px, not full-width, across all five sizes. This checks UI/RPC wiring; actual database atomicity/authorization is covered separately by PGlite tests, not by the HTTP mock. Upload/compression code is unchanged; no new live Storage upload was performed in this cleanup pass.

F. Remove remains a local gallery-list update followed by the existing save RPC, with no Storage delete call. Existing SQL tests validate that gallery removal leaves the underlying Storage object. The fixture never allows Storage writes/deletes and connects to no Supabase instance.

G. Sold-out fixture: compact notice, disabled sold-out button, no variant selector. Existing component tests retain preorder/inventory quantity rules, including 1/10/11/20 boundaries and non-preorder limits.

Development-only observations: repeated Supabase client warnings during HMR, and one native FAQ `open` hydration warning after an automation click before hydration completed. After waiting for hydrated purchase controls, reload/FAQ interaction did not add another hydration error. No security/client-creation refactor was made for these observations.

## Reproduction

Run `node tests/helpers/catalog-fixture-server.mjs` (loopback read-only default), then Next dev on port 3001 with `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54329` and a dummy anon key. Use the Browser skill to import `tests/browser/catalog-ui.mjs` and call `runCatalogUiRegression(tab, viewport)`. Start with fresh fixture memory (two gallery images), reset the viewport when done.

For local admin UI checks only, restart the fixture with `CATALOG_FIXTURE_ADMIN=1`; sign in to the local app using synthetic `fixture@example.test` / `local-fixture-only`. This opt-in mock changes disposable memory only; it is not an authentication/security test or an app route and must never be used as a deployed backend.

Changed production files: `app/catalog.css`, both detail page/not-found components, `components/storefront-shell.tsx`, `components/product-gallery.tsx`, `components/admin-catalog-editor.tsx`. Remaining changes are tests, fixtures and this validation record.

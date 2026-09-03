# PR #40 final Desktop polish

2026-09-03. Starting revision: `710b7607af989dd4ba3305677cdb3a696bc231a2`.
Existing branch `codex/phase1-product-catalog`; no new PR, no merge.

## Layout

- Desktop breakpoint: 1024px. Product composition max-width **1280px**, width `calc(100% - 64px)`, centered. Homepage/error layouts are not opted into this grid.
- At 1280px viewport and above: gallery **550px**, 4:3 / contain unchanged, 48px top-column gap, remaining width for product information. At narrower desktop widths columns shrink proportionally; no hard minimum that causes overflow.
- Product introduction keeps its full paragraphs, 16px / 1.85 line-height. Attributes become two equal columns with natural heights, no truncation or line clamp; below desktop they retain the accepted single-column presentation.
- Lower composition: FAQ / purchase columns **5:7**, 32px gap, aligned at the top. Purchase max-width **700px**, shrinking as needed. Without FAQ, purchase spans the grid and is centered: no reserved empty FAQ column.
- A presentation-only wrapper allows the existing server-rendered product page and persistent client purchase section to share a CSS grid. Desktop `display: contents` on the detail article exposes its top section and FAQ to that grid. Purchase remains in its existing component; no state registration, portal, duplicate controls or cart remount was introduced.
- Mobile DOM order remains gallery → title/description/attributes → FAQ → purchase. Existing header/cart, gallery component, purchase controls, sold-out block and accordion implementation are unchanged.

## Validation

- Full regression: **193 passed, 0 failed, 0 skipped** (`node --test tests/*.test.mjs`).
- External PostgreSQL integration: **2 skipped**, because no explicitly configured disposable PostgreSQL/psql environment is available. No Production substitute.
- TypeScript: **passed** (`node node_modules/typescript/bin/tsc --noEmit`).
- Next.js 15.5.22 production build: **passed**, 14 static pages generated. Clean staged-source export outside OneDrive, using installed dependencies.
- New regression hashes the entire accepted purchase section from revision 710b760: byte-identical. Existing checkout/cart action hashes also pass.
- Browser fixture stress mode (`CATALOG_FIXTURE_LAYOUT=1`) provides a multi-paragraph 馬頭魚 with long attributes/FAQ, a short 白蝦 with few attributes/no FAQ, and a sold-out product. These are synthetic loopback fixtures, not edits to real catalog data.

| Viewport | Long-text content / gallery / purchase width | Short/no FAQ | Sold out | Overflow |
| --- | --- | --- | --- | --- |
| 390 | 375 / 343 / 375px | single column | compact disabled | none |
| 1024 | 945 / 409 / 533px | centered 700px purchase | compact disabled | none |
| 1440 | 1280 / 550 / 700px | centered 700px purchase | compact disabled | none |
| 1920 | 1280 / 550 / 700px | centered 700px purchase | compact disabled | none |

Widths include the Windows browser scrollbar gutter. At 1440/1920 the information column is 682px and attribute columns are 329px each. Long content increases row height naturally; short content does not reserve space for absent attributes or FAQ. Desktop FAQ and purchase share the same top coordinate. At 390, FAQ remains above purchase. All twelve combinations pass text-clipping, image-ratio, control availability and overflow assertions.

Browser automation is in `tests/browser/catalog-ui.mjs`: call `runDesktopPolishRegression(tab, viewport)` through the Browser skill with the local stress fixture. The existing `runCatalogUiRegression` now includes 1920px and retains real click/navigation, missing/hidden/404, thumbnail frame, price and catalog-column checks.

Both browser suites passed. Real return clicks and malformed/nonexistent/hidden 404 checks also passed at the additional 320/375 sizes. At 390px, incremented the short-product quantity to 2, added it, reloaded and returned to catalog: total cart quantity persisted from 3 to 5, and the original drawer showed both retained lines (NT$39,995). No checkout was submitted.

No migration was added, changed or rerun. No Production SQL or live catalog writes were performed. Checkout payload/fingerprint/idempotency, inventory/ledger, payment/reversal, cancellation/restock, processing/supply snapshots, RLS, Storage, F005-1 and F005-1a remain unchanged.

## Files

- `app/catalog.css`: desktop-only composition and typography.
- `app/(storefront)/products/[id]/page.tsx`: FAQ moved after top information grid.
- `components/storefront-shell.tsx`: two-line presentation wrapper, no purchase/state changes.
- `tests/browser/catalog-ui.mjs`: extended responsive geometry/navigation coverage.
- `tests/helpers/catalog-fixture-server.mjs`: opt-in long/short content fixtures.
- `tests/f005-1-ui-cleanup.test.mjs`: accepted purchase markup hash regression.
- This validation report.

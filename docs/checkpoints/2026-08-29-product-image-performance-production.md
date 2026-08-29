# Product Image Performance — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Production code SHA: `8d2d20688de4ca3a358c83e602b2559b46512a4b`
- Release branch: `codex/product-image-performance`
- Successful GitHub Actions run: `33247848481` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=8d2d20688de4`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `55` (unchanged; no migration)

## Delivered behavior

- `InventoryItem.image` and `ProductGroup.coverImage` remain the PostgreSQL Base64 original-image authority; InventoryItem identity and all product business fields are unchanged.
- Product and POS list queries no longer read or return the Base64 payload. They return `hasImage`/`hasCoverImage` plus version metadata while lightweight ID-only queries establish image presence.
- Product Center cards, POS cards, grouped-product cards, combo choices, and the variant sheet use on-demand 320px WebP thumbnails.
- Product editing loads the versioned original image only when the editor is opened. Saving non-image fields omits the image payload and preserves the original.
- Images use IntersectionObserver-backed lazy loading plus native `loading=lazy` and async decoding.
- A matching `updatedAt` version receives `private, max-age=31536000, immutable`; an absent or stale version receives `private, max-age=0, must-revalidate`. ETag is enabled.
- Thumbnails are generated on demand with Sharp and held only in a bounded in-process derived cache. No second product or image authority was created.

## Production performance evidence

- Product Center Desktop cold first screen: list `14,618 B` + groups `6,531 B` + 5 WebP thumbnails `26,542 B` = `47,691 B`; ready in `516 ms`.
- Product Center before: list response about `10.02 MB`, decoded JSON about `13.97 MB`, ready in about `6.53 s`; all 153 originals were embedded.
- POS Desktop cold first screen: 24 WebP thumbnails / `144,882 B` (before: 118 originals / `10,223,225 B`).
- POS iPad 1024×768 cold first screen: 29 WebP thumbnails / `168,267 B` (before: 118 originals / `10,223,225 B`).
- POS 375×812 cold first screen: 12 WebP thumbnails / `57,460 B` (before: 36 originals / `3,549,430 B`).
- Product Center rendered 118 image nodes but attached only 5 Desktop and 4 mobile/iPad sources in the initial viewport.
- POS and Product Center had no horizontal overflow at measured 375px, 1024px, and 1440px viewports.

## Verification and data safety

- Image performance contract: PASS 4/4.
- Product Center + POS WebKit targeted suite: PASS 39/39.
- Exact production gate WebKit suite: PASS 70/70.
- Production build: PASS.
- Versioned thumbnail response: `image/webp`, immutable one-year private cache, ETag present.
- Stale-version response: `image/webp`, `must-revalidate`.
- Variant Bottom Sheet: five visible variants used versioned product thumbnail URLs; no cart or order was created during smoke.
- Product editor: preview used the versioned `/image` original endpoint and was cancelled without saving.
- Production backup, migration-55 authority, InventoryItem core digest, ProductGroup/member digest, and historical transfer, purchase, mailing, invoice, and partner-supply digests reconciled unchanged.

## Deployment notes

- Run `33245595717` stopped before production mutation because a stale gate required the legitimate ProductGroup state to remain empty. Production was still healthy at `aaa7dd39ac07`.
- Read-only production inspection confirmed 12 groups and 56 grouped variants. The gate was replaced with structural integrity checks plus an exact ProductGroup/member digest; no production data was altered.
- Run `33246190621` deployed the first thumbnail/lazy-loading release at `106397666673`.
- Run `33247848481` deployed the final query optimization at `8d2d20688de4`; it removed internal Base64 reads from Product Center and POS list queries.

## Rollback

- Both successful blue/green releases created fresh protected PostgreSQL backups and application/nginx rollback assets.
- No schema or data migration is required to roll back this release.

# budu Brand Slot Border Hotfix Checkpoint

Date: 2026-09-01 (Asia/Shanghai)

## Scope and root cause

- Scope was limited to the shared navigation brand slot in `src/components/BrandSlot.jsx`.
- Both controlled assets were already genuinely transparent and retained their approved hashes.
- The visible boxes came from the legacy global `img` rule in `src/index.css`, which adds a 1 px semi-transparent outline to every image. Because the icon and SVG wordmark are two `<img>` elements, the rule drew one box around each asset.
- The hotfix adds a shared, component-local transparent/borderless presentation object to both brand assets. It does not change the global image rule or any unrelated image surface.
- The approved character icon, canonical lowercase `budu` wordmark, spacing, navigation layout and absence of `甜蜜治愈日常` are preserved.

## Verification

- Brand authority tests: 7/7 PASS.
- WebKit brand-slot tests: 8/8 PASS across 320, 340, 375, 390, 430 and desktop; computed background, border, shadow and outline are transparent/none.
- Home/navigation WebKit regression: 5/5 PASS.
- 390 px Retina screenshot inspection: PASS; no box, overflow, clipping, blur or deformation.
- Production build: PASS.
- Public icon SHA-256 remains `cf6222f41ca8731295cc6bd2e7dde6346920f56a6d41e4ce4d81f953070d93a2`.
- Production Dashboard chunk SHA matches the exact local build and contains the scoped borderless style markers.

## Production

- Previous runtime: `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`.
- Deployed runtime: `cc63b1857782929992ab391d616586240b592619`.
- Production container: `budu-prod-cc63b18-brand-border`.
- Database: `budu_bj006`; migration ledger 62; failed migration count 0.
- Public/internal health: PASS; canonical writer count: 1.
- Migration and production business-data writes: NONE.
- Previous runtime `budu-prod-f7fd6e5-brand-slot-r2` remains stopped and recoverable.
- Protected rollback evidence: `/opt/budu/.rollback-assets/brand-border-cc63b18-20260901T024743Z`.

## Handoff

- Candidate branch: `codex/budu-brand-slot-border-hotfix`.
- Runtime commit is `cc63b1857782929992ab391d616586240b592619`; any later commit on the branch is documentation-only.
- Recover from remote Git, then revalidate runtime SHA, database, migration, health and writer before making further production claims.

# BUDU Brand Slot Logo Production Checkpoint

Date: 2026-09-01

## Scope

- Replaced the system navigation brand-slot graphic with the user-approved simple character icon.
- Preserved the canonical lowercase `budu` wordmark without geometry, case, font, or color changes.
- Removed `甜蜜治愈日常` from this brand position.
- Consolidated desktop sidebar and mobile drawer rendering in `src/components/BrandSlot.jsx`.
- Included the previously verified PWA cache takeover (`budu-shell-v18`) so stale installed sessions receive the release.

## Controlled assets

- Approved source: `brand/source/budu-brand-slot-icon-source.png`.
- Source SHA-256: `0a64969e00313d33093734f6438720206c832e730289c2b73309097aa8083745`.
- Transparent web derivative: `brand/web/budu-brand-slot-icon.png`.
- Web derivative SHA-256: `cf6222f41ca8731295cc6bd2e7dde6346920f56a6d41e4ce4d81f953070d93a2`.
- Processing was limited to transparent cropping and balanced clear space; source pixels were not redrawn, recolored, stretched, or compressed.

## Verification

- Brand authority tests: 7/7 PASS.
- Brand WebKit tests: 8/8 PASS, including sidebar widths 320, 340, 375, 390 and 430 px plus desktop.
- Home/navigation WebKit smoke: 5/5 PASS.
- Notification unread regression: authority PASS and WebKit 4/4 PASS.
- Production build: PASS.
- Production static asset SHA matches the controlled derivative; the deployed Dashboard chunk references that asset and contains no `甜蜜治愈日常` reference.
- An unrelated full critical run retained pre-existing Daily Entry/Payroll test debt (ledger-card timeouts and one shadow-calculator assertion); no affected file belongs to this scoped diff, and targeted release gates passed.

## Production

- Previous runtime: `2a23f0b0c7d2a8069302ee524103d4e5e4a27d73`.
- Candidate branch: `codex/budu-brand-slot-logo`.
- Deployed runtime SHA: `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`.
- Production container: `budu-prod-f7fd6e5-brand-slot-r2`.
- Database: `budu_bj006`; migration ledger 62; failed migration count 0.
- Public/internal health: PASS; canonical production writer count: 1.
- Migration and production business-data writes: NONE.
- The first cutover attempt automatically restored the old runtime because its host-side health parser required unavailable Node. Production authority was verified after rollback; the corrected curl-based cutover then passed.
- Protected rollback evidence:
  - `/opt/budu/.rollback-assets/brand-slot-f7fd6e5-20260901T014854Z`
  - `/opt/budu/.rollback-assets/brand-slot-f7fd6e5-20260901T015031Z-r2`
- Previous runtime `budu-prod-2a23f0b-brand-payroll` remains stopped and recoverable.

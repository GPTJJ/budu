# budu Sweet Card 1.0 — Commercial Release R1

Final decision: **READY_FOR_XIDAN_COMMERCIAL_LAUNCH**.

Verified 2026-09-05, Asia/Shanghai. Model configuration is
`MODEL_CONFIGURATION_NOT_VERIFIABLE`; no model switch is claimed.

## Production result

- Runtime SHA: `fe4a7254a0ec9a68390cefe12b0766b3ec15ef93`.
- Routed runtime: `budu-prod-fe4a725-sweet-card-r1-ready`.
- Canonical database: `budu_bj006`.
- Migration ledger: 65 applied / 0 failed.
- Internal and public health: PASS. Nginx routes to the exact runtime and there
  is one application writer for the canonical database.
- Sweet Card global flag remains enabled for the established test path. The
  commercial flag `XIDAN_SWEET_CARD_COMMERCIAL` remains **DISABLED**.
- No `BUDU-SC-202609-A01` batch, card, order, settlement, payment or refund was
  created by this release gate.

## Batch-purpose authority

`SweetCardBatch.businessPurpose` is the single canonical batch-purpose field.
It uses the closed `SweetCardBatchPurpose` enum with `ACCEPTANCE_TEST` and
`COMMERCIAL`. The existing free-text `purpose` column remains descriptive notes;
batch name, notes, prefixes and display labels are not classification authority.

No reusable stable typed field existed, so additive Migration 65
`20260905130000_sweet_card_batch_purpose_authority` was added. It introduced the
enum, required column and `(business_purpose, created_at)` index. It did not
change balance, Ledger, Redemption, Refund, settlement, Payment or the Migration
64 concurrency functions.

The migration classified the three pre-authority batches as
`ACCEPTANCE_TEST`. This is based on the verified release history that no
commercial batch or commercial launch had been approved before the authority
was introduced, together with the creation timestamps, audit trail, card/order
facts and P0-P19 reports. The post-P19 batch named `测试` remains intact: one
`CREATED`, unactivated 50,000-cent card, with no redemption or refund. Its name
is corroborating evidence only and was not used as the authority.

## Report contract and reconciliation

- Financial and Ledger reconciliation always uses `ALL_REAL_FACTS`.
- Commercial overview, batches, cards and usage default to
  `businessPurpose=COMMERCIAL`.
- Acceptance reporting explicitly uses `businessPurpose=ACCEPTANCE_TEST`.
- An explicit `ALL` view is available for operational comparison.

Production API and restored-backup checks both returned:

- ISSUE 50,150 - REDEEM 150 + REFUND 90 = balance 50,090 cents.
- Ledger sum 50,090 cents; unexplained delta 0.
- Acceptance/test outstanding 50,090 cents across 3 batches and 3 cards.
- Commercial outstanding 0 cents; 0 commercial batches and 0 commercial cards.

The 50,000-cent test card is therefore present in the full financial ledger and
excluded from the default commercial operation report.

## Current canonical backup

`CURRENT_CANONICAL_RESTORE_ARTIFACT`:

`/opt/budu/.rollback-assets/sweet-card-r1-fe4a725-20260905/current-canonical-budu_bj006-m65.dump`

- SHA-256:
  `c97d77a37efdefc47cf397aff6181fde1380ee37f6ad9174ef7795fb5925b773`.
- Restore-list entries: 6,102.
- Source identity: `budu_bj006|65|0|3|3`.
- Isolated restore identity: `budu_r1_current_restore|65|0|3|3`.
- Dump, restore list, identity and restore-verification checksums: PASS.
- Isolated restore and financial reconciliation: PASS.

The earlier
`production-budu_bj006-m64-post-p19.dump` is retained and marked
`P19_ACCEPTANCE_BASELINE`; it predates the later 50,000-cent test card. The two
dumps taken from the unrelated database `budu` remain protected by
`DO-NOT-RESTORE-noncanonical-budu.txt`. No backup was deleted.

## Xidan commercial capability

The stable authority is `User.permissions.sweetCardPosRedeem`, bound to
authenticated `User.id`. Commercial redemption additionally requires the
server commercial flag, the existing `store-pos` permission, xidan store scope,
and the eligible `SweetCardStorePolicy` keyed by `Store.key`.

Three verified xidan POS principals are authorized: `4e96854b…`, `7bf092be…`
and `f92d1e20…`. The final authorized count is **3**. The formal API wrote every
grant and its audit record and mirrored the resulting user permissions.

An unrouted, database-read-only candidate of the exact production image enabled
commercial mode only for the access test. The matrix passed:

- authorized xidan operator: ALLOW;
- xidan operator with the capability temporarily removed: DENY;
- authorized operator at another scoped store (`guanshe`): DENY;
- request-body `operatorId` spoof: DENY 403;
- ordinary POS access to Sweet Card administration: DENY 403.

The temporary removal was restored through the same audited API and all three
operators then passed the xidan ALLOW check. The candidate was removed. The
routed production commercial flag was never enabled.

## Final regression and rollback

POS products/orders, cash history, official WeChat payment/refund query,
official Alipay payment/refund query, Report Center, Sweet Card commercial and
acceptance reports, full Ledger reconciliation, permissions, internal/public
health and single-writer verification all passed. Sweet Card economic facts and
Payment/Refund row counts were unchanged across the regression. No HTTP 5xx was
observed in the routed runtime during this gate.

The pre-M65 dump and exact pre-cutover runtime/nginx/environment artifacts remain
under `/opt/budu/.rollback-assets/sweet-card-r1-fe4a725-20260905`. The additive
rollback refuses to drop the purpose authority if any `COMMERCIAL` batch exists.
The current database has none.

## Skills

USED: `budu-task-router` (STRICT), `budu-context`, `budu-data-authority`,
`budu-payment-safety`, `budu-sweet-card`, `budu-production-deploy`,
`budu-regression`, `budu-handoff`, `budu-mobile-ui`, and
`budu-brand-system`.

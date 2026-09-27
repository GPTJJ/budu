# Store Transfer 2.0 Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

Status: **VERIFIED — deployed and reconciled**

## Release authority

- Release branch: `codex/store-transfer-2`
- Previous production SHA: `ae08380290e2d444ab8c76f6ea6e941b6b3dd9c9`
- Production runtime SHA: `3f326ee46d82eab59444f4983fb0fa4ab9c8a2d8`
- Production environment: `prod`
- Canonical database: `budu_bj006`
- Migration ledger: `49 → 50`
- Added migration: `20260828230000_store_transfer_2_audit_fields`
- Deployment workflow: <https://github.com/GPTJJ/budu/actions/runs/33188693264>
- Post-deployment read-only audit: <https://github.com/GPTJJ/budu/actions/runs/33189746569>

The release used the authority-aware blue/green path. The candidate first ran
read-only and unrouted, then the old writer was stopped before the candidate was
started as the single writer and nginx was switched. Public health verified the
runtime SHA, database connectivity, and migration ledger after cutover.

## Delivered product contract

- The module is named **门店调拨** and has separate record and creation screens.
- The business flow ends at `待备货 → 已发货`; it has no receipt confirmation,
  stock mutation, stock validation, reservation, or in-transit inventory model.
- New records require distinct canonical 调出门店 and 调入门店. The UI and API
  both return `调出门店不能与调入门店相同` for a same-store request.
- Product and material drafts are isolated. Products support batch quantity plus
  per-line editing; materials each have an independent positive-integer quantity.
- Submission uses a separate confirmation sheet. Pending records can be withdrawn
  without physical deletion; shipped records cannot be ordinarily withdrawn.
- Shipping records the shipper and time without changing inventory.
- Notifications are scoped to eligible personnel at the 调出门店 and deep-link
  to the exact formal transfer record.
- Excel exports one row per detail. The branded image export is generated from
  formal record data on a dynamic-height Canvas, not from a DOM screenshot.
- Legacy records do not receive invented item codes or timestamps; unavailable
  values render as a dash or remain hidden.

## Verification evidence

- Critical test gate: `PASS 54 / FAIL 0`.
- Transfer + Invoice + Mailing + Customer Request WebKit gate: `41 passed`.
- Notification integration: `16 passed / 0 failed`.
- Store-transfer pure contract tests: `4 passed / 0 failed`.
- Production candidate build: passed.
- Candidate internal smoke before routing: passed.
- Nginx configuration test and public health after routing: passed.
- Responsive transfer coverage: 320, 375, 430, and 768 px with no horizontal
  overflow; the wider shared QR-only suite also passed through 1440 px.

The first candidate run
<https://github.com/GPTJJ/budu/actions/runs/33188235701> stopped in the isolated
pre-deployment test environment because two test expectations were stale. It did
not reach production backup, migration, or routing. The corrected candidate was
then rerun through the full gate above.

## Historical transfer reconciliation

The same read-only aggregate audit was run before implementation and after the
production cutover. Every value below was identical.

| Measure | Before | After |
| --- | ---: | ---: |
| Transfer records | 19 | 19 |
| Transfer item rows | 159 | 159 |
| Earliest createdAt | 2026-08-08T07:45:45.789Z | 2026-08-08T07:45:45.789Z |
| Latest createdAt | 2026-08-28T08:03:30.461Z | 2026-08-28T08:03:30.461Z |
| Status `completed` | 15 | 15 |
| Status `rejected` | 4 | 4 |
| Product item rows | 111 | 111 |
| Material item rows | 48 | 48 |
| Other item rows | 0 | 0 |

调出门店 distribution remained `guanshe=16`, `tongying=2`, `chaowai=1`.
调入门店 distribution remained `tongying=7`, `chaowai=3`, `xidan=6`,
legacy temporary `秦皇岛=1`, and `guanshe=2`.

Canonical digest before and after:

`8aba1ba41968cfc49a4ae0492c360f54abed0246c5db0792f4a32a0629b3aaea`

The deployment also checked that the complete historical TransferRequest,
MailingRecord, and Invoice business digests were unchanged immediately after the
additive migration and again after cutover. No production smoke record was
created.

## Backup and rollback

Before migration, the release created and integrity-checked a fresh PostgreSQL
custom-format backup named
`budu_bj006-migration49-pre-store-transfer-2-3f326ee46d82.dump`, plus a protected
read-only copy under the release-specific `.rollback-assets/store-transfer-2-*`
directory. The previous nginx template, active nginx config, and environment
file were also copied into that protected rollback directory.

The deployment trap restores the prior application writer, nginx authority, and
environment on failure. Schema rollback was not required: migration 50 is
strictly additive and the previous application remains compatible with the new
nullable columns. Restoring the database dump is reserved for a confirmed data
integrity incident because it would discard writes made after the backup.

## Known non-release-gate observation

`npm run test:ssr` still reaches the pre-existing direct `window` access in
`src/App.jsx`. That issue existed in the verified previous production SHA and is
not part of the browser/runtime release gate for this product change. It was not
expanded into this scope.

# budu Sweet Card 1.0 — Xidan Commercial Launch

Final decision: **XIDAN_COMMERCIAL_LIVE**.

Verified 2026-09-05, Asia/Shanghai. Model configuration is
`MODEL_CONFIGURATION_NOT_VERIFIABLE`; no model switch is claimed.

## Production authority

- Production SHA: `fe4a7254a0ec9a68390cefe12b0766b3ec15ef93`.
- Routed runtime: `budu-prod-fe4a725-sweet-card-xidan-live`.
- Canonical database: `budu_bj006`.
- Migration ledger: 65 applied / 0 failed. No Migration 66, schema, database
  function, constraint or financial-core change was made.
- Release tag `sweet-card-v1.0.0` remains pushed and resolves to core release
  `02f3f8fb6431157378c583802075713dd8bde8ef`.
- Classification authority remains required
  `SweetCardBatch.businessPurpose`, with values `ACCEPTANCE_TEST` and
  `COMMERCIAL`.
- Commercial flag: **ENABLED**. Sweet Card redemption remains a server-side
  intersection of global/commercial enablement, eligible `Store.key`, the
  authenticated user's `sweetCardPosRedeem` capability, and normal POS access.

The go-live audit record is timestamped `2026-09-05T04:17:04.700Z`
(`2026-09-05 12:17:04.700` Asia/Shanghai), actor `daa77021…`, scope `xidan`,
and authorized operator count 3.

## First commercial batch

The existing production API created exactly one batch:

- Name: `BUDU-SC-202609-A01`.
- `businessPurpose`: `COMMERCIAL`.
- Cards: 10.
- Face value: 20,000 cents / ¥200 each.
- Total issued value: 200,000 cents / ¥2,000.
- Lifecycle: all cards are `CREATED`; all credentials are `UNACTIVATED`.
- Carrier / validity / binding: `PHYSICAL` / `ONE_YEAR` /
  `REQUIRED`. Validity starts on later activation.
- Recipient fields and canonical bindings: empty for all 10 cards.
- Commercial redemptions / refunds: 0 / 0.

No QR or credential was exported or logged. The commercial cards remain unable
to redeem until the formal activation and verified-member binding lifecycle is
completed for an actual business gift.

## Go-live smoke

The smoke used an existing `ACCEPTANCE_TEST` card with sufficient active
balance. It did not use any commercial card.

- One xidan POS order for 10 cents.
- Redemption: exactly one 10-cent fact and exactly one -10-cent Ledger debit.
- Refund: exactly one completed 10-cent Refund, exactly one Sweet Card restore,
  and exactly one +10-cent Ledger credit.
- Acceptance card balance: 90 → 80 → 90 cents.
- Final order state: `refunded`.
- Payment facts for the pure Sweet Card order: 0.
- Provider refund amount: 0.

The request keys and committed facts were reconciled after each single API call;
no economic request was blindly retried.

## Final reporting and reconciliation

Financial reconciliation continues to use `ALL_REAL_FACTS`; commercial
operation reports default to `COMMERCIAL`.

Full Sweet Card Ledger:

- Issued: 250,150 cents.
- Redeemed: 160 cents.
- Refunded: 100 cents.
- Current balance: 250,090 cents.
- Ledger sum: 250,090 cents.
- Delta: 0 cents.

Commercial-only:

- Batch count: 1.
- Card count: 10.
- Issued value: 200,000 cents.
- Redeemed: 0 cents.
- Refunded: 0 cents.
- Outstanding: 200,000 cents.

The acceptance smoke remains exclusively in the `ACCEPTANCE_TEST` view. The
commercial report contains only the untouched first commercial batch.

## Permissions and regressions

Final production checks passed:

- all 3 approved xidan operators: ALLOW;
- xidan operator with capability temporarily removed: DENY;
- another scoped store (`guanshe`): DENY;
- non-direct / unsupported store probe: DENY;
- spoofed request-body `operatorId`: DENY 403;
- ordinary POS access to Sweet Card admin APIs: DENY 403;
- eligible Sweet Card store policies: xidan only.

POS products/orders, Cash history, official WeChat payment/refund queries,
official Alipay payment/refund queries, Report Center, Sweet Card reports,
permissions, production health and single-writer checks all passed. No new
WeChat or Alipay charge was created. Negative balances, duplicate economic
effects and unauthorized successful post-live redemptions are all zero.

## Current canonical backup

`CURRENT_CANONICAL_RESTORE_ARTIFACT`:

`/opt/budu/.rollback-assets/sweet-card-xidan-golive-fe4a725-20260905/current-canonical-budu_bj006-m65-xidan-live.dump`

- SHA-256:
  `b86e40aac33675ae16829a3024525d2bd0c8ac21f7db99f355122fbf32ffe1c2`.
- Restore-list entries: 6,102.
- Source identity: `budu_bj006|65|0|4|13|1|10`.
- Isolated restore identity:
  `budu_xidan_postlive_restore|65|0|4|13`.
- Restored purpose counts: 3 `ACCEPTANCE_TEST`, 1 `COMMERCIAL`.
- Dump, listing, identity, go-live audit and restored reconciliation checksums:
  PASS.
- Isolated restore rehearsal: PASS.

The earlier M65 artifact with SHA-256
`c97d77a37efdefc47cf397aff6181fde1380ee37f6ad9174ef7795fb5925b773`
is retained as `PRE_GOLIVE_CANONICAL_BASELINE`. The M64 artifact remains
`P19_ACCEPTANCE_BASELINE`, and the unrelated database `budu` dumps remain
`DO-NOT-RESTORE`. No backup was deleted.

## First-day monitoring

The thread heartbeat **西单甜意卡首日监控** is ACTIVE at 15-minute intervals.
It stays quiet while facts remain healthy and checks commercial issuance,
redemption, refund, outstanding, 409/P2034, 5xx, failed redemption, duplicate
guards, negative balances, Ledger delta, unauthorized attempts and credential
errors. Its first snapshot returned zero 409, 5xx, P2034, negative-balance and
credential errors.

Any negative balance, duplicate economic effect, non-zero unexplained delta or
unauthorized successful redemption triggers immediate commercial-flag disable,
evidence preservation, single-writer/health reconciliation and notification.
No manual balance correction is permitted.

## Skills

USED: `budu-task-router` (STRICT), `budu-context`, `budu-sweet-card`,
`budu-payment-safety`, `budu-data-authority`, `budu-regression`,
`budu-production-deploy`, `budu-handoff`, `budu-mobile-ui`, and
`budu-brand-system`.

NOT_FOUND: separate repository Skills named `release`, `POS`, `permissions`,
`audit`, or `reports`. Their current source, API, PostgreSQL, runtime and test
authorities were verified directly.

# Sweet Card Commercial R1 — production checkpoint

Status: **READY_FOR_XIDAN_COMMERCIAL_LAUNCH**

Verified 2026-09-05, Asia/Shanghai.

## Authority and deployment

- Production SHA: `fe4a7254a0ec9a68390cefe12b0766b3ec15ef93`.
- Runtime: `budu-prod-fe4a725-sweet-card-r1-ready`, healthy and routed.
- PostgreSQL: `budu_bj006`; 65 migrations applied / 0 failed.
- New additive Migration 65 establishes
  `SweetCardBatch.businessPurpose: SweetCardBatchPurpose` as the only batch-use
  authority. Values are `ACCEPTANCE_TEST` and `COMMERCIAL`.
- Batch names and the old free-text `purpose` notes are not authority.
- All 3 existing batches are `ACCEPTANCE_TEST`. No commercial batch exists.
- Commercial reporting defaults to `COMMERCIAL`; full reconciliation always
  includes all real facts.

## Financial evidence

- ISSUE: 50,150 cents.
- REDEEM: 150 cents.
- REFUND: 90 cents.
- Balance: 50,090 cents.
- Ledger: 50,090 cents.
- Delta: 0.
- Commercial-only outstanding: 0 cents.
- Acceptance/test outstanding: 50,090 cents.

The post-P19 `测试` batch was verified from timestamp, audit, card/order and prior
release evidence. Its single 50,000-cent card remains `CREATED` and unactivated,
with no redemption or refund. It was not deleted or edited.

## Restore artifact

- Marker: `CURRENT_CANONICAL_RESTORE_ARTIFACT`.
- Dump:
  `/opt/budu/.rollback-assets/sweet-card-r1-fe4a725-20260905/current-canonical-budu_bj006-m65.dump`.
- SHA-256:
  `c97d77a37efdefc47cf397aff6181fde1380ee37f6ad9174ef7795fb5925b773`.
- Restore-list entries: 6,102.
- Source identity: `budu_bj006|65|0|3|3`.
- Isolated restore identity: `budu_r1_current_restore|65|0|3|3`.
- Checksum and isolated restore rehearsal: PASS.

The former M64 artifact remains as `P19_ACCEPTANCE_BASELINE`. The unrelated
database `budu` artifacts remain `DO-NOT-RESTORE`. No artifact was deleted.

## Access and final gate

- Xidan commercial capability authority:
  `User.permissions.sweetCardPosRedeem` on authenticated `User.id`.
- Authorized xidan operator count: 3 (`4e96854b…`, `7bf092be…`, `f92d1e20…`).
- Authorized xidan: ALLOW.
- Xidan without capability: DENY.
- Other store: DENY.
- Spoofed operator id: DENY 403.
- Ordinary POS Sweet Card admin access: DENY 403.
- Commercial flag: DISABLED.
- Single production writer: PASS.

POS, Cash, WeChat, Alipay, Report Center, Sweet Card reports, Ledger,
permissions, production health and single-writer checks all passed. No new
economic fact was created. `BUDU-SC-202609-A01` was not issued or created.

Model configuration: `MODEL_CONFIGURATION_NOT_VERIFIABLE`.


# Sweet Card Xidan commercial go-live checkpoint

Status: **XIDAN_COMMERCIAL_LIVE**

Verified 2026-09-05, Asia/Shanghai.

## Live authority

- Production SHA: `fe4a7254a0ec9a68390cefe12b0766b3ec15ef93`.
- Runtime: `budu-prod-fe4a725-sweet-card-xidan-live`.
- Database: `budu_bj006`; Migration 65 applied / 0 failed.
- Commercial flag: ENABLED.
- Go-live: `2026-09-05T04:17:04.700Z`, actor `daa77021…`, scope xidan.
- Xidan commercial POS operators: 3.
- Other and unsupported stores: DENY.
- Public/internal health and single writer: PASS.

## Commercial batch

- Batch: `BUDU-SC-202609-A01`.
- Purpose: `COMMERCIAL`.
- 10 physical cards × 20,000 cents = 200,000 cents.
- All cards: `CREATED`; credentials: `UNACTIVATED`; binding mode: `REQUIRED`.
- Recipient and binding facts: empty.
- Commercial redemption/refund: 0/0.

The go-live smoke used an `ACCEPTANCE_TEST` card for a single 10-cent
redemption and full 10-cent Sweet Card refund. The debit and credit each exist
exactly once, the card balance returned 90 → 80 → 90 cents, the order is
`refunded`, and no Payment fact or provider refund was created.

## Reconciliation

- Full: ISSUE 250,150 - REDEEM 160 + REFUND 100 = balance 250,090 cents.
- Full Ledger: 250,090 cents.
- Delta: 0.
- Commercial: 1 batch, 10 cards, issued/outstanding 200,000 cents,
  redeemed/refunded 0/0.
- Negative balance: 0.
- Duplicate economic effect: 0.
- Unauthorized successful post-live redemption: 0.

POS, Cash, WeChat, Alipay, reports and final permission checks passed. No new
provider charge was initiated.

## Current restore artifact

`/opt/budu/.rollback-assets/sweet-card-xidan-golive-fe4a725-20260905/current-canonical-budu_bj006-m65-xidan-live.dump`

SHA-256:
`b86e40aac33675ae16829a3024525d2bd0c8ac21f7db99f355122fbf32ffe1c2`

Restore-list entries: 6,102. Source identity `budu_bj006|65|0|4|13|1|10`.
Checksum and isolated restore rehearsal passed. Previous M65 and M64 baselines
remain retained; unrelated `budu` database dumps remain `DO-NOT-RESTORE`.

First-day heartbeat monitoring is ACTIVE. Initial 409, 5xx, P2034,
negative-balance and credential-error counts are zero.

Model configuration: `MODEL_CONFIGURATION_NOT_VERIFIABLE`.


# Sweet Card 1.1B additive migration / runtime rollback review

Review date: 2026-09-13. Reviewed candidate: `3c66ebf`. Baseline: `95cd9ce48b25de35570cc6f1f07154ab2e13cb78` (70 migrations). Review scope: repository inspection only; no Production action, database write, or rollback performed.

## Conclusion

**OBSERVED: schema-compatible, operationally conditional rollback.** Keeping migrations 71–73 applied while restoring baseline code is structurally plausible: historical columns are not removed or renamed. This is **not** proof that baseline runtime can safely replace an active 1.1B financial runtime. Once any online obligations exist, stop new purchases while retaining the candidate recovery/callback runtime. Baseline has no online settlement recovery authority.

**UNVERIFIED:** actual baseline process against the migrated production clone; current Production backup restore capability; live pending obligations; cross-artifact CloudBase rollback compatibility. These must be closed by the deployment owner before approval.

## Exact migration scope

| Migration | Observed effect | Compatibility risk |
|---|---|---|
| 71 `20260911030000_online_checkout_financial_domain` | Creates 10 online financial/policy tables, indexes, foreign keys, immutable/deferred reconciliation and transition functions/triggers | Also installs triggers on existing `sweet_card_accounts` and `sweet_card_ledger`; therefore additive does not mean behavior-free |
| 72 `20260913010000_online_fulfillment_authorization` | Adds one immutable fulfillment authorization per settlement, actor/request/intent validation | Shipping authorization cannot be deleted or rewritten as rollback; preserve audit facts |
| 73 `20260913020000_online_refund_approval_reason` | Adds nullable approval reason, length constraint and immutable trigger on the new refunds table | Compatible with absent historical values, but older writers must not overwrite a populated reason |

No historical table column deletion, rename, type change, or data-rewriting DML was observed in these migrations. Existing Prisma model additions are inverse relations to new tables. Migration 71 foreign keys reference historical User, InventoryItem, Sweet Card account and ledger rows; referenced-row deletion may now be restricted after adoption.

SHA-256:

- 71: `085fadfe6309ebc7f3d8b9351bc0db9bb7273f54970f54a0d23d3b8a0b95761d`
- 72: `a8f737b7793333f7c0f9dfe040aa007883dc1661883ee4bf61441800147a5fea`
- 73: `6e95371ed89443658e225c0ec4510f4c3cdce3bc059f267edb9a335e66e53f24`

## Historical runtime effects requiring clone rehearsal

`online_balance_capacity` runs after every account update and rejects balance below active reservations. Reservations are not discounted merely because expires_at passed: the authoritative release/expiry transition must complete. Baseline POS may consequently receive a constraint error if it attempts to spend reserved funds; do not remove this protection to make rollback appear successful.

`online_ledger_balance_contract` runs after existing ledger INSERT/UPDATE/DELETE. Its reconciliation helper returns immediately for accounts with no online settlement; for adopted accounts it requires account balance equal signed ledger sum at transaction commit. Baseline POS/refund operations must therefore be tested on both untouched and adopted accounts. `online_ledger_immutable` additionally rejects updates/deletes of ledger rows referenced by online capture/refund facts. Historical ledger maintenance is not a rollback mechanism.

New foreign keys and CREATE TRIGGER acquire locks on referenced/existing relations. Empty new tables reduce validation work but do not eliminate DDL blocking risk. Clone rehearsal must record migration duration and lock behavior; deployment must not wait indefinitely behind writers.

## Operational rollback decision

1. Before any online settlement/reservation/provider request exists: disable new checkout, retain additive schema, restore exact verified baseline runtime artifact/config if clone smoke passes. Do not run down migrations or restore the database for an application issue.
2. Once online facts exist: first disable **purchase admission** (`SWEET_CARD_ONLINE_PAYMENT_ENABLED`), keep `SWEET_CARD_ONLINE_RUNTIME_ENABLED=1` with valid verification keys, provider callbacks, recovery workers and outbox delivery. Runtime config explicitly separates these switches. Preserve merchant/status/refund handling needed for existing orders.
3. Do not switch callback traffic to baseline while PENDING/CLOSING/RECONCILIATION_REQUIRED settlements, RESERVED balances, unverified provider results, pending refunds/compensations or undelivered outbox events remain. Provider results can arrive late; local terminal state alone is insufficient to certify absence of obligations.
4. Even after obligations drain, old runtime cannot serve historical 1.1B status/refund/fulfillment APIs. Prefer candidate runtime with admission OFF; a complete rollback needs a separately verified routing/compatibility plan for those orders. Never allow an online commerce mirror to fall through to legacy customer-approved refund or mirror-only fulfillment authority.
5. Preserve CloudBase financial mirror protections and signed receiver for any retained online domain. OS rollback does not authorize reverting CloudBase or MiniProgram artifacts.

## Required acceptance checks (not executed by this review)

- Fresh verified backup and executable runtime rollback artifact/config; identify actual database and SHA rather than relying on this document.
- On isolated production clone apply exact 71–73; verify migration count 73 / 0 failed, historical table counts and monetary aggregates unchanged.
- Start baseline95cd9ce with its matching generated Prisma client against migrated clone; health, Payroll, POS, Sweet Card 1.1A, Payment/Refund and gateway smoke. Do not run real provider transactions.
- Repeat historical Sweet Card transactions on untouched accounts and isolated online-adopted accounts, including an active reservation; verify rejection is atomic and funds never double-spent.
- Record settlement statuses, RESERVED sum, pending refund/compensation counts, provider uncertainty and undelivered outbox count before any runtime rollback decision.
- Reconcile each adopted account ledger sum to balance and capture/refund identity exactly once; global totals alone are insufficient.
- Keep all migration objects and financial/audit rows on rollback; no DROP, history rewrite, database restore, or constraint disabling.

Production mutation by this review: **NONE**. Independent full runtime rollback rehearsal: **UNVERIFIED**. No claim of Production-ready follows from static compatibility review.

## G9 execution addendum (root audit, 2026-09-13)

Fresh backup restore and baseline/candidate migrated-clone health plus22/22
authenticated read checks are now VERIFIED. All95 historical tables unchanged.
See production-candidate checkpoint for evidence. Earlier UNVERIFIED statements
refer to the static review time. No old-runtime write on adopted online accounts
was attempted: forward-fix with candidate recovery retained remains mandatory
once online obligations/history exist. No live rollback was performed.

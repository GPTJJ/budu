# budu Sweet Card P10C production completion

Final status: **PRODUCTION_COMPLETE — CONTROLLED ROLLOUT ONLY**.
Verified 2026-09-05, Asia/Shanghai. Model configuration:
`MODEL_CONFIGURATION_NOT_VERIFIABLE`; no switch claimed.

## Release and authority

- Previous production: `cd5551352420b18e2347294604b51b28b4b92dda`.
- Deployed application source: `02f3f8fb6431157378c583802075713dd8bde8ef`.
- Image: `budu-api:sweet-card-p10c-02f3f8f`, image ID
  `sha256:973c41a126cd131afd0eb39205195431c9cb159822c355017c9e1555a8b4437e`;
  full revision label verified.
- Routed runtime: `budu-prod-02f3f8f-sweet-card-p10c-xidan`.
- Canonical database: `budu_bj006`; Migration 64 applied / 0 failed.
- Public/internal health PASS; exactly one database-connected application writer.
- Rollout scope: global flag on only inside the routed controlled runtime; the
  canonical policy intersection is exactly `xidan` plus one approved principal
  whose stable ID begins `daa77021`.
- Migration/schema/function/constraint changes: **NO**. Ledger, balance, settlement,
  refund, Payment and lock models changed: **NO**.
- Candidate branch: `codex/sweet-card-p10c-concurrency`. The source commit is not
  pushed because the user did not issue the repository's `push` instruction.

The required BUDU task-router, Sweet Card, payment-safety, data-authority,
regression, production-deploy and handoff skills were read and applied. No
repository-specific Prisma, transaction, concurrency, idempotency or API-error
skill was present. The configured model/speed could not be inspected.

## P10C repair

Prisma `6.19.3` aborted the complete Serializable Sweet Card redemption transaction
with P2034 when two orders competed for one account. Every economic write was inside
that transaction and rolled back together; no external provider, HTTP, message or
file side effect existed. The requestKey, order, token and amount remain stable.

The deployed helper retries only P2034 and always re-executes the complete
transaction in a fresh snapshot. It makes at most three attempts, using 20–40 ms
then 40–60 ms bounded jitter. Each attempt re-reads the requestKey replay, Order,
credential, account, balance, eligibility and committed economic facts. Retry
exhaustion maps to HTTP 409 `核销并发冲突，请刷新后重试`; an exhausted active credential
maps to HTTP 409 `甜意卡余额不足`. Other business declines retain their contract and
unexpected errors retain the server-error path. POS displays the specific API
message and status.

Candidate verification passed the real PostgreSQL P10C matrix, 167 local targeted
tests, real PostgreSQL Alipay and Report Center RC2A/B/C suites, P7C exact BigInt
response regressions and production build. Every concurrency fixture reconciled
balance, Redemption, Ledger and allocation with delta 0.

## Production gates

| Gate | Result | Direct production evidence |
| --- | --- | --- |
| P0–P6 baseline / Legacy | PASS | Existing accepted baseline plus current POS, Product, Order, Report, Cash, WeChat and Alipay regression after exact-SHA deployment |
| P7–P9 | PASS | Previous accepted facts preserved; original card remains ISSUE 50 / REDEEM 50 / balance 0 / delta 0 |
| P10 concurrency | PASS | New card 100; two new 60-cent orders returned 201 + controlled 409; one Redemption/debit/allocation; balance 40; no 500 or double spend |
| P11 duplicate/retry | PASS | Redemption replay 200; concurrent same-key Cash payment 201 + 200; later replay 200; one Payment 10 and one Card debit 20 |
| P12 refund | PASS | Pure Card 60→Card; mixed 30→Card 20 + Cash 10; partial 10→Card; all completed on original rails |
| P13 refund idempotency | PASS | Two concurrent replays of the same completed partial-refund key; one Refund/allocation/Ledger, no second provider refund or balance change |
| P14 loss/replacement | PASS | Formal binding; loss revoked old credential; replacement preserved account/balance/Ledger/binding and linked old→new credential; audit complete |
| P15 credential/security | PASS | Old token replay 409 with zero effect; new credential distinct and usable; no plaintext in card API/bundle/server; ordinary/spoof/other-store denied |
| P16 final Ledger | PASS | 2 cards; ISSUE 150 - REDEEM 150 + REFUND 90 = balance/Ledger sum 90; 8 Redemptions, 9 item allocations, 3 refunds; delta 0 |
| P17 permission/audit/report | PASS | One principal, one store; ordinary overview 403; required audit actions present; report 200; pure-card orders have no Payment; Cash collected/refunded 10/10 |
| P18 secret/merchant | PASS | Sweet Card key, WeChat config, Alipay config each `PRESENT LOAD_PASS VALIDATION_PASS`; no values emitted |
| P19 observation | PASS | SHA/DB/64/0/health/writer/route/POS/Product/Cash/providers/report/scope/economics all pass; secret log lines 0; unexpected error lines 0 |

The new acceptance account `scv-59558632…` was issued through the formal batch API
with 100 cents. It has three committed Redemptions totaling 100 and three Sweet
Card refunds totaling 90, leaving balance 90. The original account `scv-ec6b3487…`
remains exhausted at balance 0 with its five historical Redemptions totaling 50.
Global unexplained delta: **0 cents**.

One losing P10 order remains pending/unpaid with zero Sweet Card amount, zero
Payment, zero allocation, zero Redemption and zero Ledger. The P14 revoked-token
request also has zero economic fact. A clearly named acceptance member record was
created through the formal Member API to test binding/loss/replacement. These valid
audit facts are retained; no test fact was deleted or manually edited.

No new WeChat or Alipay payment/refund was initiated. Their official query APIs were
used against existing successful/completed facts. The only new provider remainder
was Cash 10 cents on the mixed acceptance order; it was refunded 10 cents in P12.

## Deployment and reconciliation notes

The first disabled cutover attempt reached healthy candidate and public routing,
then a protected-directory glob in the evidence snapshot step failed. Automatic
application rollback restored `cd55513`, disabled flag, route and one writer. The
corrected deployment reran from the preflight and passed. The first controlled-
enable attempt similarly returned to disabled because the host environment file
did not yet contain the optional flag; the existing compatible “append when absent”
behavior was applied and the full enable gate passed. Neither event changed schema
or Sweet Card business facts.

P12 initially stopped after its first correct refund because the acceptance script
read response `refundAmount` instead of the established API field `amount`.
Read-only reconciliation proved Refund/SweetCardRefund/Ledger 60 and balance 80;
the same idempotency key resumed safely. P18 initially checked only the inline key,
while production correctly uses `SWEET_CARD_CREDENTIAL_KEY_FILE`; actual encrypt/
decrypt had already passed. P19 initially expected one item allocation per
Redemption, while the preserved P9 gift basket correctly has allocations 10 and 0.
Grouped reconciliation proved all eight Redemption sums and unique debits exact.
These were evidence-script corrections, not application repairs.

## Backup authority and rollback

Protected root:
`/opt/budu/.rollback-assets/sweet-card-p10c-02f3f8f-20260905`.

Canonical final backup:
`production-budu_bj006-m64-post-p19.dump` — 37,454,984 bytes, custom-format restore
list 6,100 entries, Sweet Card schema markers present, SHA-256 validation PASS.
`CANONICAL_BUDU_BJ006_SHA256SUMS` is the authority checksum file.

The correct pre-P10C baseline was already protected in
`/opt/budu/.rollback-assets/sweet-card-p7c-cd55513-20260905/production-m64-post-p10-hold.dump`.
It was restored into a disposable PostgreSQL database and directly produced 64/0,
1 card, 5 Redemptions, 6 Ledger rows, 0 refunds, balance 0 and Ledger sum 0.

Two newly produced custom-format dumps targeted the unrelated `budu-postgres-1`
database `budu`. They are not production backups. The P10C root contains a prominent
`DO-NOT-RESTORE-noncanonical-budu.txt` naming them and the canonical replacement.
Their file integrity never constituted production authority. This mismatch was
stopped, investigated and reconciled before final reporting.

`rollback-app.sh` restores the previous application/runtime route without restoring
the database. `disable-sweet-card.sh` immediately returns the current SHA to the
healthy disabled container and controlled-off nginx/environment snapshots. Database
restore is not authorized and is unnecessary. Any future restore must start a new
explicit production-data gate and directly verify the canonical database first.

Production remains in **CONTROLLED ROLLOUT ONLY**. Do not enable another store or
principal, and do not treat this completion as approval for a global rollout.

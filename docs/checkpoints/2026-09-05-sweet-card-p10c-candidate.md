# budu Sweet Card P10C application-only candidate

Audit date: 2026-09-05, Asia/Shanghai. Model configuration:
`MODEL_CONFIGURATION_NOT_VERIFIABLE`; no switch claimed.

- Previous production: `cd5551352420b18e2347294604b51b28b4b92dda`.
- Candidate: the commit containing this report.
- Branch: `codex/sweet-card-p10c-concurrency`.
- Status: **P10C_CANDIDATE_READY**.

## Authority and scope

VERIFIED before candidate work: production runtime
`budu-prod-cd55513-sweet-card-p7c-disabled`, database `budu_bj006`, Migration
64 applied / 0 failed, Sweet Card disabled, public/internal health healthy and
one application writer. The existing exhausted acceptance card and all P7–P10
facts were read and preserved: ISSUE 50, five REDEEM debits totaling 50, balance
0, five Redemptions, no Sweet Card refunds and unexplained delta 0.

Application change only. Migration/schema/database function/constraint changes:
**NO**. Balance, Ledger, settlement, refund, Payment and concurrency-lock models:
**UNCHANGED**. Candidate tests wrote only to disposable isolated databases.

## Root cause and retry contract

The failing operation is the Sweet Card redemption interactive Prisma transaction
at Serializable isolation. Competing orders use the same account and the first
attempt can abort with Prisma `P2034` at a write such as Redemption creation after
another transaction commits. The failed transaction rolls back its Redemption,
allocation, Ledger, balance and Order writes together.

All side effects in this transaction are PostgreSQL writes. There is no provider
call, external HTTP request, message send or file write. The caller's requestKey,
orderId, token and amount remain stable across attempts. Generated row IDs exist
only inside an aborted transaction and cannot become committed duplicate economic
identities. Existing payroll code also retries complete P2034 transactions; manual
refund and partner-supply paths map the conflict to HTTP 409.

The repair retries the complete Sweet Card transaction only when `error.code` is
exactly `P2034`. Maximum attempts: **3**. Delay after failed attempt 1 is 20–40 ms;
after attempt 2 it is 40–60 ms, each with bounded jitter. Every attempt creates a
fresh Serializable transaction and re-reads the requestKey replay, Order,
credential, account, current balance, eligibility and existing economic facts.
Individual statements and non-P2034 errors are never retried.

After the third P2034, the endpoint returns HTTP 409 with `核销并发冲突，请刷新后重试`.
After another contender exhausts the account, it returns HTTP 409 with
`甜意卡余额不足`. Existing business declines keep their current messages. Genuine
unexpected errors keep the server-error path. The shared API wrapper preserves
the status and body error, and POS displays that message.

Prisma is locked at `6.19.3`. Its v6 transaction contract classifies P2034 as a
write conflict/deadlock and recommends retrying the Serializable transaction.

## Verification matrix

| Case | Result | Reconciliation |
| --- | --- | --- |
| A single request | 201 | one Redemption/debit/allocation |
| B two requests, funds for one | 201 + 409 | one economic success; no 500 |
| C two requests, funds for two | 201 + 201 | both exactly once |
| D three requests, funds for two | 201 + 201 + 409 | committed debit never exceeds start |
| E injected first P2034 | recovery on attempt 2 | complete operation retried |
| F concurrent same requestKey/order | 201 + 200 replay | one economic effect |
| G injected P2034 exhaustion | 409 after 3 attempts | no partial facts |
| H forced late non-P2034 failure | expected 500 | complete rollback |

Every real PostgreSQL case proves balance >= 0, committed debits <= starting
balance, starting - debits = ending, and Ledger debit sum = Redemption sum =
allocation sum. Final unexplained delta in every fixture: **0 cents**.

Additional VERIFIED evidence:

- P10C helper plus real PostgreSQL concurrency matrix: 2/2 PASS.
- Local Sweet Card, POS, Order, settlement, Cash, WeChat, Alipay, permissions,
  product and report suites: 167/167 PASS.
- Real PostgreSQL Alipay idempotency/concurrent-refund guard: PASS.
- Report Center RC2A, RC2B and RC2C real API suites: PASS.
- P7C real PostgreSQL first/replay response: 201/200, all seven money fields exact,
  one economic effect and delta 0; issue/bind/query APIs: PASS.
- Production build and `git diff --check`: PASS.

## Exact review and deployment gate

Changed application file: `server/sweet-card.js`.
Added isolated test: `scripts/test-p10c-concurrency-integration.mjs`.
Added report: this file. Exact candidate diff:
`git diff cd5551352420b18e2347294604b51b28b4b92dda..HEAD`.

The required BUDU routing, Sweet Card, payment-safety, data-authority, regression,
production-deploy and handoff skills were read and applied. No repository-specific
Prisma, transaction, concurrency, idempotency or API-error skill exists.

Before cutover, directly reverify the exact previous runtime SHA, disabled flag,
Migration 64, canonical database, health, single writer and rollback assets; create
a fresh protected backup and an exact-SHA unrouted candidate. Keep Sweet Card
disabled through cutover and complete Legacy regression before controlled P10
re-acceptance with a newly issued low-value card.

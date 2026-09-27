# P7C application-only response candidate

Audit date: 2026-09-05. Model configuration: MODEL_CONFIGURATION_NOT_VERIFIABLE.

Previous production: `00d7a77235de2a3f29f8bffbd49116f5e382b2fb`.
Candidate: the commit containing this report (`git log -1 --format=%H -- server/sweet-card.js`).
Branch: `codex/sweet-card-p7c-serialization`.

## Authority and scope

VERIFIED directly: production database `budu_bj006`, 64 applied / 0 failed,
Sweet Card disabled, public/internal health healthy, exact runtime SHA matching
previous production, one application writer connected to that database.
Old P7 order `ord-38dd6a42-2368-438b-9147-c18ad5c54ff0` remains completed/paid:
Payment 0, Redemption 1, debit Ledger 1, Allocation 1, balance 40 cents,
ledger-derived balance 40 cents, unexplained delta 0. Only read, never retried.

Migration changed = NO. Schema / DB function / constraint changed = NO.
Production DB changed by this candidate audit = NO. Disposable test DBs only.
No settlement, refund, idempotency, payment authority or Order transition changes.

## Root cause and response contract

Prisma create/findUnique return BigInt scalar columns. No raw SQL/aggregate DTO
produces the offending values. The successful transaction resolves before the
route invokes Express res.json. JSON.stringify throws outside the transaction.
The replay branch returns the same scalar models and had the same failure.

| Response field | Before at res.json | After JSON |
| --- | --- | --- |
| redemption.amountCents | decimal string | unchanged decimal string |
| redemption.eligibleSubtotalCents | BigInt, serialization failure | decimal string |
| redemption.ineligibleSubtotalCents | BigInt, serialization failure | decimal string |
| order.subtotal | BigInt, serialization failure | decimal string |
| order.discountAmount | BigInt, serialization failure | decimal string |
| order.payableAmount | decimal string | unchanged decimal string |
| order.sweetCardAmount | decimal string | unchanged decimal string |

These are all seven monetary scalar columns in the two response models. No
relations are included by the returned Prisma queries. Existing POS serializeOrder,
Sweet Card serializeCard/inspect and payment/refund DTOs establish decimal strings.
No repository-wide BigInt serializer exists. Operating-cost has a private recursive
jsonSafe helper, not a shared convention/API; it is not imported across domains.
Use the existing endpoint's explicit .toString() mapping for all monetary fields.
Other keys, version/discountPercent numbers, dates and response shape stay intact.
There is no Number conversion, global JSON replacer or prototype patch.
BigInt.toString preserves every integer digit; the real HTTP fixture round-trips
subtotal 9007199254740993 (> Number.MAX_SAFE_INTEGER) and compares all seven money
fields against committed Prisma values. Request value remains 10 cents.

## Current reproducible evidence

- VERIFIED: original production image + PostgreSQL 16/M64 reproduces COMMIT then
  HTTP 500 for both first request and replay; balance 50→40 and one debit.
- VERIFIED: patched route + PostgreSQL 16/M64: HTTP 201 first, HTTP 200 replay;
  requestKey/order/token/amount identical, reused false→true; committed facts
  byte-for-value unchanged by replay, one debit, allocation 10, Payment 0, delta 0.
- VERIFIED: JSON response model key sets match committed Prisma scalar records;
  monetary fields are exact decimal strings, version remains number, dates serialize.
- VERIFIED: issue/bind/card detail/list/batch/overview APIs pass on isolated DB.
- VERIFIED: local targeted suites 168 PASS / 0 FAIL, including normal POS, Cash,
  payment/refund, WeChat, Alipay, Sweet Card, permissions and report source contract.
- VERIFIED: real PostgreSQL Alipay payment idempotency/concurrent refund guard PASS.
- VERIFIED: Report Center RC2A/RC2B/RC2C real API suites PASS, including normal Cash
  settlement and existing Order/Report contracts.
- VERIFIED: production build and diff check PASS.

Initial local PostgreSQL test lacked localhost:5432. Production runtime image lacks
frontend sources and PGlite dev dependency, and Node22 timer test process cancelled
unref timers. Appropriate local suites passed with full development dependencies;
PG-only suites passed on the disposable remote database. No application repair was
made for these harness/runtime differences. Initial unsuccessful logs are retained.

## Exact review and remaining production gates

Runtime diff: only server/sweet-card.js response mapping (four missing conversions).
Tests: scripts/test-p7c-response-integration.mjs and scripts/test-p7c-card-api.mjs.
Report: this file. Exact diff: `git diff 00d7a77235de2a3f29f8bffbd49116f5e382b2fb HEAD`.
Seven required BUDU skills plus budu-context and Sweet Card business reference were
read and applied. No additional API/serialization/Node/response skill was found in
the repository, installed skills or plugin skill catalog.

P7C_CANDIDATE_READY (source/tests). Exact-SHA image, protected fresh M64 backup,
rollback baseline, unrouted smoke and production cutover must still be verified.
User explicitly authorizes automatic deployment after passing this candidate.
Keep Sweet Card disabled initially, then re-accept NEW order only in xidan and the
existing approved principal allowlist. P8–P19 definitions remain UNVERIFIED; requested
from user. Do not invent acceptance phases or claim PRODUCTION_COMPLETE.

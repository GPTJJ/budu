# Sweet Card 1.1B task ledger

Updated 2026-09-11. Full scope: MASTER_PLAN; no release claim yet.

| Work | Status | Evidence / next action |
|---|---|---|
| Bootstrap production baseline | VERIFIED | OS95cd9ce; DBbudu_bj006; migration70/0; health; exact-db writer1; Ledger=balance=1300110 |
| Production duplicate transactionId | VERIFIED within queried scope | Nonempty string transactionId aggregate: zero duplicate groups; request4bdc91f8-bd0e-4c92-9f48-7f1adeb04d84 |
| Production duplicate payNo | VERIFIED within queried scope | Nonempty string payNo aggregate: zero duplicate groups; request347c06c8-d823-4c8f-b029-6bbff885fcaf |
| Isolated OS candidate | VERIFIED | codex/sweet-card-1-1b from exact live95cd9ce; unknown original files preserved |
| Isolated MP candidate | VERIFIED | codex/sweet-card-1-1b from1332ab8; includes merchant82ea2ec repair and CloudBase5115174 |
| G0.6 legacy payment safety | IN PROGRESS | orders/payOrder identity coordination and verified finalizer implemented; actual SDK missing-doc semantics corrected; deployment prerequisites remain |
| G1 architecture freeze | IN PROGRESS | FINANCIAL_CONTRACT.md reviewed; capture eligibility changes, quantity rounding, compensation, ledger constraints and hold-aware rollback recorded |
| Money policy | VERIFIED unit scope | 15/15 tests incl integer limits, shipping, discount, cumulative tender and quantity rounding; production build PASS; no PG concurrency claim |
| G2–G6 implementation | NOT STARTED | Follow dependency gates, no fake PASS |
| G7 native certification | NOT STARTED | No mock-only certification |
| G8–G10 integration/clone/deploy | NOT STARTED | Fresh backup/rollback required; no deployment yet |
| G11–G12 human E2E/public | NOT STARTED | Real owner actions remain human boundary |

## Current risks

Deployed payOrder uses placeholder notification URL and lacks verified query
response/state/identity safety. Local candidate improvements are not production
evidence. Deployed merchant refund repair already distinguishes PROCESSING and
SUCCESS; preserve it. No production index/config/data mutation performed.

Independent review corrected aggregate discount overflow and bounded decimal
parsing before BigInt. Native CloudBase missing-document semantics require an
explicit SDK adapter test; mocked transactions do not prove this. G0.6 cutover
must provision private paymentIdentities and coordinate all create writers,
configure/verify a genuine HTTPS notification endpoint, and complete recovery.
The current deployed function metadata has zero listed triggers; that alone does
not prove whether HTTP Service mappings exist. No route is assumed operational.
Per-account current Ledger/projection mismatch count was also queried: zero,
so the aggregate zero difference is not masking offsetting account differences.

Original worktree contains pre-existing untracked bundles, scripts and audit
documents. They are preserved. Scoped candidate commits/pushes use only the two
`codex/sweet-card-1-1b` branches. Check Git HEAD/upstream on recovery; never infer
deployment from a pushed commit. Uncommitted or unpushed later work remains local.

MP current targeted regression: 44/44 PASS including real installed SDK wrapper
with offline transport and unchanged merchant refund tests. This does not prove
native database concurrency or production callback reachability.

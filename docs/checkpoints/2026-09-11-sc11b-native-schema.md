# Native PostgreSQL schema checkpoint

2026-09-11. G2 IN PROGRESS; no production mutation.

- VERIFIED: local native PostgreSQL16.14, loopback127.0.0.1:55461,
  synthetic database `budu_sc11b_native`. Embedded-postgres supplies the real
  native binary; this is not PGlite. No production credentials/data loaded.
- VERIFIED: all71 migration files executed successfully against empty database.
- VERIFIED: initial native constraints8/8 tests pass in
  `scripts/test-online-schema-native.mjs`. Every fixture rolls back.
- Found/reproduced: REFUNDED could be set with zero settled refund facts.
  Added deferred status-versus-settled-refund-total constraint; regression first
  failed then passed. PAID and PARTIALLY_REFUNDED totals also constrained.
- Current draft function was reloaded only into isolated database. Its migration
  checksum now differs from the initial rehearsal. A fresh full rehearsal of the
  final reviewed migration is REQUIRED; do not call current rehearsal final.
- Tests cover pending WX-only consistency, missing tender, immutable money,
  unverified PAID, duplicate tender, illegal transition, immutable quote deletion,
  and false REFUNDED. They do NOT certify orchestration/concurrency/provider truth.
- G2 still requires compensation linkage, quote snapshot linkage, full fixture
  coverage and independent review. G3+ remains incomplete.
- Docker runbook is an unused alternative. Production host was not loaded with
  new test/build containers. Local configuration/password stays outside Git with
  mode0600. Runner handle36377; verify live before reuse, never infer from handle.

Run with explicit isolated connection file and pg module paths through
SC11B_NATIVE_CONFIG and SC11B_NATIVE_PG_MODULE. No fallback to DATABASE_URL.
No production migration, config change, payment, refund or ledger write occurred.

## Continued evidence (supersedes initial 8-test status)

- Current complete draft was freshly reset/reapplied only in synthetic local DB:
  all71 migrations PASS. No checksum patching of migration records.
- Native schema tests24/24 PASS. Added quote amount linkage, verified late-payment
  compensation amount/source, required compensation for received late payments,
  per-account Ledger/projection equality, reject captured unpaid reconciliation,
  monotonic versions, provider payment time, and explicit non-null SUCCESS for
  refund/compensation completion (PostgreSQL CHECK otherwise accepts NULL).
- Independent reviewer found Ledger/projection and NULL completion holes; both
  now fixed and covered. Native tests show missing debit/credit rejected and
  consistent capture/full refund accepted. All fixtures rollback.
- POS inspect/redemption now subtract all RESERVED holds; no timestamp or flag
  shortcut. Missing reservation delegate fails closed. No hold changes existing
  ledger balance semantics. Query executes under existing account lock for spend.
- Legacy Sweet Card unit/settlement plus availability helper39/39 PASS.
- Existing native HTTP Store Availability matrix27/27 PASS on a separate local
  `budu_sc_availability_isolated` DB, including refund, permission revocation and
  concurrent duplicate redemption. Final synthetic Ledger=balance=9700 cents.
- Prisma validate/generate PASS; production build PASS (4.67s).
- Remaining: full online orchestrator, outbox atomic/versioned mirror, refund SKU
  quantity enforcement, real POS-vs-hold concurrency and all other master gates.
  These tests are not full G7 certification and do not authorize deployment.

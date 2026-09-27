# budu 甜意卡 1.0 Candidate checkpoint

Date: 2026-09-04 (Asia/Shanghai)

## Authority and boundaries

- Exact Production baseline: `ccdf1358938e53da99daf2a24d2cf3c6b13c8fed` — VERIFIED from public and container-internal health.
- Canonical PostgreSQL: `budu_bj006`; migration ledger 62 and schema up to date — VERIFIED read-only.
- Candidate branch: `codex/sweet-card-1-candidate`; implementation commit: `adfda23a622b6ccce39cbc798c27aaa0ca5c1569`.
- Production was not deployed, reconfigured, migrated or written. `SWEET_CARD_ENABLED` is absent from the running Production container and therefore fail-closed.
- Candidate migration 63 (`20260904170000_sweet_card_candidate`) is additive and has not been applied to Production.

## Candidate scope

- Adds the discoverable `budu-sweet-card` Skill and Task Router contract.
- Reuses `Store.key`, `InventoryItem.id`, `ProductCategory.id`, `Order`, `Payment`, `Refund`, `RefundItem`, `Member.id` and the existing settlement coordinator.
- Adds separate value-account and replaceable-credential authorities, immutable ledger facts, batch issuance, eligibility policies, checkout snapshots, one-card redemption, mixed settlement, deterministic refund restoration, binding, loss/replacement and audited QR export.
- Adds an independent capability-gated admin surface with overview, batches, filtered cards, issuance, rules, usage records and audit; includes a replaceable electronic presentation hook.
- POS scans the `budu:sc:v1:` namespace before WeChat/Alipay routing. The server remains the sole authority for eligibility, balance, settlement and refund completion.
- Customer self-binding remains a future hook because no safe verified self-service customer identity flow exists. Candidate supports admin binding to the existing `Member.id` only.

## Verification

- Sweet Card contract, monetary cases, security structure, settlement and migration rehearsal: 36/36 PASS.
- Payment, permission, WeChat, Alipay, reconciliation and Report Center targeted regression: 101/101 PASS.
- POS Sweet Card WebKit regression at 320/340/375/390/430px plus scanner routing and mixed cash settlement: 7/7 PASS.
- Prisma validate/generate, server syntax checks, Vite production build and `git diff --check`: PASS.
- Migration 62→63 PGlite rehearsal proves all pre-existing Order/Refund facts unchanged, and the new ledger has canonical Order/Refund foreign keys plus balance constraints.
- Production authority digest was read twice with identical combined digest `cbb138833068793ac0e4b93fc92c14128c3c3e0640eaee0c719c8ffa8b2d5f61`; no task-induced Production data drift occurred.
- Broad `test:critical` was stopped after an unrelated existing `test-store-entry-state-integrity.mjs` WebKit process exceeded normal duration. The affected Daily Entry path has no Candidate diff; all directly affected critical domains were rerun and passed above.
- Dependency audit reports 8 existing findings (3 moderate, 5 high; 0 critical). Breaking/unrelated dependency upgrades are outside this Candidate.

## Rollout and rollback

- Gate 8 status: Candidate only, ready for a separate reviewer-approved Production gate.
- A future Production gate must begin with fresh backup, exact-SHA build, migration 63 rehearsal against a current clone, pre/post authority digest, internal smoke, then explicit feature enable and store-policy setup. It must not create a real-value card without separate authorization.
- Immediate rollback is feature-flag disable. The additive migration can remain dormant for application rollback; database restore is not expected, but the pre-migration backup remains mandatory.
- Existing WeChat, Alipay, Cash, Order, Refund, PaymentLog, POS, DailyEntry, Report Center, InventoryItem/ProductCategory, notifications and permissions must remain protected in that future gate.

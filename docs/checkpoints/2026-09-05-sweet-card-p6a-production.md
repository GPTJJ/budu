# budu Sweet Card 1.0 — Gate P6A production checkpoint

Date: 2026-09-05 (Asia/Shanghai)

## Verified production state

- Runtime SHA: `48c28fb1bfa9d1109c2a4562b916d0d1abc92e32`.
- Exact deployed code branch: `codex/sweet-card-p6a-allowlist`.
- PostgreSQL authority: `budu_bj006`; migration ledger 63 applied, 0 failed.
- Runtime: `budu-prod-48c28fb-sweet-card-p6a-xidan`; healthy with one production writer.
- Global Sweet Card flag: enabled.
- Effective grey scope: exactly one canonical `User.id` principal (`daa77021…`) and exactly one eligible store (`xidan`).
- Category blacklist: explicit empty set; no category identity was inferred from display names.
- Sweet Card business facts: 0 accounts/cards, 0 redemptions, 0 Sweet Card refunds.

## Authority and enforcement

- The allowlist is stored in the existing PostgreSQL `User.permissions` JSON and bound to canonical authenticated `User.id`; it is not read from names, request bodies, browser storage or frontend state.
- Access requires the intersection of the global flag, allowlisted principal, original module/capability and eligible store. Missing or false inputs fail closed.
- POS config, inspect, redeem, mixed-provider payment/query/close, order cancel/complete and refund/query paths enforce the full global + principal + original permission + eligible-store gate where a Sweet Card amount exists.
- Sweet Card management and economic APIs require the same allowlist. Provider callbacks and background reconciliation remain independent so an already-authorized transaction cannot be stranded by later revocation.
- Generic role/permission edits preserve but cannot create or remove this high-risk flag. Only the developer-only allowlist endpoint can change it.
- Allowlist add/remove events are immutable `SweetCardAuditLog` entries containing the target principal ID. Production evidence contains two enable entries, one disable entry and one rules update.

## Gate P6A evidence

- A–H unit/source gate: PASS, covering global off, principal absent, store ineligible, all conditions present, direct API/body identity bypass, revocation, and no privilege expansion.
- Disabled deployment smoke: allowlist empty; developer and ordinary POS config denied; forged body identity request returned 403.
- Add/remove/re-add smoke: PASS; revocation immediately returned 403; three corresponding allowlist audit entries verified.
- Enabled matrix: allowlisted principal at `xidan` enabled; same-store ordinary POS principal denied; non-designated store denied; forged direct API request denied with 403.
- Management smoke: PASS with 0 cards.
- Existing POS product/order reads: PASS; 86 current POS products returned.
- Existing WeChat and Alipay official payment queries remained `success`; existing WeChat and Alipay refund queries remained `completed`.
- Local targeted suites: Sweet Card 45/45, permission 17/17, POS 10/10, payment 22/22, reconciliation 17/17, WeChat signature 12/12, provider 23/23, config 9/9, Alipay/payment-access 23/23 and Product authority contract 6/6; Vite build PASS. The canonical unified-product PostgreSQL workflow also passed in an isolated 63-migration schema.
- Prisma/schema difference from the migration-63 Candidate: 0. No new migration was created.

## Rollback and stop condition

- Immediate application rollback: route traffic to the preserved disabled runtime `budu-prod-644fb97-sweet-card-p6a-disabled`, or disable `SWEET_CARD_ENABLED`. The allowlist flag and audit records are inert while disabled; database restore is not required.
- Previous runtime `budu-prod-12c9337-sweet-card-disabled` is also preserved stopped.
- Gate P6 result: PASS.
- Mandatory STOP: do not begin Gate P7, issue cards, create value, redeem, refund or expand the principal/store scope without a new explicit authorization.

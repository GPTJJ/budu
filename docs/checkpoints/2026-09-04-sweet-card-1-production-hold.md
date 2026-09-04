# budu 甜意卡 1.0 production HOLD checkpoint

Date: 2026-09-04 (Asia/Shanghai)

- Production runtime: `12c93379409d944c37e1ab9708ea972fb4be1474` — VERIFIED, Candidate deployed with `SWEET_CARD_ENABLED=0`.
- PostgreSQL authority: `budu_bj006`; migration 63 applied / 0 failed — VERIFIED.
- Gates P0–P5: PASS.
- Gate P6: HOLD because POS Sweet Card uses global flag + store policy + `STORE_POS`, with no test-account allowlist. Every production store has ordinary POS accounts.
- Gates P7–P19: not run. No Sweet Card rows exist; no card or real Sweet Card transaction was created.
- Legacy smoke: controlled ¥0.10 cash order was fully refunded; WeChat and Alipay success-state provider queries passed.
- Rollback assets: `/opt/budu/.rollback-assets/sweet-card-12c9337-20260904T151115Z`; database dump SHA256 `002250a8ea633d2583b94dc5f439ee278f60f6b73e827b579e21d272cfabbb28`.
- Full report: `docs/BUDU_SWEET_CARD_1_0_PRODUCTION_FINAL_REPORT.md`.
- Next action: create a new reviewed Candidate with a fail-closed server-side rollout account allowlist, then repeat the production gate from a freshly verified baseline. Do not enable the current Candidate.

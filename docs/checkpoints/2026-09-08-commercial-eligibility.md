# Sweet Card COMMERCIAL eligibility Candidate

Status: SWEET_CARD_COMMERCIAL_ELIGIBILITY_PATCH_READY (2026-09-08).
Branch: codex/sweet-card-commercial-eligibility.
Base: 3d9ae49b5601fbec76d63db2a5fe5d3de3f0b576.
Repository: GPTJJ/budu. Candidate is local and not pushed.

## Application authority
server/sweet-card-claim-eligibility.js is the shared supported-purpose list:
ACCEPTANCE_TEST and COMMERCIAL only. Generation DTO, issue/revoke,
claim/preview, optional binding, wallet list/detail and POS presentation use it.
Permission, account locks, credential uniqueness, signed gateway, session User.id,
Claim/POS namespaces, store policy and redemption transaction stay intact.
Expired cards are denied at generation and optional binding as well as claim/POS.
Public access requires explicit SWEET_CARD_MINIPROGRAM_CLAIM_ALLOWLIST_ONLY=0.
Generation in production still requires the enabled Claim feature and signed gateway;
controlled mode with a nonempty allowlist also remains available.
No default environment or production configuration was modified.

## Current verification
- Sweet Card unit/regression: 85/85 PASS.
- POS: 10/10 PASS. Payment: 22/22 PASS. Production build: PASS.
- Signed HTTP integration: PASS against an empty isolated PostgreSQL 16 scratch DB.
- Admin generation: 201; POS-only/customer: 403.
- Concurrent generation: one 201, one 409; one active Claim token.
- Concurrent claims by different User.id: exactly one winner.
- Public-mode customer outside the old allowlist: Claim 201, self replay 200.
- Second customer: 409; spoofed identity: 400; unsigned gateway: 401.
- REQUIRED auto-binding and OPTIONAL later binding: PASS.
- COMMERCIAL wallet list/detail and PNG POS presentation: PASS.
- Frozen/lost/expired Claim and POS denial: PASS.
- Claim QR/POS namespace confusion: denied.
- Claim/Binding/generation economic snapshot unchanged; scratch Ledger=balance=5000 cents.
- No real wx.login/physical device test was performed in this Candidate gate.

## Isolation and reproduction
Run scripts/test-sweet-card-commercial-integration.mjs only against host
sc-commercial-scratch-pg and database budu_commercial_eligibility_scratch.
The test rejects other targets before writes. It uses synthetic users/sessions
and a test signing secret. Production secrets, mounts and network were excluded.
The scratch DB was initialized from the existing schema (prisma db push) plus
the existing partial unique index on active Claim tokens. No migration was added
or applied to production. Scratch containers/network were removed after PASS.

## Production evidence
Read-only post-check: runtime 3d9ae49..., healthy; budu_bj006, migration 70/0.
Ledger and balance=700090 cents, delta=0.
No production business data/config mutation or deployment in this gate.
MiniProgram 3.5.1 unchanged. Payment/Refund/Redemption files and schema unchanged.

## Handoff
Candidate is committed locally; not pushed, so unavailable from another device.
Unknown changes in the original budu OS checkout were preserved and excluded.
Next gate requires explicit production authorization and fresh preflight.
Do not automatically enable Public Claim or deploy this Candidate.

# BUDU Payroll Audit Report 2.0 Checkpoint

Date: 2026-09-01 (Asia/Shanghai)

Status: **READY — production read-only acceptance completed**

## Git and scope

- Branch: `codex/budu-payroll-audit-skill`
- Base HEAD before Report 2.0: `4179e94fe3b09ebcde5487f4972fc58c12e2e830`
- Production business code changed: no.
- Database/schema/migration changed: no.
- Production data writes: none.
- Allowed changes are limited to the Skill, canonical report model, Markdown/PDF/email renderers, read-only extractor, headless runner, delivery-state helper, tests and documentation.

## Canonical report contract

- One audit result is the sole source for management email, full Markdown and PDF.
- Renderers do not query Payroll or recalculate salary.
- The production extractor starts a read-only repeatable-read transaction and uses the deployed Payroll authority and Personnel projection.
- `Employee.id` remains the only employee identity. Schedule is comparison evidence only and legacy name-only rows are never guessed into payroll identity.
- Daily evidence is sourced from Payroll authority explanations; raw orphan `DailyStoreStaff` rows are not promoted to attendance/payroll facts.
- Dynamic payroll components are discovered from the authority result instead of a fixed component list.
- FINAL/PREVIEW, PASS/REVIEW_REQUIRED/BLOCKED and exact-cent mismatch semantics are retained.

## Artifact and delivery safety

- Artifacts are private (`0600`) under an ignored output directory.
- Run identity and canonical hash support idempotent monthly execution.
- A SENT manifest cannot be sent a second time; an email-only retry reuses the same verified PDF/Markdown and does not rerun the audit.
- No SMTP/Gmail credential, webhook or attachment content is committed to Git.
- The only allowed recipient is `yuegu1995@gmail.com`; cc/bcc are empty.

## 2026-08 FINAL acceptance

- Production runtime SHA: `3c7f56c6cc77573e252023b59e2dcdfd1522678d` — VERIFIED on 2026-09-01.
- Database: `budu_bj006`; migration ledger: 62; failed migrations: 0 — VERIFIED.
- Run ID: `af95439ab9e231462b917132`.
- Canonical hash: `31ce05603afe600c6eb1a628dbf7c082860fe1ce71223a91c48091cf51056991`.
- Result: PASS; 11 employees; 0 findings.
- Authority digest before/after report rendering: identical; no production drift.
- PDF: 36 portrait pages; CJK/cover/employee evidence/final conclusion visually inspected; orphan raw DSS IDs absent.
- PDF SHA-256: `2604f1cd5346adf5331b910d5940e924caeddbd997e8fbcab90f6155e2d6c521`.
- Markdown SHA-256: `d9da4a1bcd7f3c88f963a181d1f1b2e4af0f41204e966ca8b4453ff4d0b63c7c`.
- Email: SENT once, verified in Gmail with PDF and Markdown attachments and no cc/bcc.

## Monthly automation

- Automation name: `BUDU 月度薪酬审查`.
- Status: ACTIVE.
- Schedule: monthly on day 1 at 09:00 Asia/Shanghai.
- Audit range: preceding complete calendar month, FINAL / ALL.
- The automation checks the manifest and Gmail sent state before delivery, preserves read-only/no-drift gates and never runs a second scheduler on the production host.

## Verification

- Skill validator: PASS.
- Skill contract: 10/10 PASS.
- Report 2.0 contract: 8/8 PASS.
- Payroll resolver/readiness/orphan/payable-hours/identity/component/card regressions: PASS.
- PDF structural and visual QA: PASS.
- Production read-only audit and no-drift reconciliation: PASS.
- Vite build: PASS.

## Recovery

Fetch `codex/budu-payroll-audit-skill`, verify the remote SHA and a clean worktree, then run `npm run test:skill:payroll-audit`, `npm run test:payroll-audit-report` and `npm run build`. Generated artifacts and the local delivery manifest are intentionally not in Git; recover them from the protected delivery record or run a new read-only audit for a new canonical period. Never rerun an already-SENT run merely to retry delivery.

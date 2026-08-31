# budu Brand + Payroll Audit Report 2.0 Checkpoint

Date: 2026-09-01

## Scope

- Added the canonical `budu` brand asset authority and the `budu-brand-system` team Skill.
- Routed user-visible UI, PDF, email, report, export and document work through the brand Skill.
- Rebranded the formal payroll audit output without changing Payroll calculations or Production business facts.
- Re-ran the complete 2026-08 payroll audit in FINAL mode and delivered the canonical PDF and Markdown to the single approved recipient.

## Verified baseline

- Production runtime before release: `3c7f56c6cc77573e252023b59e2dcdfd1522678d`.
- Authoritative mainline before candidate: `ca8fa436ec6c7b7f2d8f627431b67cad8c1b53a8`.
- PostgreSQL authority: `budu_bj006`.
- Migration ledger: 62; failed migrations: 0.
- Canonical DB-connected runtime count: 1; public health: PASS.

## Brand authority

- Canonical source: `brand/source/budu-wordmark.pdf`.
- Source SHA-256: `25a4911c83fdf79d75eea023333be89700aaafb8e2aa5a275d9c6d249208b209`.
- The source is an Illustrator vector PDF with no fonts or raster XObjects.
- Measured wordmark bounds: 396.8512 × 127.5082 pt; aspect ratio 3.11235:1.
- Controlled derivatives:
  - `brand/web/budu-wordmark.svg`
  - `brand/document/budu-wordmark-1600.png`
- Formal user-visible naming is lowercase `budu`.
- Technical constants, SKU/employee prefixes, provider identifiers and historical records remain unchanged.

## Payroll audit evidence

- Run ID: `7a1dd7a7b2f0d5325779d127`.
- Canonical authority digest: `c50d5a54b2824fe9a69e8f11a5c1e6eba87e5bdf299e2a9e2375a0b52623839d`.
- Period: 2026-08-01 through 2026-08-31; mode: FINAL; scope: ALL.
- Result: PASS; employees: 11; PASS: 11; REVIEW_REQUIRED: 0; BLOCKED: 0.
- Authoritative Payroll total: ¥47,243.45.
- Employee Card total: ¥47,243.45; difference: ¥0.00.
- 卡皮巴拉 is included as 老板替班: 35.5 payable hours and ¥1,065.00, using the normal Payroll authority.
- Production authority digests before and after the read-only extraction are equal (`noDrift=true`).

## Artifacts and delivery

- Markdown: `output/payroll-audits/7a1dd7a7b2f0d5325779d127/budu_2026-08_薪酬审查报告.md`.
- PDF: `output/payroll-audits/7a1dd7a7b2f0d5325779d127/budu_2026-08_薪酬审查报告.pdf`.
- PDF SHA-256: `d7d896b2dbc98814f12744909d2e68b93ac0becf65da3d4ee4d337b77d463041`.
- PDF is 36 A4 portrait pages. All pages were rendered and visually inspected; the canonical wordmark, Chinese text, amounts and mobile-readable layout passed.
- Gmail message ID: `1a05936ebbf82a69`.
- Subject: `budu｜2026年08月薪酬审查报告｜PASS`.
- Recipient: `yuegu1995@gmail.com`; CC/BCC: none.
- Delivery manifest state: SENT; attempts: 1.
- Existing monthly automation `budu` was updated in place; no duplicate scheduler was created.

## Verification

- Brand Skill tests: 5/5 PASS; Skill validator: PASS.
- Payroll audit Skill tests: 10/10 PASS; Skill validator: PASS.
- Payroll report tests: 8/8 PASS.
- Brand WebKit checks: 4/4 PASS at 390px and desktop.
- Payroll authority and identity regression: PASS, including isolated PostgreSQL-backed notice/self-scope tests.
- Export/transfer/partner-supply targeted regression: PASS after updating the canonical lowercase export assertion.
- Production build: PASS.
- `git diff --check`: PASS.
- Existing Settings UI suite retains one stale baseline wording assertion unrelated to this scoped diff; no business UI was changed to mask that test debt.

## Safety and migration

- Migration: NONE.
- Production business data modified: NO.
- Payroll formula, DailyEntry, DailyStoreStaff, actualHours, Payment, Refund, Notification and Report Center authorities were not changed.

## Release and handoff

- Candidate branch: `codex/budu-brand-payroll-report`.
- Candidate SHA: pending final commit.
- Production runtime after release: pending deployment verification.
- Authoritative mainline after release: pending deployment acceptance.

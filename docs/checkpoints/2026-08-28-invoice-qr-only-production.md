# CHECKPOINT — Invoice QR-Only Production Release

## Release

- Production SHA: `ae08380290e2d444ab8c76f6ea6e941b6b3dd9c9`
- Parent production SHA: `ce9f4e770224700628bb2f8de9a5579496774bdb`
- Release branch: `codex/invoice-qr-only`
- Workflow: `https://github.com/GPTJJ/budu/actions/runs/33183382425`
- Deployment result: SUCCESS at 2026-08-28 23:21 +08:00

## Product Contract

- Employee Invoice creation is QR-only; manual entry, OCR and recognition entry
  points are absent from the employee page.
- Store, positive amount and exactly one category (`食品`, `巧克力`, `太妃糖`)
  are required before QR creation.
- The server validates the active/authorized store, integer cent amount greater
  than zero and the exact category whitelist.
- Store, amount and category are stored in CustomerRequest authority and are
  rendered read-only to the customer. Customer submission payload cannot
  override them.
- Existing Invoice records, status controls, Notification, deep link and exact
  WeCom `budu → dh` delivery authority remain in place.
- Existing short-lived legacy Invoice QR metadata remains submit-compatible;
  historical Invoice records were not rewritten.

## Schema / Data Safety

- Migration files changed: NO.
- Production migration ledger before/after: 49 / 49 — VERIFIED by workflow.
- Production database: `budu_bj006` — VERIFIED by workflow.
- Production DB-connected writer before/after: exactly 1 — VERIFIED by workflow.
- Fresh migration-49 custom-format backup integrity: PASS; protected rollback
  copy created.
- Historical `Invoice` and `MailingRecord` digests: unchanged across deployment.
- Old application container/image and nginx rollback configuration were
  preserved by the blue/green deployment.

## Validation

- Critical gate: 52 PASS / 0 FAIL.
- Invoice + Mailing + CustomerRequest WebKit: 32 PASS.
- Notification suite with isolated PostgreSQL: 16 PASS.
- Stable CustomerRequest WeCom suite: 7 PASS, exact recipient `budu → dh`.
- Local Invoice/CustomerRequest/Mailing/Notification browser regression:
  35 PASS.
- Production build: PASS.
- Unrouted read-only candidate smoke: PASS.
- Public post-cutover health: `ok=true`, `env=prod`, `dbOk=true`,
  `gitSha=ae08380290e2`.
- Public production assets contain the QR-only employee flow and locked customer
  fact display. No production business record was created for smoke testing.

## Rollback

- Rollback asset pattern:
  `.rollback-assets/invoice-qr-only-ae08380-<timestamp>/`.
- Before rollback, re-verify the exact path, current database authority,
  migration ledger and single-writer ownership.
- Do not delete the protected backup or preserved old container/image.

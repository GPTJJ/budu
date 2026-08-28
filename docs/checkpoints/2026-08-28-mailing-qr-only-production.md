# CHECKPOINT — Mailing QR-Only Production Release

## Metadata

- **Name:** BUDU Mailing QR-Only Experience Production Release
- **Date:** 2026-08-28
- **Release Git SHA:** `ce9f4e770224700628bb2f8de9a5579496774bdb`
- **Production SHA:** `ce9f4e770224700628bb2f8de9a5579496774bdb`
  (VERIFIED by workflow exact SHA and current public runtime prefix)
- **Release branch:** `codex/mailing-qr-only`
- **Current checkout at handoff:** `feat/pos-wechat-refund@981ce38`
- **Workflow evidence:** `https://github.com/GPTJJ/budu/actions/runs/33175124358`

## Database / Migration State

- Database authority at cutover: `budu_bj006` — VERIFIED by deployment workflow.
- Migration: `48 → 49` — VERIFIED at cutover.
- Migration 49:
  `20260828160000_mailing_qr_only_shipping_contract`.
- Historical MailingRecord digest difference: `0` — VERIFIED at cutover.
- Current live DB/migration direct re-query during handoff: UNVERIFIED.

## Canonical Authorities

- `CustomerServiceRequest` and its hashed one-time token are the public
  collection/workflow authority; official `MailingRecord` / `Invoice` rows are
  final business authority.
- Employee Mailing creation UI is QR-only. The server, not the client, enforces
  the SF customer-paid confirmation contract.
- BUDU Notification remains notification fact authority.
- CustomerRequest WeCom routing is the exact stable binding
  `BUDU User.username=budu → WeCom UserID=dh`; recipient count is one and all
  name-, employee-, directory- and role-based routes are forbidden.
- Payroll, StoreEntry, POS and Payment/Refund retain their existing canonical
  authorities; migration 49 does not alter them.

## Critical Invariants

1. SF free and Flash free may generate the customer QR directly.
2. SF customer-paid requires exactly STANDARD ¥18 or FRESH ¥35 and trusted
   staff payment confirmation before customer QR generation/submission.
3. Flash customer-paid stores/displays `不包邮 · 微信沟通`; no fake system amount
   or payment confirmation is created.
4. CustomerRequest submission is one-time and transactional: official business
   record + BUDU Notification commit together.
5. WeCom delivery failure never rolls back CustomerRequest, Mailing, Invoice or
   BUDU Notification.
6. Historical Mailing records are not rewritten; new structured shipping fields
   are nullable and backward compatible.
7. QR assets are repository-owned, were deployed byte-for-byte, and no external
   QR generation site is an authority.
8. Payroll formula/subject authority, StoreEntry authority, POS and
   Payment/Refund behavior remain frozen.

## Validation Evidence

- Critical gate: 51 PASS / 0 FAIL.
- Mailing + CustomerRequest WebKit: 27 PASS.
- CustomerRequest integration: 13 PASS.
- WeCom stable-binding suite: 7 PASS.
- Production build: PASS.
- Migration rehearsal and old-app read compatibility: PASS.
- Unrouted read-only candidate smoke: PASS.
- Public health after nginx cutover: PASS.

## Backup

- Fresh post-freeze, pre-migration-49 custom-format backup of `budu_bj006`:
  integrity PASS (`pg_restore --list`).
- Protected rollback copy: CREATED.
- Expected server path pattern:
  `.rollback-assets/mailing-qr-only-ce9f4e7-<timestamp>/`.
- Exact surviving path at handoff: UNVERIFIED; do not invent it.

## Rollback Baseline

- Old application image/container were preserved.
- Additive migration-49 compatibility with the old application read projection
  was rehearsed.
- Application rollback is expected to be available using the preserved old
  container/image; full DB rollback uses the protected migration-48 backup.
- Before rollback, re-verify the exact container/image/backup paths and current
  DB authority. Do not delete any rollback asset.

## Known Risks

- Current checkout branch is not the production release branch. This is an
  AUTHORITY CONFLICT until explicitly integrated.
- Current migration ledger, single-writer count and backup presence have not
  been directly re-queried after cutover.
- Enterprise WeChat credential exposure is KNOWN; rotation was DEFERRED BY OWNER
  and is not a deployment blocker. Never expose credential values.
- Existing dirty `server/wechat-alert.js` work is unrelated/unverified and was
  excluded from this checkpoint work.

# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-09-05

## Repository

- Remote: `https://github.com/GPTJJ/budu.git`.
- Local HEAD must never be assumed to equal production.
- Preserve unknown working-tree changes and reconcile branch authority before deployment.

## Canonical Authorities

- Business data: PostgreSQL.
- Employee identity: `Employee.id`; self-account link: `User.employeeId → Employee.id`.
- Product identity: `InventoryItem.id`; classification: `ProductCategory`.
- POS, transfer, and partner-supply eligibility are attributes of the same `InventoryItem`.
- Financial authority: PostgreSQL `Order` / `Payment` / `Refund` and server-side transition/reconciliation services.

## Last Directly Verified Production Baseline

- Sweet Card Commercial R1 reached `READY_FOR_XIDAN_COMMERCIAL_LAUNCH` on
  2026-09-05. The commercial flag remains disabled and no first commercial
  batch was created. See `docs/BUDU_SWEET_CARD_1_0_COMMERCIAL_RELEASE.md`.
- Runtime SHA: `fe4a7254a0ec9a68390cefe12b0766b3ec15ef93` — VERIFIED.
- Database: `budu_bj006`; Migration 65 applied / 0 failed — VERIFIED.
- `SweetCardBatch.businessPurpose` is the canonical typed batch-use authority.
  All 3 existing batches are `ACCEPTANCE_TEST`; commercial reports default to
  `COMMERCIAL`, while financial reconciliation remains all-facts.
- ISSUE 50,150 - REDEEM 150 + REFUND 90 = balance/Ledger 50,090 cents; delta 0;
  commercial-only outstanding 0.
- Three xidan POS operators hold `sweetCardPosRedeem`. The commercial-mode
  read-only matrix passed authorized ALLOW and unauthorized/store/spoof DENY.
- Public/internal health and all business regressions passed; exactly one
  production writer was verified.
- Current canonical restore artifact:
  `/opt/budu/.rollback-assets/sweet-card-r1-fe4a725-20260905/current-canonical-budu_bj006-m65.dump`,
  SHA-256 `c97d77a37efdefc47cf397aff6181fde1380ee37f6ad9174ef7795fb5925b773`;
  checksum and isolated restore PASS.
- See `docs/checkpoints/2026-09-05-sweet-card-commercial-r1-ready.md`.
- Revalidate all facts before further production action.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- `codex/sweet-card-p7c-serialization` contains the deployed application-only serialization repair and subsequent documentation. Current blocker is P10 conflict error handling; continuation needs a separately authorized Candidate. No balance edits, automatic refunds or replay of completed acceptance orders.
- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- `budu-brand-system` is the canonical user-visible brand workflow. Formal names are lowercase `budu`; formal brand positions use the canonical wordmark source or its controlled derivatives. Internal identifiers and historical facts are not renamed.
- `budu-payroll-audit` is the canonical team workflow for asking whether calculated payroll is correct. It is always STRICT and read-only, reuses the current Payroll authority and stable `Employee.id`, and explicitly excludes paid/owed settlement reconciliation.
- Payroll Audit Report 2.0 renders one canonical audit model into a management email summary, complete Markdown and portrait PDF. Monthly execution is active for the first day of each month (Asia/Shanghai), audits the preceding full calendar month, and reuses immutable artifacts for email-only retries. See `docs/checkpoints/2026-09-01-payroll-audit-report-2.md`.
- System Settings UI 2.0 remains live within runtime SHA `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`; the later brand-slot release is application-only with no migration or business-authority change.
- Desktop navigation and the mobile drawer share `src/components/BrandSlot.jsx`: the approved simple character icon is paired with the unchanged canonical lowercase `budu` wordmark, and the former `甜蜜治愈日常` subtitle is absent.
- BrandSlot assets locally override the legacy global image outline with transparent, borderless presentation; the underlying icon and canonical wordmark assets remain unchanged.
- The settings surface now uses four browse-first groups with capability-aware secondary pages. Notification unread/routing, POS/DailyEntry source authority and all existing settings operations remain unchanged.
- Report Center migrations 59–62 and Sweet Card migrations 63–65 are deployed. Current migration baseline is 65; Migration 65 adds the typed batch-purpose authority without changing economic amounts.
- Previous Production runtime `budu-prod-f7fd6e5-brand-slot-r2` and protected brand-border rollback assets are retained. See `docs/checkpoints/2026-09-01-budu-brand-slot-border-hotfix.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.

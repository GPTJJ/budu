# BUDU Stable Engineering Status

> Lightweight context-recovery index. This file is not production authority and cannot replace current Git, runtime, database, migration, or reconciliation evidence.

Last reviewed: 2026-09-04

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

- Runtime SHA: `ccdf1358938e53da99daf2a24d2cf3c6b13c8fed` — VERIFIED on 2026-09-04; revalidate before use.
- Database authority: `budu_bj006` — VERIFIED on 2026-09-04; revalidate before use.
- Migration ledger: 62, schema up to date — VERIFIED on 2026-09-04; revalidate before use.
- Public/internal health and exact routed runtime: PASS / `ccdf1358938e53da99daf2a24d2cf3c6b13c8fed` — VERIFIED on 2026-09-04; revalidate before use.
- Latest Candidate checkpoint: `docs/checkpoints/2026-09-04-sweet-card-1-candidate.md`; it did not change Production.

## Architecture Contracts

- One domain has one canonical authority and stable identity key.
- Historical business facts use stable IDs and immutable snapshots; current renames or disablement do not rewrite history.
- Client storage and display names are never business authority.
- Payment and payroll work are STRICT. Production cutover requires an explicit gate.

## Current Engineering Work

- `codex/sweet-card-1-candidate` contains the feature-flagged budu 甜意卡 1.0 Candidate and additive migration 63. Production remains disabled and unmigrated; see its scoped checkpoint before any future release gate.
- BUDU repository team-skill foundation lives under `.agents/skills/budu-*`.
- `budu-brand-system` is the canonical user-visible brand workflow. Formal names are lowercase `budu`; formal brand positions use the canonical wordmark source or its controlled derivatives. Internal identifiers and historical facts are not renamed.
- `budu-payroll-audit` is the canonical team workflow for asking whether calculated payroll is correct. It is always STRICT and read-only, reuses the current Payroll authority and stable `Employee.id`, and explicitly excludes paid/owed settlement reconciliation.
- Payroll Audit Report 2.0 renders one canonical audit model into a management email summary, complete Markdown and portrait PDF. Monthly execution is active for the first day of each month (Asia/Shanghai), audits the preceding full calendar month, and reuses immutable artifacts for email-only retries. See `docs/checkpoints/2026-09-01-payroll-audit-report-2.md`.
- System Settings UI 2.0 remains live within runtime SHA `f7fd6e54c4b8eac6fbdbc761d5e0788fddb1d9dc`; the later brand-slot release is application-only with no migration or business-authority change.
- Desktop navigation and the mobile drawer share `src/components/BrandSlot.jsx`: the approved simple character icon is paired with the unchanged canonical lowercase `budu` wordmark, and the former `甜蜜治愈日常` subtitle is absent.
- BrandSlot assets locally override the legacy global image outline with transparent, borderless presentation; the underlying icon and canonical wordmark assets remain unchanged.
- The settings surface now uses four browse-first groups with capability-aware secondary pages. Notification unread/routing, POS/DailyEntry source authority and all existing settings operations remain unchanged.
- Report Center migrations 59–62 are deployed in the canonical production ledger. Future work must treat 62 as the current migration baseline and revalidate before assigning the next number.
- Previous Production runtime `budu-prod-f7fd6e5-brand-slot-r2` and protected brand-border rollback assets are retained. See `docs/checkpoints/2026-09-01-budu-brand-slot-border-hotfix.md`.

## Rollback Notes

- Production releases use exact-SHA artifacts and retain rollback assets; verify their current presence before a release.
- A migration must have an explicit backup, compatibility, reconciliation, and rollback contract.

Update this file only when a stable architecture contract or verified production baseline materially changes. Keep task history in scoped checkpoints.

# Daily Performance Correction 1.0

## Authority and scope

Production baseline verified on 2026-09-20: `f272912cfaa97fcbbd67c03c0d0bf3ea4dda9aec`, prod health/dbOk, 83 applied migrations with no failures. This change has no migration and does not change payment, Partner, inventory or logistics.

`DailyEntry` owns store/date, revenue and orders. `DailyStoreStaff` owns stable participant identity and `actualHours`. Existing unique constraints are DailyEntry(storeKey,date) and daily_store_staff(store_id,date,employee_id), plus the existing legacy participant constraints.

The new correction API requires developer or the existing top-level `admin` role AND the existing dailyEntry.revise capability. There is no separate `super_admin` role in this repository. Finance, manager, staff, cashier and Partner cannot use it. Existing revise/adjust HTTP entry points have the same narrowed permission; ordinary confirmation is unchanged.

GET/POST `/api/v2/daily-entry/correction` provides historical correction and missing-day supplement. A reason, explicit values and a snapshot token are required. A serializable transaction, ordered store-day advisory locks, existing payroll employee locks, version CAS and unique constraints protect atomicity. An occupied destination returns 409 without merging. Missing-day orphan staffing fails closed. Existing unresolved legacy staffing/payable-hours authority retains its protection rather than guessing identity.

The existing `DailyEntryAuditLog` stores actor, role, correction ID, reason, timestamp, complete before/after entry and staffing, effective previous sales and issued-payroll checksums. `salesDataStatus=corrected` (existing string column) marks audited canonical corrections; overview, ledger, dashboard POS overlay and report summary respect them. POS orders/payments remain unchanged. The editor prefills effective POS/hybrid figures rather than old zero placeholders and includes these figures in its concurrency token.

Payroll paid-state protection uses issued `payroll_notices` (pending or confirmed), not a claim of bank settlement. Issued artifacts remain byte-for-byte unchanged. No payroll amount, adjustment, payout, delivery or notification is written. Unissued payroll continues through the existing resolver and actualHours. Existing pay rules use solo base rate 30 versus multi-person 28 and per-store revenue commission tiers; this feature introduces no new overtime policy.

## Validation

`scripts/test-daily-performance-correction.mjs`: isolated native PostgreSQL, full current schema; move/release, supplement, duplicate participant pay removal, correct employee actual hours, existing store commission/solo subsidy, issued snapshot immutability, target conflict, role denial, full audit, injected staff/audit failures, simultaneous stale correction, idempotent retry, real POS fixture read authority and unchanged Order, HTTP correction/RBAC/overview, report summary.

`scripts/test-daily-correction-ui.mjs`: WebKit at 320/340/375/390/430/1024/1280px, form submission, supplement, required reason, conflict retains inputs, multi-store confirmation and single-store unchanged. Existing store-entry UI suite: 32/32. Related permissions/payroll/authority/report unit tests: 30/30. Production build passed.

## Real incident — facts still pending

Read-only observation: 2026-09-15 already has both Xidan and Tongying confirmed DailyEntry records. Chen has 12 actual hours at each store; Tongying records 716 yuan / 9 orders. Xidan is POS-backed with a zero DailyEntry placeholder. Li has no canonical staffing row that day. Neither employee has an issued payroll notice covering the incident date.

The destination is occupied, so the requested simple move must reject. Do not overwrite Xidan or delete either record. Accurate Xidan and Tongying revenue/order counts and each employee's actual hours, plus the decision to correct the two existing records, are required before using the audited service. No production incident repair is included in this code release.

## Release / rollback

User authorized tool rollout before missing incident facts. Build an exact clean commit image, verify image source hashes, retain production application image/config and fresh PostgreSQL backup, briefly quiesce through existing maintenance runbook, check ledger, start exact image, readonly production context/RBAC smoke, reopen traffic and observe. Application rollback restarts retained f272912 on the unchanged ledger83; no database restore. After actual corrections occur, old application semantics are no longer a safe rollback for corrected POS days; use a forward fix or a reviewed compatible artifact.

Private operational evidence and backups are outside the repository under the task-specific audit / rollback directories. No production personal records, tokens, passwords or dump are committed.

# PROJECT STATUS

> 当前项目状态快照，不是永久规则，也不能替代 Runtime / Database 直接验证。
> 状态词遵循根目录 `AGENTS.md`。发生冲突时必须保留冲突并 STOP。

## 1. Snapshot

| Field | Value | Status |
| --- | --- | --- |
| Last Updated | 2026-08-28 22:24 +08:00 | VERIFIED |
| Repository | `/Users/apple/Desktop/budu OS` / `GPTJJ/budu` | VERIFIED |
| Current checkout branch | `feat/pos-wechat-refund` | VERIFIED |
| Audited checkout HEAD | `981ce38b75d2bfd1ed3b85ee3b859cbd1e703d5f` | VERIFIED |
| Upstream at fetch | `origin/feat/pos-wechat-refund` at the same SHA | VERIFIED |
| Working tree before handoff docs | DIRTY: only `server/wechat-alert.js` had an existing 3-line uncommitted change | VERIFIED |
| Dirty-file provenance / correctness | Not established; preserved and excluded from handoff commit | UNVERIFIED |
| Production release branch | `origin/codex/mailing-qr-only` | VERIFIED |
| Production release commit | `ce9f4e770224700628bb2f8de9a5579496774bdb` | VERIFIED |
| Branch relationship | merge-base `f63a29c`; current checkout has 1 unique commit, production branch has 16 unique commits | VERIFIED |

The documentation commit that contains this snapshot can be obtained with
`git log -1 -- docs/PROJECT_STATUS.md`. The audited code baseline is recorded
separately so the document does not pretend its own yet-unknown commit SHA.

## 2. Production State

| Item | Current known state | Evidence | Status |
| --- | --- | --- | --- |
| Production Commit | `ce9f4e770224700628bb2f8de9a5579496774bdb`; public health reports prefix `ce9f4e770224` | Direct `https://buducandy.cn/api/health` at 2026-08-28 22:24 +08:00; successful workflow run `33175124358` | VERIFIED |
| Runtime Identity | `env=prod`, `appVersion=V2.20`, `dbOk=true` | Direct public health response | VERIFIED |
| Database Authority | `budu_bj006` at cutover | Workflow run `33175124358` verified DB before and after migration | VERIFIED at cutover; current direct DB query UNVERIFIED |
| Migration State | `48 → 49` applied by exact release migrator | Workflow run `33175124358` | VERIFIED at cutover; current direct ledger query UNVERIFIED |
| Deployment State | Exact candidate built; unrouted smoke PASS; nginx blue/green cutover PASS; public health PASS | Workflow run `33175124358` plus current public health | VERIFIED |
| Writer State | Exactly one production DB-connected application writer at cutover | Workflow run `33175124358` | VERIFIED at cutover; current direct recount UNVERIFIED |
| Historical Mailing data | Pre/post additive-migration digest unchanged | Workflow run `33175124358` | VERIFIED at cutover |

**Production Verification: PARTIAL.** Runtime SHA/health are current and direct.
DB name, migration ledger and writer count were verified by the successful
cutover workflow but have not been re-queried directly after this handoff.

## 3. Canonical Authorities

Entries are branch-scoped. Production-only code is not represented as part of
the current checkout HEAD.

| Domain | Canonical Authority | Identity Key | Legacy Compatibility | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| CustomerRequest | PostgreSQL `CustomerServiceRequest` + hashed one-time token workflow; official Mailing/Invoice records remain final business authority | request `id`; SHA-256 `tokenHash` | Employee manual Invoice/Mailing paths remain; no public token becomes business identity | production branch `server/customer-request-core.js`, `server/customer-requests.js`, migration 48, CustomerRequest tests | VERIFIED in deployed production branch |
| Mailing QR-only | PostgreSQL `MailingRecord`; QR configuration is locked in CustomerRequest metadata and submitted transactionally | `MailingRecord.id`; structured shipping fields | Historical nullable fields and display-only legacy `fee` remain; legacy direct API exists but employee create UI is QR-only | `StoreMailingPage.jsx`, `mailingWorkflow.js`, migration 49, migration rehearsal, WebKit suite | VERIFIED in deployed production branch |
| CustomerRequest WeCom | BUDU Notification remains notification authority; exact runtime binding `BUDU User.username=budu → WeCom UserID=dh` is the only WeCom recipient route | request/type/binding delivery identity | No name, Employee.id, role broadcast, directory search or `server/wechat-alert.js` routing | production `notification-center.js`, recipient resolver, WeCom unit suite, production binding verification | VERIFIED in deployed production branch |
| Invoice | PostgreSQL `Invoice` is the formal request/status authority; CustomerRequest is only collection workflow | `Invoice.id` | Staff manual entry remains | Prisma schema, `server/v2.js`, `server/customer-requests.js` | VERIFIED in deployed source; live record set not inspected |
| Payroll calculation | `Employee.id` + `DailyEntry` business facts + `DailyStoreStaff` participant facts + tagged `ACTUAL_HOURS` / `LEGACY_PAYROLL_HOURS` through the single range resolver | `Employee.id` + inclusive date range | Explicit legacy compatibility may reconcile but may not invent identity or actual attendance | `server/payroll-authority.js`, `src/utils/payrollResolver.js`, participant/payable-hours tests | VERIFIED in deployed source and CI |
| Payroll issuance | PostgreSQL immutable `PayrollNotice` snapshot | `Employee.id` + protected period | Historical snapshots retained; overlapping active periods fail closed | `server/payroll-notice.js`, Prisma constraints, issue tests | VERIFIED in deployed source and CI |
| StoreEntry / participation | PostgreSQL `DailyEntry` + `DailyStoreStaff`; stable Employee participants use `Employee.id` | `(storeKey,date)` and stable participant identity | `staffNames`, snapshots and legacy rows are compatibility/display only; no heuristic identity promotion | `server/daily-entry-upgrade.js`, `server/v2.js`, `shared/payrollParticipantAuthority.js` | VERIFIED in deployed source and CI |
| POS | PostgreSQL `Order` / `OrderItem` with protected checkout identity and immutable order snapshots | order `id`, unique checkout/request keys | Browser/session caches are resumable UI state only | `server/pos.js`, `server/pos-core.js`, order-protection tests | VERIFIED in deployed source and CI |
| Payment / Refund | PostgreSQL `Payment`, `Refund`, logs and canonical transition/reconciliation services | request/payment/refund/provider identifiers | Provider ambiguity is persisted and reconciled; no client state is financial authority | `server/payments/payment-service.js`, payment/refund reconciler tests | VERIFIED in deployed source and CI |

## 4. Completed Work

- Customer Self-Service Request 1.0 is implemented for `MAILING` and `INVOICE`
  with hashed, expiring, one-time tokens, transactional official records and
  BUDU Notifications.
- CustomerRequest WeCom delivery uses the stable `budu → dh` binding only;
  missing/mismatched binding fails closed and delivery failure does not roll
  back the business transaction.
- Mailing employee creation is QR-only. SF free, SF standard ¥18, SF fresh ¥35,
  payment confirmation gating, Flash free and Flash customer-paid WeChat
  communication are implemented. Historical Mailing rows were not rewritten.
- Migration 49 added nullable structured Mailing shipping fields. The exact
  production deployment completed on 2026-08-28.
- The production candidate gate recorded critical `51 PASS / 0 FAIL`, relevant
  WebKit `27 PASS`, WeCom `7 PASS`, CustomerRequest integration `13 PASS`, build
  PASS and migration/old-app compatibility rehearsal PASS.
- Current checkout contains payroll participant authority and Gate29R evidence;
  the last checkout commit `981ce38` is documentation evidence and is not the
  deployed release SHA.

## 5. Current Work

- PROJECT SESSION HANDOFF documentation is complete in the commit containing
  this file. No product development, migration or deployment remains active in
  this handoff session.
- Existing uncommitted `server/wechat-alert.js` work is preserved, not inspected
  for secret values, not attributed to this handoff, and must not be included in
  the handoff commit.

## 6. Current Blocker

### AUTHORITY CONFLICT — checkout branch is not production branch

- **Evidence:** checkout is `feat/pos-wechat-refund@981ce38`; production is
  `codex/mailing-qr-only@ce9f4e7`; their merge-base is `f63a29c`.
- **Impact:** a new session must not build or deploy the current checkout as if
  it were the current production source. Doing so would omit the deployed
  CustomerRequest/Mailing QR-only release commits.
- **Required verification:** use a clean worktree, fetch, confirm both tips and
  choose an explicit integration strategy. Preserve the uncommitted
  `server/wechat-alert.js` change. Re-run the relevant gates before any deploy.

## 7. Tests & Validation

| Scope | Result | Evidence status |
| --- | --- | --- |
| Exact production candidate critical gate | 51 PASS / 0 FAIL | VERIFIED, workflow `33175124358` |
| Mailing + CustomerRequest WebKit | 27 PASS | VERIFIED, workflow `33175124358` |
| CustomerRequest integration | 13 PASS | VERIFIED, workflow `33175124358` |
| Stable WeCom delivery | 7 PASS | VERIFIED, workflow `33175124358` |
| Migration 48→49 rehearsal / old-app read | PASS | VERIFIED, workflow `33175124358` |
| Production build / diff check | PASS | VERIFIED, workflow `33175124358` |
| Payroll MONTH/WEEK/CUSTOM | amount/subject difference 0 | VERIFIED, exact candidate CI |
| Handoff documentation | `git diff --check` PASS; required headings/terms and explicit commit paths checked | VERIFIED |
| Current checkout code | No code tests rerun because the handoff changed documentation only | UNVERIFIED by this handoff; use existing domain evidence only |

## 8. Deployment & Rollback

- Deployment workflow: `https://github.com/GPTJJ/budu/actions/runs/33175124358`
- Candidate image tag: `budu-api:mailing-qr-only-ce9f4e7`.
- Old image/container were intentionally preserved by the blue/green script.
- A fresh migration-48 custom-format backup passed `pg_restore --list`; a second
  protected copy was created before migration 49. The server-side path follows
  `.rollback-assets/mailing-qr-only-ce9f4e7-<timestamp>/`; the exact surviving
  path has not been re-listed in this handoff.
- Additive rollback compatibility was rehearsed: the old application projection
  can read migration-49 rows. Database rollback remains available through the
  fresh migration-48 protected backup.
- Do not delete rollback images, containers or backup assets.

## 9. Primary Next Action

In a clean worktree, reconcile branch authority before any development or
deployment: start from the verified production release `ce9f4e7`, review the
single current-checkout-only commit, preserve/exclude the dirty WeCom file, and
produce one explicitly reviewed integration branch. Then re-verify production
SHA, DB, migration and writer before changing anything.

## 10. Known Risks

- **AUTHORITY CONFLICT:** current checkout and production branch differ.
- Enterprise WeChat credential exposure: **KNOWN**. Rotation: **DEFERRED BY
  OWNER**. Owner accepted risk: **YES**. Deployment blocked by rotation: **NO**.
  Never print or rotate credentials as part of unrelated recovery/handoff work.
- The uncommitted `server/wechat-alert.js` change has unknown provenance and must
  not be confused with the CustomerRequest `budu → dh` personal application
  channel.
- Migration/writer state is verified at cutover, not by a fresh direct DB query
  during this handoff.
- The exact rollback asset path and a full restore drill remain UNVERIFIED in
  this handoff; integrity and compatibility checks were VERIFIED at deployment.
- Root `PROJECT_STATUS.md`, `CURRENT_ARCHITECTURE.md` and older production claims
  contain STALE history. They are not current authority.

## 11. Unverified Assumptions

- Current post-cutover migration ledger is still exactly 49.
- Current production DB-connected writer count is still exactly one.
- The protected backup and old container/image remain present at their recorded
  server locations after deployment.
- The existing uncommitted WeCom alert change is intentional and safe.

No unverified assumption may be promoted to a production fact without direct
revalidation.

## 12. Session Handoff

A context-free Codex must know four things first:

1. Production is currently healthy at runtime SHA prefix `ce9f4e770224`, and the
   exact deployed release commit is `ce9f4e7…` on `codex/mailing-qr-only`.
2. The checkout branch is different and cannot be deployed as-is; this is an
   explicit AUTHORITY CONFLICT requiring a clean-worktree integration decision.
3. Mailing creation is now QR-only and CustomerRequest/WeCom routing is governed
   by the deployed production branch, including the exact `budu → dh` binding.
4. Preserve the dirty `server/wechat-alert.js` file and all rollback assets;
   verify DB/migration/writer directly before the next production action.

Do not continue with a new task until SESSION BOOTSTRAP is complete.

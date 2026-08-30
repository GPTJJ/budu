# Purchase Receiving + UI — Production Handoff Checkpoint

Date: 2026-08-30 (Asia/Shanghai)

## Release authority

- Deployment status: **VERIFIED — LIVE**
- Acceptance status: **AUTHORITY CONFLICT — HOLD**
- Production code SHA: `d695bde5c2ecadfc1a3c2d41cae3f27c69f47060`
- Source branch: `codex/purchase-receiving-ui`
- Candidate parent / production before: `fd47a6d85c2b23c7e81686100f68446c08cc9a51`
- Authoritative-mainline ancestor: `3c4b4baab7226764ec44d7c9769882368001981f` — VERIFIED
- Public and internal health: `ok=true`, `env=prod`, `gitSha=d695bde5c2ec`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `58`; failed migrations: `0`
- New migration in this candidate: **NONE**
- Production writer count: `1`
- Nginx active routes to candidate: `3`

These production facts were directly reverified on 2026-08-30 at approximately 22:06 Asia/Shanghai. They are dated evidence, not permanent truth; reverify on recovery.

## Delivered behavior

- Purchase request UI was reorganized into purchase information, product/material selection, selected-item summary, notes, and request-list sections.
- Receive processing uses a transaction-scoped conditional claim, atomic stock increment, one ledger entry per received item, and safe user-facing errors.
- The raw Prisma failure caused by passing a StockLedger record outside Prisma's required `data` envelope was corrected.
- Receive, delete, and create errors are action-scoped; the page no longer exposes raw Prisma messages.
- Safe delete remains available but visually secondary to receive.
- Candidate build passed. Targeted purchase/overlay WebKit regression passed 20/20.
- Seven migration rehearsal failures reproduce on the unmodified baseline and remain recorded as **PRE-EXISTING TEST DEBT**; they were not changed in this release.

## Deployment and rollback

- Exact-SHA image: `budu-api:purchase-d695bde`.
- Active container: `budu-prod-d695bde-purchase`.
- Previous container retained stopped: `budu-prod-fd47a6d-overlay-scroll`.
- Fresh protected backup and rollback assets:
  - `/opt/budu/.rollback-assets/purchase-d695bde-20260830T132539Z`
  - custom-format dump and protected copy are mode `400`, equal size, and equal SHA-256.
- An earlier deployment attempt automatically restored the previous production because the post-switch health parser used an unavailable host runtime. Production authority and database digests were reverified before the corrected exact-candidate attempt succeeded.
- Do not restore the database or switch containers based solely on this note; reverify current production and obtain an explicit rollback gate.

## Production UI verification

- Real authenticated production page: PASS.
- Purchase information, item-selection area, selected-item empty state, request cards, receive controls, and visually secondary safe delete: PASS.
- Supplier overlay: PASS; body scroll lock active and dialog remained inside the viewport.
- Production width 390px: PASS; cards and action buttons remained within the viewport with no horizontal overflow.
- Raw Prisma error visible in production UI: NO.
- No receive button was clicked by the deployment agent.

## Post-cutover authority conflict

The deployment reconciliation immediately after cutover showed the three existing purchases still pending, with no StockBalance or StockLedger rows. Later, production recorded three successful receive requests made as operator `budu`:

- `pr-mtcpm3rv-a51y8e` at `2026-08-30T13:42:16Z`
- `pr-mtcplmep-826z6y` at `2026-08-30T13:42:25Z`
- `pr-mt9q4npy-80kylo` at `2026-08-30T13:42:30Z`

The deployment agent did not issue these requests. Their real-world business legitimacy is therefore **UNVERIFIED** in the handoff conversation.

Read-only reconciliation found:

- receive POST results: 3 × HTTP 200; receive errors: 0;
- purchases / purchase items / StockBalance / StockLedger: `3 / 6 / 6 / 6`;
- all six `receivedQty` values equal `orderedQty`;
- exactly one `purchase_in` ledger row exists per purchase item;
- every StockBalance equals the sum of its ledger changes;
- no duplicate ledger identity or partial write was detected.

Do not delete StockLedger rows, reduce StockBalance, or reopen purchases to resolve this uncertainty. First obtain the user's confirmation that these were genuine receipts. If not genuine, start a separate production inventory correction gate with backup, dry-run, reconciliation, and rollback.

## Cross-device recovery

Remote recovery refs:

- current purchase work and this checkpoint: `origin/codex/purchase-receiving-ui`;
- paused Report Center RC-2B: `origin/codex/report-center-rc2b` at source commit `8198d7a6acd2c521ab10b34a77159980560ee933`;
- historical Beijing migration checkpoint: `origin/codex/beijing-migration` at `a54283d9067e017183e423d6fa4a1be354afe4c7`.

At handoff audit time, every extant BUDU worktree was clean. Unknown working-tree changes were neither discarded nor stashed; none were found. The three commit heads above were the only extant worktree heads not already reachable from a remote ref, and are intentionally preserved as independent branches without merging.

On the new device:

```bash
git fetch --all --prune
git switch --track origin/codex/purchase-receiving-ui
```

Then read `AGENTS.md`, `docs/BUDU_STATUS.md`, and this checkpoint, and directly reverify production before any new action. Committed but unpushed work is unavailable remotely, and uncommitted work cannot be recovered through Git; this handoff is complete only after the remote refs above are verified.

## Next decision

Ask the user whether all three production purchase receipts were legitimate real arrivals. Until confirmed, keep the purchase production acceptance gate at **HOLD**. Do not start Report Center work as part of that decision.

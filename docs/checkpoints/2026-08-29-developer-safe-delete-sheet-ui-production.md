# Developer Safe Delete Sheet UI — Production Checkpoint

Date: 2026-08-29 (Asia/Shanghai)

## Release authority

- Status: **VERIFIED — LIVE**
- Production code SHA: `35951cfdc8b24f0291b157a25ccf097f6e7c4522`
- Release branch: `codex/developer-safe-delete`
- Successful GitHub Actions run: `33253298589` — PASS
- Public health: `ok=true`, `env=prod`, `gitSha=35951cfdc8b2`, `dbOk=true`
- Canonical database: `budu_bj006`
- Migration ledger: `56` (unchanged; no migration)

## Delivered UI behavior

- The safe-delete and deleted-record restore sheets use the feature's shared Overlay rendered through a `body` Portal at z-index 220; the global mobile navigation remains at z-index 30.
- The overlay blocks background pointer interaction and locks document/body scrolling while preserving and restoring the previous scroll position.
- The sheet uses the current Visual Viewport height and offset, keeps the focused password input visible when the WebKit keyboard changes the viewport, and has an independently scrolling content region.
- Cancel/confirm actions remain in a non-scrolling footer with `safe-area-inset-bottom` padding.
- Closing restores document styles; reopening creates exactly one overlay; mobile navigation is immediately usable again.

## Verification

- Targeted invoice/safe-delete WebKit suite: PASS 12/12.
- Related invoice, mailing, transfer, partner-supply, and settings WebKit regression: PASS 53/53.
- Exact deployment Gate: PASS 99/99.
- Production build: PASS.
- Production 375×460 keyboard-view smoke: overlay z-index 220 > navigation z-index 30; sheet bottom and actions bottom equal viewport height 460; password input bounds 325–363; internal scroll active; horizontal overflow 0.
- Production close/reopen smoke: background scroll styles restored, overlay count 0 after cancel and 1 after reopen, mobile navigation restored.
- Fresh final production tab console errors: 0.
- Delete confirmation was never clicked during production smoke; no business record or database data was changed.

## Scope reconciliation

- No `prisma/`, `server/`, or `shared/` business-authority change.
- Developer permissions, secondary-password verification, soft delete, restore, audit, and all five domain rules are unchanged.
- No migration was created; production migration ledger remained at 56 and historical business digests reconciled unchanged.

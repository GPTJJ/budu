# BUDU Cross-device Safety Archive — 2026-08-30

This branch exists only to preserve a local-only historical Git ref that GitHub's OAuth workflow-scope restriction prevented from being pushed directly.

## Included bundle

- File: `handoff/bundles/budu-beijing-migration-a54283d.bundle`
- Original ref: `refs/heads/codex/beijing-migration`
- Original HEAD: `a54283d9067e017183e423d6fa4a1be354afe4c7`
- SHA-256: `87c5ec5dad05959b7061d6c2ff50b0a041454bdefd4000c980ec1d96600e7c40`
- `git bundle verify`: complete history, PASS

The original branch was not merged, rewritten, or deployed. The bundle is a recovery artifact only.

## Recovery

After fetching this safety branch on another device:

```bash
shasum -a 256 handoff/bundles/budu-beijing-migration-a54283d.bundle
git bundle verify handoff/bundles/budu-beijing-migration-a54283d.bundle
git fetch handoff/bundles/budu-beijing-migration-a54283d.bundle \
  refs/heads/codex/beijing-migration:refs/heads/codex/beijing-migration
```

Do not merge this historical branch into current BUDU work without a separate authority review.

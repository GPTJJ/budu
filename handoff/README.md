# BUDU Cross-device Safety Archive — 2026-08-30

This branch exists only to preserve a local-only historical Git ref that GitHub's OAuth workflow-scope restriction prevented from being pushed directly.

## Included bundles

- File: `handoff/bundles/budu-beijing-migration-a54283d.bundle`
- Original ref: `refs/heads/codex/beijing-migration`
- Original HEAD: `a54283d9067e017183e423d6fa4a1be354afe4c7`
- SHA-256: `87c5ec5dad05959b7061d6c2ff50b0a041454bdefd4000c980ec1d96600e7c40`
- `git bundle verify`: complete history, PASS

- File: `handoff/bundles/budu-inventory-workflow-1b1a67a.bundle`
- Original ref: `refs/heads/codex/inventory-workflow`
- Original HEAD: `1b1a67abced69ea68f586c31be14950a581ab028`
- SHA-256: `51ff3db8ba6a363457cad1e3602acc36bd0d148ba027847815921c09b5e46c6d`
- `git bundle verify`: complete history, PASS

The original branch was not merged, rewritten, or deployed. The bundle is a recovery artifact only.

## Recovery

After fetching this safety branch on another device:

```bash
shasum -a 256 handoff/bundles/budu-beijing-migration-a54283d.bundle
git bundle verify handoff/bundles/budu-beijing-migration-a54283d.bundle
git fetch handoff/bundles/budu-beijing-migration-a54283d.bundle \
  refs/heads/codex/beijing-migration:refs/heads/codex/beijing-migration

shasum -a 256 handoff/bundles/budu-inventory-workflow-1b1a67a.bundle
git bundle verify handoff/bundles/budu-inventory-workflow-1b1a67a.bundle
git fetch handoff/bundles/budu-inventory-workflow-1b1a67a.bundle \
  refs/heads/codex/inventory-workflow:refs/heads/codex/inventory-workflow
```

Do not merge this historical branch into current BUDU work without a separate authority review.

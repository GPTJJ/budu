# BUDU Cross-Device Local Branch Archive

Date: 2026-08-30

This archive preserves exact local branch tips that the configured GitHub HTTPS OAuth credential could not publish as normal branches because it lacks the `workflow` scope. No remote history was rewritten.

## Bundle integrity

- File: `budu-local-branches-20260830.bundle`
- SHA-256: `5a8d9420be89b1bc403791a1f42e8b6284dfe4078e91a67e3bdbcf87d65b0539`
- `git bundle verify`: PASS

The bundle contains the only two branch tips with objects that were not reachable from any current `origin/*` ref:

- `codex/beijing-migration` → `a54283d9067e017183e423d6fa4a1be354afe4c7`
- `codex/inventory-workflow` → `1b1a67abced69ea68f586c31be14950a581ab028`

## Branch-name mappings already reachable from origin

The following exact commits are already reachable through `origin/main`; only their local branch names could not be created through the OAuth credential:

- `codex/daily-pay-adjustment` → `51fdbc62d8a9ffc9958fe8c99e05ecfc123a8b05`
- `codex/deploy-fetch-retry` → `44f461d74da367b3f0fa594a92bea9ed677ad637`
- `codex/employee-excel-download` → `63165855117ed18189d506e2ce2e638f4480fa71`
- `codex/guanshe-transfer-subsidy` → `7e3742dc7c3d725d889e6589fc5df92c5fb03def`
- `codex/mobile-liquid-glass` → `ebf8a2f3cc48808ec69ae347c5766d55668a3173`
- `codex/pos-ipad-three-columns` → `5beb90d75ba733ff4cb83193f7ac821b90bc367f`
- `codex/pos-phase1` → `de0e66fd46a90f0f74bd0668831bd42415a61150`
- `codex/pos-reference-ui` → `2bf1fc4723f710ec970e5c85792ddd875847788b`

## Recovery on another device

After cloning the repository and fetching all remote refs:

```sh
git fetch --all --prune
git switch --detach origin/safety/cross-device-handoff-archive-20260830
git bundle verify docs/handoffs/2026-08-30-cross-device/budu-local-branches-20260830.bundle
git fetch docs/handoffs/2026-08-30-cross-device/budu-local-branches-20260830.bundle 'refs/heads/*:refs/remotes/handoff/*'
git branch codex/beijing-migration refs/remotes/handoff/codex/beijing-migration
git branch codex/inventory-workflow refs/remotes/handoff/codex/inventory-workflow
```

Recreate any branch-name mappings from the exact commit SHA above only if that historical branch is needed.

This archive is a recovery artifact, not an authorization to merge, deploy, or continue those historical tasks.

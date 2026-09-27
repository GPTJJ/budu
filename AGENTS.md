# 项目约定

## BUDU Codex Skills

- Any BUDU engineering task: consult/use `budu-task-router`.
- New or resumed context: use `budu-context`.
- Data identity or source-of-truth changes: use `budu-data-authority`.
- Frontend or mobile work: use `budu-mobile-ui`.
- After code changes: use `budu-regression`.
- Deployment work: use `budu-production-deploy`.
- Payment or refund work: MUST use `budu-payment-safety` in STRICT mode.
- Sweet Card, gift-card, redemption, balance, binding, loss, or replacement work: use `budu-sweet-card` (and `budu-payment-safety` whenever value or settlement is involved).
- Device, conversation, or task handoff: use `budu-handoff`.

Detailed workflows belong in the skills under `.agents/skills/`; keep this file concise.

## 用户指令约定

- 用户发送【push】时：把当前工作区未提交的任务进度（代码、文档、配置等，排除临时与工具目录）提交并推送到 GitHub；先 `git fetch`，如有远端新提交先 `rebase` 再推送，避免覆盖他人改动。

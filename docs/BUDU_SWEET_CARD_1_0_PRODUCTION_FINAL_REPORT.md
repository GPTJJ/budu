# budu Sweet Card 1.0 production acceptance

**PRODUCTION_COMPLETE — CONTROLLED ROLLOUT ONLY.**

Directly verified production on 2026-09-05, Asia/Shanghai:
`02f3f8fb6431157378c583802075713dd8bde8ef`, database `budu_bj006`, Migration
64 applied / 0 failed, healthy, one writer. Sweet Card is enabled only for the
intersection of store `xidan` and the single approved principal `daa77021…`.

P10C bounded full-transaction retry is deployed. P0–P19 acceptance is PASS under
the existing accepted P0–P6 baseline plus current Legacy regression and the direct
P7–P19 production gates. Final authority reconciliation across both cards is:
ISSUE 150 - REDEEM 150 + REFUND 90 = balance 90 cents; Ledger sum 90 cents;
unexplained delta 0. There is no negative balance, duplicate debit, duplicate
refund, double spend or credential replay effect.

Cash, WeChat, Alipay, POS, Product, Order, Report, permission and audit checks pass.
P18 reports `PRESENT LOAD_PASS VALIDATION_PASS` for the Sweet Card credential key,
WeChat configuration and Alipay configuration without exposing values. P19 reports
internal/public health PASS, writer=1, controlled-scope enforcement PASS, credential
log leaks 0 and unexpected runtime errors 0.

[Complete P10C production report, evidence, backup authority and rollback](checkpoints/2026-09-05-sweet-card-p10c-production-complete.md).
[P10C candidate root cause and verification](checkpoints/2026-09-05-sweet-card-p10c-candidate.md).
[Previous P7C/P10 hold evidence](checkpoints/2026-09-05-sweet-card-p7c-production-hold.md).

This is not a global or commercial rollout. The original P7–P10 card and all prior
facts remain preserved. One new ¥1.00 acceptance card and its formal P10–P15
lifecycle facts remain as production audit evidence; no historical row was deleted,
rewritten or manually rebalanced.

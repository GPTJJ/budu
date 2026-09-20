# budu Payroll Audit Scheduler

The production host runs one systemd timer at 09:00 Asia/Shanghai every day. It reconciles the most recent weekly and monthly identities so `Persistent=true` can recover a missed Monday/month-first run after host downtime. `PAYROLL_AUDIT_SCHEDULER_START_DATE` is required and prevents the first server run from redelivering periods handled by the former Codex automation. When Monday is also the first day, it creates two independent jobs:

- `PAYROLL_AUDIT_WEEKLY_PART_TIME:<periodStart>:<periodEnd>` for the previous Monday–Sunday and current canonical `Employee.employmentType=parttime` subjects.
- `PAYROLL_AUDIT_MONTHLY_FULL_TIME:<periodStart>:<periodEnd>` for the previous complete month and current canonical `Employee.employmentType=fulltime` subjects.

The daily wake-up also retries failed email delivery without recalculating Payroll or replacing the stored artifacts. A delivery is attempted at most three times. An active developer/admin may explicitly resend a stored report; that creates another delivery-attempt audit entry with actor ID. `[TEST]` delivery has a separate identity and can never mark the formal period sent.

The existing Payroll authority remains unchanged. `DailyStoreStaff.actualHours` and the existing tagged payable-hours compatibility path remain the only actual/payable-hours sources. The scheduler opens the existing extractor's repeatable-read, read-only transaction, builds one canonical report model and renders Markdown, PDF and the management-summary email from it. It never updates Payroll, DailyEntry, DailyStoreStaff, Employee, PayrollNotice or paid state.

Employment type currently has no effective-dated history. The scheduler selects subjects from current `Employee.employmentType`, records that exact limitation, and marks every historical-period subject `REVIEW_REQUIRED`; it does not infer a historical type from name, store or hours. This limitation must remain visible until a separately reviewed historical authority exists.

Artifacts and job manifests are stored below `PAYROLL_AUDIT_DATA_DIR` on the existing private application data volume with mode 0600. The sender uses the same Gmail channel as the previous payroll audit delivery. Place a node-readable 0600 JSON secret containing `clientId`, `clientSecret`, `refreshToken` and `from` at `$DATA_DIR/payroll-audit-gmail.json`, or mount it elsewhere and set `PAYROLL_AUDIT_GMAIL_CREDENTIAL_FILE`. The fixed recipients are:

- `yuegu1995@gmail.com`
- `970701330@qq.com`
- `korea_jing@163.com`

Do not enable the timer until the credential mount and a `[TEST]` message to all three recipients pass. No credential belongs in Git, container environment output, logs or reports.

Install the committed unit, timer and host wrapper under `/etc/systemd/system` and `/opt/budu/bin`. The wrapper requires exactly one running production candidate container. After installing, run `systemctl daemon-reload`, execute a DRY RUN for both report types, execute one `[TEST]` delivery, and only then `systemctl enable --now budu-payroll-audit.timer`. Disable the former Codex automation after the server timer is active so only one scheduler remains.

The runtime path uses Node.js, PostgreSQL, Chromium, systemd and Gmail HTTPS only. It has no Codex, ChatGPT, OpenAI API, Codex CLI, prompt or external agent dependency.

#!/bin/sh
set -eu
: "${PAYROLL_AUDIT_SCHEDULER_START_DATE:?PAYROLL_AUDIT_SCHEDULER_START_DATE is required}"
containers="$(docker ps --filter label=budu.production-role=candidate --format '{{.Names}}')"
count="$(printf '%s\n' "$containers" | sed '/^$/d' | wc -l)"
[ "$count" -eq 1 ] || { logger -t budu-payroll-audit "expected one production candidate container, found $count"; exit 1; }
container="$(printf '%s\n' "$containers" | sed -n '1p')"
exec docker exec -e "PAYROLL_AUDIT_SCHEDULER_START_DATE=$PAYROLL_AUDIT_SCHEDULER_START_DATE" "$container" node scripts/payroll-audit-scheduler.mjs --scheduled

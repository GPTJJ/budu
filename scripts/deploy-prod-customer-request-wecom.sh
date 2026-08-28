#!/usr/bin/env bash
# Authority-aware no-schema-change blue/green deployment for Invoice QR-only.
# Runs on the Beijing host after the release bundle and helper scripts are uploaded.
set -Eeuo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: $0 BUNDLE RESOLVER CLONER SHA EXPECTED_OLD_SHA APP_DIR NGINX_CONTAINER" >&2
  exit 2
fi

BUNDLE_PATH="$1"
RESOLVER_PATH="$2"
CLONER_PATH="$3"
RELEASE_SHA="$4"
EXPECTED_OLD_SHA="$5"
APP_DIR="$6"
NGINX_CONTAINER="$7"
SELF_PATH="$0"
SHORT_SHA="${RELEASE_SHA:0:7}"
CANDIDATE="budu-prod-${SHORT_SHA}-invoice-qr"
MIGRATOR="budu-migrate-${SHORT_SHA}-invoice-qr"
BACKUP_CONTAINER="budu-backup-${SHORT_SHA}-invoice-qr"
IMAGE="budu-api:invoice-qr-only-${SHORT_SHA}"
HOST_TEMPLATE="${APP_DIR}/deploy/nginx/conf.d/budu.conf.template"
ACTIVE_CONFIG="/etc/nginx/conf.d/budu.conf"
ENV_FILE="${APP_DIR}/.env.production"
WORK_ROOT="$(mktemp -d "/dev/shm/budu-invoice-qr-${SHORT_SHA}.XXXXXX")"
BINDING_FILE="${WORK_ROOT}/recipient-binding.json"
ROLLBACK_ROOT="${APP_DIR}/.rollback-assets/invoice-qr-only-${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
OLD_CONTAINER=""
OLD_STOPPED=0
TEMPLATE_CHANGED=0
ENV_CHANGED=0
DEPLOY_OK=0

safe_cleanup() {
  if [ -n "$OLD_CONTAINER" ] && docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
    docker exec --user root "$OLD_CONTAINER" rm -f \
      /app/scripts/.resolve-customer-request-wecom-recipient.mjs \
      /tmp/.customer-request-wecom-binding >/dev/null 2>&1 || true
  fi
  rm -f "$BINDING_FILE" "$RESOLVER_PATH" "$CLONER_PATH" "$BUNDLE_PATH" "$SELF_PATH"
  rm -rf "$WORK_ROOT"
}

rollback_on_error() {
  local rc=$?
  if [ "$DEPLOY_OK" -eq 1 ]; then
    safe_cleanup
    return
  fi
  echo "deployment failed; restoring the previous application authority" >&2
  if docker inspect "$CANDIDATE" >/dev/null 2>&1; then
    docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true
  fi
  if docker inspect "$MIGRATOR" >/dev/null 2>&1; then
    docker rm -f "$MIGRATOR" >/dev/null 2>&1 || true
  fi
  if docker inspect "$BACKUP_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$BACKUP_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$OLD_STOPPED" -eq 1 ] && [ -n "$OLD_CONTAINER" ]; then
    docker start "$OLD_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$TEMPLATE_CHANGED" -eq 1 ] && [ -f "${ROLLBACK_ROOT}/budu.conf.template" ]; then
    cp "${ROLLBACK_ROOT}/budu.conf.template" "$HOST_TEMPLATE"
    docker cp "${ROLLBACK_ROOT}/budu.conf.active" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null
    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null
  fi
  if [ "$ENV_CHANGED" -eq 1 ] && [ -f "${ROLLBACK_ROOT}/env.production.pre-wecom" ]; then
    cp "${ROLLBACK_ROOT}/env.production.pre-wecom" "$ENV_FILE"
  fi
  safe_cleanup
  exit "$rc"
}
trap rollback_on_error EXIT

require_health() {
  local container="$1"
  local expected_sha_prefix="$2"
  local payload=""
  for _attempt in $(seq 1 30); do
    payload="$(docker exec "$container" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
    if HEALTH_PAYLOAD="$payload" EXPECTED_SHA_PREFIX="$expected_sha_prefix" python3 - <<'PY'
import json, os
try:
    value = json.loads(os.environ.get('HEALTH_PAYLOAD', ''))
    ok = value.get('ok') is True and value.get('dbOk') is True and str(value.get('gitSha', '')).startswith(os.environ['EXPECTED_SHA_PREFIX'][:12])
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
    then
      return 0
    fi
    sleep 3
  done
  return 1
}

verify_database_authority() {
  local container="$1"
  local expected_migrations="$2"
  docker exec -i "$container" env EXPECTED_MIGRATIONS="$expected_migrations" node --input-type=module - <<'NODE'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
try {
  const [database, migrations] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
  ])
  const result = { database: database[0]?.name, migrations: Number(migrations[0]?.count) }
  if (result.database !== 'budu_bj006' || result.migrations !== Number(process.env.EXPECTED_MIGRATIONS)) throw new Error('PRODUCTION_DATABASE_AUTHORITY_MISMATCH')
  console.log(JSON.stringify(result))
} finally {
  await prisma.$disconnect()
}
NODE
}

count_database_writers() {
  local reference="$1"
  local reference_hash
  reference_hash="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$reference" | sed -n '/^DATABASE_URL=/p' | sha256sum | cut -d ' ' -f1)"
  local count=0
  local container=""
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    local candidate_hash
    candidate_hash="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -n '/^DATABASE_URL=/p' | sha256sum | cut -d ' ' -f1)"
    if [ "$candidate_hash" = "$reference_hash" ]; then count=$((count + 1)); fi
  done < <(docker ps --format '{{.Names}}')
  printf '%s\n' "$count"
}

mailing_business_digest() {
  local container="$1"
  docker exec -i "$container" node --input-type=module - <<'NODE'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
try {
  const rows = await prisma.mailingRecord.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, method: true, postage: true, fee: true, address: true, recipient: true, phone: true, remark: true, status: true, createdBy: true, createdAt: true, shippedAt: true },
  })
  const digest = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  process.stdout.write(`${rows.length}:${digest}`)
} finally {
  await prisma.$disconnect()
}
NODE
}

invoice_business_digest() {
  local container="$1"
  docker exec -i "$container" node --input-type=module - <<'NODE'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
try {
  const rows = await prisma.invoice.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, storeKey: true, titleType: true, companyName: true, taxNo: true, amountCents: true, category: true, email: true, note: true, status: true, createdBy: true, createdAt: true },
  })
  const serializable = rows.map((row) => ({ ...row, amountCents: String(row.amountCents) }))
  const digest = crypto.createHash('sha256').update(JSON.stringify(serializable)).digest('hex')
  process.stdout.write(`${rows.length}:${digest}`)
} finally {
  await prisma.$disconnect()
}
NODE
}

verify_public_health() {
  local container="$1"
  local expected_sha_prefix="$2"
  docker exec -i "$container" env EXPECTED_SHA_PREFIX="$expected_sha_prefix" node --input-type=module - <<'NODE'
const origin = String(process.env.PUBLIC_BASE_URL || '')
if (!origin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN_NOT_HTTPS')
const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000) })
const health = await response.json()
if (!response.ok || health.ok !== true || health.dbOk !== true || !String(health.gitSha || '').startsWith(process.env.EXPECTED_SHA_PREFIX)) {
  throw new Error('PUBLIC_HEALTH_AUTHORITY_MISMATCH')
}
console.log(JSON.stringify({ publicHealth: true, database: 'budu_bj006', migrations: 49 }))
NODE
}

[ -f "$HOST_TEMPLATE" ] || { echo "production nginx authority template missing" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "production environment file missing" >&2; exit 1; }
docker inspect "$NGINX_CONTAINER" >/dev/null

mapfile -t ROUTE_TARGETS < <(sed -nE 's@.*proxy_pass[[:space:]]+http://([^:/;]+):3000.*@\1@p' "$HOST_TEMPLATE" | sort -u)
[ "${#ROUTE_TARGETS[@]}" -eq 1 ] || { echo "production route authority is ambiguous" >&2; exit 1; }
OLD_CONTAINER="${ROUTE_TARGETS[0]}"
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${OLD_CONTAINER}:3000" "$HOST_TEMPLATE")" -eq 3 ] || {
  echo "expected exactly three production API routes" >&2
  exit 1
}
docker inspect "$OLD_CONTAINER" >/dev/null
[ "$(docker inspect --format '{{.State.Running}}' "$OLD_CONTAINER")" = "true" ] || { echo "routed API is not running" >&2; exit 1; }
require_health "$OLD_CONTAINER" "${EXPECTED_OLD_SHA:0:12}"
verify_database_authority "$OLD_CONTAINER" 49
[ "$(count_database_writers "$OLD_CONTAINER")" -eq 1 ] || { echo "production does not have exactly one database-connected application writer" >&2; exit 1; }
echo "production authority verified: DB=budu_bj006 migration=49 health=PASS writer=1"

# Verify the locked BUDU account and exact directory UserID on the trusted production IP.
# The binding is written to a protected file; no name lookup participates.
docker cp "$RESOLVER_PATH" "${OLD_CONTAINER}:/app/scripts/.resolve-customer-request-wecom-recipient.mjs" >/dev/null
docker exec "$OLD_CONTAINER" node /app/scripts/.resolve-customer-request-wecom-recipient.mjs /tmp/.customer-request-wecom-binding
docker cp "${OLD_CONTAINER}:/tmp/.customer-request-wecom-binding" "$BINDING_FILE" >/dev/null
docker exec --user root "$OLD_CONTAINER" rm -f /app/scripts/.resolve-customer-request-wecom-recipient.mjs /tmp/.customer-request-wecom-binding
chmod 600 "$BINDING_FILE"
BINDING_FILE="$BINDING_FILE" python3 - <<'PY'
import json, os, pathlib
binding = json.loads(pathlib.Path(os.environ['BINDING_FILE']).read_text(encoding='utf-8'))
if binding != {'username': 'budu', 'userId': 'dh'}:
    raise SystemExit('RESOLVED_BINDING_INVALID')
PY

mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
cp "$ENV_FILE" "${ROLLBACK_ROOT}/env.production.pre-wecom"
chmod 600 "${ROLLBACK_ROOT}/env.production.pre-wecom"
ENV_FILE="$ENV_FILE" BINDING_FILE="$BINDING_FILE" python3 - <<'PY'
import json, os, pathlib, tempfile
path = pathlib.Path(os.environ['ENV_FILE'])
binding = json.loads(pathlib.Path(os.environ['BINDING_FILE']).read_text(encoding='utf-8'))
if binding != {'username': 'budu', 'userId': 'dh'}:
    raise SystemExit('BINDING_INVALID')
lines = path.read_text(encoding='utf-8').splitlines()
mapping = {
    'CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME': binding['username'],
    'CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID': binding['userId'],
}
lines = [line for line in lines if not any(line.startswith(f'{key}=') for key in mapping)]
lines.extend(f'{key}={value}' for key, value in mapping.items())
fd, temp_name = tempfile.mkstemp(prefix='.env.production.', dir=str(path.parent), text=True)
with os.fdopen(fd, 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(lines) + '\n')
os.chmod(temp_name, path.stat().st_mode & 0o777)
os.replace(temp_name, path)
PY
ENV_CHANGED=1
echo "stable CustomerRequest binding budu -> dh verified and installed"

git clone -q "$BUNDLE_PATH" "${WORK_ROOT}/release"
[ "$(git -C "${WORK_ROOT}/release" rev-parse HEAD)" = "$RELEASE_SHA" ] || { echo "release bundle SHA mismatch" >&2; exit 1; }
docker build --label "org.opencontainers.image.revision=${RELEASE_SHA}" -t "$IMAGE" "${WORK_ROOT}/release"

COMMON_NETWORK="$(CURRENT="$OLD_CONTAINER" NGINX="$NGINX_CONTAINER" python3 - <<'PY'
import json, os, subprocess
def networks(container):
    raw = subprocess.check_output(['docker', 'inspect', container], text=True)
    return set(json.loads(raw)[0]['NetworkSettings']['Networks'])
common = sorted((networks(os.environ['CURRENT']) & networks(os.environ['NGINX'])) - {'bridge', 'host', 'none'})
if len(common) != 1:
    raise SystemExit(f'FRONTEND_NETWORK_CARDINALITY_{len(common)}')
print(common[0])
PY
)"

# Fresh pre-migration backup and protected copy. Credentials stay in a 0600
# env-file and never enter command output.
DB_ENV_FILE="${WORK_ROOT}/database.env"
OLD_CONTAINER="$OLD_CONTAINER" DB_ENV_FILE="$DB_ENV_FILE" python3 - <<'PY'
import json, os, pathlib, subprocess, urllib.parse
raw = subprocess.check_output(['docker', 'inspect', os.environ['OLD_CONTAINER']], text=True)
env = json.loads(raw)[0]['Config'].get('Env') or []
database_url = next((item.split('=', 1)[1] for item in env if item.startswith('DATABASE_URL=')), '')
if not database_url:
    raise SystemExit('DATABASE_URL_MISSING')
parts = urllib.parse.urlsplit(database_url)
if parts.path != '/budu_bj006':
    raise SystemExit('BACKUP_DATABASE_AUTHORITY_MISMATCH')
safe_uri = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))
path = pathlib.Path(os.environ['DB_ENV_FILE'])
path.write_text(f'PGURI={safe_uri}\n', encoding='utf-8')
path.chmod(0o600)
PY
BACKUP_NAME="budu_bj006-migration49-pre-invoice-qr-${SHORT_SHA}.dump"
# Write the dump as the invoking deployment user so the protected host-side
# rollback copy can be permission-locked without requiring privileged chmod.
docker create --name "$BACKUP_CONTAINER" --user "$(id -u):$(id -g)" --network "$COMMON_NETWORK" --env-file "$DB_ENV_FILE" -e BACKUP_NAME="$BACKUP_NAME" -v "${ROLLBACK_ROOT}:/backup" postgres:16-alpine \
  sh -c 'pg_dump "$PGURI" --format=custom --no-owner --file="/backup/$BACKUP_NAME"' >/dev/null
while IFS= read -r backup_network; do
  [ -n "$backup_network" ] || continue
  [ "$backup_network" = "$COMMON_NETWORK" ] && continue
  docker network connect "$backup_network" "$BACKUP_CONTAINER"
done < <(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$OLD_CONTAINER")
docker start -a "$BACKUP_CONTAINER"
docker rm "$BACKUP_CONTAINER" >/dev/null
docker run --rm -v "${ROLLBACK_ROOT}:/backup:ro" postgres:16-alpine pg_restore --list "/backup/${BACKUP_NAME}" >/dev/null
cp "${ROLLBACK_ROOT}/${BACKUP_NAME}" "${ROLLBACK_ROOT}/${BACKUP_NAME}.protected"
chmod 400 "${ROLLBACK_ROOT}/${BACKUP_NAME}" "${ROLLBACK_ROOT}/${BACKUP_NAME}.protected"
BEFORE_MAILING_DIGEST="$(mailing_business_digest "$OLD_CONTAINER")"
BEFORE_INVOICE_DIGEST="$(invoice_business_digest "$OLD_CONTAINER")"
echo "fresh migration49 backup integrity PASS; protected rollback copy created"

# Run the exact release migrator in isolation. This release contains no new
# migration, so the ledger must remain 49 and both historical domains unchanged.
docker inspect "$MIGRATOR" >/dev/null 2>&1 && { echo "migration container name already exists" >&2; exit 1; }
python3 "$CLONER_PATH" "$OLD_CONTAINER" "$MIGRATOR" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" disabled migration
[ "$(docker wait "$MIGRATOR")" = "0" ] || { docker logs --tail 80 "$MIGRATOR"; exit 1; }
docker rm "$MIGRATOR" >/dev/null
verify_database_authority "$OLD_CONTAINER" 49
[ "$(mailing_business_digest "$OLD_CONTAINER")" = "$BEFORE_MAILING_DIGEST" ] || { echo "historical MailingRecord digest changed during additive migration" >&2; exit 1; }
[ "$(invoice_business_digest "$OLD_CONTAINER")" = "$BEFORE_INVOICE_DIGEST" ] || { echo "historical Invoice digest changed during no-op migration gate" >&2; exit 1; }
echo "migration ledger remains 49; historical MailingRecord and Invoice digests unchanged"

docker inspect "$CANDIDATE" >/dev/null 2>&1 && { echo "candidate container name already exists" >&2; exit 1; }
python3 "$CLONER_PATH" "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" disabled readonly
require_health "$CANDIDATE" "${RELEASE_SHA:0:12}"
verify_database_authority "$CANDIDATE" 49
[ "$(count_database_writers "$OLD_CONTAINER")" -eq 1 ] || { echo "readonly candidate changed writer ownership" >&2; exit 1; }
echo "unrouted read-only Candidate internal smoke PASS"

# Prepare immutable rollback copies and a candidate routing template. No reload yet.
cp "$HOST_TEMPLATE" "${ROLLBACK_ROOT}/budu.conf.template"
docker cp "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" "${ROLLBACK_ROOT}/budu.conf.active" >/dev/null
cp "$HOST_TEMPLATE" "${WORK_ROOT}/budu.conf.template.candidate"
OLD_CONTAINER="$OLD_CONTAINER" CANDIDATE="$CANDIDATE" TEMPLATE="${WORK_ROOT}/budu.conf.template.candidate" python3 - <<'PY'
import os, pathlib
path = pathlib.Path(os.environ['TEMPLATE'])
old = os.environ['OLD_CONTAINER']
new = os.environ['CANDIDATE']
text = path.read_text(encoding='utf-8')
if text.count(f'http://{old}:3000') != 3:
    raise SystemExit('OLD_ROUTE_COUNT_MISMATCH')
updated = text.replace(f'http://{old}:3000', f'http://{new}:3000')
if updated.count(f'http://{new}:3000') != 3 or f'http://{old}:3000' in updated:
    raise SystemExit('CANDIDATE_ROUTE_COUNT_MISMATCH')
path.write_text(updated, encoding='utf-8')
PY

# Final restart preserves the old payment/refund worker setting. The old writer is
# stopped before this instance starts, so ownership never overlaps.
docker stop -t 20 "$CANDIDATE" >/dev/null
docker rm "$CANDIDATE" >/dev/null
docker stop -t 20 "$OLD_CONTAINER" >/dev/null
OLD_STOPPED=1
python3 "$CLONER_PATH" "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" preserve writer
docker update --restart unless-stopped "$CANDIDATE" >/dev/null
require_health "$CANDIDATE" "${RELEASE_SHA:0:12}"
verify_database_authority "$CANDIDATE" 49

cp "${WORK_ROOT}/budu.conf.template.candidate" "$HOST_TEMPLATE"
TEMPLATE_CHANGED=1
docker exec "$NGINX_CONTAINER" sh -c 'envsubst '\''${DOMAIN}'\'' < /etc/nginx/budu/budu.conf.template > /etc/nginx/conf.d/budu.conf.next && mv /etc/nginx/conf.d/budu.conf.next /etc/nginx/conf.d/budu.conf'
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload

[ "$(grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker exec "$NGINX_CONTAINER" grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000" "$ACTIVE_CONFIG")" -eq 3 ]
require_health "$CANDIDATE" "${RELEASE_SHA:0:12}"
[ "$(count_database_writers "$CANDIDATE")" -eq 1 ] || { echo "post-cutover writer count is not one" >&2; exit 1; }
verify_public_health "$CANDIDATE" "${RELEASE_SHA:0:12}"

printf '%s\n' "$RELEASE_SHA" > "${APP_DIR}/.current-sha"
DEPLOY_OK=1
echo "Invoice QR-only no-schema-change blue/green deployment completed"

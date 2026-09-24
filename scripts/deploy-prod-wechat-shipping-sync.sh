#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# budu — 微信官方发货信息同步（upload_shipping_info）生产发布
#
# 专用 release engineering 脚本。只服务本次发布，不复用其它 feature 的硬编码路径。
# 不使用旧 docker compose production 路径；使用 production authority-aware
# blue/green（复用 scripts/clone-production-container.py）。
#
# 用法：
#   deploy-prod-wechat-shipping-sync.sh BUNDLE_PATH [APP_DIR] [NGINX_CONTAINER]
#
#   BUNDLE_PATH  git 仓库/包，其 HEAD 必须是 RELEASE_SHA（= RUNTIME_SHA 之上
#                仅增加本脚本的那一个 commit）。脚本自行校验这一点。
#
# 设计原则：默认 fail closed。任何一步不符即中止，由 EXIT trap 回滚应用面。
# 本脚本绝不：
#   - 补传/扫描任何历史订单
#   - 调用任何微信写接口（upload_shipping_info / update_shipping_info）
#   - 创建测试订单
#   - 修改生产 env / 新增 secret
#   - 对生产库执行 DROP / TRUNCATE / DELETE / UPDATE / INSERT
# ---------------------------------------------------------------------------
set -Eeuo pipefail

# ============================ 硬锁常量 =====================================
EXPECTED_OLD_SHA="076e6e0de4527777e633c67033d2da1888d91f1b"
RUNTIME_SHA="f454fd637055fb2fccf625b9451a4b411079bfe9"
EXPECTED_DB="budu_bj006"
BASELINE_MIGRATIONS=84
TARGET_MIGRATIONS=85
MIGRATION="20260924140000_online_wechat_shipping_sync"
RELEASE_TAG="wechat-shipping-sync"
SELF_REL="scripts/deploy-prod-wechat-shipping-sync.sh"

BUNDLE_PATH="${1:-}"
APP_DIR="${2:-/opt/budu}"
NGINX_CONTAINER="${3:-budu-nginx-1}"

[ -n "$BUNDLE_PATH" ] || { echo "usage: $0 BUNDLE_PATH [APP_DIR] [NGINX_CONTAINER]" >&2; exit 1; }
[ -d "$APP_DIR" ] || { echo "APP_DIR missing" >&2; exit 1; }
[ -f "${APP_DIR}/.env.production" ] || { echo "production environment file missing" >&2; exit 1; }

HOST_TEMPLATE="${APP_DIR}/deploy/nginx/conf.d/budu.conf.template"
ACTIVE_CONFIG="/etc/nginx/conf.d/budu.conf"
[ -f "$HOST_TEMPLATE" ] || { echo "production nginx authority template missing" >&2; exit 1; }
docker inspect "$NGINX_CONTAINER" >/dev/null

WORK_ROOT="$(mktemp -d /dev/shm/budu-${RELEASE_TAG}.XXXXXX)"
BINDING_FILE="${WORK_ROOT}/binding.json"
DB_ENV_FILE="${WORK_ROOT}/database.env"
MIGRATE_ENV_FILE="${WORK_ROOT}/migrate.env"
REHEARSE_ENV_FILE="${WORK_ROOT}/rehearse.env"
ROLLBACK_ROOT="${APP_DIR}/.rollback-assets/${RELEASE_TAG}-$(date -u +%Y%m%dT%H%M%SZ)"

OLD_CONTAINER=""
RELEASE_SHA=""
SHORT_SHA=""
CANDIDATE=""
MIGRATOR=""
REHEARSAL_PG=""
BACKUP_CONTAINER=""
BACKUP_NAME=""
COMMON_NETWORK=""
OLD_STOPPED=0
TEMPLATE_CHANGED=0
DEPLOY_OK=0

# ============================ 清理 / 回滚 ==================================
safe_cleanup() {
  if [ -n "$REHEARSAL_PG" ] && docker inspect "$REHEARSAL_PG" >/dev/null 2>&1; then
    docker rm -f "$REHEARSAL_PG" >/dev/null 2>&1 || true
  fi
  rm -f "$BINDING_FILE" "$DB_ENV_FILE" "$MIGRATE_ENV_FILE" "$REHEARSE_ENV_FILE"
  rm -rf "$WORK_ROOT"
}

rollback_on_error() {
  local rc=$?
  if [ "$DEPLOY_OK" -eq 1 ]; then safe_cleanup; return; fi
  echo "release failed (rc=$rc); restoring the previous application authority" >&2
  [ -n "$CANDIDATE" ] && docker inspect "$CANDIDATE" >/dev/null 2>&1 && docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true
  [ -n "$MIGRATOR" ] && docker inspect "$MIGRATOR" >/dev/null 2>&1 && docker rm -f "$MIGRATOR" >/dev/null 2>&1 || true
  [ -n "$BACKUP_CONTAINER" ] && docker inspect "$BACKUP_CONTAINER" >/dev/null 2>&1 && docker rm -f "$BACKUP_CONTAINER" >/dev/null 2>&1 || true
  if [ "$OLD_STOPPED" -eq 1 ] && [ -n "$OLD_CONTAINER" ]; then
    docker start "$OLD_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$TEMPLATE_CHANGED" -eq 1 ] && [ -f "${ROLLBACK_ROOT}/budu.conf.template" ]; then
    cp "${ROLLBACK_ROOT}/budu.conf.template" "$HOST_TEMPLATE"
    docker cp "${ROLLBACK_ROOT}/budu.conf.active" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null 2>&1 || true
    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1 || true
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true
  fi
  echo "ROLLBACK applied; production application authority restored" >&2
  safe_cleanup
  exit "$rc"
}
trap rollback_on_error EXIT

phase() { echo; echo "==================== $* ===================="; }

# ============================ 只读校验工具 =================================
require_health() {
  local container="$1" expected_sha_prefix="$2" payload=""
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
    then return 0; fi
    sleep 3
  done
  return 1
}

verify_database_authority() {
  local container="$1" expected_migrations="$2"
  docker exec -i "$container" env EXPECTED_MIGRATIONS="$expected_migrations" EXPECTED_DB="$EXPECTED_DB" node --input-type=module - <<'NODE'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
try {
  const [database, migrations] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
  ])
  const result = { database: database[0]?.name, migrations: Number(migrations[0]?.count) }
  if (result.database !== process.env.EXPECTED_DB || result.migrations !== Number(process.env.EXPECTED_MIGRATIONS)) {
    throw new Error('PRODUCTION_DATABASE_AUTHORITY_MISMATCH')
  }
  console.log(JSON.stringify(result))
} finally {
  await prisma.$disconnect()
}
NODE
}

count_database_writers() {
  local reference="$1" reference_hash="" count=0 container="" candidate_hash=""
  reference_hash="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$reference" | sed -n '/^DATABASE_URL=/p' | sha256sum | cut -d ' ' -f1)"
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    candidate_hash="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | sed -n '/^DATABASE_URL=/p' | sha256sum | cut -d ' ' -f1)"
    if [ "$candidate_hash" = "$reference_hash" ]; then count=$((count + 1)); fi
  done < <(docker ps --format '{{.Names}}')
  printf '%s\n' "$count"
}

# 覆盖指令指定的 7 张表。全表行文本 md5，行数少（生产 ≤56 行）成本可忽略。
feature_digest() {
  local container="$1"
  docker exec -i "$container" node --input-type=module - <<'NODE'
import crypto from 'node:crypto'
import { PrismaClient } from '@prisma/client'
const TABLES = [
  'online_settlements',
  'online_tenders',
  'online_refunds',
  'online_fulfillment_authorizations',
  'online_logistics_traces',
  'sweet_card_accounts',
  'sweet_card_ledger',
]
const prisma = new PrismaClient()
try {
  const parts = []
  let total = 0
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), 'empty') AS d FROM ${table} x`)
    const n = Number(rows[0]?.n ?? -1)
    if (n < 0) throw new Error('DIGEST_TABLE_MISSING_' + table)
    total += n
    parts.push(`${table}:${n}:${rows[0]?.d}`)
  }
  const digest = crypto.createHash('sha256').update(parts.join('\n')).digest('hex')
  process.stdout.write(`${total}:${digest}`)
} finally {
  await prisma.$disconnect()
}
NODE
}

sync_row_count() {
  local container="$1"
  docker exec -i "$container" node --input-type=module - <<'NODE'
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
try {
  const rows = await prisma.$queryRawUnsafe('SELECT to_regclass(\'public.online_wechat_shipping_sync\')::text AS t')
  if (!rows[0]?.t) { process.stdout.write('TABLE_ABSENT'); }
  else {
    const count = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM online_wechat_shipping_sync')
    process.stdout.write(String(count[0]?.n))
  }
} finally {
  await prisma.$disconnect()
}
NODE
}

# ============================ 1. 现场权威复核 ==============================
phase "PHASE 1 — production authority (read-only)"

CURRENT="$(docker inspect "$NGINX_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/etc/nginx/budu"}}{{.Source}}{{end}}{{end}}')"
[ -n "$CURRENT" ] || { echo "nginx authority mount missing" >&2; exit 1; }
[ "$CURRENT" = "${APP_DIR}/deploy/nginx/conf.d" ] || { echo "nginx authority mount unexpected" >&2; exit 1; }

# 从模板里取出所有 :3000 后端，按**镜像 revision label** 识别生产目标
# （模板含 1 条无关的测试后端路由，因此不能假设目标唯一）
mapfile -t PORT3000_TARGETS < <(sed -nE 's@.*proxy_pass[[:space:]]+http://([^:/;]+):3000.*@\1@p' "$HOST_TEMPLATE" | sort -u)
[ "${#PORT3000_TARGETS[@]}" -ge 1 ] || { echo "no :3000 proxy target found" >&2; exit 1; }
OLD_CONTAINER=""
for target in "${PORT3000_TARGETS[@]}"; do
  docker inspect "$target" >/dev/null 2>&1 || { echo "proxy target container missing: $target" >&2; exit 1; }
  rev="$(docker inspect "$target" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  if [ "$rev" = "$EXPECTED_OLD_SHA" ]; then
    [ -z "$OLD_CONTAINER" ] || { echo "ambiguous production route authority" >&2; exit 1; }
    OLD_CONTAINER="$target"
  fi
done
[ -n "$OLD_CONTAINER" ] || { echo "routed production container not found by revision label" >&2; exit 1; }
OLD_ROUTE_COUNT="$(grep -Ec "proxy_pass[[:space:]]+http://${OLD_CONTAINER}:3000" "$HOST_TEMPLATE")"
[ "$OLD_ROUTE_COUNT" -eq 3 ] || { echo "expected exactly three production API routes, found ${OLD_ROUTE_COUNT}" >&2; exit 1; }
[ "$(docker inspect --format '{{.State.Running}}' "$OLD_CONTAINER")" = "true" ] || { echo "routed API is not running" >&2; exit 1; }

require_health "$OLD_CONTAINER" "${EXPECTED_OLD_SHA:0:12}"
verify_database_authority "$OLD_CONTAINER" "$BASELINE_MIGRATIONS"
[ "$(count_database_writers "$OLD_CONTAINER")" -eq 1 ] || { echo "production does not have exactly one database writer" >&2; exit 1; }
AVAIL_KB="$(df -Pk / | awk 'NR==2{print $4}')"
[ "$AVAIL_KB" -ge 10485760 ] || { echo "available disk below 10G" >&2; exit 1; }
MEM_AVAIL_MB="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
[ "$MEM_AVAIL_MB" -ge 1024 ] || { echo "available memory below 1G" >&2; exit 1; }
echo "authority PASS: routed=${OLD_CONTAINER} revision=${EXPECTED_OLD_SHA:0:12} DB=${EXPECTED_DB} migrations=${BASELINE_MIGRATIONS} writer=1 disk=${AVAIL_KB}KB mem=${MEM_AVAIL_MB}MB"

# 绑定文件：clone helper 需要它。其两个值必须与现有生产 env 完全一致，
# 否则就是「改变生产 env」。这里只从现有容器读取并校验，不发明新值。
docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' > "${WORK_ROOT}/old.env"
python3 - "$BINDING_FILE" "${WORK_ROOT}/old.env" <<'PY'
import json, pathlib, sys
binding_path, env_path = sys.argv[1], sys.argv[2]
env = {}
for line in pathlib.Path(env_path).read_text(encoding='utf-8').splitlines():
    if '=' in line:
        key, value = line.split('=', 1)
        env[key] = value
username = env.get('CUSTOMER_REQUEST_WECOM_RECIPIENT_USERNAME')
user_id = env.get('CUSTOMER_REQUEST_WECOM_RECIPIENT_USER_ID')
if not username or not user_id:
    raise SystemExit('EXISTING_RECIPIENT_BINDING_MISSING')
pathlib.Path(binding_path).write_text(json.dumps({'username': username, 'userId': user_id}), encoding='utf-8')
PY
chmod 600 "$BINDING_FILE"
rm -f "${WORK_ROOT}/old.env"
echo "clone binding reproduced from existing runtime env (no new configuration)"

# ============================ 2. RELEASE 身份校验 ==========================
phase "PHASE 2 — release identity"

BUNDLE_TMP="${WORK_ROOT}/release"
git clone -q "$BUNDLE_PATH" "$BUNDLE_TMP" || { echo "release bundle is not clonable: ${BUNDLE_PATH}" >&2; exit 1; }
RELEASE_SHA="$(git -C "$BUNDLE_TMP" rev-parse HEAD)"
[ "$RELEASE_SHA" != "$RUNTIME_SHA" ] || { echo "release bundle has no release-engineering commit" >&2; exit 1; }
git -C "$BUNDLE_TMP" merge-base --is-ancestor "$RUNTIME_SHA" "$RELEASE_SHA" \
  || { echo "runtime SHA is not an ancestor of the release" >&2; exit 1; }
DIFF_FILES="$(git -C "$BUNDLE_TMP" diff --name-only "${RUNTIME_SHA}" "${RELEASE_SHA}")"
[ "$DIFF_FILES" = "$SELF_REL" ] || { echo "release diff is not limited to ${SELF_REL}: ${DIFF_FILES}" >&2; exit 1; }
SHORT_SHA="${RELEASE_SHA:0:7}"
CANDIDATE="budu-prod-${SHORT_SHA}-${RELEASE_TAG}"
MIGRATOR="budu-migrate-${SHORT_SHA}-${RELEASE_TAG}"
REHEARSAL_PG="budu-rehearse-${SHORT_SHA}-${RELEASE_TAG}"
BACKUP_CONTAINER="budu-backup-${SHORT_SHA}-${RELEASE_TAG}"
IMAGE="budu-api:${RELEASE_TAG}-${SHORT_SHA}"
for name in "$CANDIDATE" "$MIGRATOR" "$REHEARSAL_PG" "$BACKUP_CONTAINER"; do
  docker inspect "$name" >/dev/null 2>&1 && { echo "container name already exists: $name" >&2; exit 1; }
done
echo "runtime=${RUNTIME_SHA:0:12} release=${RELEASE_SHA:0:12} exclusive_diff=${DIFF_FILES}"

# ============================ 3. 备份 + rollback 资产 ======================
phase "PHASE 3 — fresh production backup"

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
mkdir -p "$ROLLBACK_ROOT"; chmod 700 "$ROLLBACK_ROOT"
cp "$HOST_TEMPLATE" "${ROLLBACK_ROOT}/budu.conf.template"
docker cp "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" "${ROLLBACK_ROOT}/budu.conf.active" >/dev/null
OLD_CONTAINER="$OLD_CONTAINER" DB_ENV_FILE="$DB_ENV_FILE" EXPECTED_DB="$EXPECTED_DB" python3 - <<'PY'
import json, os, pathlib, subprocess, urllib.parse
raw = subprocess.check_output(['docker', 'inspect', os.environ['OLD_CONTAINER']], text=True)
env = json.loads(raw)[0]['Config'].get('Env') or []
database_url = next((item.split('=', 1)[1] for item in env if item.startswith('DATABASE_URL=')), '')
if not database_url:
    raise SystemExit('DATABASE_URL_MISSING')
parts = urllib.parse.urlsplit(database_url)
if parts.path != '/' + os.environ['EXPECTED_DB']:
    raise SystemExit('BACKUP_DATABASE_AUTHORITY_MISMATCH')
safe_uri = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))
path = pathlib.Path(os.environ['DB_ENV_FILE'])
path.write_text(f'PGURI={safe_uri}\n', encoding='utf-8')
path.chmod(0o600)
PY
BACKUP_NAME="${EXPECTED_DB}-migration${BASELINE_MIGRATIONS}-pre-${RELEASE_TAG}-${SHORT_SHA}.dump"
docker create --name "$BACKUP_CONTAINER" --user "$(id -u):$(id -g)" --network "$COMMON_NETWORK" \
  --env-file "$DB_ENV_FILE" -e BACKUP_NAME="$BACKUP_NAME" -v "${ROLLBACK_ROOT}:/backup" postgres:16-alpine \
  sh -c 'pg_dump "$PGURI" --format=custom --no-owner --file="/backup/$BACKUP_NAME"' >/dev/null
while IFS= read -r backup_network; do
  [ -n "$backup_network" ] || continue
  [ "$backup_network" = "$COMMON_NETWORK" ] && continue
  docker network connect "$backup_network" "$BACKUP_CONTAINER"
done < <(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$OLD_CONTAINER")
docker start -a "$BACKUP_CONTAINER"
docker rm "$BACKUP_CONTAINER" >/dev/null
[ -s "${ROLLBACK_ROOT}/${BACKUP_NAME}" ] || { echo "backup is empty" >&2; exit 1; }
docker run --rm -v "${ROLLBACK_ROOT}:/backup:ro" postgres:16-alpine pg_restore --list "/backup/${BACKUP_NAME}" >/dev/null
BACKUP_SHA256="$(sha256sum "${ROLLBACK_ROOT}/${BACKUP_NAME}" | cut -d ' ' -f1)"
cp "${ROLLBACK_ROOT}/${BACKUP_NAME}" "${ROLLBACK_ROOT}/${BACKUP_NAME}.protected"
chmod 400 "${ROLLBACK_ROOT}/${BACKUP_NAME}" "${ROLLBACK_ROOT}/${BACKUP_NAME}.protected"
echo "backup=${ROLLBACK_ROOT}/${BACKUP_NAME}"
echo "backup_sha256=${BACKUP_SHA256}"
echo "$BACKUP_SHA256" > "${ROLLBACK_ROOT}/backup.sha256"
printf '%s\n' "revision=${EXPECTED_OLD_SHA}" "migration_baseline=${BASELINE_MIGRATIONS}" \
  "backup=${BACKUP_NAME}" "backup_sha256=${BACKUP_SHA256}" > "${ROLLBACK_ROOT}/manifest.txt"
chmod 600 "${ROLLBACK_ROOT}/backup.sha256" "${ROLLBACK_ROOT}/manifest.txt"
echo "backup integrity PASS (pg_restore --list); protected rollback copy created"

# ============================ 4. 构建 RELEASE image ========================
phase "PHASE 4 — build release image"

[ "$(git -C "$BUNDLE_TMP" rev-parse HEAD)" = "$RELEASE_SHA" ] || { echo "release bundle SHA mismatch" >&2; exit 1; }
docker build --label "org.opencontainers.image.revision=${RELEASE_SHA}" -t "$IMAGE" "$BUNDLE_TMP" >/dev/null
IMAGE_REV="$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[ "$IMAGE_REV" = "$RELEASE_SHA" ] || { echo "image revision label mismatch" >&2; exit 1; }
echo "image=${IMAGE} revision_label=${IMAGE_REV}"

BEFORE_DIGEST="$(feature_digest "$OLD_CONTAINER")"
echo "pre-migration feature digest (7 tables): ${BEFORE_DIGEST}"

# ============================ 5. Clone migration rehearsal =================
phase "PHASE 5 — isolated clone migration rehearsal"

docker run -d --name "$REHEARSAL_PG" --network "$COMMON_NETWORK" \
  -e POSTGRES_USER="$EXPECTED_DB" -e POSTGRES_DB="$EXPECTED_DB" -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16-alpine >/dev/null
for _attempt in $(seq 1 40); do
  docker exec "$REHEARSAL_PG" pg_isready -U "$EXPECTED_DB" -d "$EXPECTED_DB" >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$REHEARSAL_PG" pg_isready -U "$EXPECTED_DB" -d "$EXPECTED_DB" >/dev/null
docker exec -i "$REHEARSAL_PG" pg_restore -U "$EXPECTED_DB" -d "$EXPECTED_DB" --no-owner --no-acl --single-transaction \
  < "${ROLLBACK_ROOT}/${BACKUP_NAME}"
CLONE_BEFORE_MIGRATIONS="$(docker exec "$REHEARSAL_PG" psql -U "$EXPECTED_DB" -d "$EXPECTED_DB" -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d ' ')"
[ "$CLONE_BEFORE_MIGRATIONS" = "$BASELINE_MIGRATIONS" ] || { echo "restored clone migration baseline is ${CLONE_BEFORE_MIGRATIONS}, expected ${BASELINE_MIGRATIONS}" >&2; exit 1; }
CLONE_DIGEST_BEFORE="$(docker exec "$REHEARSAL_PG" psql -U "$EXPECTED_DB" -d "$EXPECTED_DB" -tAc \
  "SELECT (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_settlements x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_tenders x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_refunds x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_fulfillment_authorizations x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_logistics_traces x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM sweet_card_accounts x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM sweet_card_ledger x)" | tr -d ' ')"

# 只连 isolated clone；绝不连生产
printf 'DATABASE_URL=postgresql://%s@%s:5432/%s\n' "$EXPECTED_DB" "$REHEARSAL_PG" "$EXPECTED_DB" > "$REHEARSE_ENV_FILE"
chmod 600 "$REHEARSE_ENV_FILE"
docker run --rm --network "$COMMON_NETWORK" --env-file "$REHEARSE_ENV_FILE" "$IMAGE" npx prisma migrate deploy
CLONE_AFTER_MIGRATIONS="$(docker exec "$REHEARSAL_PG" psql -U "$EXPECTED_DB" -d "$EXPECTED_DB" -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL" | tr -d ' ')"
[ "$CLONE_AFTER_MIGRATIONS" = "$TARGET_MIGRATIONS" ] || { echo "clone migration count ${CLONE_AFTER_MIGRATIONS} != ${TARGET_MIGRATIONS}" >&2; exit 1; }
CLONE_DIGEST_AFTER="$(docker exec "$REHEARSAL_PG" psql -U "$EXPECTED_DB" -d "$EXPECTED_DB" -tAc \
  "SELECT (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_settlements x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_tenders x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_refunds x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_fulfillment_authorizations x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM online_logistics_traces x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM sweet_card_accounts x) || (SELECT md5(string_agg(x::text,'|' ORDER BY x::text)) FROM sweet_card_ledger x)" | tr -d ' ')"
[ "$CLONE_DIGEST_BEFORE" = "$CLONE_DIGEST_AFTER" ] || { echo "rehearsal changed existing financial facts" >&2; exit 1; }

CLONE_SCHEMA="$(docker exec "$REHEARSAL_PG" psql -U "$EXPECTED_DB" -d "$EXPECTED_DB" -tAc "$(cat <<'SQL'
SELECT 'table=' || (to_regclass('public.online_wechat_shipping_sync') IS NOT NULL)
  || ' index=' || (to_regclass('public.online_wechat_shipping_sync_status_available_at_idx') IS NOT NULL)
  || ' function=' || (SELECT count(*) FROM pg_proc WHERE proname='online_wechat_shipping_payload_immutable')
  || ' trigger=' || (SELECT count(*) FROM pg_trigger WHERE tgname='online_wechat_shipping_no_payload_rewrite')
  || ' method=' || (SELECT count(*) FROM information_schema.columns WHERE table_name='online_wechat_shipping_sync' AND column_name='method' AND is_nullable='NO')
  || ' logistics_type=' || (SELECT count(*) FROM information_schema.columns WHERE table_name='online_wechat_shipping_sync' AND column_name='logistics_type' AND is_nullable='NO')
  || ' delivery_id_nullable=' || (SELECT is_nullable FROM information_schema.columns WHERE table_name='online_wechat_shipping_sync' AND column_name='delivery_id')
  || ' tracking_no_nullable=' || (SELECT is_nullable FROM information_schema.columns WHERE table_name='online_wechat_shipping_sync' AND column_name='tracking_no')
  || ' reupload_count=' || (SELECT column_default FROM information_schema.columns WHERE table_name='online_wechat_shipping_sync' AND column_name='reupload_count')
  || ' checks=' || (SELECT count(*) FROM pg_constraint WHERE conrelid='public.online_wechat_shipping_sync'::regclass AND contype='c')
  || ' rows=' || (SELECT count(*) FROM online_wechat_shipping_sync);
SQL
)" | tr -d ' ')"
echo "clone schema: ${CLONE_SCHEMA}"
case "$CLONE_SCHEMA" in
  table=t*index=t*function=1*trigger=1*method=1*logistics_type=1*delivery_id_nullable=YES*tracking_no_nullable=YES*reupload_count=0*checks=*rows=0) : ;;
  *) echo "rehearsal schema assertion failed" >&2; exit 1 ;;
esac
docker rm -f "$REHEARSAL_PG" >/dev/null; REHEARSAL_PG=""
echo "rehearsal PASS: ${BASELINE_MIGRATIONS}→${TARGET_MIGRATIONS}, schema matches candidate, financial digests unchanged; isolated clone deleted"

# ============================ 6. Production migration 84→85 ================
phase "PHASE 6 — production migration ${BASELINE_MIGRATIONS}→${TARGET_MIGRATIONS}"

OLD_CONTAINER="$OLD_CONTAINER" MIGRATE_ENV_FILE="$MIGRATE_ENV_FILE" EXPECTED_DB="$EXPECTED_DB" python3 - <<'PY'
import json, os, pathlib, subprocess, urllib.parse
raw = subprocess.check_output(['docker', 'inspect', os.environ['OLD_CONTAINER']], text=True)
env = json.loads(raw)[0]['Config'].get('Env') or []
database_url = next((item.split('=', 1)[1] for item in env if item.startswith('DATABASE_URL=')), '')
if not database_url:
    raise SystemExit('DATABASE_URL_MISSING')
if urllib.parse.urlsplit(database_url).path != '/' + os.environ['EXPECTED_DB']:
    raise SystemExit('MIGRATION_DATABASE_AUTHORITY_MISMATCH')
separator = '&' if '?' in database_url else '?'
options = '-c%20lock_timeout%3D5s%20-c%20statement_timeout%3D60s'
path = pathlib.Path(os.environ['MIGRATE_ENV_FILE'])
path.write_text(f'DATABASE_URL={database_url}{separator}options={options}\n'
                f'PGOPTIONS=-c lock_timeout=5s -c statement_timeout=60s\n', encoding='utf-8')
path.chmod(0o600)
PY
docker run --rm --network "$COMMON_NETWORK" --env-file "$MIGRATE_ENV_FILE" "$IMAGE" \
  sh -c 'npx prisma migrate deploy && node -e "const{PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.\$queryRawUnsafe(\"SHOW lock_timeout\").then(r=>{console.log(\"lock_timeout=\"+Object.values(r[0])[0]);return p.\$disconnect()}).catch(e=>{console.error(e.message);process.exit(1)})"'
verify_database_authority "$OLD_CONTAINER" "$TARGET_MIGRATIONS"
AFTER_DIGEST="$(feature_digest "$OLD_CONTAINER")"
[ "$AFTER_DIGEST" = "$BEFORE_DIGEST" ] || { echo "existing financial facts changed during additive migration" >&2; exit 1; }
[ "$(sync_row_count "$OLD_CONTAINER")" = "0" ] || { echo "new sync table is not empty at deploy time" >&2; exit 1; }
require_health "$OLD_CONTAINER" "${EXPECTED_OLD_SHA:0:12}"
echo "production migrated ${BASELINE_MIGRATIONS}→${TARGET_MIGRATIONS}; 7-table digest unchanged; online_wechat_shipping_sync rows=0; old runtime still healthy"

# ============================ 7. Unrouted readonly smoke ===================
phase "PHASE 7 — unrouted read-only candidate smoke"

python3 - "$BINDING_FILE" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
value = json.loads(path.read_text(encoding='utf-8'))
if set(value) != {'username', 'userId'} or not value['username'] or not value['userId']:
    raise SystemExit('CLONE_BINDING_INVALID')
PY
# clone helper 必须与本脚本放在一起（发布时一起投递）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLONER="${SCRIPT_DIR}/clone-production-container.py"
[ -f "$CLONER" ] || { echo "clone helper missing next to this script: ${CLONER}" >&2; exit 1; }

python3 "$CLONER" "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" disabled readonly
require_health "$CANDIDATE" "${RELEASE_SHA:0:12}"
verify_database_authority "$CANDIDATE" "$TARGET_MIGRATIONS"
[ "$(count_database_writers "$OLD_CONTAINER")" -eq 1 ] || { echo "readonly candidate changed writer ownership" >&2; exit 1; }
docker stop -t 20 "$CANDIDATE" >/dev/null
docker rm "$CANDIDATE" >/dev/null
echo "readonly smoke PASS (start/imports/prisma/health/gitSha/db); writer count still 1; smoke container removed"

# ============================ 8. Writer cutover ============================
phase "PHASE 8 — writer cutover (exactly one writer)"

[ "$(count_database_writers "$OLD_CONTAINER")" -eq 1 ] || { echo "pre-cutover writer count is not one" >&2; exit 1; }
cp "$HOST_TEMPLATE" "${WORK_ROOT}/budu.conf.template.candidate"
OLD_CONTAINER="$OLD_CONTAINER" CANDIDATE="$CANDIDATE" TEMPLATE="${WORK_ROOT}/budu.conf.template.candidate" python3 - <<'PY'
import os, pathlib
path = pathlib.Path(os.environ['TEMPLATE'])
old, new = os.environ['OLD_CONTAINER'], os.environ['CANDIDATE']
text = path.read_text(encoding='utf-8')
if text.count(f'http://{old}:3000') != 3:
    raise SystemExit('OLD_ROUTE_COUNT_MISMATCH')
updated = text.replace(f'http://{old}:3000', f'http://{new}:3000')
if updated.count(f'http://{new}:3000') != 3 or f'http://{old}:3000' in updated:
    raise SystemExit('CANDIDATE_ROUTE_COUNT_MISMATCH')
path.write_text(updated, encoding='utf-8')
PY

docker stop -t 20 "$OLD_CONTAINER" >/dev/null
OLD_STOPPED=1
[ "$(docker inspect --format '{{.State.Running}}' "$OLD_CONTAINER")" = "false" ] || { echo "old container still running" >&2; exit 1; }
python3 "$CLONER" "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" preserve writer
docker update --restart unless-stopped "$CANDIDATE" >/dev/null
require_health "$CANDIDATE" "${RELEASE_SHA:0:12}"
verify_database_authority "$CANDIDATE" "$TARGET_MIGRATIONS"
[ "$(count_database_writers "$CANDIDATE")" -eq 1 ] || { echo "post-cutover writer count is not one" >&2; exit 1; }
echo "candidate is the single writer; health/db/migrations/writer verified"

# ============================ 9. Nginx cutover =============================
phase "PHASE 9 — nginx cutover"

cp "${WORK_ROOT}/budu.conf.template.candidate" "$HOST_TEMPLATE"
TEMPLATE_CHANGED=1
docker exec "$NGINX_CONTAINER" sh -c 'envsubst '\''${DOMAIN}'\'' < /etc/nginx/budu/budu.conf.template > /etc/nginx/conf.d/budu.conf.next && mv /etc/nginx/conf.d/budu.conf.next /etc/nginx/conf.d/budu.conf'
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000" "$HOST_TEMPLATE")" -eq 3 ] || { echo "host template route swap incomplete" >&2; exit 1; }
[ "$(docker exec "$NGINX_CONTAINER" grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000" "$ACTIVE_CONFIG")" -eq 3 ] || { echo "active nginx route swap incomplete" >&2; exit 1; }
[ "$(docker exec "$NGINX_CONTAINER" grep -Ec "proxy_pass[[:space:]]+http://${OLD_CONTAINER}:3000" "$ACTIVE_CONFIG")" -eq 0 ] || { echo "old route still active" >&2; exit 1; }

PUBLIC_BASE_URL="https://buducandy.cn" docker exec -i "$CANDIDATE" env EXPECTED_SHA_PREFIX="$RELEASE_SHA" node --input-type=module - <<'NODE'
const origin = String(process.env.PUBLIC_BASE_URL || '')
if (!origin.startsWith('https://')) throw new Error('PUBLIC_ORIGIN_NOT_HTTPS')
const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000) })
const health = await response.json()
if (!response.ok || health.ok !== true || health.dbOk !== true || !String(health.gitSha || '').startsWith(process.env.EXPECTED_SHA_PREFIX)) {
  throw new Error('PUBLIC_HEALTH_AUTHORITY_MISMATCH')
}
console.log(JSON.stringify({ publicHealth: 'PASS', gitSha: health.gitSha }))
NODE
[ "$(count_database_writers "$CANDIDATE")" -eq 1 ] || { echo "writer count after nginx cutover is not one" >&2; exit 1; }
[ "$(feature_digest "$CANDIDATE")" = "$BEFORE_DIGEST" ] || { echo "existing financial facts changed after cutover" >&2; exit 1; }
echo "nginx cutover PASS; public health on ${RELEASE_SHA:0:12}; writer=1; digests unchanged"

# ============================ 10. 上线验收 =================================
phase "PHASE 10 — shipping sync acceptance"

[ "$(sync_row_count "$CANDIDATE")" = "0" ] || { echo "sync table is not empty immediately after cutover" >&2; exit 1; }
echo "sync row count immediately after deploy = 0 (no historical backfill)"
sleep 35
[ "$(sync_row_count "$CANDIDATE")" = "0" ] || { echo "sync table grew during idle worker cycles" >&2; exit 1; }
require_health "$CANDIDATE" "${RELEASE_SHA:0:12}"
LOGS="$(docker logs --tail 400 "$CANDIDATE" 2>&1 || true)"
if printf '%s' "$LOGS" | grep -Eiq 'uncaughtException|unhandledRejection|SHIPPING_.*FAILED|PrismaClientKnownRequestError|does not exist in the current database|token authority|ECONNREFUSED'; then
  echo "worker log scan found a blocking symptom:" >&2
  printf '%s' "$LOGS" | grep -Ei 'uncaughtException|unhandledRejection|SHIPPING_.*FAILED|PrismaClientKnownRequestError|does not exist in the current database|token authority|ECONNREFUSED' | tail -10 >&2
  exit 1
fi
echo "worker observed >=2 cycles: no uncaught exception, no prisma table error, no shipping worker crash, no token conflict"
echo "sync row count after 35s = $(sync_row_count "$CANDIDATE")"

printf '%s\n' "$RELEASE_SHA" > "${APP_DIR}/.current-sha"
printf '%s\n' "${ROLLBACK_ROOT}/${BACKUP_NAME}" > "${ROLLBACK_ROOT}/retained-assets.txt"
cat >> "${ROLLBACK_ROOT}/manifest.txt" <<EOF
release_sha=${RELEASE_SHA}
image=${IMAGE}
candidate=${CANDIDATE}
old_container=${OLD_CONTAINER}
old_sha=${EXPECTED_OLD_SHA}
migration_applied=${MIGRATION}
target_migrations=${TARGET_MIGRATIONS}
EOF
chmod 600 "${ROLLBACK_ROOT}/manifest.txt"
DEPLOY_OK=1
echo
echo "RELEASE COMPLETE"
echo "  release_sha   = ${RELEASE_SHA}"
echo "  image         = ${IMAGE}"
echo "  candidate     = ${CANDIDATE}"
echo "  old_container = ${OLD_CONTAINER} (stopped, retained)"
echo "  rollback_root = ${ROLLBACK_ROOT}"
echo "  migrations    = ${TARGET_MIGRATIONS}"

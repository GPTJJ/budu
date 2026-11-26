#!/usr/bin/env bash
# 甜意卡领取链接改 URL Scheme（含前端新界面）生产发布 runbook。
#
# 与 sweet-card-availability 的区别（刻意保留的最小集合）：
#   - 本次没有任何 Prisma migration，因此不做 migrator / 隔离库演练，改为在
#     preflight 与 candidate 两处断言数据库权威（库名 + migration 数 + failed=0）。
#   - 改动同时含前端产物，所以 smoke 里额外断言 dist 里存在新品牌文案与新页面 chunk。
#   - 显式注入 WECHAT_URLLINK_ENV_VERSION=release：不依赖 NODE_ENV 的隐式推断，
#     避免 release 版本被生成成体验版 scheme。
set -Eeuo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 BUNDLE RELEASE_SHA EXPECTED_OLD_SHA APP_DIR NGINX_CONTAINER" >&2
  exit 2
fi

BUNDLE_PATH="$1"
RELEASE_SHA="$2"
EXPECTED_OLD_SHA="$3"
APP_DIR="$4"
NGINX_CONTAINER="$5"
SHORT_SHA="${RELEASE_SHA:0:7}"
BASELINE_MIGRATIONS="${EXPECTED_BASELINE_MIGRATIONS:-95}"
CANDIDATE="budu-prod-${SHORT_SHA}-sweet-card-scheme"
READONLY="budu-prod-${SHORT_SHA}-sweet-card-scheme-ro"
BACKUP_CONTAINER="budu-backup-${SHORT_SHA}-sweet-card-scheme"
IMAGE="budu-api:sweet-card-scheme-${SHORT_SHA}"
HOST_TEMPLATE="${APP_DIR}/deploy/nginx/conf.d/budu.conf.template"
ACTIVE_CONFIG="/etc/nginx/conf.d/budu.conf"
IN_CONTAINER_TEMPLATE="/etc/nginx/budu/budu.conf.template"
WORK_ROOT="$(mktemp -d "/dev/shm/budu-sweet-card-scheme-${SHORT_SHA}.XXXXXX")"
ROLLBACK_ROOT="${APP_DIR}/.rollback-assets/sweet-card-scheme-${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
RELEASE_ROOT="${WORK_ROOT}/release"
BINDING_FILE="${WORK_ROOT}/recipient-binding.json"
DB_ENV_FILE="${WORK_ROOT}/database.env"
EXTRA_ENV_JSON='{"WECHAT_URLLINK_ENV_VERSION":"release"}'
OLD_CONTAINER=""
OLD_STOPPED=0
ROUTE_CHANGED=0
DEPLOY_OK=0

write_current_sha() {
  docker run --rm --user root \
    -e TARGET_SHA="$1" \
    -v "${APP_DIR}:/target" \
    "$IMAGE" \
    sh -c 'printf "%s\n" "$TARGET_SHA" > /target/.current-sha'
}

safe_cleanup() {
  docker rm -f "$BACKUP_CONTAINER" "$READONLY" >/dev/null 2>&1 || true
  rm -f "$BUNDLE_PATH"
  rm -rf "$WORK_ROOT"
}

rollback_on_error() {
  local rc=$?
  if [ "$DEPLOY_OK" -eq 1 ]; then safe_cleanup; return; fi
  echo "SWEET_CARD_SCHEME_DEPLOY_ROLLBACK_START" >&2
  if docker inspect "$CANDIDATE" >/dev/null 2>&1; then docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true; fi
  if [ "$OLD_STOPPED" -eq 1 ] && [ -n "$OLD_CONTAINER" ]; then docker start "$OLD_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "$ROUTE_CHANGED" -eq 1 ] && [ -f "${ROLLBACK_ROOT}/budu.conf.template.pre" ]; then
    cp "${ROLLBACK_ROOT}/budu.conf.template.pre" "$HOST_TEMPLATE"
    docker cp "${ROLLBACK_ROOT}/budu.conf.active.pre" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null
    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null
  fi
  if [ "$OLD_STOPPED" -eq 1 ] || [ "$ROUTE_CHANGED" -eq 1 ]; then write_current_sha "$EXPECTED_OLD_SHA"; fi
  safe_cleanup
  echo "SWEET_CARD_SCHEME_DEPLOY_ROLLBACK_COMPLETE" >&2
  exit "$rc"
}
trap rollback_on_error EXIT

require_health() {
  local container="$1" expected="$2" payload=""
  for _attempt in $(seq 1 40); do
    payload="$(docker exec "$container" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
    if HEALTH_PAYLOAD="$payload" EXPECTED="$expected" python3 - <<'PY'
import json, os
try:
    value=json.loads(os.environ.get('HEALTH_PAYLOAD',''))
    valid=value.get('ok') is True and value.get('dbOk') is True and os.environ['EXPECTED'].startswith(str(value.get('gitSha','')))
except Exception:
    valid=False
raise SystemExit(0 if valid else 1)
PY
    then return 0; fi
    sleep 2
  done
  echo "HEALTH_CHECK_FAILED container=${container} last=${payload}" >&2
  return 1
}

verify_database() {
  local container="$1" expected="$2"
  docker exec -i "$container" env EXPECTED_MIGRATIONS="$expected" node --input-type=module - <<'NODE'
import { createRequire } from 'node:module'
const require = createRequire('/app/package.json')
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
try {
  const [db, migrations, failed] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE started_at IS NOT NULL AND finished_at IS NULL AND rolled_back_at IS NULL'),
  ])
  if (db[0].name !== 'budu_bj006' || migrations[0].count !== Number(process.env.EXPECTED_MIGRATIONS) || failed[0].count !== 0) {
    throw new Error(`DATABASE_AUTHORITY_MISMATCH db=${db[0].name} migrations=${migrations[0].count} failed=${failed[0].count}`)
  }
  console.log(JSON.stringify({ database: db[0].name, migrations: migrations[0].count, failed: failed[0].count }))
} finally { await prisma.$disconnect() }
NODE
}

count_writers() {
  local reference="$1" reference_hash candidate_hash count=0 container=""
  reference_hash="$(docker inspect "$reference" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n '/^DATABASE_URL=/p' | sha256sum | cut -d ' ' -f1)"
  while IFS= read -r container; do
    [ -n "$container" ] || continue
    candidate_hash="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n '/^DATABASE_URL=/p' | sha256sum | cut -d ' ' -f1)"
    [ "$candidate_hash" != "$reference_hash" ] || count=$((count+1))
  done < <(docker ps --format '{{.Names}}')
  printf '%s\n' "$count"
}

assert_route_mounted() {
  local container="$1"
  local code
  code="$(docker exec "$container" sh -c "wget -q -S -O /dev/null --header='Content-Type: application/json' --post-data='{}' http://127.0.0.1:3000/api/v2/sweet-cards/cards/route-probe/claim-url-link 2>&1 | sed -n 's@^  HTTP/[0-9.]* \\([0-9]*\\).*@\\1@p' | head -1")"
  case "$code" in
    400|401|403) echo "claim-url-link route mounted (${code})" ;;
    404|"") echo "CLAIM_URL_LINK_ROUTE_MISSING (status=${code})" >&2; return 1 ;;
    *) echo "CLAIM_URL_LINK_ROUTE_UNEXPECTED (status=${code})" >&2; return 1 ;;
  esac
}

assert_release_assets() {
  local container="$1"
  docker exec "$container" node --input-type=module -e "
    const m = await import('file:///app/server/sweet-card-url-link.js');
    if (typeof m.createClaimShareLink !== 'function' || typeof m.createClaimUrlScheme !== 'function') {
      console.error('MODULE_EXPORT_MISSING'); process.exit(1);
    }
  " || { echo "SWEET_CARD_URL_LINK_MODULE_BROKEN" >&2; return 1; }
  docker exec "$container" sh -c "grep -rl 'A LITTLE SWEETNESS' /app/dist/assets | head -1" | grep -q . \
    || { echo "DIST_BRAND_COPY_MISSING" >&2; return 1; }
  docker exec "$container" sh -c "ls /app/dist/assets/SweetCardPage-*.js >/dev/null 2>&1" \
    || { echo "DIST_SWEET_CARD_CHUNK_MISSING" >&2; return 1; }
  local env_version
  env_version="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^WECHAT_URLLINK_ENV_VERSION=//p')"
  [ "$env_version" = "release" ] || { echo "URLLINK_ENV_VERSION_NOT_RELEASE (${env_version})" >&2; return 1; }
  echo "release assets PASS: module + dist brand + SweetCardPage chunk + env_version=release"
}

create_backup() {
  local name="$1"
  docker create --name "$BACKUP_CONTAINER" --user "$(id -u):$(id -g)" --network "$COMMON_NETWORK" \
    --env-file "$DB_ENV_FILE" -e BACKUP_NAME="$name" -v "${ROLLBACK_ROOT}:/backup" postgres:16-alpine \
    sh -c 'pg_dump "$PGURI" --format=custom --no-owner --file="/backup/$BACKUP_NAME"' >/dev/null
  while IFS= read -r network; do
    [ -n "$network" ] || continue
    [ "$network" = "$COMMON_NETWORK" ] && continue
    docker network connect "$network" "$BACKUP_CONTAINER"
  done < <(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$OLD_CONTAINER")
  docker start -a "$BACKUP_CONTAINER"
  docker rm "$BACKUP_CONTAINER" >/dev/null
  docker run --rm -v "${ROLLBACK_ROOT}:/backup:ro" postgres:16-alpine pg_restore --list "/backup/${name}" >/dev/null
  sha256sum "${ROLLBACK_ROOT}/${name}" > "${ROLLBACK_ROOT}/${name}.sha256"
  chmod 400 "${ROLLBACK_ROOT}/${name}" "${ROLLBACK_ROOT}/${name}.sha256"
}

# ---------- preflight ----------
[ -f "$HOST_TEMPLATE" ] || { echo "production nginx template missing" >&2; exit 1; }
docker inspect "$NGINX_CONTAINER" >/dev/null
docker exec "$NGINX_CONTAINER" cat "$IN_CONTAINER_TEMPLATE" >/dev/null

# 只认主站路由（以 :3000; 结尾）。:3000/api/ 属于另一个 upstream，必须排除。
mapfile -t ROUTE_TARGETS < <(sed -nE 's@.*proxy_pass[[:space:]]+http://([^:/;]+):3000;.*@\1@p' "$HOST_TEMPLATE" | sort -u)
[ "${#ROUTE_TARGETS[@]}" -eq 1 ] || { echo "production route authority ambiguous: ${ROUTE_TARGETS[*]:-none}" >&2; exit 1; }
OLD_CONTAINER="${ROUTE_TARGETS[0]}"
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${OLD_CONTAINER}:3000;" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{.State.Running}}')" = true ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_OLD_SHA" ]
[ "$(count_writers "$OLD_CONTAINER")" -eq 1 ]
require_health "$OLD_CONTAINER" "$EXPECTED_OLD_SHA"
verify_database "$OLD_CONTAINER" "$BASELINE_MIGRATIONS"
[ "$(docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^XIDAN_SWEET_CARD_COMMERCIAL=//p')" = 1 ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^SWEET_CARD_ENABLED=//p')" = 1 ]
echo "production preflight PASS: runtime=${OLD_CONTAINER} database=budu_bj006 migration=${BASELINE_MIGRATIONS} writer=1 sweet_card=enabled"

# ---------- rollback assets ----------
mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
cp "$HOST_TEMPLATE" "${ROLLBACK_ROOT}/budu.conf.template.pre"
docker cp "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" "${ROLLBACK_ROOT}/budu.conf.active.pre" >/dev/null
printf '%s\n' "$EXPECTED_OLD_SHA" > "${ROLLBACK_ROOT}/previous-sha"

COMMON_NETWORK="$(CURRENT="$OLD_CONTAINER" NGINX="$NGINX_CONTAINER" python3 - <<'PY'
import json, os, subprocess
def networks(name): return set(json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]['NetworkSettings']['Networks'])
common=sorted((networks(os.environ['CURRENT']) & networks(os.environ['NGINX']))-{'bridge','host','none'})
if len(common)!=1: raise SystemExit(f'NETWORK_AUTHORITY_{len(common)}')
print(common[0])
PY
)"

OLD_CONTAINER="$OLD_CONTAINER" DB_ENV_FILE="$DB_ENV_FILE" python3 - <<'PY'
import json, os, pathlib, subprocess, urllib.parse
source=json.loads(subprocess.check_output(['docker','inspect',os.environ['OLD_CONTAINER']],text=True))[0]
value=next((line.split('=',1)[1] for line in source['Config'].get('Env',[]) if line.startswith('DATABASE_URL=')),'')
parts=urllib.parse.urlsplit(value)
if parts.path!='/budu_bj006': raise SystemExit('BACKUP_DATABASE_AUTHORITY_MISMATCH')
uri=urllib.parse.urlunsplit((parts.scheme,parts.netloc,parts.path,'',''))
path=pathlib.Path(os.environ['DB_ENV_FILE']); path.write_text(f'PGURI={uri}\nDATABASE_URL={uri}\n'); path.chmod(0o600)
PY

# ---------- build ----------
# clone-production-container.py 需要固定的 CustomerRequest 收件绑定，缺失会直接
# FileNotFoundError 中止（克隆器不接受空绑定，也不允许在这里改变收件人）。
printf '%s' '{"username":"budu","userId":"dh"}' > "$BINDING_FILE"
chmod 600 "$BINDING_FILE"
BRANCH_REF="$(git bundle list-heads "$BUNDLE_PATH" | head -1 | awk '{print $2}')"
[ -n "$BRANCH_REF" ] || { echo "BUNDLE_REF_MISSING" >&2; exit 1; }
git init -q "$RELEASE_ROOT"
git -C "$RELEASE_ROOT" fetch -q "$BUNDLE_PATH" "$BRANCH_REF"
git -C "$RELEASE_ROOT" checkout -q FETCH_HEAD
[ "$(git -C "$RELEASE_ROOT" rev-parse HEAD)" = "$RELEASE_SHA" ]
docker build --label "org.opencontainers.image.revision=${RELEASE_SHA}" -t "$IMAGE" "$RELEASE_ROOT"
echo "image built: ${IMAGE}"

# ---------- fresh db backup (no migration, still keep a restore point) ----------
PRE_BACKUP="pre-promotion-budu_bj006-m${BASELINE_MIGRATIONS}-sweet-card-scheme.dump"
create_backup "$PRE_BACKUP"
echo "pre-promotion M${BASELINE_MIGRATIONS} backup PASS"

# ---------- unrouted readonly candidate smoke ----------
docker rm -f "$READONLY" >/dev/null 2>&1 || true
EXTRA_ENV_JSON="$EXTRA_ENV_JSON" python3 "${RELEASE_ROOT}/scripts/clone-production-container.py" \
  "$OLD_CONTAINER" "$READONLY" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" disabled readonly
require_health "$READONLY" "$RELEASE_SHA"
verify_database "$READONLY" "$BASELINE_MIGRATIONS"
assert_route_mounted "$READONLY"
assert_release_assets "$READONLY"
[ "$(count_writers "$OLD_CONTAINER")" -eq 1 ]
echo "unrouted readonly candidate smoke PASS"

# ---------- cutover ----------
cp "$HOST_TEMPLATE" "${WORK_ROOT}/budu.conf.template.candidate"
OLD_CONTAINER="$OLD_CONTAINER" CANDIDATE="$CANDIDATE" TEMPLATE="${WORK_ROOT}/budu.conf.template.candidate" python3 - <<'PY'
import os, pathlib
path=pathlib.Path(os.environ['TEMPLATE']); old=os.environ['OLD_CONTAINER']; new=os.environ['CANDIDATE']; text=path.read_text()
if text.count(f'http://{old}:3000;')!=3: raise SystemExit('OLD_ROUTE_COUNT_MISMATCH')
text=text.replace(f'http://{old}:3000;',f'http://{new}:3000;')
if text.count(f'http://{new}:3000;')!=3: raise SystemExit('NEW_ROUTE_COUNT_MISMATCH')
path.write_text(text)
PY

cat > "${ROLLBACK_ROOT}/rollback-app.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true
docker update --restart unless-stopped "$OLD_CONTAINER" >/dev/null 2>&1 || true
docker start "$OLD_CONTAINER" >/dev/null
cp "${ROLLBACK_ROOT}/budu.conf.template.pre" "$HOST_TEMPLATE"
docker cp "${ROLLBACK_ROOT}/budu.conf.active.pre" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null
docker exec "${NGINX_CONTAINER}" nginx -t
docker exec "${NGINX_CONTAINER}" nginx -s reload
docker run --rm --user root -e TARGET_SHA="$EXPECTED_OLD_SHA" -v "${APP_DIR}:/target" "$IMAGE" sh -c 'printf "%s\\n" "\$TARGET_SHA" > /target/.current-sha'
EOF
chmod 500 "${ROLLBACK_ROOT}/rollback-app.sh"

docker stop -t 20 "$READONLY" >/dev/null
docker rm "$READONLY" >/dev/null
docker stop -t 20 "$OLD_CONTAINER" >/dev/null
OLD_STOPPED=1
EXTRA_ENV_JSON="$EXTRA_ENV_JSON" python3 "${RELEASE_ROOT}/scripts/clone-production-container.py" \
  "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" preserve writer
docker update --restart unless-stopped "$CANDIDATE" >/dev/null
require_health "$CANDIDATE" "$RELEASE_SHA"
verify_database "$CANDIDATE" "$BASELINE_MIGRATIONS"
[ "$(count_writers "$CANDIDATE")" -eq 1 ]
assert_release_assets "$CANDIDATE"

cp "${WORK_ROOT}/budu.conf.template.candidate" "$HOST_TEMPLATE"
ROUTE_CHANGED=1
docker exec "$NGINX_CONTAINER" sh -c 'envsubst '\''${DOMAIN}'\'' < '"$IN_CONTAINER_TEMPLATE"' > /etc/nginx/conf.d/budu.conf.next && mv /etc/nginx/conf.d/budu.conf.next /etc/nginx/conf.d/budu.conf'
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000;" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker exec "$NGINX_CONTAINER" grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000;" "$ACTIVE_CONFIG")" -eq 3 ]
echo "nginx cutover PASS: ${OLD_CONTAINER} -> ${CANDIDATE}"

# ---------- public smoke ----------
PUBLIC_HEALTH="$(curl -fsS --max-time 10 https://buducandy.cn/api/health)" EXPECTED="$RELEASE_SHA" python3 - <<'PY'
import json, os
value=json.loads(os.environ['PUBLIC_HEALTH'])
if value.get('ok') is not True or value.get('dbOk') is not True or not os.environ['EXPECTED'].startswith(str(value.get('gitSha',''))):
    raise SystemExit('PUBLIC_HEALTH_MISMATCH')
print(json.dumps({'publicHealth':'PASS','gitSha':value.get('gitSha'),'dbOk':value.get('dbOk'),'appVersion':value.get('appVersion')}))
PY

HOME_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://buducandy.cn/)"
[ "$HOME_CODE" = "200" ] || { echo "PUBLIC_HOME_STATUS_${HOME_CODE}" >&2; exit 1; }
PUBLIC_CLAIM_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' -d '{}' https://buducandy.cn/api/v2/sweet-cards/cards/route-probe/claim-url-link)"
case "$PUBLIC_CLAIM_CODE" in 400|401|403) ;; *) echo "PUBLIC_CLAIM_URL_LINK_${PUBLIC_CLAIM_CODE}" >&2; exit 1 ;; esac
echo "public smoke PASS: home=200 claim-url-link=${PUBLIC_CLAIM_CODE}"

if docker logs --tail 300 "$CANDIDATE" 2>&1 | grep -E 'unhandled|uncaught|MODULE_NOT_FOUND|ECONNREFUSED'; then
  echo "CANDIDATE_LOG_ERRORS_FOUND" >&2
  exit 1
fi

docker update --restart no "$OLD_CONTAINER" >/dev/null
write_current_sha "$RELEASE_SHA"
printf '%s\n' "$CANDIDATE" > "${ROLLBACK_ROOT}/new-runtime"
DEPLOY_OK=1
echo "SWEET_CARD_SCHEME_DEPLOY_COMPLETE sha=${RELEASE_SHA} runtime=${CANDIDATE} previous=${OLD_CONTAINER} rollback=${ROLLBACK_ROOT}/rollback-app.sh backup=${ROLLBACK_ROOT}/${PRE_BACKUP} writer=1 env_version=release"

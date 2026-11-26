#!/usr/bin/env bash
# 甜意卡领取链接改 URL Scheme（含前端新界面）生产发布 runbook。
#
# 顺序严格沿用已验证的 /opt/budu/.release/sc-nopass-92178b3/cutover.sh：
#   起候选（standby）→ 容器内 promote 为 active → 本地验证 → 切 nginx →
#   公网验证 → 写 current-sha → 最后停旧容器。
# 不采用「先停旧再起新」：那会造成流量中断，且旧容器重启后停在 standby
# （写入被 503 拦截）、IP 变化让 nginx 命中失效地址直接 502。
#
# 与 sweet-card-availability 的差异（刻意保留的最小集合）：
#   - 本次没有任何 Prisma migration，故不做 migrator / 隔离库演练，改为在
#     preflight 与候选两处断言数据库权威（库名 + migration 数 + failed=0）。
#   - 改动同时含前端产物，smoke 额外断言 dist 品牌文案与新页面 chunk。
#   - 显式注入 WECHAT_URLLINK_ENV_VERSION=release，不依赖 NODE_ENV 隐式推断。
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
BACKUP_CONTAINER="budu-backup-${SHORT_SHA}-sweet-card-scheme"
IMAGE="budu-api:sweet-card-scheme-${SHORT_SHA}"
HOST_TEMPLATE="${APP_DIR}/deploy/nginx/conf.d/budu.conf.template"
ACTIVE_CONFIG="/etc/nginx/conf.d/budu.conf"
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
PHASE=init

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

write_current_sha() {
  docker run --rm --user root \
    -e TARGET_SHA="$1" \
    -v "${APP_DIR}:/target" \
    "$IMAGE" \
    sh -c 'printf "%s\n" "$TARGET_SHA" > /target/.current-sha'
}

find_node_pid() {
  docker exec "$1" sh -c 'for p in /proc/[0-9]*; do q=${p#/proc/}; [ "$q" = "1" ] && continue; grep -qa "server/index.js" "$p/cmdline" 2>/dev/null || continue; grep -qa "^node" "$p/cmdline" 2>/dev/null || continue; echo "$q"; break; done'
}

promote() {
  local pid
  pid="$(find_node_pid "$1" || true)"
  [ -n "$pid" ] || { log "PROMOTE_NO_PID($1)"; return 1; }
  docker exec "$1" sh -c "kill -USR2 $pid" || return 1
  log "promote signal -> $1 pid=$pid"
}

wait_active() {
  local container="$1" expected="$2" body="" i
  for i in $(seq 1 30); do
    body="$(docker exec "$container" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
    if HEALTH_PAYLOAD="$body" EXPECTED="$expected" python3 - <<'PY'
import json, os
try:
    v = json.loads(os.environ.get('HEALTH_PAYLOAD', ''))
    ok = (v.get('ok') is True and v.get('dbOk') is True
          and v.get('runtimeMode') == 'active'
          and os.environ['EXPECTED'].startswith(str(v.get('gitSha', ''))))
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
    then log "candidate active: $(printf '%s' "$body" | head -c 170)"; return 0; fi
    sleep 2
  done
  log "WAIT_ACTIVE_TIMEOUT last=$(printf '%s' "${body:-}" | head -c 200)"
  return 1
}

safe_cleanup() {
  docker rm -f "$BACKUP_CONTAINER" >/dev/null 2>&1 || true
  rm -f "$BUNDLE_PATH"
  rm -rf "$WORK_ROOT"
}

rollback_on_error() {
  local rc=$?
  [ "$rc" -eq 0 ] && { [ "$DEPLOY_OK" -eq 1 ] && safe_cleanup; return; }
  log "FAILED phase=$PHASE rc=$rc -> rollback" >&2
  if [ "$ROUTE_CHANGED" -eq 1 ]; then
    docker cp "${ROLLBACK_ROOT}/budu.conf.active.pre" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null 2>&1 || true
    cp "${ROLLBACK_ROOT}/budu.conf.template.pre" "$HOST_TEMPLATE" 2>/dev/null || true
    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1 || true
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true
    log "nginx restored to $OLD_CONTAINER" >&2
  fi
  if [ "$OLD_STOPPED" -eq 1 ] && [ -n "$OLD_CONTAINER" ]; then
    docker update --restart unless-stopped "$OLD_CONTAINER" >/dev/null 2>&1 || true
    docker start "$OLD_CONTAINER" >/dev/null 2>&1 || true
    sleep 6
    # 旧容器重新以 standby 启动，不 promote 就等于没有写入能力，必须补一次。
    promote "$OLD_CONTAINER" >/dev/null 2>&1 || true
    log "old container restarted+promoted" >&2
  fi
  docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true
  docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  log "ROLLED_BACK public=$(curl -s --max-time 6 https://buducandy.cn/api/health | head -c 140)" >&2
  safe_cleanup
  exit "$rc"
}
trap rollback_on_error EXIT

require_health() {
  local container="$1" expected="$2" payload="" i
  for i in $(seq 1 40); do
    payload="$(docker exec "$container" wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null || true)"
    if HEALTH_PAYLOAD="$payload" EXPECTED="$expected" python3 - <<'PY'
import json, os
try:
    v = json.loads(os.environ.get('HEALTH_PAYLOAD', ''))
    ok = v.get('ok') is True and v.get('dbOk') is True and os.environ['EXPECTED'].startswith(str(v.get('gitSha', '')))
except Exception:
    ok = False
raise SystemExit(0 if ok else 1)
PY
    then return 0; fi
    sleep 2
  done
  log "HEALTH_CHECK_FAILED container=${container} last=${payload}" >&2
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

assert_release_assets() {
  local container="$1" env_version
  docker exec "$container" node --input-type=module -e "
    const m = await import('file:///app/server/sweet-card-url-link.js');
    if (typeof m.createClaimShareLink !== 'function' || typeof m.createClaimUrlScheme !== 'function') {
      console.error('MODULE_EXPORT_MISSING'); process.exit(1);
    }
  " || { log "SWEET_CARD_URL_LINK_MODULE_BROKEN" >&2; return 1; }
  docker exec "$container" sh -c "grep -rl 'A LITTLE SWEETNESS' /app/dist/assets | head -1" | grep -q . \
    || { log "DIST_BRAND_COPY_MISSING" >&2; return 1; }
  docker exec "$container" sh -c "ls /app/dist/assets/SweetCardPage-*.js >/dev/null 2>&1" \
    || { log "DIST_SWEET_CARD_CHUNK_MISSING" >&2; return 1; }
  env_version="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^WECHAT_URLLINK_ENV_VERSION=//p')"
  [ "$env_version" = "release" ] || { log "URLLINK_ENV_VERSION_NOT_RELEASE (${env_version})" >&2; return 1; }
  log "release assets PASS: module + dist brand + SweetCardPage chunk + env_version=release"
}

http_status_of() {
  local container="$1" url="$2" method="${3:-GET}"
  if [ "$method" = "POST" ]; then
    docker exec "$container" sh -c "wget -q -S -O /dev/null --header='Content-Type: application/json' --post-data='{}' '$url' 2>&1 | sed -n 's@^  HTTP/[0-9.]* \([0-9]*\).*@\1@p' | head -1"
  else
    docker exec "$container" sh -c "wget -q -S -O /dev/null '$url' 2>&1 | sed -n 's@^  HTTP/[0-9.]* \([0-9]*\).*@\1@p' | head -1"
  fi
}

assert_runtime_surface() {
  local container="$1" code
  code="$(http_status_of "$container" 'http://127.0.0.1:3000/' GET)"
  [ "$code" = "200" ] || { log "HOME_NOT_SERVED (${code})" >&2; return 1; }
  # 只有 active 才有写能力；standby 会返回 503 常量，探测不到真实挂载情况。
  code="$(http_status_of "$container" 'http://127.0.0.1:3000/api/v2/sweet-cards/cards/route-probe/claim-url-link' POST)"
  case "$code" in
    400|401|403) log "claim-url-link route mounted (${code})" ;;
    404|"") log "CLAIM_URL_LINK_ROUTE_MISSING (${code})" >&2; return 1 ;;
    503) log "CLAIM_URL_LINK_PROBED_ON_STANDBY" >&2; return 1 ;;
    *) log "CLAIM_URL_LINK_ROUTE_UNEXPECTED (${code})" >&2; return 1 ;;
  esac
  log "runtime surface PASS: home=200 claim-url-link=${code}"
}

create_backup() {
  local name="$1"
  docker rm -f "$BACKUP_CONTAINER" >/dev/null 2>&1 || true
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
PHASE=preflight
[ -f "$HOST_TEMPLATE" ] || { log "production nginx template missing" >&2; exit 1; }
docker inspect "$NGINX_CONTAINER" >/dev/null

# 只认主站路由（以 :3000; 结尾）。:3000/api/ 属于另一个 upstream，必须排除。
mapfile -t ROUTE_TARGETS < <(sed -nE 's@.*proxy_pass[[:space:]]+http://([^:/;]+):3000;.*@\1@p' "$HOST_TEMPLATE" | sort -u)
[ "${#ROUTE_TARGETS[@]}" -eq 1 ] || { log "production route authority ambiguous: ${ROUTE_TARGETS[*]:-none}" >&2; exit 1; }
OLD_CONTAINER="${ROUTE_TARGETS[0]}"
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${OLD_CONTAINER}:3000;" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{.State.Running}}')" = true ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_OLD_SHA" ]
require_health "$OLD_CONTAINER" "$EXPECTED_OLD_SHA"
verify_database "$OLD_CONTAINER" "$BASELINE_MIGRATIONS"
[ "$(docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^XIDAN_SWEET_CARD_COMMERCIAL=//p')" = 1 ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^SWEET_CARD_ENABLED=//p')" = 1 ]
OLD_MODE="$(docker exec "$OLD_CONTAINER" wget -qO- http://127.0.0.1:3000/api/health | python3 -c 'import json,sys; print(json.load(sys.stdin).get("runtimeMode",""))')"
[ "$OLD_MODE" = "active" ] || { log "OLD_RUNTIME_NOT_ACTIVE (${OLD_MODE})" >&2; exit 1; }
log "preflight PASS: runtime=${OLD_CONTAINER} sha=${SHORT_SHA} database=budu_bj006 migration=${BASELINE_MIGRATIONS} runtimeMode=active sweet_card=enabled"

# ---------- rollback assets ----------
mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
cp "$HOST_TEMPLATE" "${ROLLBACK_ROOT}/budu.conf.template.pre"
docker exec "$NGINX_CONTAINER" cat "$ACTIVE_CONFIG" > "${ROLLBACK_ROOT}/budu.conf.active.pre"
printf '%s\n' "$EXPECTED_OLD_SHA" > "${ROLLBACK_ROOT}/previous-sha"
printf '%s\n' "$OLD_CONTAINER" > "${ROLLBACK_ROOT}/previous-runtime"
log "rollback assets: $ROLLBACK_ROOT"

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
PHASE=build
# clone-production-container.py 需要固定的 CustomerRequest 收件绑定，缺失会直接
# FileNotFoundError 中止（克隆器不接受空绑定，也不允许在这里改变收件人）。
printf '%s' '{"username":"budu","userId":"dh"}' > "$BINDING_FILE"
chmod 600 "$BINDING_FILE"
BRANCH_REF="$(git bundle list-heads "$BUNDLE_PATH" | head -1 | awk '{print $2}')"
[ -n "$BRANCH_REF" ] || { log "BUNDLE_REF_MISSING" >&2; exit 1; }
git init -q "$RELEASE_ROOT"
git -C "$RELEASE_ROOT" fetch -q "$BUNDLE_PATH" "$BRANCH_REF"
git -C "$RELEASE_ROOT" checkout -q FETCH_HEAD
[ "$(git -C "$RELEASE_ROOT" rev-parse HEAD)" = "$RELEASE_SHA" ]
docker build --label "org.opencontainers.image.revision=${RELEASE_SHA}" -t "$IMAGE" "$RELEASE_ROOT"
log "image built: ${IMAGE}"

# ---------- fresh db backup (no migration, still keep a restore point) ----------
PHASE=backup
PRE_BACKUP="pre-promotion-budu_bj006-m${BASELINE_MIGRATIONS}-sweet-card-scheme.dump"
create_backup "$PRE_BACKUP"
log "pre-promotion M${BASELINE_MIGRATIONS} backup PASS"

# ---------- start candidate (standby, not routed) ----------
PHASE=start-candidate
docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
EXTRA_ENV_JSON="$EXTRA_ENV_JSON" python3 "${RELEASE_ROOT}/scripts/clone-production-container.py" \
  "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" preserve writer
require_health "$CANDIDATE" "$RELEASE_SHA"
verify_database "$CANDIDATE" "$BASELINE_MIGRATIONS"
log "candidate up (standby, unrouted)"

# ---------- promote candidate to active ----------
PHASE=promote-candidate
promote "$CANDIDATE"
wait_active "$CANDIDATE" "$RELEASE_SHA"

PHASE=verify-candidate
assert_release_assets "$CANDIDATE"
assert_runtime_surface "$CANDIDATE"
log "candidate verification PASS (active, unrouted)"

# ---------- switch nginx ----------
PHASE=switch-nginx
docker exec "$NGINX_CONTAINER" sed -i "s|http://${OLD_CONTAINER}:3000|http://${CANDIDATE}:3000|g" "$ACTIVE_CONFIG"
sed -i "s|http://${OLD_CONTAINER}:3000|http://${CANDIDATE}:3000|g" "$HOST_TEMPLATE"
ROUTE_CHANGED=1
docker exec "$NGINX_CONTAINER" nginx -t >/dev/null
docker exec "$NGINX_CONTAINER" nginx -s reload
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000;" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker exec "$NGINX_CONTAINER" grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000;" "$ACTIVE_CONFIG")" -eq 3 ]
log "nginx reloaded -> ${CANDIDATE}"

# ---------- public smoke ----------
PHASE=public-smoke
ok=0
for i in $(seq 1 15); do
  PUB="$(curl -s --max-time 8 https://buducandy.cn/api/health || true)"
  case "$PUB" in
    *"$SHORT_SHA"*) ok=1; log "public on new sha: $(printf '%s' "$PUB" | head -c 180)"; break ;;
  esac
  sleep 4
done
[ "$ok" -eq 1 ] || { log "PUBLIC_STILL_OLD last=$(printf '%s' "${PUB:-}" | head -c 160)" >&2; exit 5; }
HOME_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://buducandy.cn/)"
[ "$HOME_CODE" = "200" ] || { log "PUBLIC_HOME_STATUS_${HOME_CODE}" >&2; exit 1; }
PUBLIC_CLAIM_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' -d '{}' https://buducandy.cn/api/v2/sweet-cards/cards/route-probe/claim-url-link)"
case "$PUBLIC_CLAIM_CODE" in 400|401|403) ;; *) log "PUBLIC_CLAIM_URL_LINK_${PUBLIC_CLAIM_CODE}" >&2; exit 1 ;; esac
log "public smoke PASS: home=${HOME_CODE} claim-url-link=${PUBLIC_CLAIM_CODE}"

# ---------- record sha ----------
PHASE=record-sha
write_current_sha "$RELEASE_SHA"
log "current-sha recorded"

# ---------- stop old (kept for rollback) ----------
PHASE=stop-old
docker update --restart=no "$OLD_CONTAINER" >/dev/null
docker stop -t 30 "$OLD_CONTAINER" >/dev/null
OLD_STOPPED=1
log "old container stopped (kept for rollback)"

cat > "${ROLLBACK_ROOT}/rollback-app.sh" <<RB
#!/usr/bin/env bash
set -Eeuo pipefail
docker exec ${NGINX_CONTAINER} sh -c "cp ${ROLLBACK_ROOT}/budu.conf.active.pre ${ACTIVE_CONFIG}" && docker exec ${NGINX_CONTAINER} nginx -s reload
cp ${ROLLBACK_ROOT}/budu.conf.template.pre ${HOST_TEMPLATE}
docker update --restart unless-stopped ${OLD_CONTAINER} >/dev/null 2>&1 || true
docker start ${OLD_CONTAINER}; sleep 6
pid=\$(docker exec ${OLD_CONTAINER} sh -c 'for p in /proc/[0-9]*; do q=\${p#/proc/}; [ "\$q" = 1 ] && continue; grep -qa "server/index.js" "\$p/cmdline" 2>/dev/null || continue; grep -qa "^node" "\$p/cmdline" 2>/dev/null || continue; echo "\$q"; break; done')
[ -n "\$pid" ] && docker exec ${OLD_CONTAINER} sh -c "kill -USR2 \$pid"
docker stop -t 20 ${CANDIDATE} || true
docker rm -f ${CANDIDATE} || true
printf '%s\n' ${EXPECTED_OLD_SHA} > ${APP_DIR}/.current-sha || true
echo ROLLED_BACK_TO_${EXPECTED_OLD_SHA}
RB
chmod 500 "${ROLLBACK_ROOT}/rollback-app.sh"

# ---------- final verify ----------
PHASE=verify-final
FINAL="$(curl -s --max-time 8 https://buducandy.cn/api/health || true)"
case "$FINAL" in
  *"$SHORT_SHA"*) log "RELEASE_OK sha=${RELEASE_SHA}" ;;
  *) log "FINAL_VERIFY_FAILED last=$(printf '%s' "$FINAL" | head -c 160)" >&2; exit 6 ;;
esac
if docker logs --tail 300 "$CANDIDATE" 2>&1 | grep -E 'unhandled|uncaught|MODULE_NOT_FOUND|ECONNREFUSED'; then
  log "CANDIDATE_LOG_ERRORS_FOUND" >&2
  exit 1
fi
DEPLOY_OK=1
log "SWEET_CARD_SCHEME_DEPLOY_COMPLETE sha=${RELEASE_SHA} runtime=${CANDIDATE} previous=${OLD_CONTAINER} rollback=${ROLLBACK_ROOT}/rollback-app.sh backup=${ROLLBACK_ROOT}/${PRE_BACKUP} env_version=release"

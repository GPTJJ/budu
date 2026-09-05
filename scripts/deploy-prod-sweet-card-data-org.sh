#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 7 ]; then
  echo "usage: $0 BUNDLE CLONER AUDIT RELEASE_SHA EXPECTED_OLD_SHA APP_DIR NGINX_CONTAINER" >&2
  exit 2
fi

BUNDLE_PATH="$1"
CLONER_PATH="$2"
AUDIT_PATH="$3"
RELEASE_SHA="$4"
EXPECTED_OLD_SHA="$5"
APP_DIR="$6"
NGINX_CONTAINER="$7"
SHORT_SHA="${RELEASE_SHA:0:7}"
CANDIDATE="budu-prod-${SHORT_SHA}-sweet-card-data-org"
MIGRATOR="budu-migrate-${SHORT_SHA}-sweet-card-data-org"
BACKUP_CONTAINER="budu-backup-${SHORT_SHA}-sweet-card-data-org"
RESTORE_CONTAINER="budu-restore-${SHORT_SHA}-sweet-card-data-org"
ISOLATED_NETWORK="budu-isolated-${SHORT_SHA}-sweet-card-data-org"
IMAGE="budu-api:sweet-card-data-org-${SHORT_SHA}"
HOST_TEMPLATE="${APP_DIR}/deploy/nginx/conf.d/budu.conf.template"
ACTIVE_CONFIG="/etc/nginx/conf.d/budu.conf"
WORK_ROOT="$(mktemp -d "/dev/shm/budu-sweet-card-data-org-${SHORT_SHA}.XXXXXX")"
ROLLBACK_ROOT="${APP_DIR}/.rollback-assets/sweet-card-data-org-${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
BINDING_FILE="${WORK_ROOT}/recipient-binding.json"
DB_ENV_FILE="${WORK_ROOT}/database.env"
OLD_CONTAINER=""
OLD_STOPPED=0
ROUTE_CHANGED=0
DEPLOY_OK=0

safe_cleanup() {
  if [ -n "$OLD_CONTAINER" ] && docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
    docker exec --user root "$OLD_CONTAINER" rm -f /app/scripts/.audit-sweet-card-production.mjs >/dev/null 2>&1 || true
  fi
  docker rm -f "$BACKUP_CONTAINER" "$RESTORE_CONTAINER" "$MIGRATOR" >/dev/null 2>&1 || true
  docker network rm "$ISOLATED_NETWORK" >/dev/null 2>&1 || true
  rm -f "$BUNDLE_PATH" "$CLONER_PATH" "$AUDIT_PATH" "$0"
  rm -rf "$WORK_ROOT"
}

rollback_on_error() {
  local rc=$?
  if [ "$DEPLOY_OK" -eq 1 ]; then safe_cleanup; return; fi
  echo "SWEET_CARD_DATA_ORG_DEPLOY_ROLLBACK_START" >&2
  if docker inspect "$CANDIDATE" >/dev/null 2>&1; then docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true; fi
  if [ "$OLD_STOPPED" -eq 1 ] && [ -n "$OLD_CONTAINER" ]; then docker start "$OLD_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "$ROUTE_CHANGED" -eq 1 ] && [ -f "${ROLLBACK_ROOT}/budu.conf.template.pre" ]; then
    cp "${ROLLBACK_ROOT}/budu.conf.template.pre" "$HOST_TEMPLATE"
    docker cp "${ROLLBACK_ROOT}/budu.conf.active.pre" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null
    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null
  fi
  printf '%s\n' "$EXPECTED_OLD_SHA" > "${APP_DIR}/.current-sha"
  safe_cleanup
  echo "SWEET_CARD_DATA_ORG_DEPLOY_ROLLBACK_COMPLETE" >&2
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
  return 1
}

verify_database() {
  local container="$1" expected="$2"
  docker exec -i "$container" env EXPECTED_MIGRATIONS="$expected" node --input-type=module - <<'NODE'
import { PrismaClient } from '@prisma/client'
const prisma=new PrismaClient()
try {
  const [db,migrations,failed]=await Promise.all([
    prisma.$queryRawUnsafe('SELECT current_database() AS name'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'),
    prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE started_at IS NOT NULL AND finished_at IS NULL AND rolled_back_at IS NULL'),
  ])
  if(db[0].name!=='budu_bj006'||migrations[0].count!==Number(process.env.EXPECTED_MIGRATIONS)||failed[0].count!==0) throw new Error('DATABASE_AUTHORITY_MISMATCH')
  console.log(JSON.stringify({database:db[0].name,migrations:migrations[0].count,failed:failed[0].count}))
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

audit_container() {
  local container="$1"
  docker cp "$AUDIT_PATH" "${container}:/app/scripts/.audit-sweet-card-production.mjs" >/dev/null
  docker exec "$container" node /app/scripts/.audit-sweet-card-production.mjs
  docker exec --user root "$container" rm -f /app/scripts/.audit-sweet-card-production.mjs >/dev/null
}

compare_business_facts() {
  BEFORE_JSON="$1" AFTER_JSON="$2" python3 - <<'PY'
import json, os
before=json.loads(os.environ['BEFORE_JSON']); after=json.loads(os.environ['AFTER_JSON'])
for key in ('batches','counts','totals','byPurpose','authorizedOperators','economicDigest','paymentDigest'):
    if before.get(key)!=after.get(key): raise SystemExit(f'BUSINESS_FACT_DRIFT_{key}')
if after.get('archived') != 0: raise SystemExit('UNEXPECTED_AUTOMATIC_ARCHIVE')
print(json.dumps({'economicFacts':'UNCHANGED','economicDigest':after['economicDigest'],'ledgerDelta':after['totals']['delta'],'archived':after['archived']}))
PY
}

create_backup() {
  local name="$1"
  docker create --name "$BACKUP_CONTAINER" --user "$(id -u):$(id -g)" --network "$COMMON_NETWORK" --env-file "$DB_ENV_FILE" -e BACKUP_NAME="$name" -v "${ROLLBACK_ROOT}:/backup" postgres:16-alpine \
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

[ -f "$HOST_TEMPLATE" ] || { echo "production nginx template missing" >&2; exit 1; }
docker inspect "$NGINX_CONTAINER" >/dev/null
mapfile -t ROUTE_TARGETS < <(sed -nE 's@.*proxy_pass[[:space:]]+http://([^:/;]+):3000.*@\1@p' "$HOST_TEMPLATE" | sort -u)
[ "${#ROUTE_TARGETS[@]}" -eq 1 ] || { echo "production route authority ambiguous" >&2; exit 1; }
OLD_CONTAINER="${ROUTE_TARGETS[0]}"
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${OLD_CONTAINER}:3000" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{.State.Running}}')" = true ]
[ "$(docker inspect "$OLD_CONTAINER" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$EXPECTED_OLD_SHA" ]
[ "$(count_writers "$OLD_CONTAINER")" -eq 1 ]
require_health "$OLD_CONTAINER" "$EXPECTED_OLD_SHA"
verify_database "$OLD_CONTAINER" 65
[ "$(docker inspect "$OLD_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^XIDAN_SWEET_CARD_COMMERCIAL=//p')" = 1 ]
echo "production preflight PASS: runtime=${OLD_CONTAINER} database=budu_bj006 migration=65 writer=1 commercial=enabled"

printf '%s' '{"username":"budu","userId":"dh"}' > "$BINDING_FILE"
chmod 600 "$BINDING_FILE"
git clone -q "$BUNDLE_PATH" "${WORK_ROOT}/release"
[ "$(git -C "${WORK_ROOT}/release" rev-parse HEAD)" = "$RELEASE_SHA" ]
docker build --label "org.opencontainers.image.revision=${RELEASE_SHA}" -t "$IMAGE" "${WORK_ROOT}/release"

COMMON_NETWORK="$(CURRENT="$OLD_CONTAINER" NGINX="$NGINX_CONTAINER" python3 - <<'PY'
import json, os, subprocess
def networks(name): return set(json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]['NetworkSettings']['Networks'])
common=sorted((networks(os.environ['CURRENT']) & networks(os.environ['NGINX']))-{'bridge','host','none'})
if len(common)!=1: raise SystemExit(f'NETWORK_AUTHORITY_{len(common)}')
print(common[0])
PY
)"

mkdir -p "$ROLLBACK_ROOT"
chmod 700 "$ROLLBACK_ROOT"
cp "$HOST_TEMPLATE" "${ROLLBACK_ROOT}/budu.conf.template.pre"
docker cp "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" "${ROLLBACK_ROOT}/budu.conf.active.pre" >/dev/null
printf '%s\n' "$EXPECTED_OLD_SHA" > "${ROLLBACK_ROOT}/previous-sha"

OLD_CONTAINER="$OLD_CONTAINER" DB_ENV_FILE="$DB_ENV_FILE" python3 - <<'PY'
import json, os, pathlib, subprocess, urllib.parse
source=json.loads(subprocess.check_output(['docker','inspect',os.environ['OLD_CONTAINER']],text=True))[0]
value=next((line.split('=',1)[1] for line in source['Config'].get('Env',[]) if line.startswith('DATABASE_URL=')),'')
parts=urllib.parse.urlsplit(value)
if parts.path!='/budu_bj006': raise SystemExit('BACKUP_DATABASE_AUTHORITY_MISMATCH')
uri=urllib.parse.urlunsplit((parts.scheme,parts.netloc,parts.path,'',''))
path=pathlib.Path(os.environ['DB_ENV_FILE']); path.write_text(f'PGURI={uri}\n'); path.chmod(0o600)
PY

BEFORE_JSON="$(audit_container "$OLD_CONTAINER")"
BEFORE_BATCH_COUNT="$(BEFORE_JSON="$BEFORE_JSON" python3 -c 'import json,os; print(len(json.loads(os.environ["BEFORE_JSON"])["batches"]))')"
BEFORE_FILE="${ROLLBACK_ROOT}/production-before-m66.json"
printf '%s\n' "$BEFORE_JSON" > "$BEFORE_FILE"
chmod 400 "$BEFORE_FILE"
PRE_BACKUP="pre-migration66-budu_bj006-m65.dump"
create_backup "$PRE_BACKUP"
echo "fresh pre-M66 backup PASS"

docker network create "$ISOLATED_NETWORK" >/dev/null
docker run -d --name "$RESTORE_CONTAINER" --network "$ISOLATED_NETWORK" \
  -e POSTGRES_USER=restore -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=budu_sc_data_org_isolated \
  -v "${ROLLBACK_ROOT}:/backup:ro" postgres:16-alpine >/dev/null
for _attempt in $(seq 1 30); do docker exec "$RESTORE_CONTAINER" pg_isready -U restore -d budu_sc_data_org_isolated >/dev/null 2>&1 && break; sleep 1; done
docker exec "$RESTORE_CONTAINER" pg_isready -U restore -d budu_sc_data_org_isolated >/dev/null
docker exec "$RESTORE_CONTAINER" pg_restore -U restore -d budu_sc_data_org_isolated --no-owner "/backup/${PRE_BACKUP}"
ISOLATED_DATABASE_URL="postgresql://restore:restore@${RESTORE_CONTAINER}:5432/budu_sc_data_org_isolated"
docker run --rm --network "$ISOLATED_NETWORK" -e DATABASE_URL="$ISOLATED_DATABASE_URL" "$IMAGE" npx prisma migrate deploy
ISOLATED_IDENTITY="$(docker exec "$RESTORE_CONTAINER" psql -U restore -d budu_sc_data_org_isolated -Atc 'SELECT current_database() || '\''|'\'' || (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || '\''|'\'' || (SELECT count(*) FROM "_prisma_migrations" WHERE started_at IS NOT NULL AND finished_at IS NULL AND rolled_back_at IS NULL) || '\''|'\'' || (SELECT count(*) FROM "sweet_card_batches" WHERE "archived_at" IS NOT NULL);')"
[ "$ISOLATED_IDENTITY" = "budu_sc_data_org_isolated|66|0|0" ]
docker run --rm --network "$ISOLATED_NETWORK" \
  -e DATABASE_URL="$ISOLATED_DATABASE_URL" \
  -e JWT_SECRET=isolated-sweet-card-data-organization-secret \
  -e SWEET_CARD_ENABLED=1 -e XIDAN_SWEET_CARD_COMMERCIAL=1 \
  -e SWEET_CARD_CREDENTIAL_KEY="$(printf '11%.0s' $(seq 1 32))" \
  "$IMAGE" node scripts/test-sweet-card-data-organization-restored.mjs
docker rm -f "$RESTORE_CONTAINER" >/dev/null
docker network rm "$ISOLATED_NETWORK" >/dev/null
echo "restored canonical M65 -> M66 migration and real API integration PASS"

docker inspect "$MIGRATOR" >/dev/null 2>&1 && { echo "migrator name already exists" >&2; exit 1; }
python3 "$CLONER_PATH" "$OLD_CONTAINER" "$MIGRATOR" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" disabled migration
[ "$(docker wait "$MIGRATOR")" = 0 ] || { docker logs --tail 100 "$MIGRATOR"; exit 1; }
docker rm "$MIGRATOR" >/dev/null
verify_database "$OLD_CONTAINER" 66
AFTER_MIGRATION_JSON="$(audit_container "$OLD_CONTAINER")"
compare_business_facts "$BEFORE_JSON" "$AFTER_MIGRATION_JSON"
echo "Migration 66 additive production rehearsal PASS"

docker inspect "$CANDIDATE" >/dev/null 2>&1 && { echo "candidate name already exists" >&2; exit 1; }
python3 "$CLONER_PATH" "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" disabled readonly
require_health "$CANDIDATE" "$RELEASE_SHA"
verify_database "$CANDIDATE" 66
[ "$(count_writers "$OLD_CONTAINER")" -eq 1 ]
docker exec "$CANDIDATE" env EXPECTED_RELEASE_SHA="$RELEASE_SHA" node /app/scripts/verify-sweet-card-data-org-production.mjs
echo "unrouted readonly candidate smoke PASS"

cp "$HOST_TEMPLATE" "${WORK_ROOT}/budu.conf.template.candidate"
OLD_CONTAINER="$OLD_CONTAINER" CANDIDATE="$CANDIDATE" TEMPLATE="${WORK_ROOT}/budu.conf.template.candidate" python3 - <<'PY'
import os, pathlib
path=pathlib.Path(os.environ['TEMPLATE']); old=os.environ['OLD_CONTAINER']; new=os.environ['CANDIDATE']; text=path.read_text()
if text.count(f'http://{old}:3000')!=3: raise SystemExit('OLD_ROUTE_COUNT_MISMATCH')
text=text.replace(f'http://{old}:3000',f'http://{new}:3000')
if text.count(f'http://{new}:3000')!=3: raise SystemExit('NEW_ROUTE_COUNT_MISMATCH')
path.write_text(text)
PY

docker stop -t 20 "$CANDIDATE" >/dev/null
docker rm "$CANDIDATE" >/dev/null
docker stop -t 20 "$OLD_CONTAINER" >/dev/null
OLD_STOPPED=1
python3 "$CLONER_PATH" "$OLD_CONTAINER" "$CANDIDATE" "$IMAGE" "$RELEASE_SHA" "$BINDING_FILE" "$COMMON_NETWORK" preserve writer
docker update --restart unless-stopped "$CANDIDATE" >/dev/null
require_health "$CANDIDATE" "$RELEASE_SHA"
verify_database "$CANDIDATE" 66
[ "$(count_writers "$CANDIDATE")" -eq 1 ]

cp "${WORK_ROOT}/budu.conf.template.candidate" "$HOST_TEMPLATE"
ROUTE_CHANGED=1
docker exec "$NGINX_CONTAINER" sh -c 'envsubst '\''${DOMAIN}'\'' < /etc/nginx/budu/budu.conf.template > /etc/nginx/conf.d/budu.conf.next && mv /etc/nginx/conf.d/budu.conf.next /etc/nginx/conf.d/budu.conf'
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
[ "$(grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000" "$HOST_TEMPLATE")" -eq 3 ]
[ "$(docker exec "$NGINX_CONTAINER" grep -Ec "proxy_pass[[:space:]]+http://${CANDIDATE}:3000" "$ACTIVE_CONFIG")" -eq 3 ]

PUBLIC_HEALTH="$(curl -fsS --max-time 10 https://buducandy.cn/api/health)" EXPECTED="$RELEASE_SHA" python3 - <<'PY'
import json, os
value=json.loads(os.environ['PUBLIC_HEALTH'])
if value.get('ok') is not True or value.get('dbOk') is not True or not os.environ['EXPECTED'].startswith(str(value.get('gitSha',''))): raise SystemExit('PUBLIC_HEALTH_MISMATCH')
print(json.dumps({'publicHealth':'PASS','gitSha':value.get('gitSha'),'dbOk':value.get('dbOk')}))
PY
docker exec "$CANDIDATE" env EXPECTED_RELEASE_SHA="$RELEASE_SHA" node /app/scripts/verify-sweet-card-data-org-production.mjs | tee "${ROLLBACK_ROOT}/production-verification.json"
chmod 400 "${ROLLBACK_ROOT}/production-verification.json"
FINAL_JSON="$(audit_container "$CANDIDATE")"
compare_business_facts "$BEFORE_JSON" "$FINAL_JSON"
printf '%s\n' "$FINAL_JSON" > "${ROLLBACK_ROOT}/production-after-m66.json"
chmod 400 "${ROLLBACK_ROOT}/production-after-m66.json"

POST_BACKUP="current-canonical-budu_bj006-m66-data-organization.dump"
create_backup "$POST_BACKUP"
docker run -d --name "$RESTORE_CONTAINER" -e POSTGRES_USER=restore -e POSTGRES_PASSWORD=restore -e POSTGRES_DB=budu_restore_m66 -v "${ROLLBACK_ROOT}:/backup:ro" postgres:16-alpine >/dev/null
for _attempt in $(seq 1 30); do docker exec "$RESTORE_CONTAINER" pg_isready -U restore -d budu_restore_m66 >/dev/null 2>&1 && break; sleep 1; done
docker exec "$RESTORE_CONTAINER" pg_isready -U restore -d budu_restore_m66 >/dev/null
docker exec "$RESTORE_CONTAINER" pg_restore -U restore -d budu_restore_m66 --no-owner "/backup/${POST_BACKUP}"
RESTORE_RESULT="$(docker exec "$RESTORE_CONTAINER" psql -U restore -d budu_restore_m66 -Atc 'SELECT current_database() || '\''|'\'' || (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || '\''|'\'' || (SELECT count(*) FROM "_prisma_migrations" WHERE started_at IS NOT NULL AND finished_at IS NULL AND rolled_back_at IS NULL) || '\''|'\'' || (SELECT count(*) FROM "sweet_card_batches") || '\''|'\'' || (SELECT count(*) FROM "sweet_card_batches" WHERE "archived_at" IS NOT NULL);')"
[ "$RESTORE_RESULT" = "budu_restore_m66|66|0|${BEFORE_BATCH_COUNT}|0" ]
docker rm -f "$RESTORE_CONTAINER" >/dev/null

BACKUP_SHA="$(sha256sum "${ROLLBACK_ROOT}/${POST_BACKUP}" | cut -d ' ' -f1)"
RESTORE_LISTING="$(docker run --rm -v "${ROLLBACK_ROOT}:/backup:ro" postgres:16-alpine pg_restore --list "/backup/${POST_BACKUP}" | wc -l | tr -d ' ')"
cat > "${ROLLBACK_ROOT}/CURRENT_CANONICAL_RESTORE_ARTIFACT" <<EOF
path=${ROLLBACK_ROOT}/${POST_BACKUP}
sha256=${BACKUP_SHA}
restore_listing_entries=${RESTORE_LISTING}
restore_identity=${RESTORE_RESULT}
EOF
chmod 400 "${ROLLBACK_ROOT}/CURRENT_CANONICAL_RESTORE_ARTIFACT"

cat > "${ROLLBACK_ROOT}/rollback-app.sh" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
docker stop -t 20 "$CANDIDATE" >/dev/null 2>&1 || true
docker start "$OLD_CONTAINER" >/dev/null
cp "${ROLLBACK_ROOT}/budu.conf.template.pre" "$HOST_TEMPLATE"
docker cp "${ROLLBACK_ROOT}/budu.conf.active.pre" "${NGINX_CONTAINER}:${ACTIVE_CONFIG}" >/dev/null
docker exec "$NGINX_CONTAINER" nginx -t
docker exec "$NGINX_CONTAINER" nginx -s reload
printf '%s\\n' "$EXPECTED_OLD_SHA" > "${APP_DIR}/.current-sha"
EOF
chmod 500 "${ROLLBACK_ROOT}/rollback-app.sh"
printf '%s\n' "$RELEASE_SHA" > "${APP_DIR}/.current-sha"
DEPLOY_OK=1
echo "SWEET_CARD_DATA_ORGANIZATION_1_0_COMPLETE sha=${RELEASE_SHA} runtime=${CANDIDATE} migration=66 backup=${ROLLBACK_ROOT}/${POST_BACKUP} backup_sha256=${BACKUP_SHA} restore_listing=${RESTORE_LISTING} writer=1"

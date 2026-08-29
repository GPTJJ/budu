#!/usr/bin/env bash
# 远程部署脚本：由 GitHub Actions 调用（也可手动执行）
# 用法：bash scripts/deploy-remote.sh <HOST> <USER> <APP_DIR> <GIT_SHA> [ENV]
set -euo pipefail

HOST="$1"
USER="$2"
APP_DIR="$3"
SHA="$4"
ENV="${5:-test}"
case "$ENV" in
  dev|test|prod) ;;
  *) echo "==> ENV 需为 dev/test/prod，当前：$ENV" && exit 1 ;;
esac
ENV_FILE=".env.production"
if [ "$ENV" = "test" ]; then ENV_FILE=".env.test"; fi
if [ "$ENV" = "dev" ]; then ENV_FILE=".env.dev"; fi

SSH_ARGS=(ssh -o BatchMode=yes -o ConnectTimeout=15)
SCP_ARGS=(scp -o BatchMode=yes -o ConnectTimeout=15)
run_remote() {
  "${SSH_ARGS[@]}" "$USER@$HOST" "cd '$APP_DIR' && $1"
}

# ProductGroup is an additive successor to the verified POS category UI release.
# Production remains on the authority-aware blue/green deployment path below.
if [ "$ENV" = "prod" ]; then
  EXPECTED_OLD_SHA="8d2d20688de4ca3a358c83e602b2559b46512a4b"
  [ "$(git rev-parse HEAD)" = "$SHA" ] || { echo "==> 本地 release SHA 不一致"; exit 1; }

  TEST_DB_CONTAINER="budu-product-group-test-${GITHUB_RUN_ID:-$$}"
  TEST_DB_PORT=""
  PROD_BUNDLE="$(mktemp "${TMPDIR:-/tmp}/budu-product-group.XXXXXX")"
  cleanup_product_group_release() {
    docker rm -f "$TEST_DB_CONTAINER" >/dev/null 2>&1 || true
    rm -f "$PROD_BUNDLE"
  }
  trap cleanup_product_group_release EXIT

  echo "==> 启动一次性 PostgreSQL 16 回归环境"
  docker run -d --name "$TEST_DB_CONTAINER" \
    -e POSTGRES_USER=budu_test \
    -e POSTGRES_PASSWORD=budu_test_password \
    -e POSTGRES_DB=budu_test \
    -p 127.0.0.1::5432 \
    postgres:16-alpine >/dev/null
  for _attempt in $(seq 1 30); do
    if docker exec "$TEST_DB_CONTAINER" pg_isready -U budu_test -d budu_test >/dev/null 2>&1; then break; fi
    sleep 2
  done
  docker exec "$TEST_DB_CONTAINER" pg_isready -U budu_test -d budu_test >/dev/null
  TEST_DB_PORT="$(docker port "$TEST_DB_CONTAINER" 5432/tcp | awk -F: 'NR == 1 { print $NF }')"
  [ -n "$TEST_DB_PORT" ] || { echo "==> 无法解析隔离测试数据库端口"; exit 1; }
  TEST_DATABASE_URL="postgresql://budu_test:budu_test_password@127.0.0.1:${TEST_DB_PORT}/budu_test?schema=public"

  echo "==> Node 22：Developer Safe Delete / POS / Payment + Refund / Transfer / Partner / WebKit / build 回归"
  docker run --rm --network host --ipc=host \
    -e TEST_DATABASE_URL="$TEST_DATABASE_URL" \
    -e DATABASE_URL="$TEST_DATABASE_URL" \
    -e NODE_ENV=test \
    -e APP_ENV=test \
    -e CI=1 \
    -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    -v "$PWD:/work" \
    -w /work \
    mcr.microsoft.com/playwright:v1.55.0-noble \
    bash -lc 'npm ci && npx prisma migrate deploy && node --test scripts/test-developer-safe-delete-contract.mjs scripts/test-account-permissions.mjs scripts/test-product-group-migration-rehearsal.mjs scripts/test-mailing-qr-migration-rehearsal.mjs scripts/test-partner-supply-migration-rehearsal.mjs scripts/test-product-category-migration-rehearsal.mjs scripts/test-product-material-migration-rehearsal.mjs scripts/test-store-transfer-migration-rehearsal.mjs scripts/test-unified-product-center-migration-rehearsal.mjs && node scripts/test-developer-safe-delete-workflow.mjs && node scripts/test-product-group-workflow.mjs && node scripts/test-unified-product-center-workflow.mjs && node --test scripts/test-product-image-performance.mjs scripts/test-pos-core.mjs scripts/test-payment-foundation.mjs scripts/test-payment-reconciliation.mjs scripts/test-store-transfer-draft.mjs scripts/test-partner-supply-contract.mjs scripts/test-partner-supply-workflow.mjs && npx playwright test tests/product-center.spec.mjs tests/pos-ipad.spec.mjs tests/product-material.spec.mjs tests/partner-supply.spec.mjs tests/transfer.spec.mjs tests/mailing.spec.mjs tests/invoice.spec.mjs tests/settings.spec.mjs && npm run build'
  git diff --check
  docker rm -f "$TEST_DB_CONTAINER" >/dev/null

  echo "==> 上传 exact bundle 与 authority-aware deployment helpers"
  git bundle create "$PROD_BUNDLE" HEAD
  REMOTE_PREFIX="/dev/shm/budu-product-group-${SHA}"
  "${SCP_ARGS[@]}" "$PROD_BUNDLE" "$USER@$HOST:${REMOTE_PREFIX}.bundle"
  "${SCP_ARGS[@]}" scripts/resolve-customer-request-wecom-recipient.mjs "$USER@$HOST:${REMOTE_PREFIX}.resolver.mjs"
  "${SCP_ARGS[@]}" scripts/clone-production-container.py "$USER@$HOST:${REMOTE_PREFIX}.clone.py"
  "${SCP_ARGS[@]}" scripts/deploy-prod-product-category-summary.sh "$USER@$HOST:${REMOTE_PREFIX}.deploy.sh"
  "${SSH_ARGS[@]}" "$USER@$HOST" bash "${REMOTE_PREFIX}.deploy.sh" \
    "${REMOTE_PREFIX}.bundle" \
    "${REMOTE_PREFIX}.resolver.mjs" \
    "${REMOTE_PREFIX}.clone.py" \
    "$SHA" \
    "$EXPECTED_OLD_SHA" \
    "$APP_DIR" \
    "budu-nginx-1"
  exit 0
fi

# 北京生产已使用独立权威 PostgreSQL 网络。旧 docker compose 流程会把 api 接到
# compose 自带 postgres，曾导致人员/门店数据错乱；非专用发布继续硬阻断。

wait_healthy() {
  local tries="$1"
  for i in $(seq 1 "$tries"); do
    if run_remote "docker compose exec -T api wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

verify_frontend_path() {
  local tries="$1"
  local api_hash=""
  local nginx_hash=""
  for i in $(seq 1 "$tries"); do
    api_hash="$(run_remote "docker compose exec -T api sha256sum /app/dist/index.html | cut -d ' ' -f1" 2>/dev/null || true)"
    nginx_hash="$(run_remote "docker compose exec -T nginx wget -T 5 -qO- http://api:3000/ | sha256sum | cut -d ' ' -f1" 2>/dev/null || true)"
    if [ -n "$api_hash" ] && [ "$api_hash" = "$nginx_hash" ]; then
      echo "==> 前端链路校验通过：$api_hash"
      return 0
    fi
    sleep 2
  done
  echo "==> 前端链路校验失败：api=${api_hash:-无} nginx=${nginx_hash:-无}"
  return 1
}

echo "==> 部署目标：$USER@$HOST:$APP_DIR（$SHA，env=$ENV）"
PREV="$(run_remote "cat .current-sha 2>/dev/null || true")"
echo "==> 当前线上版本：${PREV:-（无记录）}"

BUNDLE_PATH="/tmp/budu-release-$SHA.bundle"
LOCAL_BUNDLE="$(mktemp "${TMPDIR:-/tmp}/budu-release.XXXXXX")"
trap 'rm -f "$LOCAL_BUNDLE"' EXIT
if [ "$(git rev-parse HEAD)" = "$SHA" ]; then
  echo "==> 生成并上传离线发布包"
  git bundle create "$LOCAL_BUNDLE" HEAD
  "${SCP_ARGS[@]}" "$LOCAL_BUNDLE" "$USER@$HOST:$BUNDLE_PATH"
else
  echo "==> 本地 HEAD 与目标版本不一致，跳过离线发布包"
fi

BACKUP_NAME="predeploy-${SHA}-$(date -u +%Y%m%dT%H%M%SZ).sql"
echo "==> 迁移前备份 PostgreSQL：~/.budu-backups/$BACKUP_NAME"
run_remote "mkdir -p \"\$HOME/.budu-backups\" && docker compose exec -T postgres sh -lc 'pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' > \"\$HOME/.budu-backups/$BACKUP_NAME\" && test -s \"\$HOME/.budu-backups/$BACKUP_NAME\" && chmod 600 \"\$HOME/.budu-backups/$BACKUP_NAME\""
echo "==> PostgreSQL 备份完成"

FETCHED=0
if run_remote "test -s '$BUNDLE_PATH'"; then
  echo "==> 使用 Actions 上传的离线发布包"
  run_remote "git fetch '$BUNDLE_PATH' HEAD"
  FETCHED=1
else
  echo "==> 未找到离线发布包，改从 GitHub 拉取（网络波动时最多重试 4 次）..."
  for attempt in 1 2 3 4; do
    if run_remote "git -c http.version=HTTP/1.1 fetch origin main"; then
      FETCHED=1
      break
    fi
    if [ "$attempt" -lt 4 ]; then
      echo "==> 第 $attempt 次拉取失败，15 秒后重试..."
      sleep 15
    fi
  done
fi

if [ "$FETCHED" -ne 1 ]; then
  echo "==> 无法获取发布代码，保留当前线上版本"
  exit 1
fi
run_remote "git checkout --force '$SHA'"
run_remote "if grep -q '^APP_ENV=' .env 2>/dev/null; then sed -i \"s/^APP_ENV=.*/APP_ENV=${ENV}/\" .env; else echo \"APP_ENV=${ENV}\" >> .env; fi"
run_remote "if grep -q '^GIT_SHA=' .env 2>/dev/null; then sed -i \"s/^GIT_SHA=.*/GIT_SHA=${SHA}/\" .env; else echo \"GIT_SHA=${SHA}\" >> .env; fi"
run_remote "if grep -q '^ENV_FILE=' .env 2>/dev/null; then sed -i \"s|^ENV_FILE=.*|ENV_FILE=${ENV_FILE}|\" .env; else echo \"ENV_FILE=${ENV_FILE}\" >> .env; fi"
run_remote "docker compose up -d --build"
run_remote "docker compose up -d --no-deps --force-recreate nginx"
run_remote "rm -f '$BUNDLE_PATH'"

echo "==> 等待健康检查（最多 90 秒）..."
if wait_healthy 18 && verify_frontend_path 12; then
  echo "==> 健康检查通过"
  run_remote "echo '$SHA' > .current-sha"
  echo "==> 部署完成：$SHA"
  exit 0
fi

echo "==> 健康检查失败，开始回滚"
if [ -n "$PREV" ]; then
  run_remote "git checkout --force '$PREV'"
  run_remote "docker compose up -d --build"
  run_remote "docker compose up -d --no-deps --force-recreate nginx"
  if wait_healthy 12 && verify_frontend_path 12; then
    run_remote "echo '$PREV' > .current-sha"
    echo "==> 已回滚到 $PREV"
    exit 1
  fi
fi

echo "==> 回滚也失败（或没有上一版本），请登录服务器手动排查："
echo "    ssh $USER@$HOST && cd $APP_DIR && docker compose ps && docker compose logs --tail=100 api"
exit 1

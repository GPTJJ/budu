#!/usr/bin/env bash
# 远程部署脚本：由 GitHub Actions 调用（也可手动执行）
# 用法：bash scripts/deploy-remote.sh <HOST> <USER> <APP_DIR> <GIT_SHA>
set -euo pipefail

HOST="$1"
USER="$2"
APP_DIR="$3"
SHA="$4"

SSH_ARGS=(ssh -o BatchMode=yes -o ConnectTimeout=15)
SCP_ARGS=(scp -o BatchMode=yes -o ConnectTimeout=15)
run_remote() {
  "${SSH_ARGS[@]}" "$USER@$HOST" "cd '$APP_DIR' && $1"
}

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
    nginx_hash="$(run_remote "docker compose exec -T nginx wget --no-check-certificate -qO- https://127.0.0.1/ | sha256sum | cut -d ' ' -f1" 2>/dev/null || true)"
    if [ -n "$api_hash" ] && [ "$api_hash" = "$nginx_hash" ]; then
      echo "==> 前端链路校验通过：$api_hash"
      return 0
    fi
    sleep 2
  done
  echo "==> 前端链路校验失败：api=${api_hash:-无} nginx=${nginx_hash:-无}"
  return 1
}

echo "==> 部署目标：$USER@$HOST:$APP_DIR（$SHA）"
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
run_remote "docker compose up -d --build"
run_remote "docker compose up -d --force-recreate nginx"
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
  run_remote "docker compose up -d --force-recreate nginx"
  if wait_healthy 12 && verify_frontend_path 12; then
    run_remote "echo '$PREV' > .current-sha"
    echo "==> 已回滚到 $PREV"
    exit 1
  fi
fi

echo "==> 回滚也失败（或没有上一版本），请登录服务器手动排查："
echo "    ssh $USER@$HOST && cd $APP_DIR && docker compose ps && docker compose logs --tail=100 api"
exit 1

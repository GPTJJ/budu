#!/usr/bin/env bash
# 远程部署脚本：由 GitHub Actions 调用（也可手动执行）
# 用法：bash scripts/deploy-remote.sh <HOST> <USER> <APP_DIR> <GIT_SHA>
set -euo pipefail

HOST="$1"
USER="$2"
APP_DIR="$3"
SHA="$4"

SSH_ARGS=(ssh -o BatchMode=yes -o ConnectTimeout=15)
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

echo "==> 部署目标：$USER@$HOST:$APP_DIR（$SHA）"
PREV="$(run_remote "cat .current-sha 2>/dev/null || true")"
echo "==> 当前线上版本：${PREV:-（无记录）}"

BACKUP_NAME="predeploy-${SHA}-$(date -u +%Y%m%dT%H%M%SZ).sql"
echo "==> 迁移前备份 PostgreSQL：backups/pg/$BACKUP_NAME"
run_remote "mkdir -p backups/pg && docker compose exec -T postgres sh -lc 'pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' > 'backups/pg/$BACKUP_NAME' && test -s 'backups/pg/$BACKUP_NAME'"
echo "==> PostgreSQL 备份完成"

echo "==> 拉取 GitHub 最新代码（网络波动时最多重试 4 次）..."
FETCHED=0
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

if [ "$FETCHED" -ne 1 ]; then
  echo "==> 无法从 GitHub 拉取代码，保留当前线上版本"
  exit 1
fi
run_remote "git checkout --force '$SHA'"
run_remote "docker compose up -d --build"

echo "==> 等待健康检查（最多 90 秒）..."
if wait_healthy 18; then
  echo "==> 健康检查通过"
  run_remote "echo '$SHA' > .current-sha"
  echo "==> 部署完成：$SHA"
  exit 0
fi

echo "==> 健康检查失败，开始回滚"
if [ -n "$PREV" ]; then
  run_remote "git checkout --force '$PREV'"
  run_remote "docker compose up -d --build"
  if wait_healthy 12; then
    run_remote "echo '$PREV' > .current-sha"
    echo "==> 已回滚到 $PREV"
    exit 1
  fi
fi

echo "==> 回滚也失败（或没有上一版本），请登录服务器手动排查："
echo "    ssh $USER@$HOST && cd $APP_DIR && docker compose ps && docker compose logs --tail=100 api"
exit 1

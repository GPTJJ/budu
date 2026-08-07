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

run_remote "git fetch origin main"
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

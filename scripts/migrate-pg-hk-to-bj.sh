#!/usr/bin/env bash
# PostgreSQL：香港(测试) → 北京(生产) 迁移脚本
# 默认只打印将执行的命令（dry-run）；加 --apply 才真正执行。
# 用法：
#   bash scripts/migrate-pg-hk-to-bj.sh <HK_HOST> <HK_USER> <HK_APP_DIR> <BJ_HOST> <BJ_USER> <BJ_APP_DIR> [--apply]
set -euo pipefail

if [ "$#" -lt 6 ]; then
  echo "用法：$0 <HK_HOST> <HK_USER> <HK_APP_DIR> <BJ_HOST> <BJ_USER> <BJ_APP_DIR> [--apply]"
  exit 1
fi

HK_HOST="$1"; HK_USER="$2"; HK_APP_DIR="$3"
BJ_HOST="$4"; BJ_USER="$5"; BJ_APP_DIR="$6"
APPLY=0
if [ "${7:-}" = "--apply" ]; then APPLY=1; fi

DUMP_NAME="budu-hk-pg-$(date -u +%Y%m%dT%H%M%SZ).sql"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=15"

run_hk() { $SSH "$HK_USER@$HK_HOST" "cd '$HK_APP_DIR' && $1"; }
run_bj() { $SSH "$BJ_USER@$BJ_HOST" "cd '$BJ_APP_DIR' && $1"; }

step() { echo "==> $1"; }

step "1/4 香港导出 PostgreSQL"
CMD_HK_DUMP="cd '$HK_APP_DIR' && docker compose exec -T postgres sh -lc 'pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' > ~/$DUMP_NAME"
echo "  ssh $HK_USER@$HK_HOST $CMD_HK_DUMP"

step "2/4 拷贝到北京服务器"
CMD_SCP="scp -o BatchMode=yes $HK_USER@$HK_HOST:$DUMP_NAME /tmp/$DUMP_NAME"
echo "  $CMD_SCP"

step "3/4 北京恢复 PostgreSQL（会覆盖北京同名库，迁移前请先备份）"
CMD_BJ_RESTORE="cd '$BJ_APP_DIR' && docker compose exec -T postgres sh -lc 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < /tmp/$DUMP_NAME"
echo "  ssh $BJ_USER@$BJ_HOST $CMD_BJ_RESTORE"

step "4/4 北京应用 Prisma 迁移"
CMD_BJ_MIGRATE="cd '$BJ_APP_DIR' && docker compose exec -T api npx prisma migrate deploy"
echo "  ssh $BJ_USER@$BJ_HOST $CMD_BJ_MIGRATE"

if [ "$APPLY" -ne 1 ]; then
  echo "==> dry-run 完成，未执行任何命令；确认无误后加 --apply 运行。"
  exit 0
fi

run_hk "$CMD_HK_DUMP"
$SSH "$HK_USER@$HK_HOST" "test -s ~/$DUMP_NAME"
scp -o BatchMode=yes "$HK_USER@$HK_HOST:$DUMP_NAME" /tmp/"$DUMP_NAME"
run_bj "$CMD_BJ_RESTORE"
run_bj "$CMD_BJ_MIGRATE"
run_hk "rm -f ~/$DUMP_NAME"
echo "==> 迁移完成：$DUMP_NAME"

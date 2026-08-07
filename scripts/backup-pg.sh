#!/bin/sh
# 每日 PostgreSQL 备份：保留 7 天
set -e
BACKUP_DIR=/opt/budu/backups/pg
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
if ! docker compose -f /opt/budu/docker-compose.yml exec -T postgres pg_dump -U budu -d budu > "$BACKUP_DIR/budu-$STAMP.sql"; then
  node /opt/budu/scripts/send-wechat-alert.mjs "数据库备份失败" "时间：$(date '+%F %T')"
  exit 1
fi
find "$BACKUP_DIR" -name 'budu-*.sql' -mtime +7 -delete
if ! node /opt/budu/scripts/upload-cos.mjs "$BACKUP_DIR/budu-$STAMP.sql"; then
  node /opt/budu/scripts/send-wechat-alert.mjs "COS 备份同步失败" "文件：$BACKUP_DIR/budu-$STAMP.sql"
  exit 1
fi
echo "PG backup ok: $BACKUP_DIR/budu-$STAMP.sql"

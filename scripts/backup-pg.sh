#!/bin/sh
# 每日 PostgreSQL 备份：保留 7 天
set -e
BACKUP_DIR=/opt/budu/backups/pg
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose -f /opt/budu/docker-compose.yml exec -T postgres pg_dump -U budu -d budu > "$BACKUP_DIR/budu-$STAMP.sql"
find "$BACKUP_DIR" -name 'budu-*.sql' -mtime +7 -delete
echo "PG backup ok: $BACKUP_DIR/budu-$STAMP.sql"

#!/usr/bin/env bash
# 香港测试域名 HTTPS 一键配置（在服务器 /opt/budu 上运行）
# 用法：bash scripts/setup-test-domain.sh <DOMAIN> [--apply]
# 默认 dry-run；确认 DNS 已解析到香港 IP 后加 --apply 执行。
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "用法：bash scripts/setup-test-domain.sh <DOMAIN> [--apply]"
  exit 1
fi
APPLY=0
[ "${2:-}" = "--apply" ] && APPLY=1

HK_IP="${HOST_IP:-124.156.171.195}"
APP_DIR="$(pwd)"

step() { echo "==> $1"; }

step "1/4 校验 DNS：$DOMAIN 是否解析到 $HK_IP"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n 1 || true)
echo "  解析结果：${RESOLVED:-无}"
if [ "$RESOLVED" != "$HK_IP" ]; then
  echo "==> DNS 尚未生效或未指向香港服务器，请先在 DNSPod 添加 A 记录：$DOMAIN -> $HK_IP"
  exit 1
fi

step "2/4 申请 Let's Encrypt 证书（需临时停 nginx，约 30 秒）"
CMD_STOP="docker stop budu-nginx-1"
CMD_CERT="docker run --rm -v budu_certbot:/etc/letsencrypt -p 80:80 certbot/certbot certonly --standalone --non-interactive --agree-tos --register-unsafely-without-email -d '$DOMAIN'"
CMD_COPY="mkdir -p '$APP_DIR/deploy/certs' && cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem '$APP_DIR/deploy/certs/fullchain.pem' && cp /etc/letsencrypt/live/$DOMAIN/privkey.pem '$APP_DIR/deploy/certs/privkey.pem'"
CMD_COPY_DOCKER="docker run --rm -v budu_certbot:/etc/letsencrypt -v '$APP_DIR/deploy/certs:/out' alpine sh -c 'cp /etc/letsencrypt/live/$DOMAIN/fullchain.pem /out/fullchain.pem && cp /etc/letsencrypt/live/$DOMAIN/privkey.pem /out/privkey.pem'"
echo "  $CMD_STOP"
echo "  $CMD_CERT"
echo "  $CMD_COPY_DOCKER"

step "3/4 更新 .env（DOMAIN=$DOMAIN, HTTP_ONLY=0）"
CMD_ENV="if grep -q '^DOMAIN=' .env; then sed -i 's|^DOMAIN=.*|DOMAIN=$DOMAIN|' .env; else echo 'DOMAIN=$DOMAIN' >> .env; fi; if grep -q '^HTTP_ONLY=' .env; then sed -i 's/^HTTP_ONLY=.*/HTTP_ONLY=0/' .env; else echo 'HTTP_ONLY=0' >> .env; fi"
echo "  $CMD_ENV"

step "4/4 重启 Nginx 并校验 HTTPS"
CMD_NGINX="docker compose up -d --no-deps --force-recreate nginx"
CMD_CHECK="curl -sS -o /dev/null -w 'https=%{http_code}\n' https://$DOMAIN/api/health"
echo "  $CMD_NGINX"
echo "  $CMD_CHECK"

if [ "$APPLY" -ne 1 ]; then
  echo "==> dry-run 完成；确认无误后加 --apply 执行。"
  exit 0
fi

eval "$CMD_STOP"
eval "$CMD_CERT"
eval "$CMD_COPY_DOCKER"
eval "$CMD_ENV"
eval "$CMD_NGINX"
eval "$CMD_CHECK"
echo "==> 测试域名 HTTPS 配置完成。"

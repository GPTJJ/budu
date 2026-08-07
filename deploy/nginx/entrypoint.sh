#!/bin/sh
set -e

if [ "$HTTP_ONLY" = "1" ]; then
  echo "BUDU nginx: HTTP_ONLY=1，使用纯 HTTP 配置"
  cp /etc/nginx/budu/http-only.conf /etc/nginx/conf.d/budu.conf
else
  echo "BUDU nginx: HTTPS 配置，域名 ${DOMAIN}"
  envsubst '${DOMAIN}' < /etc/nginx/budu/budu.conf.template > /etc/nginx/conf.d/budu.conf
fi

#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 HOST USER APP_DIR RELEASE_SHA" >&2
  exit 2
fi

HOST="$1"
USER="$2"
APP_DIR="$3"
RELEASE_SHA="$4"
EXPECTED_OLD_SHA="fe4a7254a0ec9a68390cefe12b0766b3ec15ef93"
RELEASE_BUNDLE="$(mktemp "${TMPDIR:-/tmp}/budu-sweet-card-data-org.XXXXXX")"
REMOTE_PREFIX="/dev/shm/budu-sweet-card-data-org-${RELEASE_SHA}"
SSH_ARGS=(ssh -o BatchMode=yes -o ConnectTimeout=15)
SCP_ARGS=(scp -o BatchMode=yes -o ConnectTimeout=15)

cleanup() {
  rm -f "$RELEASE_BUNDLE"
}
trap cleanup EXIT

[ "$(git rev-parse HEAD)" = "$RELEASE_SHA" ] || { echo "release SHA mismatch" >&2; exit 1; }
git diff --check

docker run --rm --ipc=host \
  -e NODE_ENV=test -e APP_ENV=test -e CI=1 \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.55.0-noble \
  bash -lc 'npm ci && npx prisma generate && npm run test:sweet-card:data-organization && npm run test:sweet-card && npm run test:permissions && npm run test:pos && npm run test:payments && node --test scripts/test-payment-access.mjs scripts/test-pos-order-summary.mjs && node --test scripts/test-wechat-v2-signature.mjs scripts/test-wechat-config.mjs && node --test scripts/test-wechat-pay-provider.mjs && node --test scripts/test-wechat-pay-e2e.mjs && node --test scripts/test-alipay-config.mjs scripts/test-alipay-provider.mjs scripts/test-alipay-callback-route.mjs && node --test scripts/test-payment-reconciliation.mjs && npx playwright test tests/sweet-card-admin.spec.mjs --project=ipad-webkit --workers=1 && npx playwright test --config=playwright.sweet-card.config.mjs --project=ipad-webkit --workers=1 && npm run build'

git bundle create "$RELEASE_BUNDLE" HEAD
"${SCP_ARGS[@]}" "$RELEASE_BUNDLE" "$USER@$HOST:${REMOTE_PREFIX}.bundle"
"${SCP_ARGS[@]}" scripts/clone-production-container.py "$USER@$HOST:${REMOTE_PREFIX}.clone.py"
"${SCP_ARGS[@]}" scripts/audit-sweet-card-production.mjs "$USER@$HOST:${REMOTE_PREFIX}.audit.mjs"
"${SCP_ARGS[@]}" scripts/deploy-prod-sweet-card-data-org.sh "$USER@$HOST:${REMOTE_PREFIX}.deploy.sh"
"${SSH_ARGS[@]}" "$USER@$HOST" bash "${REMOTE_PREFIX}.deploy.sh" \
  "${REMOTE_PREFIX}.bundle" \
  "${REMOTE_PREFIX}.clone.py" \
  "${REMOTE_PREFIX}.audit.mjs" \
  "$RELEASE_SHA" \
  "$EXPECTED_OLD_SHA" \
  "$APP_DIR" \
  "budu-nginx-1"

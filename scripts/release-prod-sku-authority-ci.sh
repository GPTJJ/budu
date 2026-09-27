#!/usr/bin/env bash
# Future reviewed Gate 8 only. This adapter is never called by build-only CI.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1

test "$#" -eq 4
DEPLOY_HOST="$1"
DEPLOY_USER="$2"
DEPLOY_APP_DIR="$3"
RELEASE_SHA="$4"
test "${GITHUB_ACTIONS:-}" = true
test "${GITHUB_REPOSITORY:-}" = GPTJJ/budu
test "${GITHUB_EVENT_NAME:-}" = workflow_dispatch
test "${GITHUB_WORKFLOW:-}" = 'Deploy to Beijing Prod'
test "${GITHUB_RUN_ATTEMPT:-}" = 1
test "$DEPLOY_HOST" = 154.8.195.42
test "$DEPLOY_USER" = ubuntu
test "$DEPLOY_APP_DIR" = /opt/budu
test "${GITHUB_REF:-}" = refs/heads/codex/sku-authority-release-controller-v4
test "$RELEASE_SHA" = "${GITHUB_SHA:-}"
test "$RELEASE_SHA" = "${AUTHORIZE_RELEASE_SHA:-}"
test "${SKU_GATE_8_AUTHORIZED:-}" = SKU_GATE_8
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
test -n "${RUNNER_TEMP:-}"
test -f "$HOME/.ssh/id_ed25519"

python3 scripts/deploy-prod-sku-authority.py identity --repo "$PWD"
python3 scripts/test-sku-release-contract.py
python3 scripts/test-sku-release-controller.py
python3 scripts/test-release-path-post-transfer.py
node --check scripts/sku-release-apply.mjs
test -z "$(git status --porcelain --untracked-files=all)"

run_dir="$(mktemp -d "$RUNNER_TEMP/sku-release-gate8.XXXXXX")"
export TRANSFER_CAS_KNOWN_HOSTS="$run_dir/known_hosts"
printf '%s\n' '154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb' > "$TRANSFER_CAS_KNOWN_HOSTS"
chmod 600 "$TRANSFER_CAS_KNOWN_HOSTS"

builder="sku-authority-gate8-${GITHUB_RUN_ID:-$$}"
docker buildx create --name "$builder" --driver docker-container
docker buildx inspect "$builder" --bootstrap | tee "$run_dir/builder.txt"
grep -q linux/amd64 "$run_dir/builder.txt"
mkdir "$run_dir/source"
git archive "$RELEASE_SHA" | tar -x -C "$run_dir/source"
timeout 35m docker buildx build --builder "$builder" --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "budu-api:sku-authority-${RELEASE_SHA:0:12}" \
  --provenance=false --sbom=false \
  --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$run_dir/image.tar" \
  "$run_dir/source"
timeout 25m docker buildx build --builder "$builder" --target builder --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "budu-api:sku-migration-${RELEASE_SHA:0:12}" \
  --provenance=false --sbom=false \
  --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$run_dir/migration.tar" \
  "$run_dir/source"

python3 scripts/deploy-prod-sku-authority.py inspect-artifact --repo "$PWD" \
  --archive "$run_dir/image.tar" --migration-archive "$run_dir/migration.tar"
python3 scripts/deploy-prod-sku-authority.py preflight --repo "$PWD" \
  --archive "$run_dir/image.tar" --migration-archive "$run_dir/migration.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519"
timeout 50m python3 scripts/deploy-prod-sku-authority.py deploy --repo "$PWD" \
  --archive "$run_dir/image.tar" --migration-archive "$run_dir/migration.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519" \
  --authorize-release-sha "$RELEASE_SHA" --production-gate-authorized SKU_GATE_8
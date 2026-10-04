#!/usr/bin/env bash
# Post-Transfer successor adapter for the existing production workflow.
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
test "${GITHUB_REF:-}" = "refs/heads/$(git branch --show-current)"
test "$(git branch --show-current)" != codex/transfer-cas-existing-workflow
test "$RELEASE_SHA" = "${GITHUB_SHA:-}"
test "$RELEASE_SHA" = "${AUTHORIZE_RELEASE_SHA:-}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
test "$(uname -m)" = x86_64
test -n "${RUNNER_TEMP:-}"
test -f "$HOME/.ssh/id_ed25519"

# This one procurement release needs the reviewed compatibility object as well.
PROCUREMENT_RELEASE=false
COMPATIBILITY_ARGS=()
if [ "${APPROVED_BUSINESS_SHA:-}" = 9049339f75d106ac02ebb0d109da2862e997a545 ]; then
  PROCUREMENT_RELEASE=true
  git fetch --no-tags origin codex/purchase-receipt-001-legacy-retirement-compat
  test "$(git rev-parse FETCH_HEAD)" = e3ecebcb94c4b058f10ad05e69a078bbc45b0d8e
fi

PROFILE=(--release-profile post-transfer
  --expected-production-sha "${EXPECTED_PRODUCTION_SHA:-}"
  --business-base-sha "${APPROVED_BUSINESS_SHA:-}")
bash scripts/deploy-prod-transfer-cas.sh identity --repo "$PWD" "${PROFILE[@]}"
if [ "$GITHUB_REF" = refs/heads/codex/material-center-integration-20261002 ]; then
  python3 scripts/test-material-release-contract.py --legacy-q-regressions
  python3 scripts/test-material-release-contract.py
elif [ "$PROCUREMENT_RELEASE" = true ]; then
  python3 scripts/test-purchase-receipt-release-contract.py
  python3 scripts/test-release-path-post-transfer.py ProcurementReleaseRoutingTests
else
  python3 scripts/test-deploy-prod-transfer-cas.py
  python3 scripts/test-transfer-cas-existing-workflow.py
  python3 scripts/test-release-path-post-transfer.py
fi
for script in scripts/deploy-remote.sh scripts/release-prod-transfer-cas-ci.sh \
              scripts/release-prod-post-transfer-ci.sh scripts/deploy-prod-transfer-cas.sh; do
  bash -n "$script"
done

# The checkout is exported at the authorized SHA; no workspace secrets enter
# the build context. Production receives only the inspected, hash-bound archive.
unset SSH_HOST SSH_USER APP_DIR SSH_KEY DATABASE_URL
RUN_DIR="$(mktemp -d "$RUNNER_TEMP/post-transfer.XXXXXX")"
export TRANSFER_CAS_KNOWN_HOSTS="$RUN_DIR/known_hosts"
finish() {
  python3 - <<'PY'
import os
from pathlib import Path
root=Path(os.environ['RUN_DIR'])
summary=os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary,'a') as out:
        for name in ('artifact','preflight','deployment'):
            p=root/(name+'.json')
            if p.exists():
                out.write('### Post-Transfer '+name+'\n\n```json\n'+p.read_text()+'\n```\n\n')
(Path.home()/'.ssh/id_ed25519').unlink(missing_ok=True)
PY
}
export RUN_DIR
trap finish EXIT
printf '%s\n' '154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb' > "$TRANSFER_CAS_KNOWN_HOSTS"
chmod 600 "$TRANSFER_CAS_KNOWN_HOSTS"

docker version
docker buildx version
if [ -n "${RETAINED_RELEASE_ARTIFACT:-}" ]; then
  test -f "$RETAINED_RELEASE_ARTIFACT"
  cp "$RETAINED_RELEASE_ARTIFACT" "$RUN_DIR/image.tar"
else
BUILDER_NAME="post-transfer-${GITHUB_RUN_ID:-$$}"
docker buildx create --name "$BUILDER_NAME" --driver docker-container
docker buildx inspect "$BUILDER_NAME" --bootstrap | tee "$RUN_DIR/builder.txt"
grep -q 'linux/amd64' "$RUN_DIR/builder.txt"
mkdir "$RUN_DIR/source"
git archive "$RELEASE_SHA" | tar -x -C "$RUN_DIR/source"
timeout 35m docker buildx build --builder "$BUILDER_NAME" --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "budu-api:post-transfer-${RELEASE_SHA:0:12}" \
  --provenance=false --sbom=false \
  --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$RUN_DIR/image.tar" \
  "$RUN_DIR/source"
fi

if [ "$PROCUREMENT_RELEASE" = true ]; then
  if [ -n "${RETAINED_RELEASE_ARTIFACT:-}" ]; then
    test -f "$(dirname "$RETAINED_RELEASE_ARTIFACT")/compatible.tar"
    cp "$(dirname "$RETAINED_RELEASE_ARTIFACT")/compatible.tar" "$RUN_DIR/compatible.tar"
  else
    mkdir "$RUN_DIR/compatible-source"
    git archive e3ecebcb94c4b058f10ad05e69a078bbc45b0d8e | tar -x -C "$RUN_DIR/compatible-source"
    timeout 35m docker buildx build --builder "$BUILDER_NAME" --platform linux/amd64 \
      --label org.opencontainers.image.revision=e3ecebcb94c4b058f10ad05e69a078bbc45b0d8e \
      --tag budu-api:post-transfer-e3ecebcb94c4 --provenance=false --sbom=false \
      --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$RUN_DIR/compatible.tar" \
      "$RUN_DIR/compatible-source"
  fi
  COMPATIBILITY_ARGS=(--compatibility-archive "$RUN_DIR/compatible.tar")
fi

bash scripts/deploy-prod-transfer-cas.sh inspect-artifact --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  "${PROFILE[@]}" "${COMPATIBILITY_ARGS[@]}" | tee "$RUN_DIR/artifact.json"
if [ "$PROCUREMENT_RELEASE" = true ]; then
  printf 'RELEASE_ARTIFACT_PATH=%s/*.tar\n' "$RUN_DIR" >> "$GITHUB_ENV"
else
  printf 'RELEASE_ARTIFACT_PATH=%s/image.tar\n' "$RUN_DIR" >> "$GITHUB_ENV"
fi
bash scripts/deploy-prod-transfer-cas.sh preflight --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519" "${PROFILE[@]}" "${COMPATIBILITY_ARGS[@]}" | tee "$RUN_DIR/preflight.json"
timeout 290m bash scripts/deploy-prod-transfer-cas.sh deploy --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519" --authorize-release-sha "$RELEASE_SHA" \
  "${PROFILE[@]}" "${COMPATIBILITY_ARGS[@]}" | tee "$RUN_DIR/deployment.json"

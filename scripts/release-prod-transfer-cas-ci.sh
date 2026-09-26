#!/usr/bin/env bash
# Adapter for the existing deploy-prod.yml workflow; no alternative cutover.
set -euo pipefail
export PYTHONDONTWRITEBYTECODE=1
readonly MEASURE_ONLY=TRUE
export MEASURE_ONLY

test "$#" -eq 4
DEPLOY_HOST="$1"
DEPLOY_USER="$2"
DEPLOY_APP_DIR="$3"
RELEASE_SHA="$4"
test "${GITHUB_ACTIONS:-}" = true
test "${GITHUB_REPOSITORY:-}" = GPTJJ/budu
test "${GITHUB_EVENT_NAME:-}" = workflow_dispatch
test "${GITHUB_WORKFLOW:-}" = 'Deploy to Beijing Prod'
test "${GITHUB_REF:-}" = refs/heads/codex/transfer-cas-existing-workflow
test "${GITHUB_RUN_ATTEMPT:-}" = 1
test "$DEPLOY_HOST" = 154.8.195.42
test "$DEPLOY_USER" = ubuntu
test "$DEPLOY_APP_DIR" = /opt/budu
test "$RELEASE_SHA" = "$GITHUB_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "$(git branch --show-current)" = codex/transfer-cas-existing-workflow
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
test "$(uname -m)" = x86_64
test -n "${RUNNER_TEMP:-}"
test -f "$HOME/.ssh/id_ed25519"

# Existing workflow injects only endpoint metadata into this step. Remove it
# before building; production private key is never part of the Git export.
unset SSH_HOST SSH_USER APP_DIR SSH_KEY DATABASE_URL
RUN_DIR="$(mktemp -d "$RUNNER_TEMP/transfer-cas.XXXXXX")"
export TRANSFER_CAS_RUN_DIR="$RUN_DIR"
export TRANSFER_CAS_KNOWN_HOSTS="$RUN_DIR/known_hosts"
finish() {
  python3 - <<'PY'
import os
from pathlib import Path
root=Path(os.environ['TRANSFER_CAS_RUN_DIR'])
summary=os.environ.get('GITHUB_STEP_SUMMARY')
if summary:
    with open(summary,'a') as out:
        for name in ('measurement',):
            p=root/(name+'.json')
            if p.exists():
                out.write('### Transfer CAS '+name+'\n\n```json\n'+p.read_text()+'\n```\n\n')
# This credential was created by the current hosted workflow, never local Mac.
(Path.home()/'.ssh/id_ed25519').unlink(missing_ok=True)
PY
}
trap finish EXIT

# Pin the previously authenticated production host public key. The existing
# workflow's keyscan result is not the authority for our SSH connection.
printf '%s\n' '154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb' > "$TRANSFER_CAS_KNOWN_HOSTS"
chmod 600 "$TRANSFER_CAS_KNOWN_HOSTS"
bash scripts/deploy-prod-transfer-cas.sh identity --repo "$PWD"
python3 scripts/test-deploy-prod-transfer-cas.py
python3 scripts/test-transfer-cas-existing-workflow.py
for script in scripts/deploy-remote.sh scripts/release-prod-transfer-cas-ci.sh scripts/deploy-prod-transfer-cas.sh; do
  bash -n "$script"
done

docker version
docker buildx version
docker buildx create --name transfer-cas --driver docker-container
docker buildx inspect transfer-cas --bootstrap | tee "$RUN_DIR/builder.txt"
grep -q 'linux/amd64' "$RUN_DIR/builder.txt"
printf 'RUNNER_OS=%s RUNNER_ARCH=%s TARGET_PLATFORM=linux/amd64\n' "$RUNNER_OS" "$RUNNER_ARCH"
mkdir "$RUN_DIR/source"
git archive "$RELEASE_SHA" | tar -x -C "$RUN_DIR/source"
timeout 35m docker buildx build --builder transfer-cas --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "budu-api:transfer-cas-${RELEASE_SHA:0:12}" \
  --provenance=false --sbom=false \
  --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$RUN_DIR/image.tar" \
  "$RUN_DIR/source"

# This measurement release has no production import/cutover invocation.
bash scripts/deploy-prod-transfer-cas.sh measure --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519" | tee "$RUN_DIR/measurement.json"
printf 'MEASURE_ONLY=TRUE PRODUCTION_DEPLOYED=NO STOP\n'

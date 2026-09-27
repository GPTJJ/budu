#!/usr/bin/env bash
# Exact-SHA SKU Authority schema-aware production release adapter.
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
test "${GITHUB_REF:-}" = "refs/heads/codex/sku-authority-release-controller"
test "$(git branch --show-current)" = codex/sku-authority-release-controller
test "$RELEASE_SHA" = "${GITHUB_SHA:-}"
test "$RELEASE_SHA" = "${AUTHORIZE_RELEASE_SHA:-}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test "${EXPECTED_PRODUCTION_SHA:-}" = 5ad27a06d731fbc94de5ae3776060b4350b886e8
test "${APPROVED_BUSINESS_SHA:-}" = 829b91ba42656e9ad2db530dba68ba629b10364a
test "${RUNNER_OS:-}" = Linux
test "${RUNNER_ARCH:-}" = X64
test "$(uname -m)" = x86_64
test -n "${RUNNER_TEMP:-}"
test -f "$HOME/.ssh/id_ed25519"

python3 scripts/deploy-prod-sku-authority.py identity --repo "$PWD"
python3 scripts/test-sku-release-controller.py
python3 scripts/test-deploy-prod-transfer-cas.py
python3 scripts/test-release-path-post-transfer.py
for script in scripts/deploy-remote.sh scripts/release-prod-sku-authority-ci.sh scripts/deploy-prod-transfer-cas.sh; do
  bash -n "$script"
done

unset SSH_HOST SSH_USER APP_DIR SSH_KEY DATABASE_URL
RUN_DIR="$(mktemp -d "$RUNNER_TEMP/sku-authority-release.XXXXXX")"
export RUN_DIR
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
                out.write('### SKU Authority '+name+'\n\n```json\n'+p.read_text()+'\n```\n\n')
(Path.home()/'.ssh/id_ed25519').unlink(missing_ok=True)
PY
}
trap finish EXIT
printf '%s\n' '154.8.195.42 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJJGZ1Kape1om+8xOhoI7IsgvKN1tw6sh8l7PGisgtb' > "$TRANSFER_CAS_KNOWN_HOSTS"
chmod 600 "$TRANSFER_CAS_KNOWN_HOSTS"

docker version
docker buildx version
BUILDER_NAME="sku-authority-${GITHUB_RUN_ID:-$$}"
docker buildx create --name "$BUILDER_NAME" --driver docker-container
docker buildx inspect "$BUILDER_NAME" --bootstrap | tee "$RUN_DIR/builder.txt"
grep -q 'linux/amd64' "$RUN_DIR/builder.txt"

mkdir "$RUN_DIR/source"
git archive "$RELEASE_SHA" | tar -x -C "$RUN_DIR/source"
timeout 35m docker buildx build --builder "$BUILDER_NAME" --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$RELEASE_SHA" \
  --tag "budu-api:sku-authority-${RELEASE_SHA:0:12}" \
  --provenance=false --sbom=false \
  --output "type=docker,compression=gzip,compression-level=9,force-compression=true,dest=$RUN_DIR/image.tar" \
  "$RUN_DIR/source"

python3 scripts/deploy-prod-sku-authority.py inspect-artifact --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  | tee "$RUN_DIR/artifact.json"

python3 scripts/deploy-prod-sku-authority.py preflight --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519" | tee "$RUN_DIR/preflight.json"

MAPPING_SHA="$(python3 - "$RUN_DIR/preflight.json" <<'PY'
import json,sys
rows=[json.loads(x) for x in open(sys.argv[1]) if x.strip().startswith('{')]
result=next(x for x in reversed(rows) if x.get('result')=='PREFLIGHT_PASS')
print(result['mappingSha256'])
PY
)"
test "$MAPPING_SHA" != ""

timeout 25m python3 scripts/deploy-prod-sku-authority.py deploy --repo "$PWD" --archive "$RUN_DIR/image.tar" \
  --ssh-key "$HOME/.ssh/id_ed25519" \
  --authorize-release-sha "$RELEASE_SHA" \
  --mapping-sha256 "$MAPPING_SHA" | tee "$RUN_DIR/deployment.json"

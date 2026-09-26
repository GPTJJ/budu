#!/usr/bin/env bash
# Dedicated application-only Transfer CAS release. Default/help never deploys.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "${SCRIPT_DIR}/deploy-prod-transfer-cas.py" "$@"

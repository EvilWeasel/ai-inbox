#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deploy-common.sh"
check_binding
export INBOX_DATA_DIR NODE_ENV=production
export INBOX_ORIGIN="http://$BIND_ADDRESS:$PORT"
cd "$DEPLOY_ROOT/current"
exec "$NODE_BIN" node_modules/next/dist/bin/next start --hostname "$BIND_ADDRESS" --port "$PORT"

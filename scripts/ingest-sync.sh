#!/usr/bin/env bash
# Local producer bridge. News content is data; no remote commands or webhook required.
set -Eeuo pipefail
umask 077
source "${AI_INBOX_TOOLS_DIR:-$HOME/.local/lib/ai-inbox}/deploy-common.sh"
ingest_config=${AI_INBOX_INGEST_CONFIG:-"$HOME/.config/ai-inbox/ingestion.conf"}
[[ -f "$ingest_config" && ! -L "$ingest_config" ]] || { echo 'Missing private ingestion config' >&2; exit 1; }
[[ $(stat -c %u "$ingest_config") == "$UID" && $(stat -c %a "$ingest_config") == 600 ]] || { echo 'Ingestion config must be owned by this user and mode 0600' >&2; exit 1; }
source "$ingest_config"
[[ -n ${INBOX_SOURCE_DIR:-} && -d "$INBOX_SOURCE_DIR" ]] || { echo 'Source workspace unavailable' >&2; exit 1; }
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -n 9 || { echo 'Deployment in progress; import will retry'; exit 0; }
[[ -d "$DEPLOY_ROOT/current" ]] || { echo 'No deployed release'; exit 1; }
export INBOX_DATA_DIR
cd "$DEPLOY_ROOT/current"
exec "$NODE_BIN" node_modules/tsx/dist/cli.mjs scripts/import.ts --source "$INBOX_SOURCE_DIR"

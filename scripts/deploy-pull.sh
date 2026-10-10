#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/deploy-common.sh"
mkdir -p "$DEPLOY_ROOT" "$DEPLOY_ROOT/releases" "$DEPLOY_ROOT/backups" "$INBOX_DATA_DIR"
exec 9>"$DEPLOY_ROOT/deploy.lock"
flock -n 9 || { echo 'Another deployment holds the lock'; exit 0; }
check_binding
repo="$DEPLOY_ROOT/source.git"
if [[ ! -d "$repo" ]]; then git init --bare "$repo" >/dev/null; fi
if (($#)); then
  [[ $# == 2 && "$1" == --local-checkout && "$2" == /* ]] || { echo 'Usage: deploy-pull.sh [--local-checkout ABSOLUTE_CHECKOUT]' >&2; exit 2; }
  [[ -d "$2/.git" && -z $(git -C "$2" status --porcelain) ]] || { echo 'Local bootstrap requires a clean committed checkout' >&2; exit 2; }
  git --git-dir="$repo" fetch --quiet --no-tags "$2" +refs/heads/main:refs/heads/deploy-main
else
  git --git-dir="$repo" fetch --quiet --no-tags "$REPO_URL" +refs/heads/main:refs/heads/deploy-main
fi
revision=$(git --git-dir="$repo" rev-parse refs/heads/deploy-main)
old=$(readlink "$DEPLOY_ROOT/current" || true)
[[ "$old" != "$DEPLOY_ROOT/releases/$revision" ]] || { echo 'Already running current main'; exit 0; }
stage=$(mktemp -d "$DEPLOY_ROOT/releases/.build-XXXXXXXX")
test_data=$(mktemp -d "$DEPLOY_ROOT/.test-data-XXXXXXXX")
cleanup() { rm -rf -- "$stage" "$test_data"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git --git-dir="$repo" archive "$revision" | tar -x -C "$stage"
# No production data or runtime credentials enter dependency/build/test processes.
(
  cd "$stage"
  export INBOX_DATA_DIR="$test_data"
  "$BUN_BIN" install --frozen-lockfile
  "$BUN_BIN" run typecheck
  "$BUN_BIN" run test:backend
  "$BUN_BIN" run test:frontend
  "$BUN_BIN" run build
)
[[ -f "$stage/.next/BUILD_ID" && -f "$stage/node_modules/next/dist/bin/next" ]] || { echo 'Missing Next production output' >&2; exit 1; }
release="$DEPLOY_ROOT/releases/$revision"
# Retry failed revisions by replacing only a release that is not current.
[[ ! -e "$release" ]] || rm -rf -- "$release"
mv "$stage" "$release"
backup="$DEPLOY_ROOT/backups/$(date -u +%Y%m%dT%H%M%S)-$revision"
was_active=0
systemctl --user is-active --quiet ai-inbox.service && was_active=1
stopped=0
switched=0
success=0
rollback() {
  local status=$?
  trap - EXIT INT TERM
  if (( stopped && ! success )); then
    systemctl --user stop ai-inbox.service || true
    if (( switched )); then
      # Preserve the failed data tree for inspection, then restore the stopped snapshot.
      failed="$DEPLOY_ROOT/backups/failed-$(date -u +%Y%m%dT%H%M%S)-$revision"
      mv "$INBOX_DATA_DIR" "$failed"
      cp -a "$backup/data" "$INBOX_DATA_DIR"
      if [[ -n "$old" ]]; then
        swap=$(mktemp -u "$DEPLOY_ROOT/.current-XXXXXXXX")
        ln -s "$old" "$swap"
        mv -Tf "$swap" "$DEPLOY_ROOT/current"
      else
        rm -f "$DEPLOY_ROOT/current"
      fi
    fi
    if (( was_active )); then systemctl --user start ai-inbox.service || true; fi
    echo 'Deployment failed; previous release and pre-switch data restored where available' >&2
  fi
  cleanup
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Stop before copying SQLite, WAL and media so the snapshot is consistent.
# Other ingestion processes must use deploy.lock, as documented.
stopped=1
systemctl --user stop ai-inbox.service
mkdir "$backup"
cp -a "$INBOX_DATA_DIR" "$backup/data"
printf '%s\n' "$old" > "$backup/previous-release"
swap=$(mktemp -u "$DEPLOY_ROOT/.current-XXXXXXXX")
ln -s "$release" "$swap"
switched=1
mv -Tf "$swap" "$DEPLOY_ROOT/current"
systemctl --user start ai-inbox.service
healthy=0
for attempt in {1..30}; do
  if systemctl --user is-active --quiet ai-inbox.service && curl --noproxy '*' --fail --silent --max-time 2 "http://$BIND_ADDRESS:$PORT/api/health" >/dev/null; then
    healthy=1; break
  fi
  sleep 2
done
(( healthy )) || { echo 'New release failed readiness check' >&2; exit 1; }
success=1
# Keep current, previous and the newest configured number. Only completed backups
# count toward retention; failed data snapshots require explicit operator review.
python3 "$(dirname "${BASH_SOURCE[0]}")/retention.py" "$DEPLOY_ROOT" "$RELEASE_KEEP" "$BACKUP_KEEP" "$old"

echo "Deployed revision $revision"

#!/usr/bin/env bash
# Installs only dedicated user units. Activation is a separate explicit option.
set -Eeuo pipefail
umask 077
usage() {
  cat <<'EOF'
Usage: scripts/deploy-install.sh --repo-url PUBLIC_GITHUB_HTTPS_URL
  --root ABSOLUTE_RELEASE_ROOT --data-dir ABSOLUTE_DATA_DIR
  --bind NETBIRD_IPV4 --interface NETBIRD_INTERFACE
  --bun ABSOLUTE_BUN_PATH --node ABSOLUTE_NODE_PATH
  [--port 3000] [--release-keep 5] [--backup-keep 7] [--activate]
EOF
}
PORT=3000 RELEASE_KEEP=5 BACKUP_KEEP=7 activate=0
while (($#)); do
  case "$1" in
    --activate) activate=1; shift; continue ;;
    --help) usage; exit 0 ;;
    --repo-url|--root|--data-dir|--bind|--interface|--bun|--node|--port|--release-keep|--backup-keep)
      (($# >= 2)) || { usage >&2; exit 2; }
      case "$1" in
        --repo-url) REPO_URL=$2 ;; --root) DEPLOY_ROOT=$2 ;;
        --data-dir) INBOX_DATA_DIR=$2 ;; --bind) BIND_ADDRESS=$2 ;;
        --interface) NETBIRD_INTERFACE=$2 ;; --bun) BUN_BIN=$2 ;;
        --node) NODE_BIN=$2 ;; --port) PORT=$2 ;;
        --release-keep) RELEASE_KEEP=$2 ;; --backup-keep) BACKUP_KEEP=$2 ;;
      esac
      shift 2 ;;
    *) usage >&2; exit 2 ;;
  esac
done
for name in REPO_URL DEPLOY_ROOT INBOX_DATA_DIR BIND_ADDRESS NETBIRD_INTERFACE BUN_BIN NODE_BIN; do
  [[ -n ${!name:-} ]] || { echo "Missing required parameter: $name" >&2; exit 2; }
done
[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$ ]] || { echo 'Use a public GitHub HTTPS clone URL without credentials' >&2; exit 2; }
python3 - "$DEPLOY_ROOT" "$INBOX_DATA_DIR" "$BIND_ADDRESS" "$PORT" "$RELEASE_KEEP" "$BACKUP_KEEP" <<'PY'
import ipaddress, os, pathlib, sys
root, data = map(pathlib.Path, sys.argv[1:3])
for p in (root, data):
    if not p.is_absolute() or len(p.parts) < 3 or p != p.resolve():
        raise SystemExit('Paths must be absolute, canonical, non-root and without symlink ancestors')
if root == data or root in data.parents or data in root.parents:
    raise SystemExit('Release root and data directory must be disjoint')
ip = ipaddress.IPv4Address(sys.argv[3])
if ip.is_unspecified or ip.is_loopback or ip.is_multicast or ip.is_global:
    raise SystemExit('Bind address must be a private/overlay IPv4 address')
port, releases, backups = map(int, sys.argv[4:])
if not 1024 <= port <= 65535 or not 2 <= releases <= 100 or not 2 <= backups <= 100:
    raise SystemExit('Port must be 1024..65535; retention must be 2..100')
PY
for binary in "$BUN_BIN" "$NODE_BIN"; do
  [[ "$binary" == /* && -x "$binary" ]] || { echo 'Runtime paths must be absolute executable files' >&2; exit 2; }
done
for binary in git curl flock tar python3 ip systemctl timeout; do command -v "$binary" >/dev/null; done
[[ $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') == 24 ]] || { echo 'Node 24 is required' >&2; exit 2; }
[[ $("$BUN_BIN" --version) == 1.4.3 ]] || { echo 'Bun 1.4.3 is required to match CI' >&2; exit 2; }
ip -4 -o address show dev "$NETBIRD_INTERFACE" | awk '{split($4,a,"/"); print a[1]}' | grep -Fxq "$BIND_ADDRESS" || { echo 'Bind address must exist on the supplied NetBird interface' >&2; exit 2; }
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
config_dir="$HOME/.config/ai-inbox"
script_dir="$HOME/.local/lib/ai-inbox"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$config_dir" "$script_dir" "$unit_dir" "$DEPLOY_ROOT" "$INBOX_DATA_DIR"
chmod 700 "$config_dir" "$script_dir" "$DEPLOY_ROOT" "$INBOX_DATA_DIR"
config_tmp=$(mktemp "$config_dir/.runtime-XXXXXXXX")
trap 'rm -f -- "$config_tmp"' EXIT
for name in REPO_URL DEPLOY_ROOT INBOX_DATA_DIR BIND_ADDRESS NETBIRD_INTERFACE PORT BUN_BIN NODE_BIN RELEASE_KEEP BACKUP_KEEP; do
  printf '%s=%q\n' "$name" "${!name}" >> "$config_tmp"
done
chmod 600 "$config_tmp"
mv -f "$config_tmp" "$config_dir/runtime.conf"
for script in deploy-common.sh deploy-start.sh deploy-pull.sh; do
  install -m 700 "$source_dir/scripts/$script" "$script_dir/$script"
done
for unit in ai-inbox.service ai-inbox-deploy.service ai-inbox-deploy.timer; do
  install -m 600 "$source_dir/deploy/$unit" "$unit_dir/$unit"
done
systemctl --user daemon-reload
if (( activate )); then
  # First build and readiness check must succeed before boot/timer enablement.
  systemctl --user start ai-inbox-deploy.service
  systemctl --user enable ai-inbox.service
  systemctl --user enable --now ai-inbox-deploy.timer
  echo 'Dedicated application and deployment timer activated'
else
  echo 'Installed private configuration and dedicated units; nothing started or enabled'
fi

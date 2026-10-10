#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
CONFIG=${AI_INBOX_CONFIG:-"$HOME/.config/ai-inbox/runtime.conf"}
[[ -f "$CONFIG" && ! -L "$CONFIG" ]] || { echo 'Missing private runtime config' >&2; exit 1; }
[[ $(stat -c %u "$CONFIG") == "$UID" && $(stat -c %a "$CONFIG") == 600 ]] || { echo 'Runtime config must be owned by this user and mode 0600' >&2; exit 1; }
# Trusted, locally generated shell config; not repository content.
source "$CONFIG"
export PATH="$(dirname "$NODE_BIN"):$(dirname "$BUN_BIN"):/usr/local/bin:/usr/bin:/bin"
export NEXT_TELEMETRY_DISABLED=1
check_binding() {
  ip -4 -o address show dev "$NETBIRD_INTERFACE" | awk '{split($4,a,"/"); print a[1]}' | grep -Fxq "$BIND_ADDRESS" || {
    echo 'Configured private interface address is unavailable' >&2; return 1;
  }
  [[ "$BIND_ADDRESS" != 0.0.0.0 && "$BIND_ADDRESS" != 127.* ]] || return 1
}

# Private deployment operations

The public repository contains templates and scripts only. Runtime configuration,
NetBird addresses and interface names, absolute host paths, account names, content,
backups and credentials belong outside the repository. Do not paste private
configuration or logs into issues. Installation writes a user-owned mode-0600
shell configuration in `$HOME/.config/ai-inbox/runtime.conf`; scripts and deployment
data are private to that user. No GitHub credentials or webhook are needed.

## Deployment model

GitHub-hosted CI runs frozen Bun installation, typecheck, tests and production
build on pushes to `main` and pull requests. It uses Node 24 and Bun 1.4.3, temporary
data, read-only repository permission and no deployment secrets. Protect `main`
with review and the `verify` check. Do not register a self-hosted GitHub runner.

A dedicated user timer fetches only public `main` every five minutes and performs
the same local build/test gate. This is the robust pull-deployment alternative:
it does **not** query GitHub CI status, so CI can still be running when the local
gate passes. Only reviewed/trusted code belongs on `main`: dependency install
hooks and build/test scripts execute as the deployment user. PR code is never
fetched by this timer. GitHub branch protection is an operator responsibility.

Each successful candidate is stored in `releases/<full-commit-sha>` with its own
dependencies and build. Releases are treated as immutable after construction;
Next may create runtime cache files. The atomic `current` symlink chooses the
active version. Production data is in the disjoint external `INBOX_DATA_DIR`,
never a release directory. No package files, application UI or backend are
changed by these tools.

Fetch/install/typecheck/test/build failure leaves the old service running. Build
steps receive a temporary `INBOX_DATA_DIR`. After the gate, deployment stops only
`ai-inbox.service`, snapshots the complete data directory (including SQLite WAL
and media), atomically switches releases and starts the app. Readiness is checked
on `/api/health` for up to roughly two minutes. A failed start/readiness check
stops the candidate, preserves failed data, restores the snapshot and previous
symlink, and restarts the previously active service. First deployment failure
leaves the app stopped. Brief downtime during snapshots and switching is expected.

Deployments use a nonblocking exclusive `flock` on `$DEPLOY_ROOT/deploy.lock`.
**All ingestion/import/backup writers must acquire that same lock** so stopped
snapshots are consistent. For example, run the ingestion command through
`flock "$DEPLOY_ROOT/deploy.lock" COMMAND ...` with the private root resolved
locally. The timer itself serializes its runs, and the lock also covers manual
runs. Avoid manual database changes while deployment is in progress.

## Install and activate after parent integration

Prerequisites: integrated app with committed Bun lockfile and scripts named
`typecheck`, `test:backend`, `test:frontend`, `build`; public GitHub `main`; Node 24; Bun 1.4.3; existing
NetBird connection and its IPv4 address; user systemd, git, curl, flock, tar,
Python 3 and iproute2. Install the runtimes separately if absent; these scripts
do not install packages or alter accounts/network services. The existing user
manager must persist after logout for unattended deployment; verify lingering
read-only with `loginctl show-user "$USER" -p Linger`. If disabled, arrange it
separately. No unrelated service is edited or restarted.

The following is the exact command structure; set the values in a private shell
from the host's actual configuration. Every angle-bracket token is a placeholder,
not a value to copy literally. Keep this shell history private.

```bash
export INBOX_REPO_URL='https://github.com/<owner>/<repository>.git'
export INBOX_RELEASE_ROOT='<absolute-private-release-root>'
export INBOX_RUNTIME_DATA='<absolute-private-data-directory>'
export INBOX_BIND_IPV4='<actual-netbird-ipv4>'
export INBOX_INTERFACE='<actual-netbird-interface-name>'
export INBOX_BUN_PATH='<absolute-bun-1.4.3-executable>'
export INBOX_NODE_PATH='<absolute-node-24-executable>'

bash scripts/deploy-install.sh \
  --repo-url "$INBOX_REPO_URL" \
  --root "$INBOX_RELEASE_ROOT" --data-dir "$INBOX_RUNTIME_DATA" \
  --bind "$INBOX_BIND_IPV4" --interface "$INBOX_INTERFACE" \
  --bun "$INBOX_BUN_PATH" --node "$INBOX_NODE_PATH" \
  --port 3000 --release-keep 5 --backup-keep 7

# After reviewing the installed config and parent integrating public main:
systemctl --user start ai-inbox-deploy.service
systemctl --user enable ai-inbox.service
systemctl --user enable --now ai-inbox-deploy.timer
```

Alternatively, add `--activate` to the installer after integration; it runs the
first gated deployment before enabling the app and timer. Without that option,
installation reloads the user unit definitions but starts/enables nothing. Use
the same installation command to update tooling/config after review. The
installer requires canonical disjoint absolute paths with no symlink ancestors,
unprivileged port, two or more retained releases/backups, and an overlay IPv4
address present on the supplied interface. The operator must identify the real
NetBird interface; it does not reconfigure NetBird.

## Verify and recover

```bash
systemctl --user status ai-inbox.service ai-inbox-deploy.timer
systemctl --user list-timers ai-inbox-deploy.timer
journalctl --user -u ai-inbox-deploy.service -u ai-inbox.service -n 100
readlink "$INBOX_RELEASE_ROOT/current"
curl --noproxy '*' --fail "http://$INBOX_BIND_IPV4:3000/api/health"
ss -ltn
stat -c '%a' "$HOME/.config/ai-inbox/runtime.conf"
```

Confirm `ss` shows the specified private address, never a wildcard listener.
On failures inspect the journal privately. A later timer run retries a failed
revision, with a new build and snapshot. To pause deployment:

```bash
systemctl --user disable --now ai-inbox-deploy.timer
systemctl --user stop ai-inbox-deploy.service
```

Keep the app running when pausing. For manual restore, stop the timer and any
active deployment first, acquire `deploy.lock`, then stop the app. Preserve the
current data tree, copy a selected `backups/<timestamp-sha>/data` into the external
data path, switch `current` to the release named in that backup's
`previous-release`, and restart/check health. Restore both code and data together
when schema migrations are involved. Never restore over an active SQLite writer.
If rollback itself fails (disk errors or unavailable interface), the journal and
retained snapshots are the recovery source; automated recovery is best effort.

## Backup, retention and security limits

Completed pre-switch snapshots are retained after healthy deployment: newest
seven by default. Current and previous releases, and every code version referenced by a retained
backup, are always preserved, plus the newest five candidates. Retained backup
references can therefore increase the number of retained releases. Failed data trees are excluded from automatic deletion
and must be inspected/deleted manually. Failed builds are removed. Backups are
full local copies, not encrypted off-host disaster recovery; the operator should
copy verified stopped snapshots to their existing private encrypted backup
system. Check disk capacity before activation and monitor it: build artifacts,
dependencies, media copies and failed snapshots can be large. Copy failure before
the switch restarts the previous service; a full disk can also prevent rollback.

Only the configured NetBird IPv4 is bound. Initially HTTP is restricted to this
overlay; enforce NetBird ACLs for the intended owner's devices. Binding is not
authentication: every peer permitted by those ACLs can access the inbox. No
public hosting, reverse proxy, firewall or TLS configuration is installed. TLS
is a future optional addition. Browser/device access, mobile playback and device
reachability remain **untested until tested on a physical authorized device**;
a local health check establishes only server readiness.

Tooling validation can run before integration with
`for script in scripts/deploy*.sh; do bash -n "$script"; done`
and `systemd-analyze --user verify deploy/*.service deploy/*.timer`. Full app
builds and real health rollback require the integrated application and runtimes.
SIGTERM is trapped for rollback; SIGKILL, host power loss and disk/filesystem
failure can interrupt a snapshot or switch and require manual recovery. Units
operate only on the three dedicated `ai-inbox` application/deployment units.

## Producer synchronization

See [local ingestion](ingestion.md) for the separate artifact synchronization
timer. It uses the same deployment lock and does not run research or models.

## Private hostname and HTTPS

Prefer a private DNS record distributed to authorized overlay peers. A public
address record is unnecessary when managed private DNS works. DNS-01 can issue
a publicly trusted certificate while only a temporary challenge TXT record is
public; the hostname is still visible in Certificate Transparency.

An existing private HTTPS proxy can preserve the incoming Host header and route
the exact hostname to the configured app address. Install with
`--public-origin https://inbox.example.test` to configure the external origin;
the direct private HTTP origin remains available. Host validation accepts only
configured hosts, and writes require the matching origin for that host. Forwarded
headers never add allowed origins. Keep private hostnames and proxy configuration
outside the public repository. Certificate renewal must deploy updated files and
reload the proxy; successful issuance alone does not establish that lifecycle.

On hosts combining Tailscale and another overlay, anti-spoofing rules may reject
local requests to the host's own overlay address. Verify actual routing and
firewall counters. A host-specific exception, if needed, must apply only to the
loopback interface, exact own address and app port, with a separately documented
reversible host unit. Never relax overlay or public-interface rules globally.

## Local bootstrap when repository creation is pending

A manually invoked `deploy-pull.sh --local-checkout /absolute/clean/checkout` can
bootstrap a committed local `main` through the same release gates and rollback.
It requires a clean Git checkout and does not change the configured remote. The
automatic timer continues to fetch only the public remote and should be enabled
only after the repository is published. This option does not bypass tests.

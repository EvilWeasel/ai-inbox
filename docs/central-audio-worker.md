# Central audio worker

`scripts/central-audio-worker.py` is the private single-consumer bridge between
central audio requests and the existing `scripts/audio-jobs.py` SQLite ledger.
It does not accept article content as a command, provider settings, or
credentials. The prepared spoken adaptation is delivered only as the store's
private UTF-8 input file and JSON stdin to the fixed Cartesia helper chain.

This worker is code only. It does not install a service, activate a release,
call a provider during tests, or make an unreviewed audio request. Start it only
after the backend worker CLI exists in the active immutable release and the
private configuration below has been provisioned by the owner.

## Private configuration

Pass one absolute path with `--config-file`. The JSON file must be a private
current-owner file (mode `0600` on POSIX, protected owner-only DACL on Windows),
with no reparse-point ancestors. It contains paths and non-secret profile
identifiers only; do not add tokens, API keys, commands, arguments, or content.
An explicitly invoked local pass uses:

```bash
python3 scripts/central-audio-worker.py --config-file /absolute/private/path/worker.json
```

The path above is illustrative; keep the real configuration outside the
checkout and in its private owner-only directory.

Required fields:

| Field | Meaning |
| --- | --- |
| `appReleaseLink` | The deployment's `current` symlink. Its target must resolve to one direct child release directory of the deployment root. |
| `nodeExecutable` | Absolute executable Node path. |
| `appDataDir` | Private application data directory passed as `INBOX_DATA_DIR`. |
| `deployLockPath` | Existing private deployment lock shared with release switching. |
| `stateDir` | Private central ledger/input directory. The worker owns `jobs.sqlite` and its sidecars here. |
| `mediaDir` | Separate private media directory passed as `INBOX_AUDIO_WORKER_MEDIA_DIR`. |
| `cartesiaAdapterPath` | Existing regular helper path passed to `AudioJobStore.HelperConfig`. |
| `cartesiaConfigFile` | Existing private bounded Cartesia adapter JSON. The worker checks its profile reference, media path, voice profile shape and timeout without resolving credentials. |
| `voiceProfileSha256` | Lowercase 64-character SHA-256 profile identity matching the backend's current profile. |
| `voiceProfileRef` | Short non-secret profile reference used by the existing helper. |
| `timeoutSeconds` | Integer from 30 through 1800 for the outer helper deadline. It must exceed the configured Cartesia adapter timeout by at least 60 seconds so adapter cleanup can finish. |
| `batchLimit` | Optional integer from 1 through 10; defaults to 10. |

The application data, ledger state and worker media directories must be
canonical, private, and disjoint. Existing path components are checked with
`scripts/private-files.py`. Do not place any of these directories under a code
release.

## Pass behavior

The worker takes `stateDir/worker.lock` for the complete pass. The configured
worker timeout must be at least 60 seconds longer than the Cartesia adapter
timeout; the ledger lease is the worker timeout plus another 60 seconds.
Insufficient margin fails before backend reconciliation or paid work. Each backend CLI
operation separately takes `deployLockPath`, resolves `current` under that
lock, and launches exactly:

```text
<nodeExecutable> <resolved-release>/node_modules/tsx/dist/cli.mjs <resolved-release>/scripts/central-audio.ts
```

The operation object is the only stdin payload. Private app and worker media
paths are supplied through `INBOX_DATA_DIR` and
`INBOX_AUDIO_WORKER_MEDIA_DIR`; no result text or paths are placed in argv.
Output is bounded to 4 MiB stdout and 8 KiB stderr. Failures return only a
generic worker diagnostic; child stderr, paths and content are not copied to
logs. The deployment lock is released before reading/writing the provider job
ledger or calling the helper, so a deployment can switch releases while an
already-started paid job finishes.

The worker first reconciles already-bound `generating` jobs and saved `ready`
receipts. It checks bounded oldest pending central ledger jobs by exact backend
request ID. Missing or terminal backend requests are marked `blocked` locally
only while still pending, with zero claims and no started attempt. Backend
lookup failures stop the pass before any claim. It then reconstructs missing
bindings from the deterministic ledger identity `central:<requestId>`, enqueues exact spoken UTF-8 bytes once, and
persists the returned ledger ID through the backend CLI before any helper call.
It inspects the actual oldest pending ledger row before `run_one`; the returned
job is attached only after its deterministic request mapping and backend
binding match. A worker pass makes at most one initial provider attempt.

Expired attempts without a recoverable receipt become `uncertain`; uncertain,
retryable and blocked jobs move to backend `needs_review` and are never
automatically retried. A valid saved receipt is attached without another
render. Attachment checks exact body and media hashes, MPEG framing, finite
duration and current media privacy before calling the backend's atomic attach
operation. If attachment fails, the ready ledger file remains for another pass.
The backend owns the final body-revision/original-media race and can report
`superseded` without replacing the written result.

Before a paid ledger claim, the worker looks up the exact request again. If a
new original recording or body revision arrived while the ledger job was being
prepared, the backend marks it superseded and the zero-attempt pending ledger
row is safely blocked. Malformed individual backend rows move to review through
a conditional unbound resolution; one bad row does not poison the batch.

## Local validation

Run the worker tests with:

```bash
python3 -m unittest tests/producer/test_central_audio_worker.py -v
```

They use real temporary `AudioJobStore` databases, fake local renderers, a
fake backend contract for crash/race cases, and one local subprocess invocation
of the actual source TypeScript CLI. The subprocess test uses a temporary data
directory and never uses provider credentials or calls a network service.

# Private T3 result decision adapter

`scripts/result-decision.py` is a trusted local classifier adapter for the
future result pipeline. The pipeline owns capture, exact-run verification,
verbatim publication, original-audio discovery, Inbox delivery, and generated
audio. This adapter decides only whether a captured final response is a
meaningful finished personal result and, when it is, supplies a concrete German
title, result type, and concise German spoken adaptation. It never chooses or
reads an original recording.

The adapter is not an activation switch. It does not scan T3 history, start a
service, alter a scheduler, send an Inbox item, or invoke audio synthesis by
itself. Captured text and references are untrusted data; embedded instructions
are not followed. A child result, acknowledgement, progress update, or
redundant news producer message must not become a fresh result. Return `review`
when completion or meaning is uncertain rather than inventing certainty.

## Fixed process contract

Use a fixed argv from the private pipeline configuration, for example:

```json
["/absolute/path/to/python3", "/absolute/path/to/result-decision.py",
 "--config-file", "/private/ai-inbox/result-decision.json"]
```

Here `--config-file` is solely this adapter's private JSON configuration
option. The adapter accepts one UTF-8 JSON object on stdin, at most 1,250,000
bytes:

```json
{
  "protocol": 1,
  "identity": {"threadId": "...", "runId": "..."},
  "capturedFinalText": "...",
  "sourceRefs": []
}
```

Only those four top-level fields and the two identity fields are accepted. The
captured text is passed as untrusted context to the model; source references
are included as evidence and are not returned by the classifier. The original
captured response remains the pipeline's verbatim Inbox body.

The only successful stdout values are strict JSON. Meaningful results use
exactly these keys:

```json
{"decision":"meaningful","title":"Konkretes Ergebnis",
 "resultType":"research","spokenText":"..."}
```

`resultType` is `research`, `implementation`, or `report`. The spoken text is
natural German, roughly 100 to 350 words and no more than 3,500 characters. It
must preserve actual uncertainty and must not read out URLs, paths, or code.
Non-meaningful outcomes are normalized to exactly `{"decision":"exclude"}` or
`{"decision":"review"}`. Process errors return a nonzero status and a short,
content-free stderr reason; the adapter never logs request text, model output,
environment values, or subprocess diagnostics. It does not retry model calls
inside one invocation.

## Private configuration and Codex process

The adapter config is JSON in a private file: mode 0600 on POSIX, or accepted
only after the repository's native Windows owner/DACL checks. The cache
directory is protected by the existing `private-files.py` helper, including
its native Windows ACL behavior. Example shape (replace placeholders locally;
do not commit runtime config):

```json
{
  "codexExecutable": "/absolute/path/to/codex",
  "cacheDir": "/private/ai-inbox/result-decisions",
  "model": "gpt-6-luna",
  "reasoningEffort": "low",
  "serviceTier": "default",
  "timeoutSeconds": 180
}
```

`codexExecutable` must be an absolute regular executable. The adapter checks
`codex exec --help` before inference for the supported options it uses:
`--ignore-user-config`, `--ephemeral`, `--ignore-rules`,
`--skip-git-repo-check`, read-only `--sandbox`, `--output-schema`, `--json`,
and `--output-last-message`. It supplies the model, reasoning effort, service
tier, `project_doc_max_bytes=0`, and disabled feature overrides through
per-process `-c` settings. These overrides disable shell, unified exec, apps,
plugins, remote plugins, multi-agent, browser, computer, image viewing, sleep,
skill search, skill dependency installation, and code mode; top-level
`web_search` is set to `"disabled"`.

The fixed instruction and actual request JSON are combined on stdin, with `-`
as the prompt argument. Personal result text is never included in argv. The
adapter does not modify `HOME`, `CODEX_HOME`, global settings, or existing
OAuth state. T3/MCP endpoint variables and secret-like environment variables
are filtered from the child; normal path and existing DBus session variables
are retained. Model, effort, tier, request, schema, and executable identity
participate in the cache key.

Each invocation uses a fresh protected temporary working directory which is
removed on completion. No project files are made available to the process.
The JSON event stream must contain exactly one successful completed turn;
unknown events, errors, failed turns, tool/command events, malformed events,
timeouts, nonzero exit, missing structured final output, or output over the
bounds fail closed. The response schema uses only required fields with basic
typed nullable values; the adapter performs outcome-specific validation and
normalization separately.

Local inspection of the installed CLI's `codex exec --help` confirmed these
options are advertised. `codex features list` reports the requested feature
names; `code_mode` is a boolean feature override. This inspection does not
prove authenticated runtime acceptance of every per-process setting. The
parent will perform the separate bounded harmless smoke test. No model request
was made while implementing or testing this adapter.

## Private decision cache

Successful normalized decisions are stored as private JSON entries keyed by a
SHA-256 digest over the complete request bytes, prompt version, output-schema
digest, model, reasoning effort, service tier, and configured executable path.
Repeating the same immutable candidate with the same nonsecret inference
configuration reuses the result without another model call. A changed thread,
run, result body, source reference, or inference configuration gets a
different key. Meaningful cache entries have the four output fields;
`exclude` and `review` entries have only `decision`. Failed or uncertain
subprocess runs are never cached and the adapter never performs an automatic
retry.

The adapter does not read the Codex auth store, copy auth state, or set up
credentials; Codex uses its existing subscription authentication.

## Tests

`tests/producer/test_result_decision.py` uses a fake local Codex executable. It
covers strict output and normalization, actual argv and stdin delivery,
environment filtering, cache idempotency and invalidation, normalized exclude
and review cache reads, oversized input and subprocess output, timeout,
tool-use and event rejection, unsupported CLI help, and invalid private
configuration. These tests make no live Codex request and do not perform paid
calls.

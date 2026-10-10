# Host-local T3 final delivery bridge

`scripts/t3-results.py` stages a finished personal result and sends it to the
inbox producer only after the bound T3 root run is complete. Host-global T3
guidance invokes staging for meaningful finished research, implementation and
report results in every future personal thread; users do not subscribe or opt
in per thread. The worker watches only thread IDs already staged in its private
outbox. It does not list threads, scrape old thread history, relay child-agent
messages, synthesize audio, or run T3 itself. The producer supplies the original
audio or requested audio for that result when available; the worker copies that
file into the private outbox.

## Private configuration

Create a private JSON file outside the checkout. On POSIX, configuration and
token files remain mode 0600 and the outbox directory is mode 0700. On Windows,
the producer checks owner and protected DACLs with the native helper described
in [windows-producer.md](windows-producer.md); Windows mode bits are not used
as a privacy check. Keep both token files in the host's existing private
credential storage. `t3TokenFile` must contain a
read-scoped T3 bearer token; `producerConfigFile` points to the existing private
configuration consumed by `scripts/deliver-result.py`.

```json
{
  "t3Origin": "http://localhost:3773",
  "t3TokenFile": "/private/path/t3-read-token",
  "producerConfigFile": "/private/path/producer.json",
  "outboxDir": "/private/path/t3-results-outbox",
  "allowedAudioRoots": ["/private/path/selected-audio"],
  "pollIntervalSeconds": 5
}
```

Use the actual configured origin locally. Plain HTTP is accepted only for a
loopback address; HTTPS is accepted for other origins. Redirects are refused.
The bridge reads the T3 token from its private file and never prints it or copies
it into the outbox. The outbox directory and staged files use owner-only access
on each platform. SQLite's main database is privately precreated, and its WAL,
SHM and rollback journal artifacts are validated and secured after SQLite opens.
Audio paths must be absolute, regular, free of symlink components, inside one of
the configured roots and at most 30 MiB. Audio is explicitly selected with
`--audio`; the bridge never chooses a newest or suggested MP3.

## Stage and deliver

Host-global T3 guidance prepares one JSON envelope using the producer contract
in [agent-results.md](agent-results.md). Its title and body contain the finished
personal deliverable. It includes original sources and the correct `resultType`,
then stages against the current thread with the meaningful-result acknowledgement:

```sh
python3 scripts/t3-results.py stage \
  --config /private/path/t3-results.json \
  --thread-id selected-thread-id \
  --input /private/path/final-result.json \
  --audio /private/path/original-answer.mp3 \
  --meaningful
```

Stage derives the current run from the highest unique numeric ordinal among
runs belonging to the projected thread. Repeating a stage after lost command
output returns the existing receipt without adding a row. A revised authored
result for the same thread/run replaces the staged payload and audio under the
same delivery ID; if already delivered, it is sent again as an idempotent
producer upsert, preserving inbox owner state. Stage can happen while the run is
active, but it does not send. Run `once` after the T3 turn has returned, or run
`watch` as a host-local process:

```sh
python3 scripts/t3-results.py once --config /private/path/t3-results.json
python3 scripts/t3-results.py watch --config /private/path/t3-results.json
```

`watch` polls every five seconds by default and only reads staged thread IDs.
One thread's fetch or processing failure is recorded as a bounded exception
class diagnostic with capped backoff; processing continues for unrelated rows.
`retry` forces a bounded recheck of pending and blocked rows; it does not bypass
T3 completion gates. Delivery failures remain pending with capped exponential
backoff. If the remote inbox accepted a request but its response was lost, a
retry sends the same stable delivery ID. The bridge writes the returned receipt
to SQLite only after `deliver-result.py` returns it. The inbox's idempotent
producer contract handles the uncertainty window between remote acceptance and
local receipt commit.

## Completion checks and verified T3 fields

For each staged thread the bridge calls only
`GET /api/orchestration/threads/:threadId`, with
`x-t3-orchestration-protocol: 2` and the configured read bearer token. It caps
the response at 5 MiB and requires the installed projection shape containing
`projection.thread`, `runs`, `nodes`, `subagents`, and `messages`. The verified
projection exposes thread identity as `projection.thread.id`; there is no
`thread.latestRunId`. The bridge selects the unique maximum `ordinal` among runs
whose `threadId` matches that projected thread. Missing, invalid, or duplicate
current ordinals fail closed. Run fields include
`id/threadId/ordinal/status/completedAt/rootNodeId/delegatedCompletion`; node
fields include `kind/status/completedAt/parentNodeId/rootNodeId`; subagents
include `threadId/runId/parentNodeId/childThreadId/status/completionWake` and
`completionDelivery`; messages include `runId/nodeId/role/text/streaming`.

A staged result can send only when its bound run has status `completed` and a
completion timestamp; the root node is a completed `root_turn`; and a completed
assistant-message node under that root has a nonempty, non-streaming assistant
message for the same run. Active execution nodes and subagents for that run hold
the item. Unknown child completion state or pending/claimed delegated delivery holds
the result. `completionWake` is the policy enum `always|settled_only`; acknowledged,
delivered and disposed child deliveries are settled. An open cohort allows further
delegation and does not itself indicate active work. Its optional delivery contains
`generation/messageId/taskIds`; referenced child deliveries must be settled. Failed, interrupted, cancelled or rolled-back runs are kept blocked
with a bounded diagnostic. Other incomplete projections stay pending. Message text is not
copied from T3: the published body is the exact explicit staged deliverable, so
assistant progress, tool output, child replies and inherited conversation rows
cannot become inbox content.

The correction follows the live projection shape reported for the current T3
runtime, including per-thread numeric run ordinals and the absence of
`latestRunId`. The parent checked the live selected-thread projection and the installed DTO
definitions for run identity, wake policies and child/cohort delivery shapes;
end-to-end delivery must still be verified when installing the host worker. The projection does not offer one universal
logical-task-settled flag for every provider-native background activity; the
bridge holds on represented active run nodes, subagent states and delegated
completion fields, and fails closed when those represented states are unknown.

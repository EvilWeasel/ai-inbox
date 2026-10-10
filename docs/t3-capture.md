# T3 completion capture

`scripts/t3-capture.py` records future completed root runs in a private review
journal. It does not publish results or scan historical message tables. Its
activation epoch, exact thread/run identity, delegated-child exclusion, final
message checks, retry backoff and private file handling are described in
[`completion-capture.md`](completion-capture.md).

## Projection response bound

Capture and explicit staging share `scripts/t3-results.py` to read one thread's
current projection. The bridge reads at most 16 MiB plus one byte, rejects a
response that exceeds 16 MiB, and requires the established projection shape.
The larger bound accommodates valid projections from older, long-running
threads while keeping memory and network reads capped. It does not change which
messages are eligible: capture still verifies the requested thread identity,
the exact completed run, root final message, and settled delegated work.
This is the current bridge limit and supersedes older 5 MiB references in the
capture and delivery notes.

If a projection exceeds the cap or has an unsupported shape, capture stores a
bounded diagnostic, keeps the candidate out of automatic delivery, and retries
only when the failure is classified as transient. The cap should be changed
only after measuring bounded responses from the exact affected threads and
confirming the current projection contract; do not fetch or archive whole
conversation histories to work around it.

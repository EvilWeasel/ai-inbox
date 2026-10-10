# Central audio generation for personal producers

Host-local completion capture and authored outboxes identify final personal
results. The private always-on Inbox host provides audio generation for producers
without a configured local voice helper. This is a design contract, not activated
functionality. Existing original recordings continue through the producer upload
path and take precedence over generation.

## User flow

A finished report appears as written content first. Its requested audio moves
through queued, generating, ready or needs-review states without a refresh button.
Ready media becomes playable on the same item. Reading and archive state remain
unchanged. Navigation and new server state never replace the recording currently
playing. Audio generation is separate from result classification: a remote helper
receives a prepared concise German adaptation, never a command or a prompt to run
another task.

## Authenticated requests

A producer may request audio only for its own existing result delivery identity.
The server resolves the item through the producer identity and delivery ID; clients
cannot choose another producer, filesystem path, voice or provider credential.
The request binds the exact written-body hash and spoken-text hash. The configured
voice profile adds its own version hash to job identity. Repeated identical
requests return the same job, including after a lost HTTP response. A changed
written result cannot receive an older generation accidentally.

A bounded POST creates the durable request after validating the result's ownership
and revision. Authenticated status and download endpoints are scoped to the same
producer. The server also exposes non-sensitive audio status in normal owner
Inbox reads. These are additional contracts to implement; the existing final-result
endpoint remains the source of written result delivery and original media upload.

## Worker and failure behavior

The server keeps private metadata, adaptation, media and job receipts outside code
releases. A scoped worker maps requests to the existing durable audio job store
using deterministic identity and a single active provider claim. It uses the
configured Proton-backed Cartesia helper and its existing voice defaults. At most
one synthesis request is made for each prepared short adaptation. Uncertain paid
attempts require review and never trigger automatic resynthesis.

The worker attaches validated ready media only if the item still matches its
written revision and no authored original recording has superseded the request.
A transaction changes media/status without resetting read or archive state, and
announces the committed change through the existing event stream. A retry after
an attachment commit uses the same job identity and causes no duplicate item.

A remote adapter can submit a deterministic request and retrieve that same job's
validated media. A timeout must not create a new central job or infer that a paid
request failed. Neither model output nor an audio request may supply commands,
credentials, paths or executable instructions. Provider credentials stay on the
already configured synthesis host.

## Acceptance

- A producer without local voice credentials delivers a real finished report and
  receives its generated MP3 in the same Inbox item.
- Retrying request, worker and attachment preserves one item and one audio attempt.
- Original media, newer report revisions and read/archive changes survive races.
- Cross-producer requests fail; hostile text remains data.
- A browser receives audio readiness automatically while another track continues.
- A lost provider response remains visible for review without another paid call.

Physical-device playback and background playback require separate device checks.
The host-local queue and coordinator foundations alone do not prove this flow.

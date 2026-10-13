# Audio requested while reading

The owner explicitly requests audio with **Generate audio**. Opening, importing,
or refreshing an item never requests speech. The action transitions to queued,
then preparing, and finally **Play**. Ready recordings are reused. Playback still
requires a click; completion does not autoplay.

The deployment uses `INBOX_AUDIO_ON_DEMAND=1`. Result producers use
`audioDeliveryMode: "on_demand"`; they deliver written results and may reuse an
original recording without submitting a new audio request. The legacy Cartesia
worker remains paused. Its queue and uncertain receipts are retained.

`POST /api/items/:id/audio-request` accepts an empty body or `{}` and enforces the
existing origin/host boundary. Clients cannot provide a model, credential, voice,
or prompt. Its durable identity binds the item, written-body hash, and fixed
`google/gemini-3.8-flash-tts:Kore:v1` profile. Repeated clicks share that identity.
All item kinds support this action. Existing media is never replaced by it.

The independent single-consumer worker prepares full prose for listening:
Markdown links retain their labels, tables become labelled statements, headings
and lists gain spoken punctuation, and code blocks refer to the written version.
It preserves prose, caveats and conclusions rather than silently summarizing a
report. Separate model instructions set natural pacing, restrained emphasis and
content-appropriate delivery. Technical reports use a calm factual tone; explicitly
comic material can use dry humor. Delivery instructions are not spoken.

Long texts split at sentence/word boundaries into bounded requests. Verified PCM
parts join with short pauses and are encoded to MP3. Decode and duration checks
detect malformed/trivially short recordings; they do not prove verbatim recitation
or substitute for listening/ASR acceptance.

## Private worker configuration

Install the worker separately from immutable web releases and enable the dedicated
user service after the web migration succeeds. Its mode-0600 JSON configuration
contains `dataDir`, `stateDir`, `deployLockPath`, and `dailyBudgetUsd`. Data and
worker-state directories must be private and owned by the user. Credentials come
from `OPENROUTER_API_KEY` injected by the existing private store. The service's
private environment file stores only the secret reference, never the resolved key.
Never commit runtime configuration, secret references, receipts or recordings.

Each provider request records its intent before sending. Started/uncertain
receipts reserve budget and cannot be replayed automatically. A failed or
interrupted paid attempt becomes `needs_review`. Worker restart can attach a
durably completed recording without another provider call. A changed body
supersedes the job, and attachment checks the current body again. The worker takes
the same deployment lock for every database/media commit, releasing it during
network calls. It never holds the web deployment lock across synthesis.

The private daily limit counts confirmed costs plus conservative reserves for
requests without a cost receipt. The initial deployment uses a USD 5 daily limit;
raising it is an operator decision. Costs and generation IDs are retained in
private per-part receipts. Provider retries after an uncertain outcome require
explicit review; they are not exposed as an ordinary retry button.

An explicitly authorized one-time backlog can queue a captured list of existing
result IDs through the same endpoint. Future items remain on demand. Stop the old
central worker when activating this policy; switching the producer configuration
does not cancel its already submitted queue.

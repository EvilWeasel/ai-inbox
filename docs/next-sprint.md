# Next delivery and listening sprint

This document specifies upcoming work, not shipped capabilities. Existing
reading, archive, live updates and explicit audio switching remain invariants.

## Immediate interaction improvements

The persistent player must offer volume, mute, seeking and playback speed as
accessible independent controls. Volume and speed are device preferences;
navigation or incoming items must not reset playback. Desktop shows volume
directly; a narrow viewport can use an accessible volume popover. Platform
restrictions on media volume require a usable fallback rather than a claim of
universal support. Playback uses one audio element and never starts implicitly.

Inbox types should be direct selectable chips with clear selected state, not an
operating-system dropdown. Theme and speed menus use the existing Radix library,
including keyboard navigation, focus return and matching light/dark surfaces.
The favicon and sidebar use one crisp custom vector mark. Verify real content
at desktop and 390-pixel width without horizontal overflow or fake counters.

## Complete future result capture

An explicitly staged result is the preferred authored delivery. A host-local
completion adapter must also capture future completions from already-open
threads when staging was omitted. Start from a persisted activation epoch;
never import all historical threads. Read completion metadata incrementally,
then fetch only changed eligible roots. Store source identity, completion time,
decision, reason and receipt durably. Provider child threads, tool messages,
progress and acknowledgements are excluded with a recorded reason. Unknown
relevance or missing artefacts remain reviewable, never silently successful.

Acceptance requires a real new result on each configured host, a future finish
in a pre-existing thread without staging, restart recovery, duplicate-event
deduplication and an honest outcome when an upstream interface is unavailable.
Do not infer coverage from an SSE connection or a global prompt instruction.
Windows private-file verification must use owner and protected DACL checks in
the personal user's context; POSIX permission rules remain strict.

## Durable audio jobs

Text delivery and audio completion have separate receipts. Existing recordings
are transferred exactly and identified by hash. Missing audio creates one
durable job per content revision and voice profile, with pending, running,
ready, retryable failure, uncertain and blocked states. Limit synthesis to one
concurrent request initially. A crash or lost provider response must not
automatically repeat an uncertain paid request. Keep private provider receipts
and publish concise, actionable status on the same inbox item through live
updates. Never synthesize the historical archive automatically.

Acceptance includes exact original-audio reuse, one new spoken adaptation with
receipt, state recovery after interruption and no second paid call after a
simulated uncertain result. A newer text revision must not silently describe
old audio as current. An already-playing media version keeps playing until an
explicit playback action changes it.

## Continue listening across devices

Add independent listening state keyed by item and media hash: position,
completion, device/session and optimistic version. Persist at most every ten
seconds and on pause, seek and end. Keep local recovery alongside server state.
Reject stale updates from another paused session. Remote changes never seek a
currently playing recording. Reload offers explicit continuation and never
autoplays. Add feature-detected MediaSession play, pause and seek controls.

Acceptance covers reload recovery, concurrent devices, offline recovery and
unchanged playback during search and live delivery. Browser checks and physical
phone background/lock-screen checks are separate evidence; the latter must not
block deploying other validated functionality.

Later archive retrieval, approvals and agent launches remain separate contracts.
Retrieved content cannot authorize actions. No framework or database replacement
is required for this sprint.

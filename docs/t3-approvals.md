# T3 approval integration contract (deferred)

The planned T3 fork will supply authoritative approval requests for reviewed
actions and narrowly scoped, short-lived access capabilities. The Inbox will
display those requests and allow the authenticated owner to approve or reject
them. This document is an integration boundary; it does not enable approval
endpoints, mint tokens or claim a working approval interface.

Implement the integration only after the fork publishes its request schema,
authenticated transport, decision endpoint and execution receipts. Ordinary news
and result bodies remain inert and cannot create approvals or execute actions.
An Inbox producer bearer credential is not permission to approve risky actions.

## Reviewable request

Every request must expose the precise action, target, scope, requested access,
purpose, risk and rollback limitations. Identify difficult or unavailable rollback
directly. The review view must use authoritative structured fields rather than
derive an executable command from Markdown. Present the reviewed payload version
and expiry; changed action parameters require a new review.

Bind each decision to a unique request ID, action type, canonical payload digest,
payload/schema version, intended executor and target identities, owner identity,
scope and expiry. T3 must verify this binding immediately before granting access
and again before execution. Approval for one action cannot authorize later work,
another server, broader privilege, or a changed command.

## Origin and decision boundary

Accept requests only from an authenticated T3 origin using signed envelopes or an
equivalent authenticated channel with verifiable integrity. Verify issuer,
audience, signature, timestamps and request identity server-side. Network
membership and an origin label alone are insufficient authentication. Review data
must be safely rendered as untrusted content.

The Inbox sends authenticated approve/reject decisions to T3. T3 remains the
authority for lifecycle transitions, capability issuance, revocation and
execution. A local button click is not proof of authorization: show pending
confirmation until T3 returns its authoritative receipt. Refresh current state
before decisions and execution; fail closed if authentication, integrity,
binding, freshness or connectivity cannot be verified.

Approval requests use the lifecycle `pending`, `approved`, `rejected`, `expired`,
`cancelled`, `executed`. Execution failures are separate structured outcomes.
Rejected, expired and cancelled requests cannot execute. Approved requests may
still expire or be cancelled before execution. T3 reports the final execution
receipt; the Inbox must not infer execution from approval.

## Capabilities, replay and audit

Issue access only for the reviewed scope and bounded time, with a single action
or otherwise explicit maximum use count. A capability must be bound to its
executor, target and approved payload digest; enforce expiry and revocation at
the access boundary. Persist replay protection and idempotency keys so repeated
decision submissions and lost responses cannot grant additional access or
execute twice. Concurrent decisions need atomic version checks; conflicting or
stale decisions require a fresh authoritative read.

Do not place passwords, access tokens or capability material in Inbox content,
notifications, browser storage, URLs or audit logs. Use opaque references and
redacted receipts. Credentials stay in the private credential service and are
made available only to the authorized executor through the fork's secure
interface. Audit request origin, reviewed digest/version, owner decision,
transition times, expiry, scope and execution outcome without storing secrets.

## Acceptance before activation

Verify signature and identity failures, altered payloads, stale versions, expiry,
revocation, concurrent decisions, replay, response loss and duplicate execution.
Test the authenticated owner flow against actual T3 request/decision/receipt
interfaces with precise action and risk information. Do not seed fictional
approvals or display operational approval controls before this interface exists.

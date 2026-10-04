---
title: "TODO steering and amendments"
description: "Transactional signal admission and the production activation boundary."
---

## Transactional admission

`flowdispatch.Service.SignalInTx` admits a signal through the existing jobs
store in the caller's PostgreSQL transaction. It shares validation, scope
binding, authorization context, reconciliation policy and request identity with
`Signal`. The caller commits or rolls back the product event, revision and
signal intent together. Admission performs no runtime resolution or delivery;
the existing jobs worker delivers committed intents and reconciles lost replies.

The dispatcher records intent; it does not authorize a TODO mutation, lock a
merge fence, settle a wait, append a revision or start an attempt. Those operations
must use the pinned TODO service and bound catalog authorization before admission.

## Activation boundary

TODO Message notifications currently refuse `notification_unavailable` before
queue admission. The pinned `todo` composition and its closure, notification
lineage and guest-host delivery contracts must pass their production checks
before replacing this refusal. Existing `coding/request` delivery is retained.

The public `POST /api/todos/{n} {steer}`, `PATCH /api/todos/{n}` and corresponding
catalog commands are not enabled by this dispatcher change. Their activation
requires T-STK-01/02/05/12, T-FLW-11, T-MCH-14, T-INS-02, T-FLW-01, T-SEC-01,
T-CAT-01 and T-ACC-03. Delegation also requires T-ACC-04; delegated Amend requires
T-APP-04. No branch-built artifact or repository code executes as root or on the
host through this admission seam.

## Stop, Resume, Retry and Drop

T-STK-05 supplies the control boundary for `POST /api/todos/{n}`. It is
unmounted until the shared install command dispatcher and its authorization,
confirmation and execution dependencies pass their joint checks. Direct
handler calls return `503` with `code: todo_control_unavailable`, `class: infra`;
they never acknowledge admission or mutate a TODO.

The request carries `Idempotency-Key` and JSON `{op, steer?}`. `op` is `stop`,
`resume`, `retry`, `retry-current-flow` or `drop`. Only the two retries accept a
steer. The browser retains the request and its key until a committed projection
receipt arrives; HTTP acceptance alone never completes the toast.

Stop requires an executing run and no question or approval; branch waits do
not refuse Stop. Resume requires the committed pause fact. Both retries require
a blocked item, even when an independent wait makes the card show Needs you.
Terminal items refuse every control. A merge fence refuses with `409 merging`.

The historical `/mythical/items/{id}/retry` route and `history.retry` command
are removed. Old recorded cards remain decodable. The former CAS helper stays
private in the stack service for the durable-attempt migration; it is not a
served control. It accepts chat-origin items through the same version CAS and
person-only typed-stop guard. Re-applying the TODO label does not lift a failed
attempt's bounds. Legacy planner declines now block with `factory/no_proposal`
instead of settling the item as dropped; existing declined records still decode.
The PR-close primitive uses a narrowly scoped installation
token and must be called only through persisted outbound intent/recovery after
cancellation, final capture and the merge fence settle.

No root operation or host-process execution fallback is added. Full
Stop/Resume, attempt creation, Drop/fold/removal and restored-input execution
remain disabled pending their production PostgreSQL/microVM boundary receipts.

## Steer and Amend refusal boundary

The same unmounted control handler recognizes `POST /api/todos/{n}` with
`{steer}`; the unmounted Amend handler accepts `PATCH /api/todos/{n}` with
`{prompt, acceptance}`. Both reuse the existing control decoder, request size
limit, number validation, idempotency-key requirement and error envelope.
Valid direct requests return `503 infra/todo_control_unavailable` before subject
reads or effects, including repeated keys. Neither accepts actor or `via`
from JSON. Attribution must come from the shared bound authorization decision.

Amend cannot allocate a revision, create a confirmation or send a signal here.
Once the shared authority exists, delegated Amend must refuse
`503 infra/confirmation_unavailable` if its confirmation consumer is absent.
There is no local credential or confirmation substitute. Future activation
requires the served install router, catalog dispatcher and pinned guest-host
checks; these direct-handler refusal tests are supplemental evidence only.

## Browser-session Merge

The repository TODO request is now `POST /api/repos/{owner}/{repo}/mythical/items/{id}/merge`
with `{reviewed_head_sha}`. The former `/land` route is removed. Only a person’s
browser session may request it; tokens receive `403 permission`. A malformed
SHA receives `400 invalid_reviewed_head_sha`; valid hexadecimal is normalized
to lowercase. The current GitHub maintainer is checked before TODO readiness,
and `checks.Land` retains the reviewed head, generation and session attribution.
The request acknowledges persisted approval, never remote completion.

The install mounts `POST /api/todos/{n}/merge` using its persisted repository
binding and repository-local TODO number. It refuses with `409 rechecking`
before approval while production readiness, fence and outbound providers are
unavailable. Stale reviews return `409 stale_head` with `current_head_sha`;
that value never replaces the reviewed head. Merge recovery waits until GitHub
reports the merge and main contains its commit. C-J1-04 remains incomplete.

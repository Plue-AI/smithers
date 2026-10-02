---
title: "Troubleshooting"
description: "Every refusal and warning @smthrs/engine raises: the symptom you see, what causes it, and the change that fixes it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine/docs/troubleshooting.md"
---

The engine's admission and configuration refusals are coded, so a control plane
or a proxy can classify one without scraping prose from a message. Most are
raised as defects rather than typed failures, because each one names a wiring
mistake rather than a condition a caller handles.

| Code                          | Class                                  | Section                                                                                       |
| ----------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `flow_not_registered`         | `FlowEngine.FlowNotRegistered`         | [Flow is not registered](#flow-is-not-registered)                                             |
| `execution_identity_conflict` | `FlowEngine.ExecutionIdentityConflict` | [Execution id already belongs to another run](#execution-id-already-belongs-to-another-run)   |
| `snapshot_boundary_required`  | `FlowEngine.SnapshotBoundaryRequired`  | [Compensable action requires SnapshotBoundary](#compensable-action-requires-snapshotboundary) |
| `suspended_resume_gave_up`    | `FlowEngine.SuspendedResumeGaveUp`     | [The caller stopped waiting on a parked run](#the-caller-stopped-waiting-on-a-parked-run)     |
| `invalid_round`               | `FlowEngine.Round.InvalidRound`        | [Invalid round or budget](#invalid-round-or-budget)                                           |
| `flow_proxy_collision`        | `FlowProxy.FlowProxyCollision`         | [Two derived operations share a wire name](#two-derived-operations-share-a-wire-name)         |
| `invalid_flow_tag`            | `FlowProxy.InvalidFlowTag`             | [A flow tag has no route encoding](#a-flow-tag-has-no-route-encoding)                         |

The engine also raises refusals declared in [`@smthrs/flow`](https://flow.smithers.sh/reference/api/):
`Flow.MaxRoundsExceeded`, `Action.ConcurrentKeylessDispatch`,
`Action.IrreversibleRetryRequiresIdempotencyKey`, and
`Action.UncanonicalIdempotencyKey`.

An exhausted or expired action retry policy propagates the final declared
failure. Inspect the action span's `retry.stopReason` and `retry.attempt` to
diagnose the spent budget. See [Retries and attempts](/concepts/retries/).

## Flow is not registered

**Symptom.** `Flow <tag> is not registered`, or
`<caller> handed off to flow <tag>, which is not registered with this engine`.

**Cause.** The engine holds no open registration for that flow tag. Either the
composition never provided `Interpreter.layer(flow)`, or the scope that held
the registration has already closed, or a handoff named a target flow this
engine was never told about.

**Fix.** Provide `Interpreter.layer` for every flow you execute AND for every
flow any of them hands off to. Registrations live as long as the layer scope
that created them, so check that the engine layer outlives the executions you
run under it.

## Execution id already belongs to another run

**Symptom.** `execution <id> already belongs to ...` with `field: "flow"` or
`field: "payload"`. A durable trampoline collision may instead name
`field: "lineage"`, `"round"`, or `"parent"`.

**Cause.** A caller reused an execution id for a different flow declaration,
payload, or durable round identity. The engine refuses rather than answering
with a result that belongs to a different question.

**Fix.** Make the id unique per (flow, payload). If the collision is across
tenants sharing one server, namespace the ids in one place:
[Namespace execution ids per tenant](/guides/namespace-execution-ids/). If
the payload difference is unintentional, remember that payload identity is
structural over the schema: a field added or a value changed makes a new
identity, while a declared-opaque value is compared by reference.

## One RPC request fails other pending requests

**Symptom.** A handler defect also fails unrelated requests sharing one RPC
client connection.

**Cause.** `RpcServer.layer` defaults to client-wide fatal defects. A reused
execution id with a different payload can still raise
`ExecutionIdentityConflict` as a typed `Flow.execute` failure.

**Fix.** Mount flow proxies with
`RpcServer.layer(MyRpcs, { disableFatalDefects: true })` to scope handler defects
to their requests. Execute, discard, and resume wire schemas reject empty ids,
ids longer than 4,096 UTF-16 code units, and ill-formed UTF-16 before the engine
runs. A trailing unpaired high surrogate is ill-formed. RPC answers these
decode errors with a request-scoped failure, including with the default server
options.

## Compensable action requires SnapshotBoundary

**Symptom.** `Compensable action "<name>" requires SnapshotBoundary`, and the
action body never ran.

**Cause.** An action declared `tier: "compensable"` was dispatched with no
`FlowEngine.SnapshotBoundary` in context. The engine refuses to perform an
effect it has promised it can undo when it has no way to undo it.

**Fix.** Provide a boundary, as in
[Run a compensable action](/guides/compensable-actions/), or change the
action's tier if it is genuinely sealed.

## The caller stopped waiting on a parked run

**Symptom.** `<flow>.execute: suspendedRetryPolicy expired` or
`... exhausted`, carrying the attempt count and elapsed milliseconds.

**Cause.** The caller's `suspendedRetryPolicy` is spent. `reason: "expired"`
means the elapsed-time bound closed the window while attempts remained;
`"exhausted"` means the attempt count ran out.

**Fix.** First decide whether the caller SHOULD have kept waiting. The
execution is still parked and nothing was cancelled, so another caller can pick
it up. If the wait was legitimate, widen `suspendedRetryPolicy` on the flow
declaration. If the run is parked on something that will never arrive, fix the
thing it waits for; a longer caller budget will not complete it. To bound the
WORK rather than the wait, declare a `RetryPolicy` with `expirationMs` on the
action, which the engine restores from persisted state across restarts.

## Invalid round or budget

**Symptom.** `Round rootExecutionId must be non-empty well-formed text`,
`Round ordinal must be a non-negative safe integer`, or
`Round maxRounds must be a positive safe integer when supplied`.

**Cause.** A trampoline identity or a round budget is malformed. In practice
this is a `maxRounds` of 0 or a negative number, or a root execution id that
came from somewhere other than an execution id.

**Fix.** Declare `maxRounds` as a positive safe integer. Remember it counts
rounds, so `maxRounds: 1` means no handoff at all. See
[Trampoline rounds](/concepts/trampoline-rounds/).

## A lineage spent its round budget

**Symptom.** `Flow.MaxRoundsExceeded`, with a message naming the lineage, the
flow, the requested ordinal, and the declared `maxRounds`.

**Cause.** The lineage asked for one round past its budget. The budget belongs
to the flow that started the lineage; a handoff to a flow with a different
`maxRounds` does not replace it.

**Fix.** Raise the budget on the originating flow, or make the body's branch
settle sooner. A lineage that never settles on its own is a loop, and the
budget is what stops it.

## Two concurrent dispatches of one declaration

**Symptom.** `Action.ConcurrentKeylessDispatch` naming the action, usually
under `Effect.all` with concurrency.

**Cause.** Two dispatches of one action landed in the same allocation scope at
the same time. Their identity would have to be assigned by fiber-arrival order,
and a replay in the other order would hand one dispatch the other's recorded
outcome, so the engine refuses instead.

**Fix.** Give the dispatches distinguishable identity, in one of three ways:
declare an `idempotencyKey` whose values differ, dispatch them from distinct
interpreter graph nodes, or run them in sequence.
[Step identity](/concepts/step-identity/) explains which scopes overlap
freely.

## An irreversible action tried to retry

**Symptom.** `Action.IrreversibleRetryRequiresIdempotencyKey`, naming the
action and the attempt.

**Cause.** An action declared `tier: "irreversible"` reached attempt 2 or
higher without a declared `idempotencyKey`. Re-dispatching an irreversible
effect the engine cannot address is how one charge becomes two.

**Fix.** Declare an `idempotencyKey` on the action so the engine can address
the effect, or remove the retry policy so it never retries.

## An idempotency key could not be canonicalized

**Symptom.** `Action.UncanonicalIdempotencyKey` with
`reason: "canonicalize_failed"` and a `path` into the offending value.

**Cause.** The object form of a declared `idempotencyKey` carries material the
canonical encoding rejects. The failure is non-retryable by construction: the
same declaration derives the same rejection on every attempt, and the body
never runs.

**Fix.** Follow `path` to the field and replace it with JSON-canonical data.

## A recorded outcome does not match the declared schemas

**Symptom.** The log line
`A recorded action outcome does not match the action's declared schemas`,
annotated with the action name and its recorded exit, followed by a defect.

**Cause.** A value recorded for that step key does not decode under the
action's declared success and error schemas. Usually the declaration changed
after the row was written, or an implementation returned something outside what
it declared.

**Fix.** Read the annotated exit; it names the actual value, which the bare
schema mismatch does not. Then either fix the implementation or accept the
declaration change and let the key miss: a string-form sealed key folds a
digest of the declared schemas exactly so a changed declaration misses rather
than decoding a stale row.

## A flow body failed outside its declared error schema

**Symptom.** The log line
`A flow body failed with an error outside its declared error schema`, annotated
with the flow tag and a rendered error, followed by a defect carrying that
error.

**Cause.** The body failed with a value the flow's `error` schema does not
describe. The most common source is the interpreter refusing an action that has
no implementation, in a flow that declares no error type at all.

**Fix.** Read the annotated error rather than the schema mismatch: it names the
real failure, which is usually a missing `Action.toLayer`. Add the
implementation, or widen the flow's declared error schema if the failure is
genuinely part of its contract.

**Served through a proxy, the caller sees a refusal instead.** The raw error is
the best diagnostic there is inside the process, so the engine keeps dying with
it, but it stays here. A defect crossing `FlowProxyServer` leaves the process:
the proxy logs it, and an RPC server answers the caller with `Schema.Defect` of
it, which encodes a plain object as full JSON. An implementation error is the
kind that carries the credential the call was made with, so the proxy logs the
same bounded, redacted rendering the engine writes and re-dies with
`FlowHandlerDefect`, whose `diagnostic` field carries that rendering. The
rendering redacts authorization and cookie header values, `Bearer` and `Basic`
credentials, token, secret, password, API key, credential, and private key
values, URL userinfo, and key, signature, and auth query parameters. The
engine's annotated log is also redacted; the raw defect remains available only
to in-process error handling.

## Warnings a durable store can raise

These are logged, not raised. Each one means the engine kept running on a
fallback:

| Warning                                                                    | Meaning                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no durable retry origin for "<action>"`                                   | No attempt row survives for the step key, usually from retention pruning. The `expirationMs` budget restarts from the current clock. Only a declared `retryPolicy` warns; the implicit transient policy of a repeat-safe action logs this at Debug. |
| `unusable durable retry origin for "<action>"`                             | The store reported a non-finite time or one in the future. The budget starts now.                                                                                                                                                                                                                                       |
| `rejected unusable durable latest attempt for "<action>"`                  | The store reported an attempt number that is not a safe integer. The caller's attempt number is used.                                                                                                                                                                                                                   |
| `engine: could not record the linked cancellation of child execution <id>` | A parent's cancellation could not be recorded against a child. Linked delivery is bounded to five seconds; a timeout logs `engine: linked cancellation timed out for child execution <id>`. A durable store cascades cancellation over its own parent edges, so this path is the prompt delivery and not the guarantee. |

## Two derived operations share a wire name

**Symptom.** `Flow proxy operation "<name>" is not unique`, thrown while you
wire the server rather than while it serves.

**Cause.** Operation names are derived by suffixing, so a flow set containing
both `Foo` and `FooDiscard` generates one name twice.

**Fix.** Rename one of the flows, or split them across two groups with
different prefixes.

## A flow tag has no route encoding

**Symptom.** `Flow tag "<tag>" is not well-formed UTF-16`, thrown by
`FlowProxy.toHttpApiGroup`.

**Cause.** The tag contains an unpaired surrogate, so it has no URL-safe
encoding.

**Fix.** Rename the flow to a well-formed tag.

## A cycle between executions

**Symptom.** `FlowRuntime.FlowCycleDetected` carrying the path of execution ids
it walked.

**Cause.** A child request would close a cycle, either directly or through a
fan-in that joins an execution already in the caller's ancestry.

**Fix.** Read the path: it names the executions in order. Break the loop, or
give the joining execution its own identity so it is not the same run.

## Polling an execution the engine does not know

**Symptom.** `FlowRuntime.FlowExecutionNotFound` from `poll`.

**Cause.** No engine holds that execution id. This is distinct from
`Option.none()`, which `poll` answers for a known execution that has not
settled AND for one belonging to a different flow declaration.

**Fix.** Check the id, and check that you are polling the same engine that
admitted it. A memory engine loses every execution when its layer scope closes.

## A missing Crypto service

**Symptom.** A type error naming `Crypto.Crypto` as an unmet requirement of a
program that executes a flow.

**Cause.** Every action dispatch is recorded under a derived step identity, and
deriving it is a SHA-256. The in-memory engine needs crypto for the same reason
the durable one does.

**Fix.** Provide a platform crypto layer, such as `NodeCrypto.layer` from
`@effect/platform-node`, or the browser equivalent.

# Vendored Effect flow engine

## Fork point

- Upstream repository: `Effect-TS/effect`
- Upstream commit: `23e176a4f05ed3e81cc13a5d70111099692ea9a5`
- Upstream package: `effect@4.0.0-beta.102`
- Upstream source: `packages/effect/src/unstable/workflow`
- Vendored modules, upstream name in parentheses where it changed:
  - in `@smthrs/flow`: `Flow/` (`Flow.ts`), `Action/` (`Activity.ts`),
    `FlowRuntime/` (the service half of `FlowEngine.ts`), `DurableClock.ts`,
    `DurableDeferred.ts`, `DurableQueue.ts`, and `index.ts`
  - in `@smthrs/engine`: `FlowEngine/` (`FlowEngine.ts`, split into
    `Encoded.ts`, `make.ts`, `layerMemory.ts`, `ActionKey.ts`,
    `FlowInstance.ts`, `SnapshotBoundary.ts`, `Trampoline.ts`, `Dispatch.ts`,
    `Lineage.ts`, `Round.ts`, and the barrel), `FlowProxy.ts`,
    `FlowProxyServer.ts`, and `index.ts`

The vendored source now spans two packages. `@smthrs/flow` carries the
authoring half (`Flow`, `Action`, `DurableClock`, `DurableDeferred`,
`DurableQueue`, and the runtime port those APIs are written against);
`@smthrs/engine` carries the runtime half (the encoded seam, its typed
adapter, the in-memory implementation, and the proxies). This file documents
the fork for both, and both tarballs ship `THIRD_PARTY_NOTICES.md`.

The baseline vendor commit rewrites imports that pointed elsewhere inside the
Effect repository to published `effect/*` package subpaths. Because Effect
strips its internal crypto helper from published declarations, that baseline
also carried temporary typecheck suppressions at the two helper imports; the
behavioral fork removes both imports and suppressions when identity moves to
`@smthrs/keys`. The behavioral fork is intentionally reviewable with
`git show`.

## Licensing

Effect is distributed under the MIT License, `Copyright (c) 2023 Effectful
Technologies Inc`. That license requires its copyright and permission notice to
be preserved in all copies or substantial portions of the software, and the
modules listed above are substantial portions.

The notice is therefore reproduced verbatim in `THIRD_PARTY_NOTICES.md`, which
sits beside this file, is listed in this package's `files` whitelist, and so
ships inside the `@smthrs/engine` tarball. The same notice is kept at the
repository root. `@smthrs/engine` itself remains MIT licensed under the
project's own `LICENSE`; the two notices are additive, not alternatives.

## Behavioral differences

### 1. Execution identity is caller-selected, with opt-in derivation

Upstream requires every flow to declare `idempotencyKey`, hashes the
flow tag and derived key, and always computes that ID inside `execute`.
Consequently equal payload keys join the same execution. Upstream proxy execute
and discard requests contain the flow payload directly.

Smithers makes the `idempotencyKey` option of `Flow.make` optional and adds
`executionId?: string` to library calls through `Flow.execute`. An explicit
value always wins. If it is absent, an opt-in idempotency key is decoded
through the injected `@smthrs/crypto` `Sha256` transformation. If neither exists,
the ambient `Flow.CurrentExecutionIds` source names the invocation before
`FlowEngine` is read. Its default, `Flow.fresh`, mints a fresh UUID using host
cryptography, so equal unkeyed payloads start independent executions. The
`Flow.executionId` helper resolves identity the same three ways.

RPC and HTTP execute/discard schemas instead require `{ payload, executionId }`.
Resume requires `{ executionId }`. Both server adapters validate the mandatory
client wire id and pass it through the optional server-owned `executionId`
scope. A scope may select library identity resolution by returning `undefined`
for execute/discard. Resume has no payload and requires a scoped string;
returning `undefined` there raises `Flow.ExecutionIdRequired`.

A caller that needs reattachment after a crash must retain the execution id
or declare an idempotency key. Another unkeyed library invocation starts new
work under the fresh default. A host can opt into equal-payload joins with
`Flow.layerExecutionIds(Flow.derived)`, or install a source that scopes the
minted id to its request, session, or workspace.

Upstream references:

- `Flow.ts:59`, required definition field
- `Flow.ts:80-84`, execute options without an execution ID
- `Flow.ts:316-317`, tag/key hashing
- `Flow.ts:343-363`, engine lookup followed by unconditional derivation
- `Flow.ts:429-460`, required constructor option
- `FlowProxy.ts:68-75` and `FlowProxy.ts:148-155`, direct payload schemas
- `FlowProxyServer.ts:51-71` and `FlowProxyServer.ts:118-127`, forwarding
  direct payloads

### 2. Infrastructure interruption retry is explicit

Upstream sandwiches every activity effect in a default schedule that retries
any interrupt cause up to ten times and turns exhaustion into a defect.

Smithers removes that default. Ordinary fiber interruption and flow suspension
propagate immediately. `InfraInterrupt` is an explicit marker an action adapter
may fail with for a host-loss or rebalancing event, and only that marker
consumes an action's opt-in `interruptRetryPolicy`. The shipped memory and
durable engines do not synthesize it from fiber interruption. Exhaustion still
becomes a defect.

This keeps user cancellation prompt while allowing a clustered engine to opt
into the recovery behavior it actually needs.

Upstream references:

- `Activity.ts:127-144`, activity retry option and unconditional wrapper
- `Activity.ts:181-201`, default exponential/spaced interrupt schedule

### 3. Flow authoring shape is expanded

At the upstream fork point, flows contain their tag, schemas, annotations,
required idempotency function, and suspension schedule (`Flow.ts:53-60`,
`Flow.ts:218-229`). Smithers makes the idempotency function optional and
changes execution identity as described above. The current public
`@smthrs/flow` shape also differs structurally: `Flow.make` requires a
pure plan-time `body` returning one `@smthrs/plan` `Node`. `Flow` stores
that body and exposes `.call()` for inline composition and `.child()` for
a separate child execution.

`Flow.make` accepts `description`, `capabilities`, `effects`,
`modelInvocable`, and `maxRounds` alongside schemas and annotations.
`description`, `body`, and `maxRounds` are Flow fields; capability,
effect, and model-invocable declarations are lowered into annotations.
`Flow.annotations` remains `Context.Context<never>`. These authoring
declarations are not new fields on the engine's encoded seam, nor do they
imply a placement, failure-policy, external-event, or token-budget field.
The authoring shape therefore requires structural review on an upstream
rebase, even where the encoded runtime seam is unchanged.

Current fork references:

- `@smthrs/flow/src/Flow/make.ts`, `MakeOptions`, `Body`, and `make`
- `@smthrs/flow/src/Flow/Flow.ts`, `Flow.body`, `Flow.call`, and `Flow.child`

Upstream references:

- `Flow.ts:53-60`, flow fields
- `Flow.ts:218-229`, type-erased flow fields

### 4. Suspension polling keeps its fallback and gains an optional signal

Upstream reruns a suspended root execution after sleeping on
`Schedule.min([Schedule.exponential(200, 1.5), Schedule.spaced(30000)])`.

Smithers preserves that schedule verbatim. `FlowEngine.Encoded` additionally
accepts optional `resumeSignal(flow, executionId)`, and each fallback sleep
races that signal when supplied. `@smthrs/engine-store` implements the
process-local signal with its `WakeBus`; the race is deliberately
miss-tolerant because polling remains the durable fallback. Cross-process
event delivery is not part of rc.0.

This permits prompt journal-backed wakeups without making the first durable
store depend on a signal transport or removing the safe polling fallback.

Upstream references:

- `FlowEngine.ts:448-465`, suspended execution polling loop
- `FlowEngine.ts:555-558`, unchanged fallback schedule

### 5. Action identity is supplied above the encoded seam

Upstream passes `(activity, attempt)` through `Encoded.activityExecute`; the
memory engine derives `${executionId}/${activity.name}/${attempt}` internally.
The `Activity.idempotencyKey` helper separately hashes execution ID, optional
attempt, and activity name.

Smithers passes `{ action, attempt, key, tier, metadata }` through the encoded
seam. `FlowEngine.makeUnsafe` computes `key` before dispatch with
`@smthrs/keys`: the engine builds sealed identity input and decodes it through `Key`, while
compensable, irreversible, and identity-free sealed actions use stable
per-run ordinals. `metadata` carries an optional read/write-set descriptor
without interpretation below this package boundary. The memory implementation
indexes memo state only by `(key, attempt)`. Durable clock and queue internals
use the same ordinal allocator, and no implementation derives identity from an
action name.

`Action.make` adds `tier` (default `"sealed"`), optional `idempotencyKey`,
and opaque `metadata`. Compensable dispatch requires the local
`SnapshotBoundary` hook (`snapshot`, `restore`, `diff`) and restores before a
retry. `@smthrs/engine-store` provides the boundary over `@smthrs/kernel`
`Jj`; this package does not import `@smthrs/kernel`. An irreversible retry
without a declared idempotency key dies with structured
`IrreversibleRetryRequiresIdempotencyKey` before redispatch.

This eliminates replay collisions caused by reused or renamed action names,
keeps key computation identical for memory and durable engines, preserves
write-set metadata for enforcement below the seam, and prevents unsafe
double-sends.

Upstream references:

- `Activity.ts:123-176`, activity construction without tier/key metadata
- `Activity.ts:239-262`, name-derived helper
- `Activity.ts:310-321`, dispatch before encoded execution
- `FlowEngine.ts:296-338`, encoded activity seam
- `FlowEngine.ts:471-483`, typed adapter forwarding name-bearing activity
- `FlowEngine.ts:691-715`, memory key derivation from execution ID/name
- `DurableClock.ts:100-104`, internal short-sleep activity
- `DurableQueue.ts:203-226`, internal name-derived queue identity

### 6. Deferred wakeups use `resume`, and `into` records no interrupt-only exit

Upstream (rc.108) registers each awaited deferred name in
`instance.awaitedDeferreds` before reading, and its memory engine's
`deferredDone` preempts a live run that awaits the completed deferred by
marking it suspended and interrupting its fiber, so the replay observes the
completion.

Smithers has no `awaitedDeferreds` set. `FlowInstance` carries only
`suspended` and `interrupted`, and the runtime port exposes
`resume(flow, executionId)` instead: `layerMemory.deferredDone` records the
exit first-writer-wins and then calls `resume`, which re-drives an execution
only when its last settlement was `Suspended`. A live run is never preempted
by a completion; the awaiter suspends first and is re-driven.

Because persisted deferred results are first-writer-wins, `into` must never
record an interrupt-only exit that is not a suspension. The fork's baseline
(beta.102) recorded the non-interrupt partition of such a cause — an empty
cause — which permanently poisoned replay of that deferred with
`Error: Empty cause`. `into` now records nothing for any interrupt-only exit
and only propagates `suspended` to the parent instance, matching upstream
rc.108. The interrupt-only region of `into` therefore diverges from the
beta.102 fork point; the token encoding and external completion surface cited
under "Deliberate non-changes" are unaffected.

Upstream references (rc.108):

- `DurableDeferred.ts:148`, await-side registration in `awaitedDeferreds`
- `WorkflowEngine.ts:265`, the `awaitedDeferreds` instance field
- `WorkflowEngine.ts:350-372`, completion preempting a live awaiting run
- `DurableDeferred.ts:225-240`, interrupt-only exits record nothing

## Deliberate non-changes

- `Flow.annotations` remains `Context.Context<never>`; capability and effect
  declarations do not change that annotation type (`Flow.ts:58`).
- Action exits remain schema encoded and decoded across the engine boundary
  (`Activity.ts:135-175`, `FlowEngine.ts:471-483`).
- `Flow.intoResult` retains upstream scope closure, defect capture,
  interrupt filtering, and the `Suspended` value (`Flow.ts:651-713`).
- Compensation and flow-scope finalization are unchanged
  (`Flow.ts:779-858`).
- `DurableDeferred`, including base64url `Token` encoding and external
  completion, is unchanged (`DurableDeferred.ts:268-653`).
- Durable deferreds, clock scheduling, durable queue workers, proxy resume
  operations, and schema codecs remain present. Only their identity transport
  and execute/discard envelope changed.
- The upstream exponential/spaced suspension schedule remains the fallback
  (`FlowEngine.ts:555-558`).
- No placement, failure-policy, external-event, or token-budget field was
  added to `Flow` or the encoded seam. The required graph body, description,
  and round budget belong to the expanded public Flow shape described above;
  capability and effect declarations are lowered into annotations.

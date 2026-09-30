---
title: "The sandboxed runner protocol"
description: "What SandboxedFlow puts on a machine and what comes back: the bundle, the request and result JSON, the guest composition, what the guest image must contain, and why one sandboxed execution is a single durable action to the parent."
sidebar:
  order: 2
---

There are two tiers of sandboxing in this stack, and mixing them up is the
usual source of confusion.

`Sandbox.layerHost` from [`@smthrs/sandbox`](/api/sandbox) places a body's
**side effects** on a machine. The action's TypeScript keeps running in the
engine host; only its file operations and child processes are routed to a held
session.

`@smthrs/flows/SandboxedFlow` is the tier above it. The child flow's **own
code** executes inside the guest. Its TypeScript never runs in the parent's
process. A provider is a `Sandbox.Provider` value you pass in, never a string
looked up in a registry, and the authoring is `Flow.make` and `Action.make`, so
a sandboxed child is declared the same way every other flow is.

## The five steps

Every `SandboxedFlow.execute` call runs this sequence inside one acquired
session. The protocol's own files live in `.smithers-sandbox/` under the session
workdir.

| Step    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bundle  | esbuild bundles the `entry` module (`platform: "node"`, ESM) together with the guest runner into one self-contained `.smithers-sandbox/bundle.mjs`.                                                                                                                                                                                                                                                                                  |
| request | The host writes `.smithers-sandbox/request.json`, holding `{ attempt, flow, executionId, capabilityCeiling, payload }`: a fresh nonce for this execution of the effect, the flow's tag, the session key as the guest execution id, the caller's capability ceiling, and the payload encoded through `Schema.toCodecJson` of the flow's payload schema.                                                                               |
| run     | The guest runtime (`node` by default) runs the bundle with the workdir as its working directory and `SMITHERS_SANDBOX_REQUEST_PATH` and `SMITHERS_SANDBOX_RESULT_PATH` set.                                                                                                                                                                                                                                                          |
| guest   | The runner finds the flow by tag among the entry module's exports, decodes the payload, runs the flow under the ceiling, and writes `.smithers-sandbox/result.json`: `{ attempt, capabilityCeiling, status: "succeeded", output }` with the success value encoded through the success schema's JSON codec, or `{ attempt, capabilityCeiling, status: "failed", error, denied? }`, echoing `request.attempt` and the ceiling exactly. |
| result  | The host refuses a non-zero exit, a missing or unparseable result, a result whose `attempt` or `capabilityCeiling` is absent or differs from this execution's, and a result over the limits, then decodes `output` through the same codec. Every refusal is a typed `SandboxedFlowError`.                                                                                                                                            |

The `attempt` nonce is a fresh random value for every execution of the effect,
separate from the stable `executionId` that names the session. A retry or a
replay writes a new request with a new nonce, so a result left in the workdir by
an earlier attempt cannot be mistaken for the current one: the host refuses it
as `result_unreadable`. A custom runner must copy `request.attempt` into its
result unchanged.

## Capability ceilings

`capabilityCeiling` is the caller's current authority intersected with the
child flow's own `capabilities` declaration, as the normalized any-of groups of
a `CapabilitySet`. No groups is unrestricted; an empty group denies every
capability. Inside a parent flow, the caller's authority already includes every
declaration on the way to the sandboxed action.

The guest starts unrestricted, which is the identity of intersection, and runs
the child under exactly the ceiling it was sent, including building the entry's
`layer`, its finalizers, and any fiber it forks. It can only narrow it. A
request with no ceiling or with a pattern that does not decode is a protocol
failure: the guest throws and runs nothing.

The guest echoes the ceiling it enforced. The host refuses a result whose echo
is absent or differs from what it sent, so a runner that never received or
applied the ceiling cannot report success, and the nonce refuses a result an
earlier attempt produced under a wider ceiling. Neither is proof of honesty:
the guest can read `request.json`. The ceiling binds the kernel-guarded
services the entry's `layer` composes, as the host's ceiling binds its own; the
machine is what contains code that reaches past them.

A capability the ceiling refuses fails the child with the kernel's
`PermissionDenied`, directly or inside a guarded service's `PlatformError`. When
that refusal is the child's only failure, the guest writes it as `denied`, with
its resource and reason redacted, and the host fails with that
`PermissionDenied` rather than a `SandboxedFlowError`: the same typed error a
local run fails with. A refusal beside any other failure stays `flow_failed`.
The parent journals the refusal, or on success the result with its
`capabilityCeiling` receipt, as the action's one recorded outcome.

Payload and output both cross the machine boundary through a schema round trip
on each side, never a cast. The wire codecs are service-free, the same erasure
the interpreter performs for a handoff, because a JSON codec that needs a
service to encode has no way to be satisfied on the other side of a machine.

## What the entry module must export

The entry exports the flow under any name, default export included. It may also
export `layer`, an Effect `Layer` providing the implementations of the actions
the flow's body names and the `Interpreter.layer` registration of any flow it
calls as `.child()`. An entry with no `layer` export is fine when the flow's
body needs no implementations.

## The guest composition is in-memory on purpose

Inside the guest, the flow runs under `FlowEngine.layerMemory` with
`Interpreter.layer`, `Action.layerImplementations`, the entry's own `layer`, and
a `Crypto` built on WebCrypto, which Node 26 and Bun both expose as
`globalThis.crypto`.

That is the smallest composition in the tree that drives a flow to completion
with no host services, and it is the right one here: the child completes inside
one guest process, and the parent journals the whole sandboxed execution as one
durable action. An in-guest SQLite journal would put `node:sqlite`, the
migration ladder, and a `Jj` stub into every bundle without changing the
durability the parent can observe.

The guest's digests still agree with the host's: a child execution id derived in
the guest for a `.child()` boundary is the same SHA-256 the host would derive
from the same material, so a nested child is identified identically on either
side of the machine boundary.

## Failures split two ways

The guest distinguishes outcomes the protocol can state from failures of the
protocol itself.

A flow that failed, a payload its schema refuses, and an entry module that
exports no flow of the requested tag are all statable outcomes: the guest writes
a `failed` result and exits normally, and the host reports `flow_failed` with
the child's error as its tag and fields rather than a stack trace into the
bundle.

A missing request path, an unreadable request file, or a result that cannot be
written are failures of the protocol. The guest throws, the process exits
non-zero, and the host reports the exit code and the guest's stderr instead of a
fabricated result.

## What the guest image must contain

The runtime the bundle is started with has to be on the guest's `PATH`: `node`
22 or later, or `bun`. Nothing installs one. A missing runtime is a
`guest_failed` failure that names it, so `node:22-alpine` works and bare
`alpine` does not.

The entry's imports of `effect`, `@smthrs/flow`, and `@smthrs/engine` must
resolve to the same installation the host's `@smthrs/flows` uses. One installed
version of each in the project that bundles the entry is what gives you that;
two copies of `effect` in one bundle produce a schema that refuses its own
payload.

## A session key is an exclusive claim

The `session` option is the key the machine is acquired under, and it is
exclusive. Two live executions sharing one key share a machine, and the first to
finish tears it down under the other.

Reusing a key is what resume looks like. A normal completion releases the
session, which removes the workspace; only a host crash leaves a machine behind,
and the next execution with the same key reattaches it, workspace included. That
is why deriving the key from the parent execution id is the recommended shape:
it is unique per execution and stable across a resume.

## One action for the parent

`SandboxedFlow.action(flow)` declares an ordinary durable action over the
child's payload schema, whose success is `{ output, diff }` and whose error is
`SandboxedFlowError`. From the parent's point of view the whole sandboxed
execution is one step: the engine journals one attempt, applies one retry
policy, and replays one recorded result. A second run of the parent over the
same database answers from the journal without acquiring a machine at all.

Next: [run a child flow in a sandbox](../guides/run-a-child-flow-in-a-sandbox.md).

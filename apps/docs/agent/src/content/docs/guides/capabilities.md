---
title: "Give a run capabilities"
description: "Bind the standard capability flows (filesystem, shell, tests, memory, Jev, durable wait, and approval), order them with plugin contributions, and gate calls with authorize."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/capabilities.md"
---

Every capability a cell reaches is an ordinary flow. There is no `ctx.fs`, no
`ctx.shell`, no `ctx.memory`, and no `ctx.wait`: a cell finds a flow in
`ctx.flows` and invokes it with `ctx.call`, and the boundary is the same keyed,
journaled, permission-gated activity whether the flow reads a file or calls a
remote tool. This guide covers binding the built-ins and adding your own.

Each `cell-call-settled` event carries a frame in its call identity. If a run
continues after a completion check, later frames have their own call events.

## Bind the standard flows

`StandardFlows` pairs declarations that already exist with the handlers that
already exist. Each helper takes the slice of host services its handlers
require, so two capabilities built from two different slices of the host
compose into one `flows` array:

```ts
import { ChildFlows, StandardFlows } from "@smthrs/agent"

const run = agent.run({
  // session, seat, prompt, registry ...
  flows: [
    StandardFlows.filesystem(filesystemServices), // FileSystem | Path
    StandardFlows.shell(shellServices), // ChildProcessSpawner | Path
    StandardFlows.tests(testServices), // ChildProcessSpawner | Evaluator | TestRunner
    StandardFlows.memory(memoryServices, judgeServices), // MemoryStore | Recall, Evaluator
    StandardFlows.jev(judgeServices), // Evaluator
    ChildFlows.source(children)
  ]
})
```

| Helper       | Flows bound                                                  | Context it takes                                 |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------ |
| `filesystem` | `read`, `write`, `edit`, `apply_patch`, `ls`, `glob`, `grep` | `FileSystem \| Path`                             |
| `shell`      | `bash`                                                       | `ChildProcessSpawner \| Path`                    |
| `tests`      | the project's test runner                                    | `ChildProcessSpawner \| Evaluator \| TestRunner` |
| `memory`     | `remember`, `recall`                                         | `MemoryStore \| Recall`, plus `Evaluator`        |
| `jev`        | `jev`                                                        | `Evaluator`                                      |
| `clock`      | `wait`                                                       | `Crypto \| FlowRuntime \| FlowInstance`          |
| `approval`   | `ask`                                                        | an `Asker` port, not a context                   |

All seven filesystem flows are bound, not just `read` and `write`: a host that
offers whole-file writes and nothing else forces every edit through "read the
file, then write the whole file back". `shell` takes an optional container
transport, defaulting to the docker or podman CLI, which is what makes `bash`'s
`container` field mean anything. `clock` is the one helper whose context is the
durable engine; nothing in `Agent` imports it, and `AgentSession` composes it
for you.

`memory` reaches any bank a call names. Pass a scope, after the judge when
there is one, to confine a run to one namespace:

```ts
StandardFlows.memory(memoryServices, judgeServices, {
  policy: { namespace: { kind: "agent", id: "builder" }, maxTokens: 2048, retain: "on-complete" },
  provenance: { runId }
})
```

A call naming any other bank fails with `invalid_namespace` before any I/O.

## Approval needs a human

`approval` takes a narrow injected `Asker` port rather than a fake: one `ask`
method. A host with nobody to ask binds `StandardFlows.askerNoop()`, which
refuses with `ApprovalUnavailable`, a refusal the cell may catch and route
around. A host that wants the run to wait for a person does not answer at all:
it fails with a `HarnessError` carrying a `Permission.PermissionRequired`, or
gates the call in `Agent.Options.authorize`, so the park stays in the typed
error channel where the cell can neither see nor swallow it. `AgentSession`
wires its `ask` through the control plane this way; see
[Run the agent as a control-plane run](/guides/control-plane-runs/#the-approval-gate).

## Jev needs a transport

**Every agent needs a configured evaluator.** Bind a judge through the existing
seat resolver:

```ts
const judge = Effect.gen(function*() {
  const resolver = yield* SeatResolver.SeatResolver
  const seat = yield* resolver.resolve("openai:gpt-6-astra")
  return Evaluator.layerFromSeat(seat)
})
```

Codex and Claude subscriptions need no provider API key or gateway key.
Native hosts select a configured subscription seat automatically. A missing
seat, unavailable provider or invalid judgment fails as `completion_unjudged`;
there is no API-key fallback. `Agent.run` and every `AgentAction` layer require
`Evaluator.Evaluator`, so omitting the service is a type error.

For an offline host, deliberately bind `Evaluator.layerScripted(request => ...)`.
Dispatch by question id and compute answers from the supplied evidence. One
composition shares one evaluator across its classifiers, so a completion-only
answer map cannot answer an intake screen or citation check. Unknown question
sets must refuse, and a constant yes is a disabled brake. See the repository's
[whole-host scripted judge](https://github.com/smithersai/smithers/blob/main/flows/test/fixtures/scripted-judge.ts).
`@smthrs/agent/ScriptedJudge.layer` is a deliberately limited completion-only
fixture: it checks named commands against the record and refuses other questions.
It is not a production default or a general language judge.

See [the harness's completion brake](https://harness.smithers.sh/reference/api/#completionclaim).

## Jev as a flow the cell can call

`StandardFlows.jev(judgeServices)` binds the same evaluator as one ordinary
flow named `jev`, so a cell can make its own typed judgments:

```ts
const judged = await ctx.call("jev", {
  state: { files },
  questions: Object.fromEntries(files.map((file, i) => [
    String(i),
    { type: "boolean", instructions: `Does files[${i}] implement or call authentication?` }
  ]))
})
const authFiles = files.filter((_, i) => judged.answers[String(i)].probability >= 0.8)
```

- `state` is any JSON up to 256 KiB (`defaultMaxJevStateBytes`; a host may
  only lower it). `questions` is a map of boolean, choice or score questions,
  decoded through `Classifier.Question`, so a malformed question is refused as
  `invalid_input` before any transport is asked.
- The result is `{ answers, confidence?, usage?, latencyMs }`. Answers are
  `Classifier.Answer` values: a probability, a chosen option with its
  distribution, or a score with its rung label. `usage` and `latencyMs` are the
  call's metered cost and are journaled with the call's recorded result.
- All questions in one call are answered in parallel by one request. The host
  settles a cell's calls one at a time and caps a cell's calls, so fan-out
  belongs inside one call: one question per item, not one call per item.
- It never falls back. An evaluator failure is the call's own `flow_failed`
  result, with the `EvaluatorError` code first in `error.message`
  (`refused: The gateway answered 503`), and no default answer.
- It is bound only where an `Evaluator` is bound: the helper takes
  `Context<Evaluator>` and nothing else, so a composition without a judge has
  no `jev` in its catalog rather than a stub. The native host binds it beside
  `memory`, with the judge the completion brake already uses.

Where `jev` is bound, the harness teaches it in a `cell-jev` prompt section
with one worked example: use `jev` for every judgment over more than 3 items,
make one call rather than one per item, never ask it for text, act on a boolean
at `probability >= 0.8` and on a choice or score at the provider's
`confidence >= 0.7`, and print the uncertain items instead of deciding them. A
run without `jev` is not taught it. The flow's catalog description carries the
details.

## How the catalog is composed

`flows` is an ordered list of `FlowBinding.Source`s. Plugin `cellFlows`
handlers run after them, in resolution order, and the composed catalog is both
what the model is shown and what the boundary resolves against: the declaration
digest a cell was written against is the one checked when the call arrives.
Duplicate names fail composition rather than dispatching one descriptor to
another implementation.

The catalog shown to the model is the registry's `visible()` narrowed to
model-invocable flows, so a discovered markdown flow in the registry is already
callable without a binding; `flows` is for capabilities that need a host
implementation.

## Contribute capabilities from a plugin

`CellPlugin.fromBindings` is the one-liner for a plugin that adds executable
flows:

```ts
import { CellPlugin } from "@smthrs/agent"

const deployPlugin = CellPlugin.fromBindings({
  name: "deploy",
  bindings: [/* FlowBinding.make({ flow, handler }) entries */]
})
```

The whole plugin is `name` plus bindings; ordering, `apply` filtering, and the
config waterfall are the plugin kernel's. A plugin that needs to transform
other plugins' flows writes the `cellFlows` hook itself. For the binding
contract, see [`@smthrs/harness`](https://harness.smithers.sh/reference/api/); for the kernel, see
[`@smthrs/plugin`](https://plugin.smithers.sh/reference/api/).

## Gate calls with authorize

`Agent.Options.authorize` decides whether a call may proceed, and it runs
before the call's durable boundary opens. That placement is the point: an
activity's outcome is journaled, so a permission requirement raised from inside
one would replay forever and no later grant could unblock it. Checked outside,
a park records nothing, and the resumed attempt asks again against the grant
store as it now stands.

A hook that fails with a `HarnessError` whose `cause` is a
`Permission.PermissionDenied` refuses that one call: the cell reads
`{ ok: false, error: { code: "capability_refused", message } }`, where
`message` is the hook's own `HarnessError` message, and the run goes on. The
code set is part of every sealed call key, so a denial reuses
`capability_refused` rather than adding a code; write a message your host can
recognize when it needs to tell its denials apart. Any other failure ends the
run. The call's `callMs` clock starts after the hook answers, so a hook may
wait for a person.

## Declare the envelope honestly

`Agent.Options.capabilityEnvelope` is the composition's complete authority, and
the default really is "nothing granted". It matters beyond gating: a sealed
boundary is cross-run cacheable, so a result computed under a broad envelope
must not be served to a run with an attenuated one. The envelope is folded into
the run's content environment; `Agent.run` declares the envelope it actually
built, so hosts on that path get cross-run reuse without asserting anything
false. The key rules are in [The engine port](/concepts/engine-port/).

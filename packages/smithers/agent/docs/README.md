---
title: "@smthrs/agent"
description: "Run a coding agent as a durable program: the model writes JavaScript, every capability it reaches is a journaled flow call, and the answer arrives decoded by the schema you declared."
---

`@smthrs/agent` runs a coding agent as a durable program. Each turn, the model
writes a small JavaScript program called a cell, and the cell runs in a QuickJS
sandbox. A cell's only authority is `ctx.call(flowName, input)`, so reading a
file, running a command, or asking a person is an ordinary function call that a
durable engine keys, journals, and can replay.

## Why you would reach for it

Starting an agent loop takes an afternoon. Operating one is the hard part, and
the same three failures end most runs:

- **The process dies.** Every model call and every capability call is a sealed
  step with a content key. A restart replays what already settled instead of
  paying the provider for it a second time.
- **The provider refuses.** A rate limit is a time, not a defect. A refusal that
  names a reset parks the run as a durable wait, and the recorded wake time
  survives a restart, so the resumed run waits out the deadline the first pass
  chose.
- **The answer is prose.** Every model-backed step declares an output schema.
  The schema is taught to the model and enforced against the run's final answer,
  so the next step in your flow reads typed fields instead of parsing text.

Two more controls come with the loop: durable run-wide spending records with
atomic, soft-forecast model admission, and an explicit per-cell sandbox limit.
The journal prevents restart from resetting recorded spend; reservations
coordinate concurrent calls, but cannot hard-cap a provider's actual bill.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/apps/site/docs/installation.mdx).

The package requires Node.js 26.4.0 or later. For the import forms and the
packages a runnable composition adds, see [Installation](./installation.md).

## The shortest real example

A model-backed step is an ordinary action that ships its own implementation:

```ts
import { AgentAction } from "@smthrs/agent"
import * as Schema from "effect/Schema"

const Research = AgentAction.make("docs/Research", {
  payload: { topic: Schema.String },
  output: Schema.Struct({ summary: Schema.String }),
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You are a research assistant."],
  prompt: ({ topic }) => `Research ${topic}.`
})
```

`Research.call({ topic })` records the same plan node any other action records,
`Research.layer` is the implementation you never have to write, and the step
answers with a decoded value, so a later step reads `summary` as a `string`. The
`seat` string names a model without carrying a credential: resolving it into a
live model is the host's job.
[Quickstart](./quickstart.md) runs this step end to end against a scripted
model, with no API key.

## Two ways to run the loop

`Agent` is the loop itself: one service whose single method runs one whole cell
loop and returns a `Stream<AgentEvent>`. There is no callback, no event emitter,
and no host-shaped result type, so a caller renders the stream, journals it, or
ignores it. Two adapters run that loop, and neither reimplements it:

- `AgentAction` runs it as one typed step inside a larger flow, bounded by the
  declared output schema and replayed like any other action. Workflow authors
  reach for this when the model is one step among other steps.
- `AgentSession` runs it as one whole durable run: the launch is a flow
  execution, the events land on the run's journal, and an operator steers and
  approves it. It is the production `ControlExecutor` for
  [`@smthrs/control`](/api/control). Hosts and control planes reach for this
  when the agent is the unit of work somebody manages.

## How this fits with the smithers CLI

Most people meet this agent through [`@smthrs/cli`](/api/cli), the `smthrs`
command line. Running `smthrs flow start my-flow` against a prompt flow composes
`AgentSession` from this package as the run executor, resolves the flow's
declared seat against the provider keys in your environment, and binds the
standard capability flows. The operator commands then act on that run:
[`smthrs runs steer`](/cli/runs) delivers a message the loop drains at its
next frame boundary, and [`smthrs approvals approve`](/cli/approvals) answers
the approval a cell asked a person for.

Install `@smthrs/agent` directly when you are embedding the loop in a program of
your own: a host with its own control plane, or a flow that wants one
model-backed step rather than a whole agent run. The pieces the loop is built
from are their own packages, so you can go a level deeper without leaving the
composition: the cell contract, the controller, and the sandbox are
[`@smthrs/harness`](/api/harness), the provider-neutral model protocol is
[`@smthrs/model`](/api/model), flow discovery is
[`@smthrs/registry`](/api/registry), the built-in filesystem and shell flows are
[`@smthrs/std`](/api/std), and durable cross-run facts are
[`@smthrs/memory`](/api/memory).

## The package at a glance

The root entry point exports these namespaces, and each is also importable
from `@smthrs/agent/<Module>`:

| Namespace                                      | What it is                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Agent`                                        | The agent: one service whose `run` executes one whole cell loop and returns its event stream.                       |
| `AgentSession`                                 | The production `ControlExecutor`: the agent as one durable control-plane run.                                       |
| `AgentAction`                                  | A model-backed step: an ordinary action with the agent loop as its shipped implementation.                          |
| `Seat`, `SeatResolver`                         | The declared model string and the credentialed seam that resolves it into a live model.                             |
| `QuotaPolicy`                                  | Classifies a provider refusal as a wait with a deadline, so a run parks instead of failing.                         |
| `Budget`                                       | Accumulates what a run spends across its model calls and refuses past the approved ceiling.                         |
| `EventSink`                                    | An optional tap that receives each agent event while a step runs.                                                   |
| `StandardFlows`                                | The built-in capabilities as flows: filesystem, shell, tests, memory, durable wait, and approval.                   |
| `ChildFlows`, `EngineChildren`                 | Detached child agents: the `agent/spawn`, `agent/send`, and `agent/await` flows plus the durable port behind them.  |
| `CellPlugin`                                   | The cell hooks of the shared plugin kernel: registry, flows, and model-request waterfalls.                          |
| `SmithersPlugin`                               | Teaches an agent Smithers: package and CLI facts plus `smithers.*` flows for listing, running, and inspecting runs. |
| `PromoteFlows`, `FlowStore`                    | Saving the script a run wrote as a discoverable flow, and the store its files land in.                              |
| `FlowEngineLike`                               | The harness engine port implemented on the durable engine from [`@smthrs/engine`](/api/engine).                     |
| `Checkpointed`                                 | Runs one cell call against a pinned tree instead of the live one.                                                   |
| `WorkspaceSandbox`, `InMemoryWorkspaceSandbox` | The workspace transaction contract and its in-memory implementation.                                                |
| `WorkspaceObservation`                         | Measures the workspace around a frame, so mutation accounting is a fact about the tree.                             |
| `MemorySnapshotRecorder`                       | Durable memory snapshots through the engine port.                                                                   |

Every export of every namespace, with signatures and errors, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): requirements, import forms, and the
  packages a real composition adds.
- [Quickstart](./quickstart.md): run a typed model-backed step end to end with
  a scripted model.
- Guides: [model-backed steps](./guides/model-backed-steps.md),
  [structured output](./guides/structured-output.md),
  [quota waits and budgets](./guides/quota-and-budgets.md),
  [control-plane runs](./guides/control-plane-runs.md),
  [capabilities](./guides/capabilities.md), [memory](./guides/memory.md),
  [subagents](./guides/subagents.md),
  [seat resolvers](./guides/seat-resolvers.md),
  [workspace isolation](./guides/workspace.md),
  [promoting flows](./guides/promote-flows.md), and
  [testing](./guides/testing.md).
- Concepts: [the agent loop](./concepts/agent-loop.md),
  [seats](./concepts/seats.md), [the engine port](./concepts/engine-port.md),
  and [the three policies](./concepts/policies.md).
- [Troubleshooting](./troubleshooting.md): the typed failures this package
  reports, what causes them, and what to change.

---
title: "Add a flow"
description: "Declare a second flow in a Smithers app: where the file goes, what Flow.make takes, what chat: true does and does not do, and how to give one flow its own seat."
sidebar:
  order: 1
---

A flow is a directory under the app's flows directory holding a `flow.ts` that
default-exports a tagged `Flow.make`. The directory is the flow's id, so there is nothing to register
and no id to keep in step with a file name.

## Write the file

Create `flows/summarize/flow.ts`:

```ts
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

export default Flow.make("summarize", {
  description: "Summarize a ledger entry for an operator.",
  payload: { entryId: Schema.String, audience: Schema.String },
  success: Schema.Struct({
    summary: Schema.String.annotate({ description: "Two sentences at most" }),
    risk: Schema.Literals(["none", "review", "block"])
  }),
  error: AgentAction.AgentFailure,
  prompt: ({ audience, entryId }) => `Summarize entry ${entryId} for ${audience}.`,
  system: ["Say what changed and who it affects. Do not speculate about intent."]
})
```

Five fields carry the flow:

- `description` is what a host shows when it lists the flow.
- `payload` is a struct of schema fields, and `prompt` receives the decoded
  value of exactly those fields.
- `success` is the schema the model's answer must fit. It is rendered into the
  run's teaching and enforced against the final answer, so prefer typed fields
  over prose.
- `prompt` builds the opening message from the payload.
- `system` is appended after the resolved `AGENT.ts` teaching, in that order.

Nothing here names a model. The seat comes from the nearest ancestor
`AGENT.ts`, which is [Layer files](../concepts/layers.md).

## Regenerate the tables

```bash
pnpm routes
```

```text
routes: 1 pages, 1 panes, 2 flows
```

`routes.gen.ts` now carries the flow with its three resolved layers. A flow
directory whose name breaks the route grammar is refused instead:
`flows/Summarize/flow.ts` and `flows/v1.2/flow.ts` both fail with
`invalid_name`. Nested ids are fine, and the id keeps the separator:
`flows/build/plan/flow.ts` is the flow `build/plan`.

## Decide whether it is a chat

```ts
export default Flow.make("summarize", {
  // ...
  chat: true
})
```

`chat` is routing metadata and nothing else. It decides which endpoint a host
offers the flow on: a host sends a `chat: true` flow to its turn endpoint and a
pipeline flow to its flow-run endpoint. The `aomi` template's Worker refuses a
chat flow on `POST /api/flows/run` for exactly that reason.

It does not carry a conversation across turns. Nothing in
`@smthrs/create-app/runtime` reads the field, and each turn opens its own
execution from its own payload, so a host that wants continuity owns the
history it replays into the next turn's payload.

## Give one flow its own seat

Add an `AGENT.ts` beside the flow:

```ts
import { defineAgent } from "@smthrs/create-app/app"

export const Agent = defineAgent({
  seat: "openai:gpt-6-sol",
  system: ["You review ledger entries for compliance risk."],
  limits: { calls: 64 },
  maxFrames: 24
})
```

That moves `flows/summarize` and everything below it to the new seat and leaves
its sandbox and tools resolving to the root. The lines above are the whole
teaching those flows get: nothing merges with the root `AGENT.ts`.

Run `pnpm routes` again, and the flow's row in `routes.gen.ts` points at the
new layer.

## Add a test

Every flow should carry a `flow.e2e.ts` that replays a recorded model
transcript, so the suite runs offline:

```ts
import { cachedModelTest } from "@smthrs/create-app/testing"
import type * as Schema from "effect/Schema"
import Flow from "./flow.ts"

type Payload = typeof Flow.payloadSchema.Type
type Output = typeof Flow.successSchema.Type

cachedModelTest<Payload, Output>("summarize flags a risky entry", {
  fixture: new URL("./fixtures/risky.json", import.meta.url),
  flow: "summarize",
  payload: { entryId: "e-1042", audience: "the compliance desk" },
  expect: (output) => {
    if (output.risk === "none") throw new Error("expected the entry to be flagged")
  }
})
```

Recording the fixture is [Test a flow](./test-a-flow.md).

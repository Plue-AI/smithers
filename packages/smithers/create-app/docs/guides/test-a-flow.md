---
title: "Test a flow"
description: "Run a routed flow through the production agent loop against a recorded model transcript: what replay guarantees, how to record a fixture, and what a recording refuses to write."
sidebar:
  order: 5
---

`cachedModelTest` runs one routed flow end to end. The agent loop, the sandbox,
the tool bindings, and the output schema are the production ones. Only the model
is replaced, by a transcript recorded from a real provider, so the suite runs
offline and grades the same model turn on every commit.

## Write the test

The `@smthrs/create-app/testing` entry is ESM-only, like Vitest itself. Use
`import`, not CommonJS `require`.

A flow's test sits beside it, so the fixture URL is relative:

```ts
import { cachedModelTest } from "@smthrs/create-app/testing"
import type * as Schema from "effect/Schema"
import Flow from "./flow.ts"

type Payload = typeof Flow.payloadSchema.Type
type Output = typeof Flow.successSchema.Type

cachedModelTest<Payload, Output>("chat answers a balance question", {
  fixture: new URL("./fixtures/balance.json", import.meta.url),
  flow: "chat",
  payload: { message: "What is vitalik.eth's balance?" },
  expect: (output) => {
    if (!output.answer.includes("ETH")) throw new Error("expected an ETH figure")
  }
})
```

`cachedModelTest` registers a Vitest test. `runCachedModelTest` is the same
body without the registration, for a harness that is not Vitest or for a test
of the harness itself.

Four options change what it runs against:

| Option   | Default                       | What it is for                                |
| -------- | ----------------------------- | --------------------------------------------- |
| `live`   | none                          | Builds the live model for a recording run     |
| `routes` | re-run the router over `root` | Supply the routed flows directly              |
| `dirs`   | `app`, `flows`, `tools`       | An app whose source layout is not the default |
| `root`   | `process.cwd()`               | The app root the default loader walks         |

## What replay guarantees

The fixture is decoded with [`@smthrs/testing`](/api/testing)'s `Fixture`
schema and served by its recorded model. There is no network call and no API
key on that path: every declared seat resolves to the recorded model, and the
prepared request the seat carries is a credential-free placeholder.

The flows the test may run are resolved by re-running the router and importing
only the named flow and its three layer files. `routes.gen.ts` is deliberately
not used: it statically imports every page and the shell layout so the Worker
bundle sees them, and those pull in React and a virtual module that exists only
while Vite is running. A model test has no business loading the UI graph.

Each imported layer file is checked for the export it owes, and named when it
does not have one:

```text
AGENT.ts must export `Agent` built by defineAgent
```

A recorded provider refusal is stored whole, retry metadata included, and
reconstructed field for field on replay, so a run that parks on a reset-bearing
refusal takes the same branch it took when recording. A kernel permission
decision is not recorded: it is not a provider response, and replaying it would
hand the code under test a refusal the provider never made.

## Record a fixture

Recording needs a live model, and the harness will not invent one:

```ts
cachedModelTest<Payload, Output>("chat answers a balance question", {
  fixture: new URL("./fixtures/balance.json", import.meta.url),
  flow: "chat",
  payload: { message: "What is vitalik.eth's balance?" },
  live: () => liveModel(),
  expect: (output) => {
    if (!output.answer.includes("ETH")) throw new Error("expected an ETH figure")
  }
})
```

Then run the suite with the environment variable set:

```bash
SMTHRS_RECORD=1 pnpm test
```

The `aomi` template ships this as `pnpm test:record`, and its
`test/support/liveModel.ts` is the worked example of a `live` function. Omit
`live` on a flow that is only ever replayed: recording then fails with a
message instead of running silently against a model that answers nothing.

A recording reads the credential for whatever provider the flow's seat names,
so switching `AGENT.ts` from an `anthropic:` seat to an `openai:` one changes
which key the recording run needs.

## What a recording refuses to write

The fixture is written only by a run that reached the end of its assertions,
and only when the run made at least one model call. A provider refusal, a
payload the flow rejected, or an assertion that no longer holds leaves the
committed fixture untouched, so a red test never silently rewrites the
transcript that made it red.

The write goes through a neighbouring temporary file and a rename, so an
interrupted process cannot leave a truncated fixture behind.

A fixture stores every system prompt, message, and tool result verbatim, and
you commit it. Before writing, the recording checks the text against every
environment variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`,
or `CREDENTIAL` and whose value is at least eight characters. A match refuses
the write and names the variable. That check cannot see a secret that is not in
the environment, so read the fixture before you commit it.

## Common refusals

| Message                                                | Cause                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `no fixture at <path>. Record one with ...`            | Replaying a test whose fixture is not committed yet                                   |
| `flow "<id>" is not routed. Known flows: ...`          | The `flow` option does not match a routed id, often because `pnpm routes` has not run |
| `SMTHRS_RECORD=1 needs a live model`                   | Recording a test that declares no `live`                                              |
| `recording produced no model calls`                    | The run finished without reaching the model                                           |
| `the recording of <path> contains the value of <NAME>` | A prompt or tool result echoed a credential; the fixture was not written              |
| `<path> is not a @smthrs/testing fixture`              | The fixture drifted from the schema; record it again                                  |

Each one is expanded in [Troubleshooting](../troubleshooting.md).

## Keep the runner off Vite

Run the flow suite with a Vitest config that carries no plugins:

```ts
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["flows/**/*.e2e.ts", "test/**/*.test.ts"],
    environment: "node",
    testTimeout: 300000
  },
  resolve: { dedupe: ["effect"] }
})
```

Nothing under test needs workerd, and the create-app plugin would regenerate
the route tables on every run. Regeneration is `pnpm routes`. The `dedupe`
entry ensures every bundled package shares one Effect runtime and one set of
service tags.

The timeout is sized for the slower of the two modes. A replay is fast; a
recording makes real provider calls.

---
title: "Expose flows to cells"
description: "How to pair a flow declaration with its handler using FlowBinding, compose bindings into a catalog, disclose them through a registry, and resolve ctx.call with CellCalls."
sidebar:
  order: 2
---

A cell's only authority is `ctx.call(flowName, input)`, so every capability an
agent can reach has to arrive as an ordinary flow declaration plus the code
that runs it. Standard host capabilities, incoming MCP tools, and subagents
all take this one shape. `FlowBinding` pairs the two halves; `CellCalls`
resolves a call name against the registry and dispatches to the body the
declaration names.

## Bind one flow

`FlowBinding.make` takes a flow declaration and a handler:

```ts
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Effect, Schema } from "effect"

const echo = FlowBinding.make({
  flow: {
    name: "echo",
    description: "Echo one string back.",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String, length: Schema.Number }),
    capabilities: [],
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
  },
  handler: (input) => Effect.succeed({ text: input.text, length: input.text.length })
})
```

The declaration is the `FlowBinding.Declared` shape plus `input` and `output`
schemas; the `Flow.make` declarations of [`@smthrs/core`](/api/core) satisfy
it as-is. The handler receives the decoded input and the `Cell.Call` itself,
because a handler that opens a durable boundary of its own needs
`call.identity` as a replay-stable name for it.

A binding is `{ descriptor, run }`:

- `descriptor` is an ordinary `FlowDescriptor` from
  [`@smthrs/registry`](/api/registry), projected by
  `FlowBinding.descriptorOf`. `make` derives the body's content digest from
  the handler source and renders both schemas as inline JSON Schema documents,
  which is what puts a parameter schema beside the flow in `ctx.flows`.
- `run` decodes the call's input through the input schema, executes the
  handler, and validates the handler's output back into serializable JSON.

A handler with remaining service requirements produces a `Binding<R>`; close
them with `FlowBinding.provide(binding, context)` before composing.

## How a call settles

Inside `run`, every failure lands where the cell contract says it must:

- Input the schema rejects settles as a resolved `invalid_input` failure
  without running the handler. For struct inputs, a failed decode retries once
  with `null` omitted only from declared optional fields that reject it on the
  encoded side. Schema-valid nulls remain present; the full schema validates
  the retry. If it still fails, the original rejection is reported.
  The encoded input must be a struct-like object; unions of structs and
  records get no null-omission retry.
- An ordinary handler failure settles as a resolved `flow_failed` with the
  opaque message `Flow <name> failed.` No raw error message, object, or cause
  enters the call result or its journal record.
- Output the output schema rejects, or that is not serializable, settles as
  `flow_failed` naming which.
- Existing `HarnessError` values pass through the error channel unchanged,
  preserving their code and identity.
- `PermissionRequired` and `PermissionDenied` become `HarnessError` values
  with code `suspended`, so a cell cannot ignore its own permission park.
  Interruptions are never caught.

A binding can opt safe details into the public failure using
`publicError: (error: E) => string | undefined`. Select only fields approved
for cells and journals, for example a public status code. The returned text
is bounded before it enters the call result. Returning `undefined`, throwing,
or returning a non-string at runtime uses the opaque default. Harness and
permission errors bypass this renderer.

Raw diagnostics remain in the host handler. Inspect them there, for example
with `Effect.tapError`, and redact credentials before logging or persisting
anything. `publicError` is an explicit disclosure decision, not a sanitizer;
forward `message` only for error classes the host authored with model-facing
text; never forward messages of transport, SDK, OS, or unknown errors,
headers, URLs, or serialized causes.

## Compose a catalog

`FlowBinding.Source` produces bindings, possibly effectfully, so a lazily
connected server or a plugin contributes without being resolved at import
time. `FlowBinding.source(name, bindings)` lifts a fixed list into one.
`FlowBinding.catalog` resolves ordered sources into one
`FlowBinding.Catalog`:

```ts
const catalog = await Effect.runPromise(
  FlowBinding.catalog([FlowBinding.source("standard", [echo])])
)
```

A catalog refuses two implementations under one name: `catalogResult` fails
with a `HarnessError` of code `assembly_failed`, because one descriptor
dispatched to another implementation is how a call runs the wrong body. An
unnamed binding fails the same way with its own message.
`FlowBinding.empty()` is the empty catalog.

## Disclose through a registry

`FlowBinding.registry(base, catalog)` discloses a catalog's descriptors
through an existing `Registry.Registry`:

- File-discovered entries keep their names: a binding whose name a discovery
  source already found is not disclosed, and the shadowed binding is reported
  as an ordinary `duplicate_name` warning. Discovery precedence stays exactly
  where discovery put it.
- `list`, `visible`, `getOption`, and `get` answer from both sources; body
  loading, prompt rendering, and refresh pass through to the base registry.

## Resolve calls with CellCalls

`CellCalls.make` turns a call name into the body that answers it:

```ts
import * as CellCalls from "@smthrs/harness/CellCalls"

const resolver = CellCalls.make({
  registry,
  catalog,
  implementations: new Map(),
  prompt: runMarkdownFlow
})
```

The resolver's `run` has exactly the shape a durable host's call runner
consumes, so the host wires it in behind `EngineLike.call`. Resolution works
in this order:

1. The registry must know the name, or the call settles `unknown_flow`.
2. The descriptor must be model-invocable, or the call settles
   `capability_refused`.
3. The descriptor's declaration digest must equal the digest folded into the
   call's identity, or the call settles `declaration_changed`. The registry is
   refreshable, and this check is what keeps a call bound to the declaration
   the agent was shown.
4. An executable binding answers first, after an identity check that the
   binding's declaration is the disclosed one. A markdown flow renders against
   the call's arguments and runs through the `CellCalls.PromptRunner` the host
   supplied, or settles `unimplemented` when the host runs none. Anything else
   dispatches to the host's `Implementation` for the name, or settles
   `unimplemented`.

Every refusal is a `failure` `Cell.CallResult` that resolves in the cell as
`{ ok: false, error }`. Inspect `.ok === false` and `.error.code` to recover;
ordinary refusals do not throw.

## Next steps

- To run cells against the bound catalog, see
  [Run cells in a persistent realm](./run-cells.md).
- To wire the resolver into the controller's durable call boundary, see
  [Drive the cell loop](./drive-the-loop.md).
- For the contract details, see [`FlowBinding`](../api.md#flowbinding) and
  [`CellCalls`](../api.md#cellcalls) in the API reference.

---
title: "Scope a flow tree to a namespace"
description: "Attach a memory policy to a flow tree with withMemory, bind the policy-carrying declaration, and record provenance on every write."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/guides/scope-a-flow-tree.md"
---

A memory policy decides which namespace a flow tree reads and writes, the default recall budget, and whether recall and retention run at all. [Memory policies](/concepts/policies/) explains the model. This guide attaches one and binds it.

## Attach the policy

Call `WithMemory.withMemory` with the flow and the policy. It returns a copy carrying the policy; the original is untouched:

```ts
import * as Flows from "@smthrs/memory/Flows"
import * as WithMemory from "@smthrs/memory/WithMemory"

const scoped = WithMemory.withMemory(Flows.recall, {
  banks: ["flow-release-notes"],
  maxTokens: 2048
})
```

The policy is decoded and deeply frozen at this call, so an invalid policy (an empty bank name or list, a `maxTokens` above 65,536) throws a typed `MemoryError` here rather than failing later at a SQL constraint.

## Bind the policy-carrying declaration

Bind the same declaration the caller will run. For delegated work that is the copy `withMemory` produced, not the bare export, so build the handler from that same copy with `Flows.handlersFor`:

```ts
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Flows from "@smthrs/memory/Flows"

const bound = WithMemory.withMemory(Flows.recall, policy)
const binding = FlowBinding.make({ flow: bound, handler: Flows.handlersFor(bound).recall })
```

The copy keeps the declaration's input and output schemas, which is what makes that call compile: `FlowBinding.make` reads `flow.input` to type the handler. Binding `Flows.recall` with the bare `Flows.runRecall` instead uses the caller's banks and the recall service's budget default, without enforcing the policy namespace or `recall: "none"`.

Every handler takes exactly one argument, the decoded flow input, because `FlowBinding.make` types its handler as `(input, call)` and passes the `Call` in the second position. Bind run coordinates once, when the handler is built:

```ts
const handlers = Flows.handlersFor(boundRemember, {
  runId: "run-1",
  nodeId: "node-7",
  iteration: 0
})
```

Every fact the returned `remember` handler writes records that provenance. A provenance parameter on the handler itself would receive the `Call` and persist it as the fact's provenance. `Flows.runRememberWith(provenance)` is the same binding without a policy.

## Call the scoped handlers directly

Outside a host, `Flows.runRecallFor` and `Flows.runRememberFor` apply a flow's policy to one call. The policy namespace is an allowlist. Empty banks use it; explicit banks must resolve to the same `kind` and `id`. A foreign bank fails with `invalid_namespace` before the recall service or store runs. A mixed recall request also fails in full. Equivalent spellings such as `release-notes` and `flow-release-notes` are allowed. Every declared bank is readable and writable. An explicit `maxTokens` still overrides the budget default:

```ts
import * as Flows from "@smthrs/memory/Flows"
import { Effect } from "effect"

const scopedCalls = Effect.gen(function*() {
  // banks and maxTokens come from the policy because the caller named none
  const rows = yield* Flows.runRecallFor(scoped, { banks: [], query: "changelog" })

  // bank resolves to the policy namespace because the caller left it empty
  const written = yield* Flows.runRememberFor(scopedRemember, { bank: "", key: "release", text: "cut 0.1.0" })

  return { rows, written }
})
```

Two policy values short-circuit before bank validation or I/O: `recall: "none"` answers no rows and never reaches the recall service, and `retain: "never"` answers `{ key }` while nothing reaches the store.

Given a declaration that carries no policy, `handlersFor`, `runRecallFor`, and `runRememberFor` fail with `invalid_namespace` before any I/O. Bare handlers, direct `runRecall` / `runRemember` calls, recall services, and store methods do not enforce flow policies. Bind the policy-carrying declarations for model-facing access.

## Cover generated work with MemoryTrellis

`MemoryTrellis.make` is the delegation case. `Trellis.make` from [`@smthrs/patterns`](https://smithers-patterns.smithers.sh/reference/api/) declares the topology a model-authored plan fits inside and fills its leaf slots at run time, so a leaf cannot be handed a namespace at declaration time. `MemoryTrellis.make` applies one policy to the author, to the leaf, and to the memory flows those declare, then annotates the trellis itself.

It takes what `Trellis.make` takes, plus `memory`. `Trellis.make` accepts any member it can record a call to; a memory trellis needs more of its author and its leaf, because a policy is an annotation and a member states no annotation bag, so both are declarations here. The `envelope` bounds the plan the author is allowed to produce: `fuel` is the total number of leaf calls, `depth` the nesting the plan may reach, and `fanout` the members any one group may hold.

```ts
import * as MemoryTrellis from "@smthrs/memory/MemoryTrellis"

const trellis = MemoryTrellis.make({
  author: planner,
  leaf: worker,
  envelope: { fuel: 6, depth: 3, fanout: 3 },
  memory: {
    banks: ["flow-release-notes"],
    maxTokens: 2048
  }
})
```

The graph is the plain trellis graph, node for node. When you drive the plan yourself with `Trellis.run` rather than calling the declared flow, take the scoped author and leaf from `MemoryTrellis.parts`; calling the originals instead loses the policy. For the trellis itself, see the [`@smthrs/patterns` delegation guide](https://smithers-patterns.smithers.sh/delegation/).

## Next steps

- Store through the bound handlers: [Store facts, notes, and history](/guides/store-facts/).
- Understand why a policy is an annotation: [Memory policies](/concepts/policies/).

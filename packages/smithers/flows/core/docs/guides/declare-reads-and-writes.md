---
title: "Declare what a step reads and writes"
description: "Attach an effect declaration to a flow or a node, keep each step inside the envelope it inherits, and choose what the planner does when two steps write the same path."
sidebar:
  order: 5
---

An effect declaration says which resources a step touches. The planner checks
that every step stays inside the envelope it inherited, and compares every pair
of writers to find the ones that would race. Both checks are plan-time data
work: nothing opens a file.

## Declare an envelope on the signature

A signature's declaration is the envelope for everything beneath it: its body,
and every call that body makes.

```ts
import { Effects } from "@smthrs/core"
import { Action, Flow } from "@smthrs/flow"
import * as Schema from "effect/Schema"

const Write = Action.make("write", {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.Void,
  effects: Effects.make({
    reads: ["src/index.ts"],
    writes: ["out/report.json"],
    mode: "hermetic",
    onConflict: "serialize"
  })
})

const Publish = Flow.make("publish", {
  payload: {},
  success: Schema.Void,
  effects: Effects.make({
    reads: ["src/**"],
    writes: ["out/**"],
    mode: "expected",
    onConflict: "serialize"
  }),
  body: () => Write.call({ path: "out/report.json" })
})
```

The callee claims less than the caller granted, which is allowed. Claiming more
is not. For the coverage grammar behind "less", see
[Effect envelopes](../concepts/effects.md).

## Check the claim yourself

`Effects.narrow` applies the same three rules `Graph.build` applies, so you can
check a declaration in a test without building a graph:

```ts
const envelope = Effects.make({ reads: ["src/**"], writes: ["out/**"], mode: "expected", onConflict: "serialize" })
const step = Effects.make({ reads: [], writes: ["secret.txt"], mode: "hermetic", onConflict: "serialize" })

const result = Effects.narrow(envelope, step)
if (!result.ok) console.error(result.code, result.paths)
```

| Result code               | Cause                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `effect_outside_envelope` | A read or write path the envelope does not cover. `paths` names them. |
| `effect_mode_widening`    | A `hermetic` envelope with an `expected` step.                        |
| `effect_tier_widening`    | A step whose tier is less reversible than the envelope's.             |

All three are fatal when `Graph.build` records them, so the graph compiles no
drafts until you fix the declaration.

## Read the diagnostics from a build

```ts
import { Graph } from "@smthrs/core"

const Escaping = Flow.make("escaping", {
  payload: {},
  success: Schema.Void,
  effects: Effects.make({ reads: ["src/**"], writes: ["public/**"], mode: "expected", onConflict: "serialize" }),
  body: () => Write.call({ path: "out/report.json" })
})

const graph = Graph.build(Escaping, {})

console.dir(Graph.diagnostics(graph).map(({ code, node, path }) => ({ code, node, path })))
```

```text
[
  { code: 'effect_outside_envelope', node: 'root.flow', path: [ 'out/report.json' ] }
]
```

Here `Write` declares `out/report.json` and `Escaping` granted only `public/**`, so the
action call is refused. `node` names the node
whose declaration was refused, so you can find it in your source by its
structural position. The declaration is static: changing the call's `path`
payload alone does not change its declared effect paths.

An empty payload is `{}`. Primitive values belong in a named field of the
struct payload, so both the declaration and every call use the same shape.

## Two writers of one path

[`@smthrs/flow`](/api/flow) owns the comparison: its graph builder records a
conflict when two writers' effective write declarations overlap, orders them
under `serialize`, lanes them under `lane`, and refuses the plan under `fail`.
The stricter declaration decides: `fail` beats `lane`, and `lane` beats
`serialize`, so one careful step can refuse to share a path with a careless
one. Its reference documents each strategy and the diagnostics it records.

## Declare a sealed envelope

Set `mode: "hermetic"` and `tier: "sealed"` in the flow's explicit `effects`
option. Keep its complete reads, writes, and conflict policy. Sealed mode does
not establish a content cache contract for an action: an explicit idempotency
key and implementation version are still required for content sharing.

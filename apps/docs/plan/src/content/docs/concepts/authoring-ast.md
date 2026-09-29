---
title: "The authoring AST"
description: "Node and Planned: how a flow body describes topology as pure data, why map transforms and branch decides, and how a closure survives as a digest."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/concepts/authoring-ast.md"
---

`Node` is the shape a flow body describes, and nothing more. Building a node
records an inspectable, closure-free, JSON-serializable description and executes
nothing. `Planned` is the strict placeholder that body sees wherever a step
result will be.

Together they are the layer above the persisted plan. Neither runs anything.

## Building a node runs nothing

```ts
import * as Node from "@smthrs/plan/Node"

const greeting = Node.map(Node.succeed({ name: "world" }), (value) => value.name.toUpperCase())
```

`greeting` is a value holding an AST. The mapper has not run, and `succeed` has
produced no string. The same split as a build system's action declaration: you
describe the work, and something else decides when to do it.

The AST has nine variants: `Succeed`, `Fail`, `All`, `Map`, `AndThen`,
`Branch`, `Catch`, `FlowCall`, and `ActionCall`. `Node.Ast` is the union, and
every node exposes it as `node.ast`.

## Requirements are phantom

A node carries Effect's requirement channel, `R`, and carries it as a phantom.
Nothing at plan time reads it: the AST, the graph built from it, its key
material, and every digest are identical whatever `R` says.

It exists so a value that names an implementation it does not carry, an action
call, can say so in its type, and so the place that finally has to run that
implementation can demand it. Building a plan stays requirement-free; only
executing one is not.

## Map transforms; branch decides

`Node.map` is transformation only. The function is digested, not run: it
executes later, on the real value. A `map` that decides what happens next is a
`branch` written wrongly.

`Node.branch` takes both arms and evaluates each once, symbolically, against a
`Planned` placeholder. The resulting ASTs are what the node stores, so a plan
shows the exit condition and both continuations before it runs. The predicate is
digested and evaluated at run time on the real value.

```ts
import { Action } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Schema from "effect/Schema"

const Draft = Action.make("docs/Draft", { payload: { topic: Schema.String }, success: Schema.String })
const Publish = Action.make("docs/Publish", {
  payload: { text: Schema.String, urgent: Schema.Boolean },
  success: Schema.String
})

const article = Node.bindPlanned(
  Draft.call({ topic: "durable plans" }),
  (text: Planned.Planned<string>) =>
    Node.branch(Node.succeed({ urgent: true }), {
      if: (flags) => flags.urgent,
      then: () => Publish.call({ text, urgent: true }),
      else: () => Publish.call({ text, urgent: false })
    })
)
```

Both arms contribute their requirements, because both arms are topology the plan
carries. A run takes one of them, but which one is not known until the predicate
sees the real value, so an execution has to be able to take either.

`Node.catch` is the same idea for failures: the protected graph and the failure
arm are both stored, and the arm is built once at plan time against a strict
planned error placeholder. With no schema the whole typed error channel is
handled; with one, only the values it accepts, and the remainder survives in the
resulting error type.

## There is no loop node

A plan is always a DAG, so this module has no loop and never will. Repetition
lives one level up, in what a flow settles with.

`Node.all`, `Node.race`, `Node.any`, and `Node.quorum` have the same boundary. Its width is fixed at plan time. Fanning out
over something a step discovered is not `all`: end the round and carry the list
in the next flow's payload, where it is real data.

## Planned values

A `Planned<T>` may be passed into a payload field, into a branch, or into a map,
and field access is allowed, because it records a reference path. It may never
be computed on.

Misuse fails twice. The type is branded, so arithmetic on a planned value is a
compile error. The proxy's `Symbol.toPrimitive`, `valueOf`, `toString`,
`toJSON`, application, `in`, and enumeration traps throw a `GraphBuildError`
rather than let a plan be built around `NaN` or `"[object Object]"`, which
catches template interpolation, `String(value)`, and `JSON.stringify` of a
payload holding one.

```ts
import * as Planned from "@smthrs/plan/Planned"

declare const files: Planned.Planned<{ readonly count: number }>

/** Records the path ["count"] and stays a placeholder. */
const count: Planned.Planned<number> = files.count
```

Reading `files.count` is a reference. Interpolating it into a string is
computation, and the refusal names both the node and the recorded path, so the
message says which value in which body was misused.

JavaScript exposes no trap for `Boolean(value)` or strict identity, so those
cannot be refused at run time. They reveal only proxy truthiness or identity and
never the planned result. Use `Node.branch` for a decision on a real value.

`Planned.TypeId` is interned, so a value that crossed a module boundary is still
recognized. Interning is a recognition aid rather than a capability:
`Planned.reference` returns a reference only when the value stored under that
symbol has the complete `{node, path}` shape.

## Payloads become inert JSON

A payload is stored as its inert JSON mirror. A data-valued callable `toJSON` is
honored, so a `Date` or a `URL` keys as the value it serializes to rather than
as an empty object. A function or symbol member is dropped from an object and
becomes `null` in an array. Shared references and cycles clone as they were
written.

Accessors and unsupported prototypes without `toJSON` fail as `invalid_payload`.
A `toJSON` that returns its own receiver fails as `cyclic_payload` rather than
collapsing to an empty object. The clone and the input therefore key identically
or refuse together.

## Functions survive as digests

The functions an author writes, a mapper, a continuation, a branch predicate,
live in `WeakMap`s keyed by the AST node they belong to. The AST keeps only a
`FunctionIdentity` digest of the function's exact source.

Exact source matters, because whitespace inside a string literal is behavior.

A function whose inert captures were declared with `Node.capture` digests those
captures and gets deterministic identity. Every other function additionally
carries process-local, per-function entropy, so two indistinguishable closure
sources fail closed instead of sharing a cache key.

```ts
import * as Node from "@smthrs/plan/Node"

const suffixed = Node.capture({ suffix: "!" }, (value: string) => `${value}!`)
```

`capture` refuses a capture record nested past 256 levels with a path-bearing
error rather than overflowing the native stack, and refuses accessors, exotic
prototypes, symbols, and cycles for the same reason it refuses them in a
payload: an identity that cannot describe the function's behavior is worse than
no identity.

## Recognizing a node

`Node.isNode` recognizes a node this package built, by registration at
construction. It also recognizes a rehydrated node, an object sharing the node
prototype whose own `ast` is a well-formed AST, by that shape, because
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/) hands an AST that crossed a serialization boundary
back as a node.

`Node.TypeId` is a public string any object can carry and counts for nothing on
its own. Every combinator that admits a node reads its `ast` as trusted
topology, so an object carrying the marker on any other prototype, one
inheriting it from a node, and one whose `ast` is missing, malformed, or cyclic
are all refused with the same `GraphBuildError` as any other non-node. A proxy
is judged by the shape it forwards.

## How a flow call joins the plan

`Node.flowCall` takes a mode. `inline` splices the callee's body into the
caller's plan, `boundary` makes the call one child execution, and `handoff`
names the next trampoline round.

The child call is `FlowCall{mode: "boundary"}` rather than a second AST tag
beside `FlowCall`. The three modes are one authoring construct, a call to a
named flow with a payload, differing only in how the plan joins it, and every
consumer (`Graph.build`'s expansion test, key material, the interpreter's
dispatch) already switches on `mode`. A parallel `ChildCall` tag would duplicate
the flow tag, payload, and declaration side table in every one of them.

## The engine members

`Node.flowCall`, `actionCall`, `declaration`, `continuation`, `mapper`,
`predicate`, `catchFilter`, and `functionIdentity` exist for
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/), which owns flow and action authoring. They are
supported names, not authoring API: they validate nothing, and several of them
answer `undefined` for an AST that was rehydrated from JSON, because the side
tables holding the real functions do not survive serialization.

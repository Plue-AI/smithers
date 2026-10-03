---
title: "Reuse a discovered flow's result"
description: "Declare a cache policy on a discovered flow, understand how it changes the plan the engine builds, and satisfy the sealed-tier gate that decides whether a recorded result is served again."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/registry/docs/guides/reuse-a-flow-result.md"
---

A discovered flow can declare that its result may be recorded and served to a
later run asking the same question. Declaring it is one annotation. Having it
honored takes two more things, and both are stated in the descriptor.

## Declare the policy on the body

The policy is `CacheEnvironment.CachePolicyAnnotation`, the annotation
`@smthrs/patterns`' `withCache` writes. A module that delegates to an agent
declares it on the `@smthrs/core` signature, which is the body-less form of a
declaration. The `name` is the tag, and it is required: it is what the plan
records and what a host binds to, so a file flow declares the name its path
derives.

```ts
"use server"

import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Schema } from "effect"

export default ({
  name: "cacheable",
  description: "Delegates to the agent and declares a reusable result.",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ greeting: Schema.String }),
  flows: [],
  capabilities: [],
  effects: {
    reads: [],
    writes: [],
    mode: "hermetic",
    onConflict: "serialize",
    tier: "sealed"
  }
}).pipe(Flow.annotate(CacheEnvironment.CachePolicyAnnotation, { ttlMs: 60_000, scope: "shared" }))
```

`ttlMs` bounds the age of the row the engine may serve. `scope` narrows the
address it is stored under; `shared` is the unnarrowed reach.

## Declaring one changes the plan

Without a policy, the delegation is a **call**: the delegate's own node goes
into the plan the engine builds for the bridged flow, so its fan-out, its
priorities, and its waits are the caller's plan, and a host reading that plan
sees the real work. That shape is many steps, and there is nothing in it for a
policy to govern.

A declared policy asks for one recorded unit instead. The bridge dispatches a
single action carrying the descriptor's tier, its file boundary, and the
policy, and runs the delegate underneath it as a **child execution** derived
from the parent's. The child keeps its own execution, journal lineage, and
retry policy beneath the step rather than being hidden inside it.

Deriving the child id from the parent's keeps two runs' children apart while
making a retry of one parent's step reattach to its existing child. The ambient
default mints a fresh UUID for unkeyed invocations; relying on that source here
would create a new child on every retry. The bridge supplies the stable child
id explicitly, independent of the host's chosen execution-ID source.

## The gate: a sealed tier

[`@smthrs/engine-store`](https://engine-store.smithers.sh/reference/api/)'s `ActionPersistence` reuses a
`sealed` dispatch and nothing else. The tier on that dispatch is the
descriptor's own, declared or inferred, and the bridge never widens it.

So a descriptor that names a delegate flow and declares no capabilities cannot
have a result reused. Naming a delegate makes its authority unreadable to
discovery, which projects the conservative wildcard and an `irreversible` tier,
and its policy reaches admission and is refused there. Declared capabilities
narrow that wildcard, and the narrowed set decides the tier. Anything else would let a flow with unbounded
authority declare its own result reusable. See
[Declared authority](/concepts/authority/).

The descriptor whose result travels declares three things:

| Requirement                                                                                               | Why                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capabilities that project a `sealed` tier, or an explicit `tier: "sealed"` that the inference agrees with | `ActionPersistence` reuses a sealed dispatch and nothing else.                                                                                                                                                                       |
| `mode: "hermetic"`                                                                                        | The declared reads and writes are complete, which is the hard boundary a shared result needs. `expected` records a deviation rather than refusing the result, which is not a claim a cache can rest on.                              |
| No declared `reads`                                                                                       | A declared read carries no digest at discovery time, so the whole read set lowers to one glob the host expands. The engine keeps a globbed read set out of the cross-run cache, because the key cannot say which expansion it names. |

A flow that declares reads is still boundary-checked. It is simply not reused.

## What the recorded row is addressed by

The dispatched action's idempotency key is the delegate's tag, the whole
`Invocation` envelope, and the policy itself.

Including the envelope is what keeps one caller's recorded answer from being
served to the next caller's question: the envelope carries both the
descriptor's declaration and the caller's input. Including the policy is what
makes a changed `ttlMs` a changed step key, which `ActionPersistence` assumes
when it fences its own expiry verdict.

The policy also enters the delegating node's captured identity, so two
descriptors declaring different policies are two declarations with two step
keys.

## Check what was lowered

`Executable.lower(descriptor, annotations)` reads the three runtime decisions
off a loaded body and its descriptor, and every built executable carries the
result:

```ts
const built = yield * Executable.fromDescriptor(descriptor, { delegates })
console.log(built.lowered.cache) // { ttlMs: 60000, scope: "shared" } or undefined
console.log(built.lowered.priority) // a number, or undefined
console.log(built.lowered.placement) // a Placement value, or undefined
```

A body annotation wins over the descriptor's frontmatter directive, because the
body is the later and more specific statement.

---
title: "Delegation"
description: "How one descriptor becomes a durable flow: the delegate a descriptor names, the fixed Invocation envelope every delegate receives, and the three declarations lowered onto the runtime."
sidebar:
  order: 4
---

Discovery answers what flows exist. Nothing in that answer is executable, so a
host holding a catalog could print a plan card and stop. `Executable` is the
missing half: it loads the body a descriptor points at, resolves the
[`@smthrs/flow`](/api/flow) flow the descriptor delegates to, and returns a
durable flow plus the `Interpreter` layer that registers it.

## The bridge does not compile a graph

A discovered flow declares **what** it delegates to: a markdown `flows:`
frontmatter list, a module binding record’s `flows`. The host declares **how**
that work runs, by registering `@smthrs/flow` flows under those names. One
delegating node is therefore the whole lowering. There is no compiler here, and
a descriptor's body never becomes a plan of its own.

That split is what lets one registered driver run many descriptors. The agent
driver a host registers under `agent` runs every markdown skill in the project;
a `shell` flow runs every descriptor that names it.

## Which flow a descriptor delegates to

| The descriptor names         | The delegate                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| One flow                     | That flow.                                                                                       |
| No flow                      | The agent driver, `Executable.defaultAgent` (`"agent"`), renameable with `Options.agent`.        |
| Several flows and a `model`  | The agent driver. A skill listing its tools is naming what the model may call, not what runs it. |
| Several flows and no `model` | Nothing. `ExecutableError { code: "ambiguous_delegate" }`.                                       |

A delegate no host registered is refused as
`ExecutableError { code: "missing_delegate" }`, and the refusal names the
missing flow and lists what is registered. It is raised while the executable is
being built, before the flow exists, and deliberately before the body is
loaded: a flow whose delegate nobody registered is not runnable on this host
whatever its body says, and an operator reading "could not load the body" would
go looking in the wrong place. Refusing at dispatch instead would surface an
empty `AnyOf` issue that names nothing.

## The Invocation envelope

Every delegate receives the same fixed, serializable envelope, because one
delegate runs many descriptors and none of them share an input schema:

```ts
interface Invocation {
  readonly flow: string
  readonly input: Schema.Json
  readonly prompt: string
  readonly model: string | null
  readonly placement: "client" | "local" | "sandbox" | "remote" | null
  readonly placementOptions: { image?: string; profile?: string; target?: string } | null
  readonly capabilities: ReadonlyArray<string>
  readonly flows: ReadonlyArray<string>
}
```

`prompt` is the rendered markdown body, or the empty string for a module flow.
`model` and `placement` are the two decisions a driver cannot re-derive: which
seat to run on, and which host to spawn a cell on. The envelope and everything
in it is frozen, and the same values are captured as the delegating node's
durable identity, so what a delegate reads and what the engine recorded cannot
diverge.

`placementOptions` decodes an absent key to `null`. The envelope is a durable
action payload, so a journal row written before the field existed still decodes
on replay. The default applies to decoding only: encoding still writes the key,
so the step key an envelope carrying a placement hashes to does not move.

## Three declarations reach the runtime

| Declared on the body                                                                   | Lowered onto                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CacheEnvironment.CachePolicyAnnotation`, which `@smthrs/patterns`' `withCache` writes | the action the bridged flow dispatches, which is what [`@smthrs/engine-store`](/api/engine-store) reads a policy off, plus the delegating node's captured key material and the flow's own annotation bag |
| `Annotations.Priority`                                                                 | the delegating node's `Node.priority`, which becomes `NodeDraft.priority` for `@smthrs/engine-store`'s `PlanScheduler`                                                                                   |
| `Flow.within(...)`, or the descriptor's own placement directive                        | the flow's `@smthrs/flow` placement annotation and the `Invocation.placement` plus `Invocation.placementOptions` a host selects a spawn target with                                                      |

A body annotation wins over the descriptor's frontmatter directive in all
three, because the body is the later and more specific statement.

Read the table with two limits, both of which are guaranteed behavior:

- **A cache policy changes the shape of the plan.** Without one, the delegate's
  own node goes into the plan the engine builds, so its fan-out, its priorities,
  and its waits are the caller's plan, and a host reading that plan sees the
  real work. That is many steps, and there is nothing in it for a policy to
  govern. Declaring a policy asks for one recorded unit instead, so the bridge
  dispatches a single action and runs the delegate underneath it as a child
  execution. See
  [Reuse a discovered flow's result](../guides/reuse-a-flow-result.md).
- **The priority orders scheduled plans and nothing else.** `PlanScheduler`
  admits ready nodes highest-priority-first under a concurrency limit. The
  [`smthrs flow start`](/cli/flow) path settles a flow through `@smthrs/flow`
  `Interpreter`, which admits every ready node at once, so on that path the
  priority orders nothing.

## Identity is a function of the descriptor, not the process

The delegating node captures the descriptor's own data as its key material: the
flow name, the delegate, the rendered prompt, the model, the placement, the
capabilities, the collaborator flows, the priority, and the cache policy.

It has to. A plan-time function JavaScript cannot inspect gets process-local
identity, so a bridged flow built from one unchanged descriptor would key
differently in every process. No replayed step would ever match, and no
recorded result would ever be reused. Everything the body reads is inert
descriptor data, so declaring it makes the flow's identity a function of the
descriptor rather than of the process that loaded it.

## Reading it back

- [Run a discovered flow](../guides/run-a-discovered-flow.md): the task, with
  the delegates and the host composition written out.
- [Declared authority](./authority.md): why the descriptor's tier decides
  whether a declared policy is honored.

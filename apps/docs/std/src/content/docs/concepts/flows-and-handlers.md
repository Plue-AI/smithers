---
title: "Flows and handlers"
description: "Every tool in this package is a portable declaration plus a separately supplied handler, and the Manifest registries are how a host reaches both halves by name."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/std/docs/concepts/flows-and-handlers.md"
---

A tool in this package is two halves that ship apart.

The **declaration** is data. It carries `name`, `description`, `Input`,
`Output`, `capabilities`, and `effects`, and it reaches nothing: no filesystem,
no process, no network. That is what makes it safe to hand to a model, safe to
put in a registry, and safe to plan against before a single call runs.

The **handler** is the executable half. It is an ordinary Effect whose
requirement names the host services it needs, so the host decides what `read`
actually reads from.

## The module shape

Every flow module exports the same names, which is what lets a host treat all 17
uniformly:

| Export         | What it is                                                     |
| -------------- | -------------------------------------------------------------- |
| `name`         | The registry name, such as `"read"`.                           |
| `description`  | The one line the model sees.                                   |
| `Input`        | The input schema.                                              |
| `Output`       | The output schema.                                             |
| `effects`      | The declared effect envelope, before any input is known.       |
| `effectsFor`   | The same envelope narrowed to one decoded input.               |
| `capabilities` | The authority the flow requires, as `action:resource` strings. |
| `flow`         | The declaration itself, built by `Flow.make`.                  |
| `run`          | The handler.                                                   |

`Explore` is the one exception: it has no `run`, because it is a dynamic flow
composed from other flows rather than a handler.

## Naming a declaration from another flow

Because the declaration is data, a larger flow can name it and inherit both its
capabilities and its effect envelope, without importing the handler at all:

```ts
import * as Read from "@smthrs/std/Read"
import * as Schema from "effect/Schema"

/** A step that reads a file. It declares what `read` declares. */
export const ReadTarget = ({
  name: "read-target",
  input: Schema.Struct({ path: Schema.String }),
  output: Read.Output,
  capabilities: Read.capabilities,
  effects: Read.effects,
  flows: [Read.flow]
})
```

A planner reading `ReadTarget` can see that the step reads and does not write,
before anything runs. That is the same property a review gate or an approval
prompt needs.

## The registries

`Manifest` is the whole library keyed by name, so a host binds all of it without
writing 17 imports:

```ts
import * as Manifest from "@smthrs/std/Manifest"

Manifest.names // the 17 names, in registry order
Manifest.flows // name -> declaration, all 17
Manifest.handlers // name -> handler, the 16 that have one
Manifest.effectsFor // name -> narrowing function, all 17
Manifest.readOnly // the 8 names a read-only tool surface may see
```

Every registry is frozen. `Manifest.handlers` omits `explore` because a dynamic
flow has no handler; `Manifest.effectsFor` includes it, because a model can
still be offered the declaration and its envelope still narrows.

`Manifest.readOnly` is `read`, `ls`, `glob`, `grep`, `fetch`, `explore`,
`webfetch`, and `lsp`. `websearch` is deliberately absent: its provider contract
requires `net:post` authority, which is mutating under the kernel capability
taxonomy, so it cannot ride in a read-only tool surface.

## The services a host binds

Most handlers ask only for platform services such as `FileSystem` or
`ChildProcessSpawner`. Six ask for a service this package defines, because the
answer is a host decision rather than a platform one:

| Service          | The flows that need it  | What it decides                                    |
| ---------------- | ----------------------- | -------------------------------------------------- |
| `Search`         | `grep`, `glob`          | Whether searching runs in process or through `rg`. |
| `Container`      | `bash`, `test`          | How a command reaches a named container.           |
| `TestRunner`     | `test`                  | How the project under test runs its suite.         |
| `Checkpoints`    | agent-side tree pinning | Where a pinned tree is recorded and checked out.   |
| `WebSearch`      | `websearch`             | Which search provider answers.                     |
| `LanguageServer` | `lsp`                   | Which language server answers.                     |

Each one ships a refusal implementation, and binding it is the honest way to say
"this host cannot do that". A `makeNoop` service fails the call with
`provider_unavailable` and a message naming what to do instead. Refusing loudly
is the contract: a flow that appears to work while doing nothing costs a model
the frames it takes to notice.

## What stays in the success channel

A handler fails only when a model must see a failure. A non-zero exit code, an
empty match set, and an HTTP 500 are all ordinary values, returned in the
success channel with the fields that describe them. `StdError` carries the rest,
under a closed list of codes. See
[Failures](/reference/flows/#failures) for the list and
[Troubleshooting](/troubleshooting/) for what each one means in practice.

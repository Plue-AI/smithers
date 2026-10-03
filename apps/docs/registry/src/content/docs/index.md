---
title: "@smthrs/registry"
description: "Scan directories of flows into serializable descriptors without importing anything, then look them up, disclose them to a model, and turn one into a runnable flow."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/registry/docs/README.md"
---

`@smthrs/registry` answers the question "what flows does this project have"
without running any of them. It scans directories into serializable
descriptors, keeps every prompt body behind a reference, and hands a host the
lookups it needs to list a catalog, show it to a model, and execute one entry
by name.

A flow lives on disk as a directory holding one entry file: a markdown
`flow.mdx`, its Agent Skills spelling `SKILL.md`, or a TypeScript `flow.ts`.
Scanning one produces a `FlowDescriptor`, a plain value you can journal, send
over a wire, or compare against another.

## What it solves

Reach for this package when your program has to know what flows exist before it
can act: an agent that tells a model which capabilities it may call, a command
line that completes flow names, a host that loads one flow and runs it.

The obvious implementation, importing every file under a directory, has two
costs. It runs third-party code before anyone decided to, and it pays for every
flow in the tree to learn about one. Discovery avoids both. The scan reads and
hashes each entry file whole, up to `Discovery.entrySizeLimit`, and parses at
most its first 64 KiB to find the declaration, so a catalog of a thousand flows
costs a thousand reads and frontmatter parses and no imports. The body stays
behind a path plus the SHA-256 digest measured during the scan, and the one
read that goes back to disk rehashes those bytes before it returns them, so a
file edited after discovery is refused rather than run against a stale
declaration.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

`effect` is a peer dependency at exactly `4.0.0-rc.115`. `@effect/platform-node`
supplies the `FileSystem` and `Path` implementations the scan walks with; the
package itself has no platform bindings. For the import forms and what a
runnable composition adds, see [Installation](/installation/).

## List what a directory holds

The API is Effect services and layers: you build a `Registry` layer over the
sources you want scanned, then run a program that asks that service for the
catalog.

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { join } from "node:path"

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

const registry = Registry.layer({
  sources: [{ source: "project", root: join(process.cwd(), "flows"), naming: "path" }]
}).pipe(Layer.provide([discovery, platform]))

const main = Effect.gen(function*() {
  const catalog = yield* Registry.Registry

  for (const flow of yield* catalog.list()) {
    console.log(`${flow.name}: ${flow.description}`)
  }

  for (const warning of yield* catalog.warnings()) {
    console.log(`skipped ${warning.path}: ${warning.message}`)
  }
})

await Effect.runPromise(main.pipe(Effect.provide(registry), Effect.orDie))
```

```text
review: Reviews a proposed change and reports concrete correctness and maintainability risks.
skipped /repo/flows/draft/flow.mdx: Markdown flows require a non-empty frontmatter description
```

`list()` and `warnings()` both answer from one complete snapshot and touch no
files. A malformed entry becomes a warning rather than a failure, because a
`flows/` directory is a directory a person edits and one file in it is
routinely mid-edit.

## How this fits with @smthrs/agent

[`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the Smithers agent loop, and its cells reach
the world only by calling a flow by name. Something has to decide which names
exist, which of them a model is allowed to see, and what each one claims about
its own authority. That is this package. The agent reads a `Registry` service,
renders the catalog through `Disclosure.toXml` into the block the model is
shown, and dispatches a call to the flow the descriptor delegates to. Read
`@smthrs/agent` for what happens after the call; read this package for
everything that decides what is callable at all.

Both sit under the `smthrs` command line,
[`@smthrs/cli`](https://cli.smithers.sh/reference/api/), which builds this registry over your project's
`flows/` directory at startup. Every verb that names a flow, including
[`smthrs flow`](https://smithers.sh/docs/reference/cli/flow/) and [`smthrs doctor`](https://smithers.sh/docs/reference/cli/doctor/), answers from that
one catalog.

## The package at a glance

The root entry point exports these namespaces, and each is also importable from
`@smthrs/registry/<Module>`:

| Namespace       | What it owns                                                                              |
| --------------- | ----------------------------------------------------------------------------------------- |
| `Descriptor`    | The serializable `FlowDescriptor` and every value it is built from.                       |
| `Discovery`     | The service that walks one source root and returns a scan, warnings included.             |
| `Registry`      | The refreshable, first-found-wins catalog every read answers from.                        |
| `MarkdownFlow`  | Markdown and Agent Skills compatibility: frontmatter, lazy bodies, rendered prompts.      |
| `Disclosure`    | The two compact projections a client renders: an entry list and the model's XML block.    |
| `Executable`    | Turning a descriptor into a durable [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) flow the engine settles.  |
| `Pack`          | Workflow packs: manifests, content addresses, compatibility ranges, and merge precedence. |
| `RegistryError` | The typed discovery and registry failures, and their constructors.                        |

## Where to go next

Start here:

- [Installation](/installation/): the import forms, and the packages a
  filesystem-backed or runnable composition adds.
- [Quickstart](/quickstart/): write two flows, scan them, and render the
  prompt a model receives.

Concepts:

- [Descriptors](/concepts/descriptors/): what a scan produces and why it
  holds no closures.
- [Sources and naming](/concepts/sources/): what a source is, how one
  directory becomes one flow, and what decides a name collision.
- [Declared authority](/concepts/authority/): how capabilities become an
  effect declaration and a reversibility tier.
- [Delegation](/concepts/delegation/): the delegate a descriptor names and
  the fixed envelope every delegate receives.

Guides:

- [Discover a project's flows](/guides/discover-a-project/): ordered
  sources, first-found collisions, and `refresh`.
- [Diagnose a flow that did not appear](/guides/diagnose-a-missing-flow/):
  every warning code, and what each one means.
- [Run a discovered flow](/guides/run-a-discovered-flow/): the bridge from a
  descriptor to a flow the durable engine runs.
- [Reuse a discovered flow's result](/guides/reuse-a-flow-result/): the
  cache policy, and the sealed tier that gates it.
- [Show a catalog to a model](/guides/show-flows-to-a-model/): the entry
  list and the Agent Skills XML block.
- [Load workflow packs](/guides/load-packs/): manifests, content addresses,
  compatibility ranges, and merge precedence.
- [Test against a registry](/guides/testing/): the noop seams, an in-memory
  snapshot, and the loader seam.

Reference:

- [API reference](/reference/api/): every export, field, and constructor.
- [Troubleshooting](/troubleshooting/): every failure code this package
  raises, what causes it, and what to change.

---
title: "Quickstart"
description: "Scan a flows directory end to end: write one markdown flow, build the registry from ordered sources, read the catalog and its warnings, and render the prompt a model receives."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/registry/docs/quickstart.md"
---

This quickstart discovers a real directory. By the end you will have a registry
that lists a flow it found, reports a diagnostic about one it refused, and
renders the prompt an agent would run.

## Prerequisites

- Node.js 26.4.0 or later.
- A package with the dependencies installed. Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## Write two flows

Discovery walks a source root looking for one entry file per directory, and
`flow.mdx` is the markdown form. Create `flows/review/flow.mdx`:

```md
---
description: Reviews a proposed change and reports concrete correctness and maintainability risks.
capabilities: ["fs:read:**"]
---

Review the supplied change. Report only findings you can point at a line for.
```

Then create `flows/draft/flow.mdx` with the description left out, so the scan
has something to refuse:

```md
---
name: draft
---

This flow is missing the description discovery requires.
```

The frontmatter keys a markdown flow accepts are documented in the
[flow.mdx reference](https://smithers.sh/docs/reference/flow-mdx/). Discovery needs exactly one of
them: a non-empty `description`.

## Build the registry

Create `quickstart.ts`. Two layers stack: `Discovery` walks a source, and
`Registry` holds the snapshot every read answers from.

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { join } from "node:path"

/** Discovery is portable, so the host supplies the filesystem it walks. */
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
const discovery = Discovery.layer.pipe(Layer.provide(platform))

/** One source: this project's own flows, named by their path below the root. */
export const registry = Registry.layer({
  sources: [{ source: "project", root: join(process.cwd(), "flows"), naming: "path" }]
}).pipe(Layer.provide([discovery, platform]))
```

`source` is opaque metadata the registry carries onto each descriptor's
provenance, so a catalog entry can say where it came from. `naming: "path"`
makes the directory path below the root the flow's name, which is what a
project wants: `flows/review/flow.mdx` is the flow `review`. The other mode,
`frontmatter`, reads the name out of the file and is how a foreign Agent Skills
directory is scanned. See
[Sources and naming](/concepts/sources/).

## Read the catalog and render a prompt

`list` and `warnings` answer from one complete snapshot and touch no files.
`runPrompt` is the read that goes back to disk: it loads the body the
descriptor points at, rehashes those bytes against the digest discovery
recorded, and renders them the way an agent host does.

```ts
const main = Effect.gen(function*() {
  const catalog = yield* Registry.Registry

  for (const entry of yield* catalog.list()) {
    console.log(`${entry.name}: ${entry.description}`)
    console.log(`  tier=${entry.effects.tier} invocable=${entry.modelInvocable}`)
  }

  for (const warning of yield* catalog.warnings()) {
    console.log(`warning ${warning.code} at ${warning.path}: ${warning.message}`)
  }

  console.log(yield* catalog.runPrompt("review", { args: "the staged diff" }))
})

await Effect.runPromise(main.pipe(Effect.provide(registry), Effect.orDie))
```

Run the file with your TypeScript runner. The catalog holds one flow, the
missing description is reported rather than raised, and the prompt is the body
plus the fixed block that tells a model where the flow's own files live:

```text
review: Reviews a proposed change and reports concrete correctness and maintainability risks.
  tier=sealed invocable=true
warning missing_description at /repo/flows/draft/flow.mdx: Markdown flows require a non-empty frontmatter description
warning name_field_ignored at /repo/flows/draft/flow.mdx: Ignoring frontmatter name because this source uses path-derived names
Review the supplied change. Report only findings you can point at a line for.

Supporting skill resources are available relative to this skill directory but are not loaded into context unless needed:
<skill_resources>
- Base directory: /repo/flows/review
- Resolve relative resource paths from this directory and read only the files you need.
</skill_resources>

the staged diff
```

## What just happened

The scan read and hashed each entry file whole, parsed at most its first 64 KiB
to find the metadata, and built a serializable descriptor with the body left
behind a reference. `capabilities: ["fs:read:**"]` is why `review` came back as
`tier=sealed`: reading files is reversible, so nothing has to be undone, and
the tier is inferred from the authority the flow declared. The flow with no
description contributed two `DiscoveryWarning` values instead of an entry: one
for the description a markdown flow must have, and one for the `name:` key a
path-named source ignores. A scan that drops something says so rather than
returning a shorter list.

## Next steps

- [Discover a project's flows](/guides/discover-a-project/): ordered
  sources, first-found collisions, and `refresh`.
- [Diagnose a flow that did not appear](/guides/diagnose-a-missing-flow/):
  every warning code, and what each one means.
- [Run a discovered flow](/guides/run-a-discovered-flow/): the bridge from a
  descriptor to a durable flow the engine settles.

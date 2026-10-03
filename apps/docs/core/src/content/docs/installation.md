---
title: "Installation"
description: "Install @smthrs/core, its runtime requirements, its import forms, and the subpaths that are not part of the public surface."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/installation.md"
---

## Install the package

Not on npm yet; see [Installation](https://smithers.sh/docs/installation/#use-the-libraries).

The package requires Node.js 26.4.0 or later and ships as both ESM and
CommonJS with TypeScript declarations. It has no platform bindings: it reads no
file, opens no socket, and starts no process, so the same build runs in Node,
in Bun, in a browser, and in a Cloudflare Worker.

The package requires `effect@4.0.0-rc.115` as an exact peer dependency. Keep
the application on that version so all Smithers packages share one Effect
runtime. [`effect`](https://effect.website) supplies `Schema`, `Context`,
`Result`, and `Data`, which appear in this package's public types. Import it
directly in your own code.

Five runtime dependencies install with it:

- [`@smthrs/canonical`](https://canonical.smithers.sh/reference/api/) supplies the RFC 8785 canonical JSON
  serialization behind `Digest.canonical`.
- [`@smthrs/crypto`](https://crypto.smithers.sh/reference/api/) supplies the synchronous SHA-256 behind
  `Digest.digest` and behind captured function identity.
- [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) owns the flow, the action, and the graph builder a
  signature lowers to, and `Graph` re-exports its builder.
- [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) owns the node model `Node` re-exports and the
  effect declaration model `Effects` re-exports, so one node shape and one
  declaration shape serve every package that plans.
- [`yaml`](https://eemeli.org/yaml/) parses Agent Skills frontmatter with the
  failsafe schema.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Effects, Graph, Markdown, Node, Placement } from "@smthrs/core"
import { Flow } from "@smthrs/flow"
```

Each module is also importable from its own subpath, which is the form this
package's consumers use and the form the API reference uses in its examples:

```ts
import * as Digest from "@smthrs/core/Digest"
import * as Flow from "@smthrs/flow/Flow"
```

## What is not public

Two subpath families are blocked in the package's export map and are not part
of the contract:

- `@smthrs/core/internal/*` holds the Agent Skills frontmatter splitter. Its
  shape changes without a version bump.
- `@smthrs/core/*/index` is blocked so a deep import cannot reach a module's
  barrel by a second name.

`@smthrs/core/package.json` is exported.

## What a real composition adds

`@smthrs/core` on its own gets you declarations, a planned graph, and key
material. It does not execute anything. A host that runs what the plan
describes adds the packages above it:

- [`@smthrs/flow`](https://flow.smithers.sh/reference/api/) executes the flow a signature lowers to, and takes
  the implementation of its action through `action.toLayer`.
- [`@smthrs/plan`](https://plan.smithers.sh/reference/api/) compiles key material into step keys, performing
  the dependency-digest substitution this package deliberately leaves undone.
- [`@smthrs/registry`](https://registry.smithers.sh/reference/api/) resolves the flow names a declaration
  carries, and owns the markdown and Agent Skills rules that need the file
  system.
- [`@smthrs/harness`](https://harness.smithers.sh/reference/api/) reads effects, placement, and key material
  at its durable boundary.
- [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) runs the agent loop those declarations describe.

For unit tests of a package that builds signatures, `Graph.build` is enough: it
plans without executing anything. Running what it planned needs
[`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s interpreter and an engine.

## Next step

Plan your first graph in the [Quickstart](/quickstart/).

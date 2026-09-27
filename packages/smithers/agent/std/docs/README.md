---
title: "@smthrs/std"
description: "The standard tool library for coding agents: read, edit, grep, bash, test, and twelve more, each a portable declaration paired with a handler your host runs."
---

`@smthrs/std` is the tool library a coding agent works with: seventeen tools,
among them `read`, `write`, `edit`, `grep`, `glob`, `bash`, `test`, and `lsp`.
Every tool ships as two halves. The **declaration**, called a **flow** here and
exported as `flow` from every module, is plain data, carrying a name, the one
line a model sees, input and output schemas, the capabilities the tool needs,
and the effects it would have. It reaches no filesystem, no process, and no
network, so it is safe to hand to a model or keep in a registry. The **handler**
is an ordinary [Effect](https://effect.website) whose requirements name the host
services it needs, so you decide what `read` reads from and where `bash` runs.

Reach for this package directly when you are building your own host, your own
tool registry, or a tool surface for a model you drive yourself. If you want the
agent loop that already offers all seventeen, use
[`@smthrs/agent`](/api/agent), the parent package, instead.

## Why reach for this

Any host can write `read` and `grep` in an afternoon. The cost arrives later, in
the details that decide whether a model gets its next step right:

- **Limits are disclosed, never silent.** Every capped result says it was
  capped, in `truncated` and `notice`. A model shown 200 lines of a 1,000-line
  file is told so, instead of concluding the file ends there.
- **`read` returns raw file text.** Line numbers come back as the sibling fields
  `startLine`, `endLine`, and `totalLines`, never as a gutter inside the text,
  so any line of a read is an anchor that `edit` accepts as it stands.
- **A `grep` hit carries the definition it sits in.** When a file's shape says
  plainly which definition a match falls inside, the hit carries that
  definition's `kind`, `name`, `startLine`, and `endLine`, so the follow-up read
  is a fact rather than a guess.
- **Search has one meaning and two implementations.** `PortableSearch` walks the
  filesystem in process and needs no external binary; `NativeSearch` drives the
  `rg` executable. A differential kit holds both to the same answers.
- **Every tool states its authority before it runs**, as `action:resource`
  capability strings and an effect envelope, so a permission layer or a
  scheduler can decide about a call before making it.

## Install

Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

The handlers
ask the host for services such as `FileSystem`, `Path`, and
`ChildProcessSpawner`. `@effect/platform-node` supplies them on Node.js 26.4.0 or later. For the browser-safe subset and the service each handler requires, see
[Installation](./installation.md).

## Read a file, bounded and disclosed

```ts
import { NodeServices } from "@effect/platform-node"
import * as Read from "@smthrs/std/Read"
import * as Effect from "effect/Effect"

const page = await Effect.runPromise(
  Effect.provide(Read.run({ path: "./README.md", limit: 20 }), NodeServices.layer)
)

console.log(page.content) // raw file text, no line-number prefixes
console.log(`lines ${page.startLine} to ${page.endLine} of ${page.totalLines}`)
if (page.truncated) console.log(page.notice)
```

When the file holds more than 20 lines, `page.truncated` is `true` and
`page.notice` names both counts, in the form
`Showing 20 of 213 lines; output was truncated.` Nothing was cut quietly, and
every line of `page.content` can be pasted back into `edit` as an anchor.

## What the library covers

| Area              | Flows                                         |
| ----------------- | --------------------------------------------- |
| Files             | `read`, `write`, `edit`, `apply_patch`, `ls`  |
| Search            | `grep`, `glob`, `explore`                     |
| Processes         | `bash`, `shell_command`, `test`               |
| Network           | `fetch`, `http-post`, `webfetch`, `websearch` |
| Code intelligence | `lsp`                                         |
| Planning          | `update_plan`                                 |

Sixteen of the seventeen carry a handler. `explore` is a dynamic flow composed
from the others, so it declares an interface without implementing one.
`Manifest` is the whole set keyed by name, and `Manifest.readOnly` is the
projection of it that changes nothing, for offering to a model you want to read
and not write. Every field of every flow is in the
[Flow reference](./reference/flows.md).

## How this fits with the Smithers agent

`@smthrs/std` is the tool half of a coding agent, and it knows nothing about
models, prompts, or loops: it declares tools and it runs them. The loop lives in
[`@smthrs/agent`](/api/agent), the parent package. Its `StandardFlows` module
pairs each declaration here with its handler here, so the JavaScript a model
emits on each turn reaches a file through `ctx.call("read", input)` rather than
through a bespoke tool surface.

See [Give a run capabilities](/pkg/agent/guides/capabilities) for how a run
binds these flows and gates the calls a cell makes into them. Both packages sit
under the `smithers` command line tool,
[`@smthrs/cli`](/api/cli), which composes the agent, the durable engine, and a
control plane into something you run in a terminal.

## Where to go next

- [Quickstart](./quickstart.md) searches a real directory and reads the
  definition a hit sits in, with no external binary and no API key.
- [Flows and handlers](./concepts/flows-and-handlers.md) explains the two halves
  and the registries that reach both.
- [Bind the standard flows into a host](./guides/bind-the-standard-flows.md)
  composes the layers and offers all seventeen tools at once.
- [Flow reference](./reference/flows.md) lists every input field, output field,
  and failure code.
- [Troubleshooting](./troubleshooting.md) maps each failure code to what to
  change.

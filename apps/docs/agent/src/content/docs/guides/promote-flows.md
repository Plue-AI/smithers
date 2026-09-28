---
title: "Save the script a run wrote as a flow"
description: "Promote the cells a run executed into a discoverable flow with PromoteFlows: flows/show-script, flows/write-flow, and the FlowStore the files land in."
sidebar:
  order: 9
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/guides/promote-flows.md"
---

A run that solved something once solved it as a script: a few cells that read
the right things, called the right boundaries, and printed an answer.
`PromoteFlows` is how that script becomes a flow anyone can call again, and it
is two ordinary flows rather than a new affordance.

## Bind the two flows

```ts
import { FlowStore, PromoteFlows } from "@smthrs/agent"
import type * as CellHistory from "@smthrs/harness/CellHistory"
import * as Effect from "effect/Effect"

// Inside a flow body, where CellHistory and FlowStore are in context:
const services = yield* Effect.context<CellHistory.CellHistory | FlowStore.FlowStore>()

const run = agent.run({
  // session, seat, prompt, registry ...
  flows: [PromoteFlows.source(services)]
})
```

- `flows/show-script` hands the model its own turn back: the source of every
  cell it executed, in order, together with the rules a saved flow has to
  follow and the file skeleton to fill in. It reads the `CellHistory` the
  controller records into, so a host that keeps no history reports an empty
  script instead of failing.
- `flows/write-flow` takes the three files that come back (the flow, its
  end-to-end test, and the fixture that test replays) and writes them through a
  `FlowStore`. When a `Registry` is in context it is refreshed afterwards,
  and a successful refresh makes the saved model-invocable flow appear in
  `ctx.flows` on the next frame. Supply the same registry to `Agent.run` and
  the promotion binding's context. Refresh is best effort; a failed refresh
  leaves the files saved and discovery waits for a later successful refresh.
  It declares `fs:write:/flows/**`, so the run's `capabilityEnvelope` must
  grant that write; a run without it gets `capability_refused` and nothing is
  saved.

`Agent.run` reads the visible catalog at each frame boundary and journals the
descriptor snapshot. The model prompt, `ctx.flows`, and call admission use that
snapshot for the whole frame. Existing frames replay their recorded catalogs;
new frames read the current registry. Call resolution checks the declaration
digest before executing, so a registry entry changed during a cell is refused
until the next frame reads it.

The rules and the skeleton are the host's too: `PromoteFlows.source(services, { bestPractices, template })`
replaces both for a host whose flows are laid out differently.

## Choose where files land

`FlowStore` is the one contract a checkout, a browser host, and a test all
satisfy:

| Layer                             | Where files go                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FlowStore.layerFileSystem(root)` | `<root>/flows/<id>/{flow.ts,flow.e2e.ts,fixtures/<id>.json}`, through Effect's `FileSystem`.                                                                |
| `FlowStore.layerMemory(map)`      | A caller-owned `Map<string, string>` keyed by path, so a test reads the bytes back without a filesystem. Every key must be a file path under `flows/<id>/`. |
| `FlowStore.layerNoop()`           | Nowhere: refuses with `FlowStoreError { code: "unsupported" }` and a message the model can read.                                                            |

Every message a store returns is written for the model that will read it back
as a call failure, because the cell that asked to save a flow is the only thing
that can correct the id or reissue the write.

## The id is checked before any path is built

The store is the last place an id is still text, so `FlowStore.validateId` runs
before any path is built from it: lowercase letters, digits, and hyphens,
starting with a letter (`/^[a-z][a-z0-9-]*$/`). A `../escape` is refused as a
bad id, not caught as a surprising write outside the root, and the filesystem
store checks every file path before the first byte is written, so a rejected
file cannot leave a half-saved flow on disk. It uses the injected `Path`
semantics for confinement, including Windows separators. Saves to the same
resolved root are serialized within the process, including across store
instances. All new files and backups are staged inside the root before
publication; a failed publication restores the previous files. Staging
is cleaned on interruption, or publication finishes before interruption takes
effect. If rollback also fails, the error identifies retained recovery files.
External readers can see individual renames in progress; this is not crash
recovery or coordination between processes.

`flows/write-flow` validates the id again before it asks the store, so a noop
store answers a bad id with "invalid id" rather than "nowhere to save" and sends the model to fix the right
thing.

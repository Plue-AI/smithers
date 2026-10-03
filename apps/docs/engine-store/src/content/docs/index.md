---
title: "@smthrs/engine-store"
description: "The durable engine behind Smithers flows: it persists every step attempt to SQLite or PostgreSQL, fences writes to one owner, and replays a recorded result instead of running the step again."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/engine-store/docs/README.md"
---

`@smthrs/engine-store` is the durable half of the Smithers flow engine. It
persists every step a flow takes to a SQLite or PostgreSQL database, so a flow that crashes,
is killed, or waits for a week resumes where it stopped instead of starting
over.

It is an [Effect](https://effect.website) library: every surface below is a
`Layer` you compose or an `Effect` you run.

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

## What it solves

Long work made of model calls, shell commands, and file edits fails in the
middle. Restarting from the top is usually the wrong answer: the expensive step
already ran, the file was already written, the irreversible effect already
reached the world. This package makes the restart cheap and safe.

- **Attempts are durable.** A step opens a row before its body runs and settles
  that row afterwards, so a restart replays the recorded result instead of
  executing the body a second time.
- **One owner drives a run.** An engine claims a run, and every durable write
  is fenced against the claiming owner, so two processes over one database
  cannot both drive it. A dead owner's runs are reclaimed under a liveness
  check you choose.
- **Waits outlive the process.** A parked run holds a durable deferred or clock
  row, so a timer that outlives the process that set it still fires.
- **Steps declare the files they touch.** The engine measures the real tree
  against the declaration, refuses a step that wrote outside it, and admits
  only whole-tree evidence into the cache that other runs read.
- **Deletion is a pass you run.** Old run history and unreferenced artifacts go
  away when you ask for it, never on a schedule you did not set.

## Replay in one example

Build the engine layer with an owner identity and a journal source:

```ts
import { EngineStore } from "@smthrs/engine-store"
import { Ownership } from "@smthrs/run-store"

const engine = EngineStore.layer({
  owner: { hostId: "worker-a" },
  journalSource: "worker-a",
  isAlive: Ownership.sameHostPidProbe
})
```

Provide that layer the journal, run, attempt, and cache stores over one
migrated SQLite file and you have `workerA`. Build a second engine, `workerB`,
over that same file, the way a second process would. `Analyse` is a flow with
one sealed step. Execute it twice under the same execution id:

```ts
import * as Effect from "effect/Effect"

const first = await Effect.runPromise(
  Effect.scoped(Analyse.execute({}, { executionId: "analyse-1" }).pipe(Effect.provide(workerA)))
)

const second = await Effect.runPromise(
  Effect.scoped(Analyse.execute({}, { executionId: "analyse-1" }).pipe(Effect.provide(workerB)))
)
```

```text
first: '42'   second: '42'   step bodies executed: 1
```

The second engine found the settled attempt row for that step key and replayed
it, so the body ran once. Delete the database file and the count becomes 2,
which is the falsifiable version of the claim. The
[Quickstart](/quickstart/) builds both engines end to end, in one file you
can run.

## Where this sits

This package is one piece of the Smithers flow engine, not the whole of it.
[`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is the barrel over that engine: it re-exports
this package next to the flow language, the journal, the run and cache stores,
and the artifact tier, and it ships `NodeRuntime`, which wires all of them over
one SQLite file so a program does not restate the composition by hand. Install
`@smthrs/flows` when you want a runtime that already works. Reach for
`@smthrs/engine-store` directly when you are building the host itself and need
control over ownership, step boundaries, workspace sandboxing, retention, or a
cache shared across machines.

Above both sits the [`smithers` command-line interface](https://cli.smithers.sh/reference/api/), which runs
flows out of a project directory without writing a composition at all.

## Next steps

- [Installation](/installation/): runtime requirements, import forms, the
  storage packages a runnable composition adds, and the browser boundary.
- [Quickstart](/quickstart/): compose an engine over one SQLite file and
  watch a sealed step replay.
- [Compose a durable engine](/guides/compose-a-durable-engine/): every
  service `EngineStore.layer` requires, and what each option changes.
- [Ownership and fencing](/concepts/ownership-and-fencing/): how a run is
  claimed, fenced, and reclaimed.
- [Attempts and replay](/concepts/attempts-and-replay/): what is persisted
  per attempt, and which admission checks refuse one.
- [Share a step cache across machines](/guides/share-a-cache-across-machines/):
  turn one machine's sealed result into every machine's.
- [Back up and restore the store](/guides/back-up-and-restore/): hot backup,
  verification, and the ownership fence a restored file needs.
- [API reference](/reference/api/): every public export, grouped by namespace.
- [Troubleshooting](/troubleshooting/): the typed failures this package
  reports, and what to change for each.

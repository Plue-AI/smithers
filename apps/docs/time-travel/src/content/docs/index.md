---
title: "@smthrs/time-travel"
description: "Replay, fork, and rewind a durable run from the journal it already wrote: one injectable Effect service, addressed by a frame, with no re-execution."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/time-travel/docs/README.md"
---

`@smthrs/time-travel` lets you read a durable run's past, branch it, or take it
back. One injectable Effect service, `TimeTravel`, carries the four verbs that
do it: `replay` and `inspect` read, `fork` branches, and `rewind` truncates.
Each one acts at a _frame_, which is a point in the run's committed journal.

## What it solves

A long agent run, build, or approval pipeline records what it did as it goes.
Once it has finished or parked, that history is the only honest account of what
happened, and the questions you want to ask it are awkward without a library:
what did this run look like after step 17, what if it had branched there
instead, and can I take it back to there and try again.

Answering those by re-executing the run is wrong twice. It costs money, and it
repeats effects that already left the system. This package answers them by
folding the journal instead. A replay reads committed records and derives an
answer; it never dispatches a model call or spawns a child flow, so replaying is
free and cannot change the run. A fork copies history up to a frame into a new
child run and leaves the parent untouched. A rewind is the one destructive verb:
it removes everything above a frame, and it refuses rather than silently
stranding an effect that already crossed into the outside world.

## Install

Not on npm yet; see [Installation](https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/flow/docs/installation.md#use-the-libraries).

Node.js 26.4.0 or later. The package ships ESM and CommonJS with TypeScript
declarations, and its root entry point bundles for the browser with no `node:`
built-in.

## Read a run's past

`inspect` folds the run's journal up to a frame through a projection you write.
A frame pairs a lineage id with a journal sequence, and the lineage id is minted
by `FlowEngine.Lineage` rather than spelled by hand:

```ts
import { Engine } from "@smthrs/flows"
import { TimeTravel } from "@smthrs/time-travel"
import * as Effect from "effect/Effect"

const attemptsAtFrame = Effect.gen(function*() {
  const timeTravel = yield* TimeTravel
  return yield* timeTravel.inspect(
    {
      runId: "build-42",
      frame: { lineageId: Engine.FlowEngine.Lineage.root("build-42"), seq: 17 }
    },
    {
      initial: 0,
      reduce: (count: number, entry) => entry.eventType === "flows.engine.attempt-started" ? count + 1 : count
    }
  )
})
```

The same `{ runId, frame }` value is what the other verbs take.
`timeTravel.fork(position)` branches a child run that inherits the history under
the frame. `timeTravel.rewind(position)` removes everything above it and
compensates what it crosses.

## How this fits with @smthrs/flows

Time travel reads history it does not write. The producer is the Smithers
durable flow engine, which stamps a lineage id on every record a run commits and
journals the evidence a rewind reasons about. [`@smthrs/flows`](https://flows.smithers.sh/reference/api/) is
that engine packaged as one dependency: it declares flows and actions, stands a
durable host up over local SQLite, and resumes a run after a crash. Install it
if you need runs to travel back through; install this package if you already
have such runs and want to look at, branch, or truncate them.

The two compose without ceremony. `TimeTravel.layer` asks for five injectable
contracts, four of which an engine composition already provides, so it merges
straight onto one. `@smthrs/flows` also re-exports the `TimeTravel` service key,
so a program that already depends on the barrel reaches the service through it
with no second dependency, and reaches `FlowEngine.Lineage` the same way.

Above both sits the `smithers` command-line tool, which runs and supervises
flows without a program of your own. Its verbs are documented at
[the CLI reference](https://cli.smithers.sh/reference/api/).

## Where to go next

- [Installation](/installation/): the services `TimeTravel.layer` requires,
  the import forms, and the packages a runnable composition adds.
- [Quickstart](/quickstart/): execute a durable run, then fold its journal
  into a number.
- [Frames and lineage](/concepts/frames-and-lineage/): why an address carries
  a lineage rather than a run, and what goes wrong when it does not.
- [Replay a run into a view](/guides/replay-a-run/),
  [Fork a run at a frame](/guides/fork-a-run/), and
  [Rewind a run to a frame](/guides/rewind-a-run/): one guide per verb.
- [API reference](/reference/api/): every public export, and the closed list of failure
  codes.
- [Troubleshooting](/troubleshooting/): each refusal, and what to change.

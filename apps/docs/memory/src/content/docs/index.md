---
title: "@smthrs/memory"
description: "Effect services for durable cross-run facts, history, notes, recall, and maintenance."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/README.md"
---

`@smthrs/memory` is durable memory for an AI agent: facts, notes, and message threads kept in SQLite or PostgreSQL, ranked for recall, and reachable by a model through two operations it calls by name, `remember` and `recall`. The package is a set of [Effect](https://effect.website) services, so you choose the storage and recall implementations your host can support and every caller keeps working.

## What it solves

A model's context window disappears when the process exits. Everything the next run should still know, a decision made yesterday, a convention someone corrected, the conversation so far, has to live outside the model. This package is that store, shaped around the ways agent memory goes wrong:

- Scoped namespace isolation across `flow`, `agent`, `user`, and `global` memory. Bind a policy-carrying declaration with `Flows.handlersFor` to limit model-facing reads and writes to the policy namespace. Empty banks default to it; explicit banks resolving to another kind or id fail with `invalid_namespace` before I/O. Equivalent bank spellings are allowed. Bare handlers and direct recall or store APIs remain unscoped.
- Recall is a replaceable service rather than one fixed algorithm. Keyword matching needs nothing beyond the store; SQLite or PostgreSQL full text search and in-process semantic search over embeddings are also included, and swapping between them changes no caller.
- Every recall answer fits a byte budget, because recalled rows are about to become part of a prompt.
- Writes are idempotent. Re-appending an identical message is a no-op, and re-appending the same id with different content fails with `idempotency_conflict` instead of duplicating history.
- Notes are append-only and correct themselves by supersession, so an obsolete note drops out of recall without a destructive edit.

## Install

The `1.0.0-rc.0` release documented here is not on npm yet, so it is used today from a checkout of the [Smithers repository](https://github.com/smithersai/smithers). [Installation](/installation/) has the workspace form and the packages a file-backed store adds.

## Write a fact and recall it

The smallest working program writes a fact and recalls it over a fresh in-memory database:

```ts
import * as Flows from "@smthrs/memory/Flows"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Layer } from "effect"

const memory = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)

const program = Effect.gen(function*() {
  yield* Flows.runRemember({ bank: "global-notes", key: "release", text: "cut 0.1.0" })
  return yield* Flows.runRecall({ banks: ["global-notes"], query: "release" })
})

const rows = await Effect.runPromise(program.pipe(Effect.provide(memory)))
// [{ bank: "global-notes", key: "release", text: "cut 0.1.0", score: 1, updatedAtMs: ... }]
```

`global-notes` is a bank, the public string spelling of a namespace. `TestMemory.layer` is the in-memory test layer, which forgets everything when the process exits. For a database file that outlives the process, wire `MemoryStore.layer` over the `@smthrs/database` client instead; the [Quickstart](/quickstart/) shows both, and the second run recalls what the first one wrote.

## Where this package sits

`@smthrs/memory` is one capability of the Smithers agent, and [`@smthrs/agent`](https://agent.smithers.sh/reference/api/) is the package that gives it that context. The agent package owns the agent loop, and it reaches memory in three places. `StandardFlows.memory` binds the `remember` and `recall` declarations defined here into the flows a model can call, so a model that writes a fact crosses the same journaled boundary as a model that reads a file. `Agent.Options.memory` accepts the frozen `{ rows, digest }` snapshot `Source.declared` builds, which becomes the opening context of a run; a judged run's relevance reading may withhold rows from it. And `@smthrs/agent/MemorySnapshotRecorder` implements the `SnapshotRecorder` port declared here, so a resumed run reads the snapshot its first attempt read instead of refetching live memory.

Agents in turn run under the Smithers command line tool, [`@smthrs/cli`](https://cli.smithers.sh/reference/api/). Its [`smthrs memory`](https://smithers.sh/docs/reference/cli/memory/) command reads and writes the same store this package defines, so you can list, set, and remove facts from a terminal without writing a program.

Underneath, storage is SQLite or PostgreSQL through [`@smthrs/database`](https://database.smithers.sh/reference/api/), and `MemoryStore.layer` applies its own migrations when it builds. The two flows are plain [`@smthrs/core`](https://core.smithers.sh/reference/api/) declarations, bound at run time through [`@smthrs/harness`](https://harness.smithers.sh/reference/api/). Recall is a replaceable slot declared with [`@smthrs/patterns`](https://smithers-patterns.smithers.sh/reference/api/).

## Where to go next

- Set up the package: [Installation](/installation/), then a guided first run in the [Quickstart](/quickstart/).
- Learn the model: [What memory persists](/concepts/durability/), [How recall works](/concepts/recall/), and [Memory policies](/concepts/policies/).
- Perform a task: [Store facts, notes, and history](/guides/store-facts/), [Recall memory](/guides/recall-memory/), [Scope a flow tree to a namespace](/guides/scope-a-flow-tree/), [Give an agent opening memory](/guides/agent-opening-context/), and [Run maintenance passes](/guides/maintenance/).
- Look up an export: the [API reference](/reference/api/) covers every public module.
- Fix a failure: [Troubleshooting](/troubleshooting/) lists every typed error code and the recall checklists.
- Pick an import form: [Import surface](/surface/) documents the exports map.

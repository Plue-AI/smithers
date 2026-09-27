---
title: "Quickstart"
description: "A guided first run of @smthrs/memory: write a fact, recall it, then make it survive a restart."
sidebar:
  order: 2
---

This quickstart writes one fact, recalls it, and then moves the store from an in-memory database to a file so the fact survives the process. It takes about ten minutes.

## Before you begin

- Node.js 26.4.0 or later.
- `@smthrs/memory`, resolving in your project. [Installation](./installation.md)
  covers where to get it today and its SQLite driver.

## 1. Write and recall over an in-memory database

Write `notebook.ts`:

```ts
import * as Flows from "@smthrs/memory/Flows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Layer } from "effect"

// The store over a fresh in-memory database, plus keyword recall over it.
// provideMerge shares one store build: recall reads the database the
// program writes to.
const memory = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)

const program = Effect.gen(function*() {
  // Write through the remember flow's runtime handler.
  yield* Flows.runRemember({ bank: "global-notes", key: "release", text: "cut 0.1.0" })

  // Recall through the keyword binding.
  const rows = yield* Flows.runRecall({ banks: ["global-notes"], query: "release" })

  // The store itself answers the authoritative read.
  const store = yield* MemoryStore.MemoryStore
  const facts = yield* store.listFacts({ namespace: { kind: "global", id: "notes" } })

  return { rows, keys: facts.map((fact) => fact.key) }
})

const result = await Effect.runPromise(program.pipe(Effect.provide(memory)))
console.log(result)
```

Run it. Node.js 26.4 runs the TypeScript file directly:

```bash
node notebook.ts
```

```text
{ rows: [ { bank: 'global-notes', key: 'release', text: 'cut 0.1.0', score: 1, ... } ], keys: [ 'release' ] }
```

The bank name `global-notes` resolves to the namespace `{ kind: "global", id: "notes" }`, which is why `listFacts` finds the fact there. An unprefixed bank such as `notes` would have resolved to `{ kind: "flow", id: "notes" }` instead.

## 2. Make the fact survive a restart

The in-memory layer forgets everything when the process exits. Swap it for a SQLite file by replacing the layer, and nothing else. Declare the database package and its Node adapters before replacing the layer. Not on npm yet; see [Installation](/docs/installation/#use-the-libraries).

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import { Layer } from "effect"

const sql = NodeDatabase.layer({ filename: "memory.db" })
const stores = Layer.provideMerge(DurableWriter.layer(), sql)
const memory = Layer.provide(
  Layer.provideMerge(RecallKeyword.layer, MemoryStore.layer),
  Layer.merge(stores, NodeCrypto.layer)
)
```

`MemoryStore.layer` applies the package's migrations when it builds, so `memory.db` gains the memory tables on first run. Provide this `memory` layer to the same `program` from step 1, run `node notebook.ts` twice, and the second run still recalls `release`: the fact outlived the process that wrote it.

## 3. Next steps

- To give one flow tree its own namespace and budget instead of naming banks per call, attach a policy as described in [Scope a flow tree to a namespace](./guides/scope-a-flow-tree.md).
- To pick a different recall binding, see [Recall memory](./guides/recall-memory.md).
- For a full application walkthrough with an agent and the Smithers engine, see the [memory tutorial](/docs/tutorials/memory/) on smithers.sh.

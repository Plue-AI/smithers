---
title: "Store facts, notes, and history"
description: "Write and read the three record kinds @smthrs/memory persists: facts, notes, and message threads."
sidebar:
  order: 1
---

All storage goes through the `MemoryStore` service. Every example on this page is an Effect that takes the store from the context:

```ts
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  // the calls below go here
})
```

Provide it with `MemoryStore.layer` over a SQL client in production, or `@smthrs/memory/test/TestMemory` in tests, as shown in the [Quickstart](../quickstart.md).

## Store a fact

Call `putFact` with a namespace, a key, a JSON-serializable value, and the provenance you want recorded. Writes are last-write-wins upserts.

```ts
const write = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  yield* store.putFact({
    namespace: { kind: "flow", id: "release-notes" },
    key: "release",
    value: { content: "cut 0.1.0" },
    tags: ["scope:project"],
    ttlMs: 86_400_000,
    provenance: { runId: "run-1" }
  })
})
```

- The value is serialized through a `JSON.stringify` round trip, so `NaN` and `Infinity` come back as `null`, and `undefined`, function, and symbol members disappear. Serialize once in your head: what `JSON.stringify` produces is what `getFact` returns.
- Tags must come from the vocabulary prefixes `branch:`, `stream:`, `source:`, and `scope:`, must be unique, and number at most 16. A violation fails with `invalid_tag`.
- `ttlMs` must be a non-negative safe integer and expires the fact that many milliseconds after its last update. Omit it for a permanent fact.
- A namespace string such as `"flow-release-notes"` works anywhere the structured value does; an unprefixed string resolves to the `flow` kind. An empty string fails with `invalid_namespace`.

Read facts back with `getFact` for an exact key, or `listFacts` with an optional key `prefix` and `limit`:

```ts
const read = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  const fact = yield* store.getFact({ namespace: { kind: "flow", id: "release-notes" }, key: "release" })
  const sessionFacts = yield* store.listFacts({ namespace: "flow-release-notes", prefix: "session:", limit: 50 })
  return { fact, sessionFacts }
})
```

`getFact` answers `undefined` for a missing or expired fact. `deleteFact` removes a fact together with its full text and vector projections and answers whether a row existed.

## Write through the remember flow

When the writer is a model, use the `remember` flow's runtime handler instead of calling `putFact` yourself. It stores `{ content: text }` as the fact value, which is the shape recall renders best. It refuses a `source:` tag with `invalid_tag`, so a model-written fact cannot claim a trusted source:

```ts
import * as Flows from "@smthrs/memory/Flows"
import { Effect } from "effect"

const remembered = Effect.gen(function*() {
  return yield* Flows.runRemember({
    bank: "global-history",
    key: "release",
    text: "cut 0.1.0",
    tags: ["scope:project"]
  })
})
// { key: "release" }
```

`Flows.runRememberWith(provenance)` builds the same handler with run coordinates bound in, so every fact it writes records them. See [Scope a flow tree to a namespace](./scope-a-flow-tree.md) for binding handlers under a policy.

## Store a note

Notes are append-only knowledge records. Call `putNote` with a globally unique id, text, tags, and provenance:

```ts
const noted = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  return yield* store.putNote({
    namespace: { kind: "agent", id: "reviewer" },
    id: "finding-41",
    text: "The changelog job skips pre-release tags.",
    tags: ["source:eval"],
    provenance: {},
    supersedes: ["finding-40"]
  })
})
```

- `status` defaults to `"accepted"`. Pass `"pending"` for a note an evaluation has not judged yet, and move it later with `setNoteStatus`.
- `supersedes` edges persist in the same write transaction as the note, and each target must exist in the same namespace.
- Re-putting an id with different creation data, different supersession data, a self-supersession, or a missing target fails with `supersede_conflict`. Re-putting identical data is a safe no-op.

Read notes with `listNotes`. An absent `status` filter selects `accepted`; pass `"any"` for everything, or an array of statuses. A note with an accepted superseder is hidden unless you pass `includeSuperseded: true`:

```ts
const findings = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  const accepted = yield* store.listNotes({ namespace: "agent-reviewer", prefix: "finding-" })
  const everything = yield* store.listNotes({
    namespace: "agent-reviewer",
    status: "any",
    includeSuperseded: true,
    tagGroups: [{ tags: ["source:eval"], match: "any" }]
  })
  return { accepted, everything }
})
```

Add a supersession edge after the fact with `supersede`:

```ts
const corrected = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  yield* store.supersede({ supersederId: "finding-41", targetId: "finding-40" })
})
```

Both notes must exist and share a namespace, and a note cannot supersede itself; violations fail with `supersede_conflict`.

## Store history

Create a thread explicitly when it belongs in a specific namespace, then append messages:

```ts
const conversation = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  yield* store.createThread({ id: "conversation-7", namespace: "agent-reviewer", title: "PR 41 review" })
  yield* store.appendMessage({
    threadId: "conversation-7",
    id: "msg-1",
    role: "user",
    text: "Review the changelog job.",
    at: Date.now()
  })
})
```

- `createThread` generates an id when you omit one, and re-creating with identical data answers the existing thread. Reusing an id with different data fails with `idempotency_conflict`.
- `appendMessage` creates a missing thread for you, in the `global` namespace under the id `history`. Call `createThread` first when the thread belongs somewhere else.
- A message id is unique within its thread. Re-appending identical data is a no-op; any difference in `role`, `text`, or `at` fails with `idempotency_conflict` and a path to the field.

Read a thread with `listMessages`, paginating with the exclusive `cursor` when you need more than one page:

```ts
const history = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  const page = yield* store.listMessages({ threadId: "conversation-7", limit: 100 })
  const last = page.at(-1)
  if (last === undefined) return page
  const nextPage = yield* store.listMessages({
    threadId: "conversation-7",
    limit: 100,
    cursor: { at: last.at, id: last.id }
  })
  return [...page, ...nextPage]
})
```

`deleteThread` removes the thread and all its messages.

## Next steps

- Rank what you stored: [Recall memory](./recall-memory.md).
- Understand the record model: [What memory persists](../concepts/durability.md).
- Trim history when it grows: [Run maintenance passes](./maintenance.md).

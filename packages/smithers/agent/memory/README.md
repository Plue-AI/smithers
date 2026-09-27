# @smthrs/memory

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://memory.smithers.sh

Durable memory for an AI agent: facts, notes, and message threads kept in
SQLite, ranked for recall, and reachable by a model through two operations it
calls by name, `remember` and `recall`.

A model's context window disappears when the process exits. Everything the next
run should still know has to live outside the model, and this package is that
store. It ships as Effect services, so you choose the storage and the recall
algorithm your host can support and every caller keeps working.

## Install

The `1.0.0-rc.0` release documented here is not on npm yet. The `0.x` versions
published under this name are the previous generation of the package and have a
different API. Until the release candidate publishes, use `@smthrs/memory` from
a checkout of the [smithers repository](https://github.com/smithersai/smithers),
where it resolves as a workspace dependency:

```bash
git clone https://github.com/smithersai/smithers.git
cd smithers
pnpm install
```

It needs Node.js 26.4.0 or later and `effect` 4.0.0-rc.115 as a peer. The full
requirements, and the two packages a file-backed store adds, are on the
[installation page](https://memory.smithers.sh/installation/).

## Write a fact and recall it

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

`global-notes` is a bank, the public string spelling of a namespace.
`TestMemory.layer` forgets everything when the process exits; swapping it for
`MemoryStore.layer` over a SQLite file is a one-layer change, and the
[quickstart](https://memory.smithers.sh/quickstart/) walks that whole path.

## What the package gives you

- Scoped namespace isolation across `flow`, `agent`, `user`, and `global`
  memory. Bind a policy-carrying declaration with `Flows.handlersFor` to limit
  model-facing reads and writes to the policy namespace. Empty banks default
  to it; explicit banks resolving to another kind or id fail with
  `invalid_namespace` before I/O. Equivalent bank spellings are allowed.
  Bare handlers and direct recall or store APIs remain unscoped.
- Recall as a replaceable service rather than one fixed algorithm. Keyword
  matching needs nothing beyond the store; SQLite or PostgreSQL full text search and
  in-process semantic search over embeddings are also included, and swapping
  between them changes no caller. Semantic recall searches all eligible records
  in the selected banks using bounded pages and retains only its result budget.
- A byte budget on every recall answer, because recalled rows are about to
  become part of a prompt.
- Idempotent writes. Re-appending an identical message is a no-op; re-appending
  the same id with different content fails with `idempotency_conflict` instead
  of duplicating history.
- Append-only notes that correct themselves by supersession, so an obsolete
  note drops out of recall without a destructive edit.
- One memory policy a whole flow tree inherits, including the work a delegated
  plan generates that nobody named.

## Public API

The root entry point exports these namespaces, and each is also importable from
`@smthrs/memory/<Module>`. Every export, with its signature and its guarantees,
is on the [API reference](https://memory.smithers.sh/reference/api/).

| Namespace          | What it is                                                                        |
| ------------------ | --------------------------------------------------------------------------------- |
| `Flows`            | The callable `remember` and `recall` declarations, and their runtime bindings.    |
| `WithMemory`       | One memory policy applied to a whole flow tree.                                   |
| `MemoryTrellis`    | A trellis whose model-authored work inherits one memory policy.                   |
| `MemoryStore`      | The authoritative SQL store: facts, notes, threads, messages, and search rows.    |
| `Namespace`        | Structured memory namespaces and tag-group matching.                              |
| `Bank`             | The validating reader for the public string spelling of a namespace.              |
| `Recall`           | The replaceable recall seam: the service, the slot, and the byte budget.          |
| `RecallKeyword`    | Keyword recall, needing nothing beyond the store.                                 |
| `RecallFts`        | SQLite FTS5 recall.                                                               |
| `RecallSemantic`   | In-process semantic recall and opt-in vector projection.                          |
| `Embedding`        | The provider-neutral embedding port semantic recall reads.                        |
| `Source`           | The frozen, byte-capped memory snapshot an agent's opening context reads.         |
| `SnapshotRecorder` | The optional port that keeps that snapshot stable across a resumed process.       |
| `Maintenance`      | TTL collection, history limiting, and compaction, as finite Effects you schedule. |
| `Database`         | The public database port SQL-backed memory adapters accept.                       |
| `MemoryError`      | The one failure type, carrying a stable code and an optional field path.          |
| `Migrations`       | The registered memory schema for standalone and shared database composition.      |

`@smthrs/memory/test/TestMemory` is the in-memory test layer: the same
authoritative store over a fresh in-memory database. `internal/*`,
`migrations/*`, and nested `*/index` subpaths resolve to nothing on purpose.

## Documentation

- [Overview](https://memory.smithers.sh)
- [Quickstart](https://memory.smithers.sh/quickstart/)
- [What memory persists](https://memory.smithers.sh/concepts/durability/)
- [How recall works](https://memory.smithers.sh/concepts/recall/)
- [Memory policies](https://memory.smithers.sh/concepts/policies/)
- [Give an agent opening memory](https://memory.smithers.sh/guides/agent-opening-context/)
- [Troubleshooting](https://memory.smithers.sh/troubleshooting/), which lists
  every failure code, what causes it, and what to change.

## License

MIT. See [LICENSE](./LICENSE).

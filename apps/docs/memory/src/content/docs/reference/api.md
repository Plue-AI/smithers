---
title: "API reference"
description: "Every public export of @smthrs/memory: the two flows, the memory policy, the store contract, the recall bindings, and the failure codes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/api.md"
---

This page covers the parts a flow author touches: the two callable flows, the memory policy that decides which namespace a flow tree reads and writes, and the store behaviors that are easy to get wrong. The [module reference](#module-reference) at the end lists every export; the sections before it explain how those exports behave.

## The two flows

`Flows.remember` writes one record into a bank. `Flows.recall` reads advisory rows out of named banks. Both are declarations: building a graph performs no memory I/O. `Flows.handlersFor(flow)` supplies the runtime bindings for one declaration. `Flows.runRemember` and `Flows.runRecall` are the same implementations callable directly, without a policy.

Each flow also carries an effect declaration, the claim a planner reads before it runs anything: the paths the flow touches, a `mode` (`expected` means these are the paths worth declaring, `hermetic` means these are all of them), an `onConflict` policy saying what to do about another writer of the same path, and a `tier` saying how reversible the effect is. Tiers order from `irreversible` through `compensable` to `sealed`, and a nested declaration may narrow along that order but never widen it. `Flows.rememberEffects` is `irreversible` because it writes; `Flows.recallEffects` is `sealed` because recall declares no writes, so recall nests inside any enclosing declaration without widening it. [Effect envelopes](https://core.smithers.sh/concepts/effects/) in `@smthrs/core` covers the full grammar.

A bank name is the public spelling of a namespace. `Bank.parse` is the validating reader: it answers an `Effect` and rejects an empty or malformed bank with `invalid_namespace`. `Recall.namespaceForBank` is the unvalidated inverse kept for callers that already hold a well-formed bank, and `Recall.bankForNamespace` maps a namespace back. An unprefixed bank is flow-local; a prefix such as `flow-` or `global-` names an explicit lifetime. Because `bank` and `flow-bank` resolve to the same namespace, recall de-duplicates on the resolved namespace rather than on the bank string.

## Memory policies

A delegated plan generates work its author never named, so the memory settings that work runs under cannot be arguments threaded through every call. They are attached to the flow instead.

`WithMemory.Policy` has four fields:

| Field       | Values                | Meaning                                       |
| ----------- | --------------------- | --------------------------------------------- |
| `banks`     | nonempty `BankName[]` | where memory this tree reads and writes lives |
| `recall`    | `"none"`, or absent   | `"none"` refuses recall                       |
| `maxTokens` | integer               | the budget recall answers within              |
| `retain`    | `"never"`, or absent  | `"never"` drops every write                   |

`WithMemory.withMemory(flow, policy)` returns a copy of `flow` carrying the policy, and gives the same policy to every flow that flow declares. The original is untouched. A nested flow that already carries a policy is replaced by this one, so the tree runs under exactly one policy and the inherited answer is predictable. The policy is decoded and frozen at that call, so an invalid policy fails there rather than at a SQL constraint, and mutating the object afterwards changes nothing.

Only a flow whose collaborators are data, one declared with `flows: [...]` and no body, carries children a decorator can rewrite. A flow with a body reaches its collaborators by calling them, and those calls are graph nodes rather than a list, so `WithMemory.children` returns nothing for one. `WithMemory.references` is the wider view: it includes registry names the runtime has not resolved to a flow yet, which a policy carries through untouched.

A policy is an annotation, and an annotation takes no part in flow identity. Applying one never changes the graph a flow plans, node for node.

### Reading a policy back

`Flows.runRecallFor(flow, input)` and `Flows.runRememberFor(flow, input)` read the policy, and `Flows.handlersFor(flow)` is the pair a host binds. The policy namespace is the only namespace these scoped handlers may read or write:

- `runRecallFor` fills an empty `banks` list with all policy banks. Every explicit bank must resolve to a policy bank, matching both `kind` and `id`. A foreign bank fails the whole request with `invalid_namespace` before the recall service runs, including requests that mix allowed and foreign banks.
- `runRememberFor` resolves an empty bank to the first policy bank. An explicit foreign bank fails with `invalid_namespace` before the store runs.
- Equivalent spellings are allowed: `release-notes` and `flow-release-notes` both resolve to `{ kind: "flow", id: "release-notes" }`. There is no additional readable-bank list.
- `maxTokens` remains a default: the policy budget applies only when the caller omits it.

Two policy values short-circuit before bank validation or I/O:

- `recall: "none"` returns no rows and never reaches the recall service.
- `retain: "never"` drops the write. The caller still receives the key it asked for, and nothing reaches the store.

The boundary applies through `Flows.handlersFor` on a policy-carrying declaration, or through `runRecallFor` and `runRememberFor`. Given a declaration that carries no policy, these fail closed with `invalid_namespace` before any I/O. Bare handlers, direct `runRecall` / `runRemember` calls, recall services, and store methods do not enforce flow policies. Hosts must bind the scoped declarations for model-facing access.

```ts
import { Flows, WithMemory } from "@smthrs/memory"
import { Effect } from "effect"

const scoped = WithMemory.withMemory(Flows.recall, {
  banks: ["flow-release-notes"],
  maxTokens: 2048
})

const recalled = Effect.gen(function*() {
  return yield* Flows.runRecallFor(scoped, { banks: [], query: "changelog" })
})
```

### Binding a policy-carrying declaration

Bind the same declaration the caller will run. For delegated work that is the copy `withMemory` produced, not the bare export, so bind it through `handlersFor`:

```ts
import { FlowBinding } from "@smthrs/harness"

const bound = WithMemory.withMemory(Flows.recall, policy)
const binding = FlowBinding.make({ flow: bound, handler: Flows.handlersFor(bound).recall })
```

The copy keeps the declaration's input and output schemas, which is what makes that call compile: `FlowBinding.make` reads `flow.input` to type the handler. A flow held as `Flow.Any`, the existential a pattern passes around, stays `Flow.Any`.

Every handler takes exactly one argument, the decoded flow input, because `FlowBinding.make` types its handler as `(input, call)` and passes the `Call` in the second position. Run coordinates are bound instead, once, when the handler is built: `Flows.handlersFor(flow, { runId, nodeId, iteration })` records them on every fact its `remember` writes, and `Flows.runRememberWith(provenance)` is the same thing without a policy. A provenance parameter on the handler itself would receive the `Call` and persist it as the fact's provenance.

Binding `Flows.recall` with `Flows.runRecall` reaches the store with no namespace, no budget cap, and no way to honor `recall: "none"`.

## MemoryTrellis

`MemoryTrellis.make` is the delegation case. `Trellis.make` declares the topology a model-authored plan fits inside, and fills its leaf slots at run time, so a leaf cannot be handed a namespace at declaration time. `MemoryTrellis.make` applies one policy to the author, to the leaf, and to the memory flows those declare, then annotates the trellis itself.

It takes what `Trellis.make` takes, plus `memory`. `Trellis.make` accepts any member it can record a call to; a memory trellis needs more of its author and its leaf, because a policy is an annotation and a member states no annotation bag, so both are declarations here. The `envelope` is the bound the authored plan is admitted under: `fuel` is the total number of leaf calls the plan may make, `depth` the nesting it may reach, and `fanout` the members any one group may hold.

```ts
import { MemoryTrellis } from "@smthrs/memory"

const trellis = MemoryTrellis.make({
  author: planner,
  leaf: worker,
  envelope: { fuel: 6, depth: 3, fanout: 3 },
  memory: {
    banks: ["flow-release-notes"],
    maxTokens: 2048
  }
})
```

The graph is the plain trellis graph, node for node. `MemoryTrellis.parts` returns the scoped author and leaf on their own, for a caller that drives the plan with `Trellis.run` rather than calling the declared flow: calling the originals instead loses the policy.

See the [`@smthrs/patterns` reference](https://smithers-patterns.smithers.sh/reference/api/) and its [delegation guide](https://smithers-patterns.smithers.sh/delegation/) for the trellis itself.

## Store behaviors worth knowing

These are the answers that surprise callers most often.

- `listNotes` defaults `status` to `"accepted"`. Pending and rejected notes are hidden unless you ask for them by name or pass `"any"`.
- A message id is unique within its thread, not globally. The same id in two threads is two messages. A same-thread retry whose `role`, `text`, or `at` differs fails with `idempotency_conflict` and a path to the first field that differs.
- `appendMessage` creates a missing thread for you, in the `global` namespace under the id `history`. Call `createThread` first when the thread belongs somewhere else.
- `maxTokens` is a UTF-8 byte ceiling over the serialized result array, not a token count. Bytes conservatively bound tokens without committing the package to one model's tokenizer. `Source.Input.maxBytes` is a separate ceiling on the rendered snapshot.
- `capRecallResults` drops rows with empty text before it fills the budget.
- Fact values are stored as JSON, so the value `getFact` returns is the value `JSON.stringify` produced: `NaN` and `Infinity` become `null`, `undefined`, function, and symbol members disappear, and sparse arrays collapse. The value is serialized once at API entry, and the stored JSON, the search text, the retained tags, and any vector projection all come from that one snapshot.
- `RecallKeyword` normalizes both query and row text to NFKC before matching. SQLite full text search does not, so the two bindings can disagree on compatibility-equivalent characters.
- The authoritative store writes no embedding vectors. Semantic projection is opt-in through `RecallSemantic.decorateStore`, and `RecallSemantic.recall` scans all eligible vectors in the selected banks under the requested model, retaining only its result budget.
- TTL garbage collection is complete: `Maintenance.ttlGc` removes the expired fact, its full text projection, and its vector rows in one transaction.

### Published ceilings

| Ceiling                              | Value  | Enforced at                               |
| ------------------------------------ | ------ | ----------------------------------------- |
| `Namespace.MAX_TAGS`                 | 16     | tag decode                                |
| `Namespace.MAX_TAG_GROUP_DEPTH`      | 8      | tag-group decode and matching             |
| `Namespace.MAX_TAG_GROUP_NODES`      | 64     | tag-group decode and matching             |
| `Recall.MAX_RECALL_BANKS`            | 16     | `Recall.Input` decode                     |
| `Recall.MAX_RECALL_BANK_NAME_LENGTH` | 128    | `Recall.Input` and `RememberInput` decode |
| `Recall.MAX_RECALL_QUERY_BYTES`      | 16,384 | `Recall.Input` decode                     |
| `Recall.MAX_RECALL_TOKENS`           | 65,536 | `Recall.Input` and `Policy`               |
| `Recall.MAX_RECALL_TAG_GROUPS`       | 16     | `Recall.Input` decode                     |
| `Flows.MAX_REMEMBER_KEY_BYTES`       | 1,024  | `RememberInput` decode                    |
| `Flows.MAX_REMEMBER_TEXT_BYTES`      | 16,384 | `RememberInput` decode                    |

Each tag group is bounded on its own, and the group list is bounded too: every group is evaluated against every candidate row by every binding, so an unbounded list would multiply the per-group budget without limit.

### What a read limit counts

`searchRows.records` and `searchFts.records` optionally restrict the read to at most 64 exact `{ kind, id }` identities, while preserving namespace, TTL, status, supersession, and tag filtering. An empty array selects nothing. Each identity requires kind `fact` or `note` and a nonempty id.

`limit` on `listFacts`, `listNotes`, `listMessages`, `searchRows` and `searchFts` bounds the rows the caller receives, after every status, supersession and tag-group filter on the same input. It is not a bound on the rows the query examines, and a bounded read never under-fills while matching rows remain.

Statuses and supersession are answered in SQL. Tag groups are answered by `Namespace.matches`, the single source of truth for the five match modes, so a tag-filtered read walks the namespace in bounded pages until it has `limit` matches. Working-set memory stays proportional to one page, never to the namespace.

Note and fact pages continue from the last examined timestamp and id, preserving ascending ids within timestamp ties. Inserts or deletes before the cursor do not shift later pages. These reads are not snapshots; updates that move a fact across the cursor may affect results.

FTS rank pages share one transaction because BM25 depends on the corpus, and filtered FTS reads use 512-row pages. The SQLite transaction holds off writers until the scan finishes.

Use `tagGroups: [group]` for one tag predicate. Multiple groups are conjunctive; the singular `tagGroup` input is no longer supported.

## Failure codes

`MemoryError.code` is the stable machine-readable answer, and `MemoryError.path` points at the offending field when one exists. `invalid_argument` means the caller passed something wrong; `store` means the backend failed. They are never the same code.

| Code                    | Meaning                                                           |
| ----------------------- | ----------------------------------------------------------------- |
| `not_found`             | the addressed record does not exist                               |
| `fts_not_enabled`       | the namespace kind has not opted into full text search            |
| `invalid_namespace`     | a namespace or bank name is empty or malformed                    |
| `invalid_tag`           | a tag or tag group violates the vocabulary or a published ceiling |
| `invalid_argument`      | any other rejected argument, with a `path` to the field           |
| `supersede_conflict`    | a supersession request contradicts what is already stored         |
| `idempotency_conflict`  | different creation data on retry, or an existing summary id       |
| `compaction_conflict`   | a summarized source row disappeared or its payload changed        |
| `embedding_unavailable` | the embedding provider failed or answered an invalid batch        |
| `vector_model_mismatch` | a stored vector under the requested model has the wrong dimension |
| `store`                 | the backend failed                                                |

[Troubleshooting](/troubleshooting/) maps each code to its cause and fix.

## Module reference

Every module is importable from the root as a namespace and from its own subpath; the tables use the subpath form. [Import surface](/surface/) documents the exports map.

### `@smthrs/memory/Bank`

| Export  | Signature                                          | Behavior                                                                                                                                                 |
| ------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parse` | `(bank: string) => Effect<Namespace, MemoryError>` | The validating reader for bank names. Rejects an empty or malformed bank with `invalid_namespace`. The unvalidated inverse is `Recall.namespaceForBank`. |

### `@smthrs/memory/Database`

| Export            | Signature | Behavior                                                                                                                                                                                                                        |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseService` | interface | The query and serialized-write capabilities memory SQL adapters need: a `SqlClient.SqlClient` plus the `DurableWriter` write contract from [`@smthrs/database`](https://database.smithers.sh/reference/api/). `RecallSemantic.makeSqlVectorStore` accepts it. |

### `@smthrs/memory/Embedding`

| Export              | Signature                                                   | Behavior                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EmbedResponse`     | interface                                                   | One returned vector: `{ vector: ReadonlyArray<number> }`.                                                                                                           |
| `EmbedManyResponse` | interface                                                   | An ordered batch: `{ embeddings: ReadonlyArray<EmbedResponse> }`.                                                                                                   |
| `EmbedMany`         | type                                                        | The injectable provider function: `(inputs) => Effect<ReadonlyArray<ReadonlyArray<number>>, MemoryError>`.                                                          |
| `Service`           | interface                                                   | `embed(input)` for one input and `embedMany(inputs)` for an ordered batch.                                                                                          |
| `Embedding`         | `Context.Service` tag `flows/memory/Embedding`              | The context tag semantic recall reads.                                                                                                                              |
| `make`              | `(embedMany: EmbedMany) => Service`                         | Builds the service and validates every batch: count match, non-zero and uniform dimensions, finite components. An invalid batch fails with `embedding_unavailable`. |
| `layer`             | `(embedMany: EmbedMany) => Layer<Embedding>`                | Provides an injectable provider.                                                                                                                                    |
| `makeNoop`          | `() => Service`                                             | A non-empty request fails with `embedding_unavailable`: no embedding provider is configured. An empty batch returns `{ embeddings: [] }`.                           |
| `layerNoop`         | `Layer<Embedding>`                                          | Provides the unavailable implementation.                                                                                                                            |
| `layerFake`         | `(vectors \| (input, index) => vector) => Layer<Embedding>` | Provides a deterministic implementation for tests and local integrations.                                                                                           |
| `inProcessModel`    | `"flows-embedding/in-process-v1"`                           | Stable model identity for the built-in projection.                                                                                                                  |
| `inProcessVector`   | `(input: string) => ReadonlyArray<number>`                  | Computes the deterministic local v1 vector: a character hash into 64 dimensions over NFKC-normalized input. Lexical, not semantic; for tests and offline runs.      |
| `makeInProcess`     | `() => Service`                                             | Constructs the deterministic in-process implementation.                                                                                                             |
| `layerInProcess`    | `Layer<Embedding>`                                          | Provides in-process embeddings with no provider dependency.                                                                                                         |

### `@smthrs/memory/Flows`

The `mode`, `onConflict`, and `tier` values in the two effect declarations below are the vocabulary defined under [The two flows](#the-two-flows).

| Export                         | Signature                                                                                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rememberName`                 | `"remember"`                                                                                 | The registry name of the `remember` flow.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `recallName`                   | `"recall"`                                                                                   | The registry name of the `recall` flow.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `rememberDescription`          | `"Persist a memory record in a named bank."`                                                 | The one-line description the model sees for `remember`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `recallDescription`            | `"Recall advisory memory rows from named banks."`                                            | The one-line description the model sees for `recall`.                                                                                                                                                                                                                                                                                                                                                                                               |
| `MAX_REMEMBER_KEY_BYTES`       | `1024`                                                                                       | Maximum UTF-8 bytes in a remembered key.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MAX_REMEMBER_TEXT_BYTES`      | `16384`                                                                                      | Maximum UTF-8 bytes in a remembered text, the recall query cap.                                                                                                                                                                                                                                                                                                                                                                                     |
| `RESERVED_REMEMBER_TAG_PREFIX` | `"source:"`                                                                                  | The tag prefix `remember` refuses with `invalid_tag`: only a host writing through the store may claim a record's source.                                                                                                                                                                                                                                                                                                                            |
| `RememberInput`                | schema                                                                                       | `{ bank, key, text, tags?, ttlMs? }`. `bank` is `Recall.BankName`, so every remembered fact is in a bank recall can name. `key` is non-empty and at most `MAX_REMEMBER_KEY_BYTES` UTF-8 bytes; `text` is at most `MAX_REMEMBER_TEXT_BYTES`. Tags use `Namespace.Tags`, so model decoding and durable writes enforce the same vocabulary, uniqueness rule, and 16-tag cap. A `source:` tag fails with `invalid_tag`, in decode and in `runRemember`. |
| `RememberOutput`               | schema                                                                                       | `{ key }`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `RecallInput`                  | schema                                                                                       | `Recall.Input`.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RecallOutput`                 | schema                                                                                       | `Recall.Output`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rememberEffects`              | `Effects` declaration                                                                        | Reads and writes `memory/**`, mode `expected`, conflict policy `serialize`, tier `irreversible`.                                                                                                                                                                                                                                                                                                                                                    |
| `recallEffects`                | `Effects` declaration                                                                        | Reads `memory/**`, writes nothing, mode `expected`, conflict policy `fail`, tier `sealed`.                                                                                                                                                                                                                                                                                                                                                          |
| `remember`                     | `Flow` declaration                                                                           | Declaration for a memory write. Performs no I/O while a graph builds.                                                                                                                                                                                                                                                                                                                                                                               |
| `recall`                       | `Flow` declaration                                                                           | Declaration for advisory memory recall. Performs no I/O while a graph builds.                                                                                                                                                                                                                                                                                                                                                                       |
| `bindRecall`                   | `(supplied: Flow.Any) => Flow.Any`                                                           | Resolves the recall slot to a supplied flow, through `Pattern.bind`.                                                                                                                                                                                                                                                                                                                                                                                |
| `runRememberWith`              | `(provenance) => (input: RememberInput) => Effect<RememberOutput, MemoryError, MemoryStore>` | Runtime binding carrying explicit provenance, bound once when a host builds the handler. Stores the fact value `{ content: text }`.                                                                                                                                                                                                                                                                                                                 |
| `runRemember`                  | `(input: RememberInput) => Effect<RememberOutput, MemoryError, MemoryStore>`                 | Runtime binding with no provenance. Takes exactly one argument so a host can hand it to `FlowBinding.make`.                                                                                                                                                                                                                                                                                                                                         |
| `runRecall`                    | `(input: RecallInput) => Effect<RecallOutput, MemoryError, Recall>`                          | Delegates to whichever recall service the context provides.                                                                                                                                                                                                                                                                                                                                                                                         |
| `runRecallFor`                 | `(flow: Flow.Any, input: RecallInput) => Effect<RecallOutput, MemoryError, Recall>`          | Defaults empty banks and the budget; rejects foreign namespaces with `invalid_namespace` before recall. `recall: "none"` short-circuits to no rows.                                                                                                                                                                                                                                                                                                 |
| `runRememberFor`               | `(flow, input, provenance = {}) => Effect<RememberOutput, MemoryError, MemoryStore>`         | Defaults an empty bank; rejects foreign namespaces with `invalid_namespace` before writing. `retain: "never"` short-circuits to `{ key }`.                                                                                                                                                                                                                                                                                                          |
| `Handlers`                     | interface                                                                                    | The one-argument `remember` and `recall` handlers one bound declaration answers with.                                                                                                                                                                                                                                                                                                                                                               |
| `handlersFor`                  | `(flow: Flow.Any, provenance = {}) => Handlers`                                              | Builds the handlers for one memory declaration, reading the policy it carries and binding provenance once.                                                                                                                                                                                                                                                                                                                                          |
| `RememberInputType`            | type                                                                                         | What the `remember` flow accepts.                                                                                                                                                                                                                                                                                                                                                                                                                   |

### `@smthrs/memory/Maintenance`

| Export                 | Signature                                                                   | Behavior                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TtlGcResult`          | interface                                                                   | `{ deletedFacts: number }`.                                                                                                                                                                                                                                                                                                                        |
| `ttlGc`                | `Effect<TtlGcResult, MemoryError, MemoryStore>`                             | Deletes facts whose TTL has elapsed, with their full text and vector projections, in one finite pass.                                                                                                                                                                                                                                              |
| `TtlGcScheduleOptions` | interface                                                                   | `{ interval? }`; `interval` defaults to ten minutes.                                                                                                                                                                                                                                                                                               |
| `layerTtlGc`           | `(options?) => Layer<never, never, MemoryStore>`                            | Runs `ttlGc` at build and on every interval while the scope is open, in a span named `Maintenance.ttlGc`. Logs a count when a pass deletes rows and a warning when one fails; the next pass still runs. The Smithers host composes it wherever it builds the memory store.                                                                         |
| `TokenLimiterOptions`  | interface                                                                   | `{ maxTokens, charsPerToken? }`; `charsPerToken` defaults to 4.                                                                                                                                                                                                                                                                                    |
| `TokenLimiterResult`   | interface                                                                   | `{ deletedMessages: number }`.                                                                                                                                                                                                                                                                                                                     |
| `limitHistory`         | `(options) => Effect<TokenLimiterResult, MemoryError, MemoryStore>`         | Deletes the oldest messages in every thread until each thread fits the approximate budget `maxTokens * charsPerToken` characters.                                                                                                                                                                                                                  |
| `SummarizerInput`      | interface                                                                   | `{ threadId, messages, rendered }`: the old messages and their rendered `role: text` lines.                                                                                                                                                                                                                                                        |
| `Summarizer`           | interface                                                                   | `{ summarize(input): Effect<string, E, R> }`: the injected summarization route.                                                                                                                                                                                                                                                                    |
| `CompactionOptions`    | interface                                                                   | `{ summarizer, threadId?, keepRecent?, maxMessagesPerSummary?, makeSummaryId? }`; `keepRecent` defaults to 2, `maxMessagesPerSummary` to 1024 and must be at least 2.                                                                                                                                                                              |
| `CompactionResult`     | interface                                                                   | `{ compactedThreads: number, deletedMessages: number }`.                                                                                                                                                                                                                                                                                           |
| `compact`              | `(options) => Effect<CompactionResult, E \| MemoryError, R \| MemoryStore>` | Summarizes old history in windows of at most `maxMessagesPerSummary` messages, each atomically replaced by one summary that the next window folds in. The summarizer runs before each write transaction; interruption before a commit leaves that window's sources intact. `deletedMessages` counts every deleted row, including folded summaries. |

### `@smthrs/memory/MemoryError`

| Export            | Signature                                            | Behavior                                                                                                    |
| ----------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `MemoryErrorCode` | schema and type                                      | The eleven stable codes listed in [Failure codes](#failure-codes).                                          |
| `MemoryError`     | `Schema.TaggedError`, tag `flows/memory/MemoryError` | The error raised by memory validation, storage, search, and projection: `{ code, message, path?, cause? }`. |

### `@smthrs/memory/MemoryStore`

Model types, all plain interfaces unless noted:

| Export                 | Shape                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Provenance`           | `{ runId?, nodeId?, iteration? }`: explicit run coordinates attached to a write.                                                      |
| `Fact`                 | `{ namespace, key, value, tags?, ttlMs?, provenance, createdAtMs, updatedAtMs }`.                                                     |
| `PutFactInput`         | `{ namespace, key, value, tags?, ttlMs?, provenance }`; `value` is stored through a `JSON.stringify` round trip.                      |
| `GetFactInput`         | `{ namespace, key }`.                                                                                                                 |
| `ListFactsInput`       | `{ namespace, prefix?, limit? }`.                                                                                                     |
| `Thread`               | `{ id, namespace, title?, metadata?, createdAtMs, updatedAtMs }`.                                                                     |
| `CreateThreadInput`    | `{ id?, namespace, title?, metadata? }`.                                                                                              |
| `ListThreadsInput`     | `{ namespace? }`.                                                                                                                     |
| `GetThreadInput`       | `{ threadId }`.                                                                                                                       |
| `DeleteThreadInput`    | `{ threadId }`.                                                                                                                       |
| `Message`              | `{ threadId, id, role, text, at }`.                                                                                                   |
| `AppendMessageInput`   | `Message`: an idempotent append, with the id unique within its thread.                                                                |
| `ListMessagesInput`    | `{ threadId, limit?, cursor? }`.                                                                                                      |
| `MessageCursor`        | `{ at, id }`: a stable exclusive cursor for ordered pagination.                                                                       |
| `MessageStats`         | `{ messages, codePoints, bytes }`: one thread's size bounds; its JavaScript string length lies between `codePoints` and `bytes`.      |
| `GetNoteInput`         | `{ id }`.                                                                                                                             |
| `NoteStatus`           | schema and type: `"pending"`, `"accepted"`, `"rejected"`; the only mutable state on an append-only note.                              |
| `Note`                 | `{ namespace, id, text, tags, provenance, status, createdAtMs }`.                                                                     |
| `PutNoteInput`         | `{ namespace, id, text, tags, provenance, status?, supersedes? }`; `supersedes` persists in the same write transaction.               |
| `SetNoteStatusInput`   | `{ id, status }`.                                                                                                                     |
| `SupersedeInput`       | `{ supersederId, targetId }`.                                                                                                         |
| `NamespaceInput`       | `Namespace \| string`: a structured namespace or a bank name; explicit prefixes keep their lifetime, unprefixed banks are flow-local. |
| `StatusFilter`         | `NoteStatus \| "any" \| ReadonlyArray<NoteStatus>`.                                                                                   |
| `ListNotesInput`       | `{ namespace, prefix?, limit?, tagGroups?, status?, includeSuperseded? }`.                                                            |
| `SearchRow`            | `{ id, kind: "fact" \| "note", bank, namespace, key, text, tags, updatedAtMs, status? }`: the normalized row recall bindings consume. |
| `SearchRowsInput`      | `ListNotesInput` with a `limit` that counts merged fact and note rows passing every filter.                                           |
| `EnableFtsInput`       | `Namespace.Kind`.                                                                                                                     |
| `SearchFtsInput`       | `SearchRowsInput` plus `query`.                                                                                                       |
| `FtsRow`               | `SearchRow` plus `rank` (raw SQLite BM25) and `score`.                                                                                |
| `CompactMessagesInput` | `{ threadId, summary: Message, sourceMessages: ReadonlyArray<Message> }`.                                                             |

The service tag is `MemoryStore`, `Context.Service` tag `flows/memory/MemoryStore`. Every operation fails only with `MemoryError`:

| Operation            | Signature                                         | Behavior                                                                                                                                                |
| -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `putFact`            | `(PutFactInput) => Effect<void>`                  | Last-write-wins upsert. Each update restarts the TTL clock and refreshes the FTS projection.                                                            |
| `getFact`            | `(GetFactInput) => Effect<Fact \| undefined>`     | Answers the current fact, or `undefined` when it is missing or expired.                                                                                 |
| `deleteFact`         | `(GetFactInput) => Effect<boolean>`               | Deletes the fact with its FTS and vector rows; answers whether a row existed.                                                                           |
| `listFacts`          | `(ListFactsInput) => Effect<Fact[]>`              | Ordered by key, excluding expired facts; optional key `prefix` and `limit`.                                                                             |
| `listAllFacts`       | `Effect<Fact[]>`                                  | Every unexpired fact, ordered by namespace and key.                                                                                                     |
| `createThread`       | `(CreateThreadInput) => Effect<Thread>`           | Generates an id when omitted. Idempotent on identical creation data; a conflict fails `idempotency_conflict`.                                           |
| `getThread`          | `(GetThreadInput) => Effect<Thread \| undefined>` | Exact read by id.                                                                                                                                       |
| `listThreads`        | `(ListThreadsInput?) => Effect<Thread[]>`         | All threads, or one namespace's, ordered by creation.                                                                                                   |
| `deleteThread`       | `(DeleteThreadInput) => Effect<boolean>`          | Deletes the thread and all its messages.                                                                                                                |
| `appendMessage`      | `(AppendMessageInput) => Effect<void>`            | Creates a missing thread in the `global` namespace under the id `history`. An identical retry is a no-op; a differing one fails `idempotency_conflict`. |
| `listMessages`       | `(ListMessagesInput) => Effect<Message[]>`        | Ordered by `(at, id)`; paginate with the exclusive `cursor`.                                                                                            |
| `countMessages`      | `(ListMessagesInput) => Effect<number>`           | Counts one thread's messages.                                                                                                                           |
| `messageStats`       | `({ threadId }) => Effect<MessageStats>`          | One SQL aggregate: message count, summed code points, and summed stored bytes, without reading message bodies.                                          |
| `putNote`            | `(PutNoteInput) => Effect<Note>`                  | Append-only insert; `status` defaults to `accepted`. An identical re-put is a no-op; a differing one fails `supersede_conflict`.                        |
| `getNote`            | `(GetNoteInput) => Effect<Note \| undefined>`     | Exact read by globally unique id.                                                                                                                       |
| `setNoteStatus`      | `(SetNoteStatusInput) => Effect<void>`            | The status gate. An unknown id fails `not_found`.                                                                                                       |
| `supersede`          | `(SupersedeInput) => Effect<void>`                | Adds a supersession edge. Both notes must exist and share a namespace; violations fail `supersede_conflict`.                                            |
| `listNotes`          | `(ListNotesInput) => Effect<Note[]>`              | Authoritative note read; `status` defaults to `accepted`, superseded notes hide unless `includeSuperseded`.                                             |
| `enableFts`          | `(kind: EnableFtsInput) => Effect<void>`          | Lazily enables FTS5 for one namespace kind and backfills it once; a kind that is already enabled is left as is, so calling it on every boot is cheap.   |
| `searchFts`          | `(SearchFtsInput) => Effect<FtsRow[]>`            | Direct FTS5 recall, `limit` defaulting to 20. A disabled kind fails `fts_not_enabled`.                                                                  |
| `searchRows`         | `(SearchRowsInput) => Effect<SearchRow[]>`        | Merged newest-first facts and notes for recall bindings; a bounded read never under-fills.                                                              |
| `deleteExpiredFacts` | `Effect<number>`                                  | Deletes expired facts with their projections, in bounded chunks.                                                                                        |
| `listThreadIds`      | `Effect<string[]>`                                | Every thread id, ordered by creation.                                                                                                                   |
| `deleteMessages`     | `({ threadId, ids }) => Effect<number>`           | Deletes the named messages, in bounded chunks.                                                                                                          |
| `compactMessages`    | `(CompactMessagesInput) => Effect<number>`        | Inserts the summary and deletes the sources in one durable write. A summary id that already exists fails `idempotency_conflict`.                        |

`compactMessages` captures the full `sourceMessages` rows and verifies them inside the write transaction before inserting or deleting. Missing or changed sources fail with `compaction_conflict`. An existing summary id fails with `idempotency_conflict`, including identical retries.

| Export      | Signature                                                                      | Behavior                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make`      | `Effect<Service, MemoryError, Crypto.Crypto \| DurableWriter \| SqlClient>`    | Builds the SQL-backed service and applies the package's idempotent migrations. Every operation runs in a span named `MemoryStore.<method>` carrying shape attributes only (namespace kind, limit, row count), and counts its outcome on the `smithers_memory_operations` counter by `method` and `outcome`. |
| `makeNoop`  | `(overrides?: Partial<Service>) => Service`                                    | An unavailable stub: every operation fails `store`, optionally overridden per method.                                                                                                                                                                                                                       |
| `layerNoop` | `(overrides?: Partial<Service>) => Layer<MemoryStore>`                         | Provides the unavailable stub.                                                                                                                                                                                                                                                                              |
| `layer`     | `Layer<MemoryStore, MemoryError, Crypto.Crypto \| DurableWriter \| SqlClient>` | Provides the authoritative SQL store over the SQL client and the durable writer.                                                                                                                                                                                                                            |

### `@smthrs/memory/MemoryTrellis`

| Export        | Signature                                   | Behavior                                                                                                                     |
| ------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `MakeOptions` | interface                                   | What `Trellis.make` accepts, with `author` and `leaf` narrowed to `Flow.Any` so each can carry an annotation, plus `memory`. |
| `Parts`       | interface                                   | `{ author, leaf }`: the scoped flows to hold when you drive the plan yourself with `Trellis.run`.                            |
| `parts`       | `(options) => Parts`                        | Applies the policy to the author and the leaf without composing them.                                                        |
| `make`        | `(options) => Trellis.TrellisFlow<unknown>` | Declares a trellis whose author, leaves, and memory flows all run under one policy. The graph is unchanged.                  |

### `@smthrs/memory/Migrations`

| Export  | Signature                                                                                 | Behavior                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set`   | `DatabaseMigrations.MigrationSet`                                                         | Namespace `memory`, migration block `7000`; owns the authoritative memory schema and its indexes.                                                                   |
| `run`   | `Effect<ReadonlyArray<readonly [number, string]>, MigrationError \| SqlError, SqlClient>` | Applies pending memory migrations and records their identities atomically in `flows_migrations`. Repeated calls return an empty list after the schema is installed. |
| `layer` | `Layer<never, MigrationError \| SqlError, SqlClient>`                                     | Runs `run` during layer construction.                                                                                                                               |

`MemoryStore.make` and `MemoryStore.layer` run these migrations automatically. A standalone store needs only its SQL client, durable writer, and Crypto service; the resulting database can be reopened by another process.

When memory shares a database with the engine or control plane, compose all required lower migration sets before building memory. The CLI's shared control database installs `TimeTravelMigrations.sets`, `ControlMigrations.set`, and `MemoryMigrations.set` together. The database migration ladder rejects adding a previously absent lower block after memory has advanced the ledger; it does not assume those tables already exist. The [memory tutorial](https://smithers.sh/docs/tutorials/memory/) shows that shared composition.

### `@smthrs/memory/Namespace`

| Export                | Signature                                                      | Behavior                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Kind`                | schema and type                                                | The four stable lifetimes: `"flow"`, `"agent"`, `"user"`, `"global"`.                                                                                                                                                              |
| `Namespace`           | schema and type                                                | `{ kind, id }` with a non-empty `id`.                                                                                                                                                                                              |
| `MAX_TAGS`            | `16`                                                           | Maximum unique tags on one record or tag-group leaf.                                                                                                                                                                               |
| `MAX_TAG_GROUP_DEPTH` | `8`                                                            | Maximum root-inclusive depth of one tag-group expression.                                                                                                                                                                          |
| `MAX_TAG_GROUP_NODES` | `64`                                                           | Maximum expression nodes in one tag-group tree.                                                                                                                                                                                    |
| `TagPrefix`           | schema and type                                                | The vocabulary prefixes: `"branch:"`, `"stream:"`, `"source:"`, `"scope:"`.                                                                                                                                                        |
| `Tag`                 | schema and type                                                | A prefixed, non-empty tag.                                                                                                                                                                                                         |
| `Tags`                | schema and type                                                | A bounded, duplicate-free tag collection.                                                                                                                                                                                          |
| `MatchMode`           | schema and type                                                | `"any"`, `"all"`, `"any_strict"`, `"all_strict"`, `"exact"`.                                                                                                                                                                       |
| `TagGroup`            | schema and type                                                | The recursive query expression: `{ tags, match? }`, `{ and }`, `{ or }`, or `{ not }`, decoded within the published budgets.                                                                                                       |
| `matches`             | `(tagGroup: TagGroup, tags: ReadonlyArray<string>) => boolean` | The single source of truth for the five match modes. Non-strict `any` and `all` match untagged records; strict modes require at least one tag; `exact` requires set equality. An undecoded expression over budget answers `false`. |

### `@smthrs/memory/Recall`

| Export                        | Signature                                    | Behavior                                                                                                                    |
| ----------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MAX_RECALL_BANKS`            | `16`                                         | Maximum banks per model-facing request.                                                                                     |
| `MAX_RECALL_BANK_NAME_LENGTH` | `128`                                        | Maximum code units in one bank name.                                                                                        |
| `BankName`                    | schema                                       | A non-empty bank name of at most `MAX_RECALL_BANK_NAME_LENGTH` code units; `Input.banks` and `RememberInput.bank` share it. |
| `MAX_RECALL_QUERY_BYTES`      | `16384`                                      | Maximum UTF-8 bytes in one query.                                                                                           |
| `MAX_RECALL_TOKENS`           | `65536`                                      | Maximum conservative byte budget accepted as `maxTokens`.                                                                   |
| `MAX_RECALL_TAG_GROUPS`       | `16`                                         | Maximum tag groups per request; each group is evaluated against every candidate row, so the list is bounded too.            |
| `DEFAULT_MAX_TOKENS`          | `2048`                                       | Byte budget when `maxTokens` is absent.                                                                                     |
| `MaxTokens`                   | schema                                       | An integer byte budget from 0 to `MAX_RECALL_TOKENS`; `Input.maxTokens` and `WithMemory.Policy.maxTokens` share it.         |
| `requestedRows`               | `(maxTokens = 2048) => number`               | Rows keyword and FTS recall keep: one per 256 bytes, at least one.                                                          |
| `TagGroup`                    | type                                         | `Namespace.TagGroup`.                                                                                                       |
| `Input`                       | schema and type                              | `{ banks, query, tagGroups?, maxTokens?, budget? }` where `budget` is `"low"`, `"mid"`, or `"high"`.                        |
| `Result`                      | schema and type                              | `{ bank, key, text, score, updatedAtMs? }`.                                                                                 |
| `Output`                      | schema and type                              | `ReadonlyArray<Result>`.                                                                                                    |
| `slot`                        | `Pattern` slot                               | The flow-valued recall injection slot.                                                                                      |
| `Service`                     | interface                                    | `{ recall(input): Effect<Output, MemoryError> }`.                                                                           |
| `Recall`                      | `Context.Service` tag `flows/memory/Recall`  | The context tag for the replaceable implementation.                                                                         |
| `capRecallResults`            | `(results, maxTokens = 2048) => Result[]`    | The shared byte cap: drops empty text, selects complete rows greedily, then truncates only the first overflowing row.       |
| `compareResults`              | `(left, right) => number`                    | The ranking every binding sorts by: score descending, newest update, key, then bank.                                        |
| `layerFrom`                   | `(run) => Layer<Recall, never, MemoryStore>` | Provides a store-backed binding, capturing the MemoryStore once.                                                            |
| `layer`                       | `(implementation: Service) => Layer<Recall>` | Provides a recall service.                                                                                                  |
| `makeNoop`                    | `() => Service`                              | Answers no rows.                                                                                                            |
| `layerNoop`                   | `Layer<Recall>`                              | Provides the empty implementation.                                                                                          |
| `bankForNamespace`            | `(namespace: Namespace) => string`           | Maps a structured namespace to its public bank name, `kind-id`.                                                             |
| `namespaceForBank`            | `(bank: string) => { kind, id }`             | The unvalidated syntactic inverse. Use `Bank.parse` at every I/O boundary.                                                  |

### `@smthrs/memory/RecallFts`

| Export            | Signature                                                    | Behavior                                                                                                                            |
| ----------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `literalFtsQuery` | `(query: string) => string`                                  | Escapes a query into a quoted, implicit-AND FTS5 expression. `MemoryStore.searchFts` applies the same escaper, so pass raw queries. |
| `recall`          | `(input: Input) => Effect<Output, MemoryError, MemoryStore>` | Runs FTS recall against the supplied store. A disabled namespace kind propagates `fts_not_enabled`.                                 |
| `layer`           | `Layer<Recall, never, MemoryStore>`                          | Provides FTS recall as the replaceable recall slot.                                                                                 |

### `@smthrs/memory/RecallKeyword`

| Export                | Signature                                                    | Behavior                                                                                                            |
| --------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `Row`                 | type                                                         | `Pick<MemoryStore.SearchRow, "key" \| "text" \| "tags" \| "status" \| "updatedAtMs">`.                              |
| `recall`              | `(input: Input) => Effect<Output, MemoryError, MemoryStore>` | Runs keyword recall against the supplied store. Scores every row of each selected bank; there is no recency window. |
| `layer`               | `Layer<Recall, never, MemoryStore>`                          | Provides keyword recall with no host dependencies.                                                                  |
| `normalizeQueryTerms` | `(value: string) => ReadonlyArray<string>`                   | The NFKC, lowercase term split scoring compares against.                                                            |
| `scoreRow`            | `(query: ReadonlyArray<string>, row: Row) => number`         | The term-occurrence score of one row.                                                                               |

### `@smthrs/memory/RecallSemantic`

| Export                     | Signature                                                                         | Behavior                                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Vector`                   | interface                                                                         | A durable projection row: `{ bank, recordKind, recordId, model, contentDigest, dimensions, vector, updatedAtMs }`; components may be a readonly array or `Float32Array`. |
| `VectorStore`              | interface                                                                         | The injectable vector-table adapter: `upsert(vector)`, which keeps the newest row by `updatedAtMs`, and finite `scan(banks, model)` pages of at most 64 vectors.         |
| `Options`                  | interface                                                                         | `{ vectorStore, model?, halfLifeMs?, projectionTimeout? }`.                                                                                                              |
| `budgetLimits`             | `{ low: 3, mid: 8, high: 20 }`                                                    | Deterministic result counts for the three budgets.                                                                                                                       |
| `defaultModel`             | `Embedding.inProcessModel`                                                        | The model semantic recall uses when a declaration names none. It is the lexical in-process hash, so name a provider-backed model for semantic similarity.                |
| `makeSqlVectorStore`       | `(database: DatabaseService) => VectorStore`                                      | The SQLite adapter for the migration-owned `memory_vectors` table.                                                                                                       |
| `recall`                   | `(input, options) => Effect<Output, MemoryError, MemoryStore \| Embedding>`       | Cosine similarity decayed by row age. Skips foreign-model and stale rows; a same-model dimension mismatch fails `vector_model_mismatch`.                                 |
| `ProjectionInput`          | interface                                                                         | One authoritative row submitted for projection after commit: `{ bank, recordKind, recordId, text, updatedAtMs }`.                                                        |
| `Projector`                | interface                                                                         | `{ project(row), activeKeys() }`: the per-key serialized projection coordinator. There is no callable projector alias.                                                   |
| `makeProjector`            | `(options: Options) => Effect<Projector, never, Scope>`                           | Constructs the coordinator in its owner scope. Projection retries once, times out after `projectionTimeout`, and logs failures without changing the write result.        |
| `defaultProjectionTimeout` | `"5 seconds"`                                                                     | The projection deadline used when `Options.projectionTimeout` is absent.                                                                                                 |
| `decorateStore`            | `(store: Service, projector: Projector, embedding: Embedding.Service) => Service` | Adds after-commit projection to `putFact` and `putNote`, keeping the ordinary write signatures.                                                                          |
| `layer`                    | `(options: Options) => Layer<Recall, never, MemoryStore \| Embedding>`            | Provides semantic recall from the store, the embedding service, and the vector table.                                                                                    |

### `@smthrs/memory/Source`

| Export     | Signature                                                                                                | Behavior                                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Input`    | interface                                                                                                | `Recall.Input` plus `lineageId`, `iteration`, optional `primerBanks`, and optional `maxBytes` (default 16,384).                                                                                                                                                                          |
| `Source`   | interface                                                                                                | `{ read(input): Effect<Snapshot, MemoryError \| TimeoutError, MemoryStore \| Recall> }`.                                                                                                                                                                                                 |
| `Declared` | interface                                                                                                | `{ rows, digest }`: the exact shape `Agent.Options.memory` accepts; `digest` is the SHA-256 of `render(rows)`.                                                                                                                                                                           |
| `readRows` | `(input: Input) => Effect<Snapshot, MemoryError \| TimeoutError, MemoryStore \| Recall>`                 | Reads primer notes, then recall, unrendered and bounded so their render fits `maxBytes`. Fails typed; a read over two seconds fails with `TimeoutError`.                                                                                                                                 |
| `render`   | `(rows: ReadonlyArray<Row>) => string`                                                                   | Fences rows, one escaped line each; `""` for no rows.                                                                                                                                                                                                                                    |
| `make`     | `(options?: { capacity?: number }) => Source`                                                            | Constructs a memoizing source. `capacity` defaults to 1,024 identities and must be a positive safe integer. Beyond it the least recently used identity is evicted and its next read refetches unless a `SnapshotRecorder` is in context. A failed read is neither memoized nor recorded. |
| `source`   | `Source`                                                                                                 | The default source value.                                                                                                                                                                                                                                                                |
| `declared` | `(source: Source, input: Input) => Effect<Declared, MemoryError \| TimeoutError, MemoryStore \| Recall>` | Reads the frozen snapshot once per `(lineageId, iteration)` and digests its render.                                                                                                                                                                                                      |

### `@smthrs/memory/SnapshotRecorder`

| Export             | Signature                                              | Behavior                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Row`              | schema and type                                        | `{ origin: "primer" \| "recall", bank, key, text }`: one unrendered row. `key` is the note id (else the text's digest) for a primer and the recall key for a recalled row. |
| `Snapshot`         | schema and type                                        | `{ rows }`: the value one snapshot holds.                                                                                                                                  |
| `Identity`         | interface                                              | `{ lineageId, iteration }`: the stable identity of one opening snapshot.                                                                                                   |
| `Service`          | interface                                              | `{ record(identity, effect) }`: answer the recorded `Snapshot`, or evaluate, record, and answer `effect`.                                                                  |
| `SnapshotRecorder` | `Context.Service` tag `flows/memory/SnapshotRecorder`  | The optional recorder tag. With no service in context, `Source` keeps its process-local memo.                                                                              |
| `layer`            | `(implementation: Service) => Layer<SnapshotRecorder>` | Provides a recorder.                                                                                                                                                       |

### `@smthrs/memory/WithMemory`

| Export         | Signature                                                                                                                                                    | Behavior                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Policy`       | schema and type                                                                                                                                              | `{ banks, recall?: "none", maxTokens, retain?: "never" }`, with `maxTokens` capped at `Recall.MAX_RECALL_TOKENS`.                        |
| `MemoryPolicy` | annotation key `flows/memory/Annotations/MemoryPolicy`                                                                                                       | The annotation key carrying the policy on a flow.                                                                                        |
| `Declared`     | `Flow.Any \| DurableDeclaration`                                                                                                                             | A declaration a policy attaches to: a `@smthrs/core` signature, or the `@smthrs/flow` flow a pattern composes.                           |
| `references`   | `(flow: Declared) => ReadonlyArray<Flow.Reference>`                                                                                                          | The collaborators a flow declares, callable flows and unresolved registry names alike. A `@smthrs/flow` flow declares none.              |
| `children`     | `(flow: Declared) => ReadonlyArray<Flow.Any>`                                                                                                                | The callable flows a flow declares.                                                                                                      |
| `policyOf`     | `(flow: Declared) => Policy \| undefined`                                                                                                                    | Reads the policy a flow carries.                                                                                                         |
| `withMemory`   | `(flow: Flow<Input, Output, E>, policy: Policy) => Flow<Input, Output, E>`; also `(Flow.Any) => Flow.Any` and `(DurableFlow.Flow<…>) => DurableFlow.Flow<…>` | Returns a copy carrying the policy, with every declared flow carrying the same policy. Invalid policies throw `MemoryError` at the call. |

### `@smthrs/memory/test/TestMemory`

| Export              | Signature                                                    | Behavior                                                                                   |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `layer`             | `Layer<MemoryStore>`                                         | The authoritative store over a fresh in-memory database, with deterministic test services. |
| `layerWithDatabase` | `Layer<MemoryStore \| DurableWriter \| SqlClient.SqlClient>` | The same store, plus its in-memory database services for tests that inspect rows directly. |

For installation and the import forms, see [Installation](/installation/) and [Import surface](/surface/).

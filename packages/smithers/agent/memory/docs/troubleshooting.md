---
title: "Troubleshooting"
description: "The typed failures @smthrs/memory raises, what each one means, and the checks for empty recall and missing facts."
---

Every typed failure is a `MemoryError` with a stable machine-readable `code`, a human `message`, and a `path` to the offending field when one exists. `invalid_argument` means the caller passed something wrong; `store` means the backend failed. They are never the same code.

## Error codes

### `not_found`

The addressed record does not exist. `setNoteStatus` raises it for an unknown note id.

### `fts_not_enabled`

A full text read reached a namespace kind that has not opted into FTS. Call `enableFts` once per kind (`"flow"`, `"agent"`, `"user"`, `"global"`) before the first `searchFts` or `RecallFts` query against that kind. The store raises this instead of answering an empty result, so a missing enablement step is loud.

### `invalid_namespace`

A namespace or bank name is empty or malformed. An empty bank string is the common case, including a `remember` input whose `bank` is empty outside a policy. An invalid `enableFts` kind raises the same code.

For a policy-carrying declaration, `Flows.handlersFor`, `Flows.runRecallFor`, and `Flows.runRememberFor` also reject an explicit bank whose resolved kind or id differs from `policy.namespace`. Rejection happens before any I/O; one foreign bank fails the entire recall request. Empty bank selections use the policy namespace. `recall: "none"` and `retain: "never"` short-circuit before bank validation. Given a declaration that carries no policy, the same three fail with `invalid_namespace` before any I/O; bind the `WithMemory.withMemory` copy.

### `invalid_tag`

A tag or tag group violates the vocabulary or a published ceiling. Tags must start with `branch:`, `stream:`, `source:`, or `scope:`, must be unique per record, and number at most 16. The `remember` flow refuses a `source:` tag, which only a host writing through the store may set. A tag group accepts at most 8 levels and 64 expression nodes.

### `invalid_argument`

Any other rejected argument, with `path` naming the field: an empty key, id, thread id, or role; a negative or unsafe `ttlMs`, `at`, or `limit`; a value `JSON.stringify` cannot serialize; a `compactMessages` summary whose `threadId` differs from the compacted thread; `limitHistory` options outside their ranges; `compact` with a negative `keepRecent`; a vector whose `dimensions` do not match its length. `WithMemory.withMemory` throws the same error at graph-build time for an invalid policy, as a throw rather than an Effect failure.

### `supersede_conflict`

A supersession request contradicts what is already stored: a note id reused with different creation data or different supersession data, a note asked to supersede itself, a superseded target that does not exist, or a superseder and target in different namespaces.

### `idempotency_conflict`

`createThread` rejects an existing id with different namespace, title, or metadata. `appendMessage` rejects an existing message id with different `role`, `text`, or `at`; `path` names the first differing field. These two operations accept identical retries as no-ops.

`compactMessages` rejects an existing summary id even when the summary and source snapshot are identical. After a lost response, use `listMessages` to confirm that the exact summary (`threadId`, `id`, `role`, `text`, and `at`) exists and every source id is absent. Check all pages. Treat this as evidence of a committed compaction only if the summary id was unique to that operation and no other writer has reset or edited that history. The conflict alone does not prove success. Otherwise, read the current history and summarize it again with a fresh summary id.

### `compaction_conflict`

A `compactMessages` source row disappeared or its `role`, `text`, or `at` changed since it was read. Pass the full summarized rows as `sourceMessages`, not just their ids. The store captures the input and verifies every row inside the replacement transaction, before inserting the summary or deleting sources. A conflict leaves the current history untouched. Read and summarize the current history again; do not retry the stale summary. Appended messages outside the source snapshot are preserved.

### `embedding_unavailable`

The embedding provider failed or answered an invalid batch: a count that differs from the input count, zero or non-uniform dimensions, or a non-finite component. `Embedding.makeNoop` and `Embedding.layerNoop` raise it for every non-empty request with the message "no embedding provider is configured"; an empty batch returns `{ embeddings: [] }`.

### `vector_model_mismatch`

A stored vector under the requested model has a dimension that differs from the query vector's. Semantic recall skips vectors written under other models entirely, so this code means the same model answered two different dimensions, which points at a provider or model-name change. Reproject the bank's rows under one model.

### `store`

The backend failed: SQL errors, undecodable stored data, or a migration failure. `MemoryStore.makeNoop` and `MemoryStore.layerNoop` also report every operation as `store` with the message "`<method>` is unavailable", so an unexpected `store` error in a test usually means the noop layer is still in context.

## Recall returns no rows

Work through the checks in order:

1. The request decoded at all: `banks` non-empty, each name at most 128 code units, at most 16 banks, the query at most 16,384 UTF-8 bytes, at most 16 tag groups, `maxTokens` at most 65,536. A violated bound fails at decode, before any binding runs.
2. The query has terms. Keyword and FTS recall answer no rows for an empty or whitespace query.
3. Rows survive the filters. Notes default to `accepted`, a note with an accepted superseder is hidden, and every tag group must match. Read the bank with `searchRows` and `status: "any"` to see what the binding saw.
4. FTS is enabled for the namespace kind. `RecallFts` propagates `fts_not_enabled` rather than answering nothing.
5. Semantic recall has projections. Only rows whose vector was written under the requested model, whose content digest still matches, and whose score is positive rank. An undecorated store writes no vectors, so semantic recall over it answers nothing.
6. The policy allows recall. `recall: "none"` answers no rows without reaching the service.

One disagreement to know: `RecallKeyword` normalizes query and row text to NFKC, and SQLite FTS does not. The two bindings can legitimately disagree on compatibility-equivalent characters.

## A remembered fact is missing later

Three causes cover nearly every case:

- The fact expired. `ttlMs` counts from the last update, and expired facts are invisible to `getFact` and `listFacts` even before `Maintenance.ttlGc` removes them.
- The bank resolved to a different namespace than the read used. An unprefixed bank is flow-local: `notes` and `flow-notes` are the same namespace, but `notes` and `global-notes` are not. `Bank.parse` shows the resolution any bank string gets.
- The store was in-memory. `@smthrs/memory/test/TestMemory` and `MemoryStore.layerNoop` persist nothing beyond the process or the stub; the [Quickstart](./quickstart.md) shows the file-backed wiring.

## The opening snapshot is empty

`Source` never answers empty text for a failure: a read that exceeds two seconds fails with `TimeoutError`, and a store or recall failure fails with its `MemoryError`. The host decides what the run does without its memory. A failed read is never frozen: a later read for the same identity retries, and with `SnapshotRecorder` it is not recorded either.

An empty snapshot is a successful read that found no rows, or a `maxBytes` too small for the fence and the first row's label. Primer reads use a bounded newest-first candidate window; facts can occupy candidate slots but only notes render as primers. See [opening memory](./guides/agent-opening-context.md) for truncation order.

---
title: "Write catalog entries"
description: "Define the entries a script may call: name, description, handler, capabilities, and the declaration digest that keys replay."
sidebar:
  order: 1
---

Every effect a script can perform is a catalog entry. Gate 3 admits a call
only when `Catalog.lookup` finds its name, and the entry's declaration digest
is pinned into every call key that names it.

## The entry shape

```ts
import * as Catalog from "@smthrs/chain/Catalog"
import { Effect } from "effect"

const grep: Catalog.Entry = {
  name: "grep",
  description: "Search the workspace for a pattern",
  capabilities: ["fs:read:src/**"],
  handler: (payload, slot) =>
    Effect.gen(function*() {
      // read the payload, do the work, return a JSON value
      return { files: ["a.ts"] }
    })
}
```

An entry carries:

- `name`: the string a script passes to `ctx.call`.
- `description`: the one line the model reads in the prompt's catalog block.
- `handler`: `(payload, slot?) => Effect<unknown, Catalog.CallError>`. The
  payload is whatever the script passed, already copied across the JSON
  boundary. The slot is the call's `{ chain, link, ordinal }` position,
  handed over so entries that spawn scoped work (sub-chains) can derive
  deterministic child identities. A failing handler's `CallError` message
  is journaled verbatim and shown to the model on the next link, so keep
  credentials and private data out of it.
- `capabilities` (optional): the claims the `Authorize` seam evaluates per
  call. Undeclared is conservatively the broadest claim: the chain asks under
  `["*"]`, never silently passes. An explicit empty array claims no external
  authority and skips the seam.
- `settleOnInterrupt` (optional): signal `slot.signal` on interruption, then
  await the handler and its journal receipt before returning cancellation.
  The handler must forward this signal to its work and await cleanup. A
  controller that cannot abort must return its completed result. These calls
  also receive `slot.key`, the durable replay key; the host supplies its
  lineage when deriving destination-side idempotency keys. Other entries
  retain ordinary Effect interruption.
- `digest` (optional): a declaration digest overriding the default. Richer
  catalogs (the registry, memory, sub-chains) pin their full declaration
  here.

The handler fails with `Catalog.CallError`, which carries `name`, `message`,
and an optional `cause` for the failing subsystem's own stable code. The
chain journals it as a `call_failed` observation the next author reads; it
never crashes the run. One cause is special: `approval_required` parks the
run in place instead of journaling, the way a sub-chain bubbles a child's
approval wait.

## The declaration digest

`Catalog.entryDigest` pins an entry's identity into every call key. With no
`digest` override it digests the canonical form of the name, description,
and declared capabilities, so narrowing or widening a claim re-keys the calls
settled under the old claim. An empty override falls back to the default too:
every call key pins a non-empty digest whatever the host supplies. On resume,
a call whose journaled digest no longer matches the catalog's current
declaration fails with `replay_divergence` rather than serving a stale
result. For the resume rule, see [Keyed replay](../concepts/keyed-replay.md).

## Build the catalog

`Catalog.make(entries)` indexes the entries by name, last-wins, over one
frozen snapshot. The snapshot backs BOTH the advertised list and the dispatch
index, so renaming a caller-owned entry after construction cannot move the
prompt's catalog block away from what gate 3 dispatches. Only the declaration
is copied; the handler is held by reference. Mount it with
`Catalog.layer(entries)`.

## The system entries

`Catalog.system` is two entries every sealed realm relies on, because the
QuickJS prelude deletes `Date` and `Math.random`:

- `sys/now`: the current wall-clock time in epoch milliseconds, journaled
  for replay.
- `sys/random`: a uniform random number in `[0, 1)`, journaled for replay.

Both declare an empty capability list: they are the harness's own journaled
reads, claiming no external authority, so every ruleset admits them.

Append them with `Catalog.withSystem(entries)`, the one place the ordering
lives. The system entries come LAST because `Catalog.make` indexes
last-wins: nothing a host passes can shadow `sys/now` or `sys/random` with
an unjournaled clock or generator, and replay determinism rests on that
ordering.

For authorization of the claims you declare, see
[Authorize calls](./authorization.md). For the prompt block the model
actually reads, see the [API reference](../api.md).

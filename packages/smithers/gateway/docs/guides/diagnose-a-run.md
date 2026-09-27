---
title: "Diagnose what happened to a run"
description: "Read the verdict and diagnosis a run summary already carries, or fold your own from a run's control events with the Diagnosis module."
sidebar:
  order: 6
---

Every `run-summary` row already answers "what happened to this run". Two of its
fields are the whole diagnosis:

- `verdict`: one line, the status plus the reason that most explains it.
- `diagnosis`: the whole card, folded by `Diagnosis.digest`, which is also
  what [`smthrs runs show`](/cli/runs) folds. The terminal card adds lines a
  client does not need, such as the command that unblocks a parked run, so the
  two read the same facts and print different cards.

A client that renders a run card renders those two strings. Nothing else is
needed, and nothing has to be recomputed.

```json
"Verdict   completed \u2014 shipped\nRun       run-1 · deploy · opus · 5s\nActivity  1 turns · 1 calls (0 refused) · edits 1/1\nTokens    0 in / 0 out\nOutput    shipped"
```

## What the verdict leads with

`Diagnosis.verdict` picks the one thing a reader needs first, in this order:

1. A recorded failure cause, or the fact that a failed run recorded none.
2. A park's question, so a waiting run says what it is waiting for.
3. The "worked but never edited" pathology, which a green status would
   otherwise hide.
4. The resolved output.
5. The bare status, when none of the above applies.

```json
[
  "failed \u2014 could not resolve seat anthropic:claude-sonnet-4-5",
  "failed \u2014 no cause recorded in the journal",
  "waiting-approval \u2014 asks: Write to src/index.ts?",
  "completed \u2014 but 0 of 12 calls attempted an edit; the run only read",
  "completed \u2014 shipped"
]
```

An unlaunched run, one with no status event at all, reads `unlaunched`.
Status events use the vocabulary from `ControlSchema.RunStatus.literals`.

## Fold your own

The module is exported, so a client holding a run's ordered control events can
compute the same facts without a served projection:

```ts
import * as Diagnosis from "@smthrs/gateway/Diagnosis"

const facts = Diagnosis.digest(events)
const line = Diagnosis.verdict(facts)
const card = Diagnosis.render({ runId, flowId }, facts)
const span = Diagnosis.duration(facts)
```

`Diagnosis.Digest` carries the status, the failure cause, the model seat, turn
and call counts, edit attempts and successes, token totals, the refusals
aggregated by message, the final output, the pending question, and the span the
events cover.

The fold is total on purpose: an event kind outside its vocabulary contributes
nothing rather than failing it, and a payload that is not a record reads as an
empty one. A malformed journal produces a sparse digest, never a throw.
Unknown kinds include `__proto__`, `hasOwnProperty`, and `toString`; none changes
the digest or its timestamps. The unknown-kind cases in
[`Diagnosis.test.ts`](../../test/Diagnosis.test.ts) pin this guarantee.

## What counts as an edit

`editsAttempted` counts calls to the `write`, `edit`, and `apply_patch` flows.
`editsSucceeded` counts the ones that settled without a failure. That pair is
what makes the "only read" verdict possible, and it is why a run that reported
success while touching nothing is visible on its own card.

## What counts as time

Only an event kind the fold handles widens the reported span. This matters
because the gateway merges a keepalive event into every followed `Watch`
stream, and a fold that let an unhandled kind contribute its timestamp reported
a run that ran for as long as somebody watched it.

## Refusals

Failed calls are aggregated by their first-line message, descending by count.
`Diagnosis.render` prints the top three:

```text
Refusals  3× permission denied: capability "shell" is not in the envelope
```

## Clipping text for a wire

`Diagnosis.clip(text, width)` is the truncation the card and the verdict use,
and it is exported because a client rendering its own summary needs the same
guarantee. The cut is made on code points, never on UTF-16 code units: slicing
code units splits an astral character in half and puts a lone surrogate on the
wire, where a Go decoder silently replaces it and a strict decoder rejects the
whole frame.

A clipped result is exactly `width` code points, so `width` 1 is the ellipsis
alone, and `width` 0 or any negative width is the empty string.

## Reading further

`run-tree` and `node-output` answer the next two questions a diagnosis raises:
which calls the run made, and what one of them produced. Both key their rows by
the ordinal a call opened on, so a node id from the tree is a node id
[`smthrs runs output`](/cli/runs) accepts. See
[Projections](../concepts/projections.md#how-a-node-gets-its-id).

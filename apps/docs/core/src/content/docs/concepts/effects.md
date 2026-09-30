---
title: "Effect envelopes"
description: "How a declaration says what it reads and writes, the coverage grammar behind that claim, how a step narrows the envelope it inherits, and what the planner does with two writers of the same path."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/core/docs/concepts/effects.md"
---

An effect declaration is a claim: this flow, or this step, touches these
resources and no others. The planner does two things with the claim. It checks
that a step stays inside the envelope it inherited, and it compares every pair
of writers to find the ones that would race.

Both happen at plan time, on data. Nothing here opens a file or asks a host
what a path means.

## What a declaration says

```ts
import { Effects } from "@smthrs/core"

const envelope = Effects.make({
  reads: ["src/**"],
  writes: ["out/**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "compensable"
})
```

| Field             | What it means                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `reads`, `writes` | The paths and patterns this declaration claims. Normalized into sorted, duplicate-free arrays.      |
| `mode`            | `hermetic` means these are all of them. `expected` means these are the ones worth declaring.        |
| `onConflict`      | What the planner should do about another writer of the same path: `serialize`, `lane`, or `fail`.   |
| `tier`            | How reversible the effect is: `sealed`, `compensable`, or `irreversible`. Absent reads as `sealed`. |

`Effects.make` normalizes, and normalization is exactly sorting and
deduplication. It performs no separator rewriting and no dot-segment
resolution, because those rules belong to a host that knows what the paths
name. Hand it paths that are already normalized.

## The coverage grammar

`Effects.covers(envelope, path)` answers whether one envelope entry covers one
path. The grammar is short and exhaustive, and deliberately not minimatch:

| Entry             | Covers                                                       |
| ----------------- | ------------------------------------------------------------ |
| `out/report.json` | Exactly itself.                                              |
| `*` or `**`       | Everything.                                                  |
| `out*`            | Every path starting with `out`, including `out` itself.      |
| `out/**`          | `out/` and everything below it, but not the bare path `out`. |

```ts
Effects.covers("out/**", "out/report.json") // true
Effects.covers("out/**", "out") // false
Effects.covers("out*", "out") // true
```

One rule overrides all of them: a path containing a whole `.` or `..` segment
is never covered. A declaration that names `out/../secret.txt` therefore fails
its envelope check with `effect_outside_envelope` rather than quietly
escaping through an unresolved segment. The escape is refused, not resolved.

`Effects.overlaps` is stricter about the same paths in the opposite direction:
two writers naming the identical literal path always overlap, dot segments
included. An unnormalized path escapes no envelope, and two writers of it are
still detected as writing the same resource.

## Narrowing, not widening

An envelope is inherited lexically. A flow's declaration is the envelope for
everything inside its body, and a node's declaration narrows the envelope for
everything under that node. A step may claim less than it inherited; it may
never claim more. `Effects.narrow(envelope, step)` checks the three rules and
`Graph.build` applies the same check at every enclosed node:

| Rule                                                                           | Violation                                            |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Every read and write path must be covered by the matching envelope list.       | `effect_outside_envelope`, with the uncovered paths. |
| `expected` may tighten to `hermetic`; `hermetic` may not loosen to `expected`. | `effect_mode_widening`.                              |
| The tier may narrow: `irreversible`, then `compensable`, then `sealed`.        | `effect_tier_widening`.                              |

For a call, the callee's own declaration must narrow the envelope the caller
granted. The body inherits the resulting restriction, including reads, writes,
mode and tier. A declaration that is absent inherits the preceding envelope.

All three are fatal: a step that claimed more than it was granted is not a step
a host will be allowed to key and cache.

A canonical flow states its envelope in the `effects` option. Declare
`mode: "hermetic"` and `tier: "sealed"` explicitly when those bounds are
justified; preserve its complete reads, writes, and conflict policy. An action
needs its own cache contract before results can be shared across runs.

## Two writers of the same path

The comparison is [`@smthrs/flow`](https://flow.smithers.sh/reference/api/)'s: it holds the graph builder that
walks a plan, and it records a conflict when two writers' effective write
declarations overlap. The strategy comes from the two declarations, and the
stricter one wins: `fail` beats `lane`, and `lane` beats `serialize`. Its
reference documents what each strategy produces and which refusals are fatal.

What belongs here is the declaration: `Effects.overlaps` answers whether two
declarations touch the same path, on data, without a graph.

## Where to go next

- [Declare what a step reads and writes](/guides/declare-reads-and-writes/):
  the procedure, with each diagnostic and its fix.
- [Declare a flow](/guides/declare-a-flow/): where a signature states its
  envelope and its tier.

---
title: "Diff two plans"
description: "Compare a re-plan against the plan before it: what the verdict is, how a re-key is attributed to the field that caused it, and why the report is in no digest."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/plan/docs/guides/diff-two-plans.md"
---

"What is different about this run" is a set comparison, not archaeology.
`PlanDiff.diff` is that comparison as a value.

```ts
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Plan from "@smthrs/plan/Plan"
import * as PlanDiff from "@smthrs/plan/PlanDiff"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"

/** The drafts and the compiled effect from "Compile drafts into a plan". */
declare const readPr: Plan.NodeDraft
declare const runTests: Plan.NodeDraft
declare const compiled: Effect.Effect<Plan.Plan, never, Crypto.Crypto>

export const compare = Effect.gen(function*() {
  const before = yield* compiled
  const after = yield* Plan.compile({
    planId: "review-4821",
    flow: "example/Review",
    nodes: [readPr, { ...runTests, material: { ...runTests.material, body: { action: "run-tests", jobs: 4 } } }]
  })
  const changes: PlanDiff.PlanDiff = PlanDiff.diff(before, after)
  return changes.rekeyed.map((entry) => `${entry.id}: ${entry.changed.join(", ")}`)
}).pipe(Effect.provide(NodeCrypto.layer))
```

`compare` answers `["run-tests: body"]`. The edit moved one field of one node's
body, so that node re-keyed and the report says which field did it.

## The verdict is the key

Two nodes with the same id and the same key are the same step. Nothing else
needs saying, and `diff` says nothing else. Four lists come back:

| Field       | Contents                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `added`     | Node ids present in `next` and absent from `previous`.                   |
| `removed`   | Node ids present in `previous` and absent from `next`.                   |
| `rekeyed`   | Nodes present in both whose key moved, with `from`, `to`, and `changed`. |
| `unchanged` | Node ids present in both with the same key.                              |

## The attribution is for a human

`Rekeyed.changed` is a list of field labels: `["body", "input[1]"]`. It is
derived by comparing declarations field by field, and it is deliberately part of
no digest. Changing how the report reads can never change what a plan hashes to.

The labels mirror the hashed declaration: the effect tier `kind`, the fields
the hashed material body folds, and the input positions:

```text
kind  body  layers  capabilities  effects  version  nondeterministic  placement  input[n]
```

An `input[n]` entry appears when that input's declaration changed, and also when
the declaration is unchanged but the node it references itself re-keyed. A node
re-keyed purely by an upstream edit is therefore attributed to the input
position that references it, even behind an unprojected `Pending`, rather than
reported as nothing changed.

`changed` is empty only when none of the compared fields moved, which means the
key moved for a reason the comparison does not model. Treat an empty `changed`
on a re-keyed node as a bug report, not as noise.

## Comparison uses the key's own JSON semantics

Each compared field is projected through the same JSON mirror the keys are
derived from, so two `Date` bodies a generation apart attribute to `body` rather
than to nothing. The projection runs no accessor.

A field the projection refuses compares by an identity token scoped to that node
and field. The same value stays equal to itself, two distinct refused values
never compare equal, and `diff` stays a total function even for a value
canonical serialization would reject. `diff` never fails and never needs a
service.

## Reporting a re-plan

The pairing this is built for is a re-plan of the same flow: compile the flow
again against the current source and compare the result with the plan an
operator last saw. `added` and `removed` are the shape change, `rekeyed` is the
work that will not come from cache, and `unchanged` is everything a cache hit
will skip.

The command line prints the same comparison through
[`smthrs flow plan`](https://smithers.sh/docs/reference/cli/flow/), and the plan card it renders is what
[`smthrs approvals approve`](https://smithers.sh/docs/reference/cli/approvals/) binds a decision to.

## Next

- [Step keys](/concepts/step-keys/): why an upstream edit re-keys a
  downstream node whose own declaration did not change.
- [The plan value](/concepts/plan-value/): the digests a diff sits beside.

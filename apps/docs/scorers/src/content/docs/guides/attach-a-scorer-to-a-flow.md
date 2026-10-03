---
title: "Attach a scorer to a flow"
description: "Bind a scorer to a target flow with ground truth, context, and a sampling policy, and understand what a binding retains by reference."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/guides/attach-a-scorer-to-a-flow.md"
---

A binding says which scorer grades which flow, with what expected answer, and
how often. It is a plain value: `Binding.make` builds one and changes nothing
about the target.

## Build the binding

```ts
import { Binding } from "@smthrs/scorers"

const greet = ({ name: "greet" })

const binding = Binding.make({
  scorer: contains,
  appliesTo: greet,
  groundTruth: "hello",
  context: { rubric: "phrase" },
  sampling: { ratio: 0.25, seed: "2026-01" }
})
```

`appliesTo` is the target flow value itself, retained unchanged. Matching is by
reference identity, so only an execution that reports this exact value as its
target is graded by this binding. Binding never rewrites the target and never
changes its step key: a flow that is scored and a flow that is not produce the
same keys, which is what lets you turn scoring on for an existing history.

`sampling` defaults to `"all"`. Pass `"none"` to keep a binding declared but
inert, or a `{ratio, seed}` policy to grade a deterministic fraction. See
[Replay-stable sampling](/concepts/sampling/) for what the seed controls.

## Supply the expected answer

`groundTruth` is the expected result, and `context` is anything else the scorer
needs that is not part of the execution: a rubric, a tolerance, a document the
judge should cite. Both reach the scorer as the matching fields of
`Scorer.Input`.

Put a value in `config` instead when it changes what the scorer means. `config`
is hashed into the scorer key, so two thresholds become two scorer keys and two
separable histories. `context` is not hashed, so a change to it is invisible in
the durable record.

## What a binding retains by reference

`Binding.make` copies the options object shallowly. `groundTruth` and `context`
are not snapshotted, and scoring runs later, so a scorer sees whatever those
objects hold when it executes rather than when the binding was made:

```ts
const groundTruth = { answer: 1 }
const bound = Binding.make({ scorer: contains, appliesTo: greet, groundTruth })
groundTruth.answer = 2
// bound.groundTruth is { answer: 2 }
```

`readonly` is a compile-time promise only, and `scorerKey` covers
`{id, version, config}` alone, so a durable record gives no way to notice the
difference afterwards. Pass values that do not change, or copy before binding.

This is the one deliberate exception to the snapshotting this package does
everywhere else. A ground truth is frequently a value with no JSON
representation, an image buffer or a class instance, and refusing those at
binding time would be the larger break.

## Decide a sample

Nothing in this package calls `Sampling.decide` for you. A host that owns the
scheduling asks per candidate step, using the target's step key and the
scorer's key:

```ts
import { Sampling } from "@smthrs/scorers"
import { Effect } from "effect"

const shouldScore = (stepKey: string) => Sampling.decide(binding.sampling, stepKey, binding.scorer.scorerKey)

const program = Effect.gen(function*() {
  if (yield* shouldScore("greet/ada")) {
    // build a job for this step
  }
})
```

[`@smthrs/evals`](https://evals.smithers.sh/reference/api/) is the host that already does this: it filters
bindings by target, calls `decide` once per candidate step, and hands the
selected work to a runner. If you are writing suites rather than a host, use it
instead of reimplementing the loop.

## Next

- [Run a batch of scorers](/guides/run-a-batch-of-scorers/): turn selected steps
  into jobs and execute them.
- [Scorer identity](/concepts/scorer-identity/): what the scorer key does
  and does not cover.

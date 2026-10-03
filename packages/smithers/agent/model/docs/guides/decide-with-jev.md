---
title: "Decide with Jev"
description: "Classify, filter, rank, or route items inside a flow with one Jev request and a typed failure."
sidebar:
  order: 4
---

A decision inside a flow (classify, filter, rank, route, yes/no over items)
asks Jev through `Classifier.make` and the host `Evaluator`. A host can use
`EvaluatorBackup.withFallback(jev, EvaluatorBackup.fromModel(model, modelId))`
when its resolved LLM seat should cover Jev outages and timeouts.

| Where           | Ask with                                                              |
| --------------- | --------------------------------------------------------------------- |
| A flow's Action | `Classifier.make`, provided `Evaluator.Evaluator`                     |
| An agent cell   | `ctx.call("jev", { state, questions })`, when `ctx.flows` lists `jev` |

## One request, one question per item

Put the items in `state` and key one question per item. Read a boolean with
`Classifier.confident` at 0.8. Read a choice or score with the provider's
`Evaluator.Response.confidence` at 0.7.

```ts
import { Action } from "@smthrs/flow"
import * as Classifier from "@smthrs/model/Classifier"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer, Option, Schema } from "effect"

const Items = Schema.Struct({ task: Schema.String, items: Schema.Array(Schema.String) })
const key = (index: number) => `item${index}`

/** One classifier over every item: one question per item, asked in one request. */
const perItem = <Q extends Classifier.Questions[string]>(items: ReadonlyArray<string>, question: (item: string) => Q) =>
  Classifier.make("example/per-item", {
    description: "Judge each item against the task.",
    state: Items,
    questions: Object.fromEntries(items.map((item, index) => [key(index), question(item)])) as Record<string, Q>
  })

export const Keep = Action.make("example/keep", {
  payload: Items,
  success: Schema.Array(Schema.String),
  error: Classifier.ClassifierError,
  nondeterministic: true
})

export const Rank = Action.make("example/rank", {
  payload: Items,
  success: Schema.Array(Schema.String),
  error: Classifier.ClassifierError,
  nondeterministic: true
})

/** Boolean: keep an item only when Jev says yes at 0.8 or better. */
export const keep = (state: typeof Items.Type) =>
  Effect.gen(function*() {
    const needed = perItem(state.items, (item) => Classifier.boolean({ instructions: `Does the task need ${item}?` }))
    const answers = yield* needed.evaluate(state)
    return state.items.filter((_, index) =>
      Option.getOrElse(Classifier.confident(answers[key(index)]!, 0.8), () => false)
    )
  })

/** Choice or score: read the provider's own confidence, at 0.7 or better. */
export const rank = (state: typeof Items.Type) =>
  Effect.gen(function*() {
    const relevance = perItem(
      state.items,
      (item) => Classifier.score({ instructions: `How relevant is ${item}?`, criteria: ["none", "some", "high"] })
    )
    const response = yield* (yield* Evaluator.Evaluator)
      .evaluate({ state, questions: relevance.questions })
      .pipe(Effect.mapError(Classifier.fromEvaluatorError))
    const answers = yield* Classifier.decodeAnswers(relevance.questions, response.answers)
    const sure = state.items.flatMap((item, index) =>
      (response.confidence?.[key(index)] ?? 0) >= 0.7 ? [{ item, score: answers[key(index)]!.value }] : []
    )
    return sure.sort((a, b) => b.score - a.score).map((ranked) => ranked.item)
  })

export const JudgeLive = Layer.mergeAll(Keep.toLayer(keep), Rank.toLayer(rank))
```

## Failure

Jev refusals and invalid answers fail with a typed `ClassifierError`. A configured
backup is used only when Jev is unreachable, times out, or refuses with a 5xx or
429. A missing `AI_GATEWAY_API_KEY` is a setup fault: it fails with a typed
`unconfigured` error and never falls back to the backup. Backup answers receive
the same question validation; a malformed answer still fails.

## Examples

- [flows/coding/jev-check.ts](https://github.com/smithersai/smithers/blob/main/flows/coding/jev-check.ts)
- [flows/repository/jev-checks.ts](https://github.com/smithersai/smithers/blob/main/flows/repository/jev-checks.ts)

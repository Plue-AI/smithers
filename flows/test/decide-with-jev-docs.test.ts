import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"
import { keep, rank } from "./fixtures/decide-with-jev.ts"

const state = { task: "Fix the login redirect", items: ["auth.ts", "README.md", "session.ts"] }

test("the decide-with-jev guide shows the type-checked fixture verbatim", async () => {
  const [guide, fixture] = await Promise.all([
    readFile(new URL("../../packages/smithers/agent/model/docs/guides/decide-with-jev.md", import.meta.url), "utf8"),
    readFile(new URL("./fixtures/decide-with-jev.ts", import.meta.url), "utf8")
  ])
  assert.ok(guide.includes("```ts\n" + fixture + "```"))
})

test("keep asks one question per item in one request and keeps only confident yeses", async () => {
  const requests: Array<Evaluator.Request> = []
  const kept = await Effect.runPromise(
    keep(state).pipe(Effect.provide(Evaluator.layerScripted((request) => {
      requests.push(request)
      return { item0: { probability: 0.95 }, item1: { probability: 0.02 }, item2: { probability: 0.7 } }
    })))
  )
  assert.equal(requests.length, 1)
  assert.deepEqual(Object.keys(requests[0]!.questions), ["item0", "item1", "item2"])
  assert.deepEqual(kept, ["auth.ts"])
})

test("keep fails typed when Jev cannot answer", async () => {
  const result = await Effect.runPromise(Effect.result(keep(state)).pipe(Effect.provide(Evaluator.layerUnavailable())))
  assert.equal(result._tag, "Failure")
  assert.equal(result._tag === "Failure" ? result.failure._tag : undefined, "flows/model/ClassifierError")
})

test("rank orders items by score among answers the provider is confident in", async () => {
  const evaluator = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
    evaluate: () =>
      Effect.succeed({
        answers: {
          item0: { type: "score", score: 2 },
          item1: { type: "score", score: 0 },
          item2: { type: "score", score: 1 }
        },
        confidence: { item0: 0.9, item1: 0.75, item2: 0.4 },
        latencyMs: 0
      })
  }))
  assert.deepEqual(await Effect.runPromise(rank(state).pipe(Effect.provide(evaluator))), ["auth.ts", "README.md"])
})

test("rank fails typed when Jev cannot answer", async () => {
  const result = await Effect.runPromise(Effect.result(rank(state)).pipe(Effect.provide(Evaluator.layerUnavailable())))
  assert.equal(result._tag === "Failure" ? result.failure._tag : undefined, "flows/model/ClassifierError")
})

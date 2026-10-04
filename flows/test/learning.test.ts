import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Exit, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { evidence, learn, Output, type Snapshot } from "../learning/flow.ts"

const text = "Run lint before review to catch unused imports."
const snapshot: Snapshot = {
  repository: "smithers/canary", todo: 7, run: "learning-7", state: "merged",
  change: "https://github.com/smithers/canary/pull/41", commit: "abc123", attempts: ["attempt-1", "attempt-2"],
  journal: [
    { seq: 1, eventType: "control.agent.model-settled", payload: { text } },
    { seq: 2, eventType: "control.agent.steering-drained", payload: { messages: [{ role: "user", text: "Use the existing retry helper because it already backs off." }] } }
  ],
  outcomes: [3, 4, 5, 6, 7].map(todo => ({ todo, failures: [3, 5, 7].includes(todo) ? [{ signature: "check:lint@review", text }] : [] }))
}
const evaluator = Evaluator.layerScripted(() => ({ durable_0: { probability: 0 }, issue_0: { probability: 1 } }))

test("failure evidence counts TODOs once and bounds the history", () => {
  assert.deepEqual(evidence(snapshot.outcomes), [{ signature: "check:lint@review", todos: [3, 5, 7], count: "3 of the last 5" }])
  assert.deepEqual(evidence([{ todo: 7, failures: [{ signature: "check:lint@review", text }, { signature: "check:lint@review", text }] }]),
    [{ signature: "check:lint@review", todos: [7], count: "1 of the last 1" }])
  assert.deepEqual(evidence(Array.from({ length: 21 }, (_, i) => ({ todo: i + 1, failures: i === 0 ? [{ signature: "check:lint@review", text }] : [] }))), [])
})

test("learning returns cited decisions and evidence; identical inputs have the same signature", async () => {
  const output = await Effect.runPromise(learn(snapshot).pipe(Effect.provide(evaluator)))
  assert.deepEqual(Schema.decodeUnknownSync(Output)(output), {
    repository: "smithers/canary", todo: 7, run: "learning-7",
    pages: [{ title: "T7 decisions", body: "Change: https://github.com/smithers/canary/pull/41\nCommit: https://github.com/smithers/canary/commit/abc123\nRun: attempt-1\nRun: attempt-2\n- Use the existing retry helper because it already backs off. (learning learning-7, evidence seq 2)" }],
    proposals: [{ signature: "check:lint@review", title: text, evidence: ["3 of the last 5 failed check:lint@review"], todos: [3, 5, 7], prompt: text }]
  })
  assert.deepEqual(await Effect.runPromise(learn(snapshot).pipe(Effect.provide(evaluator))), output)
})

test("no proposal without failure evidence or Jev acceptance; empty transcript writes no page", async () => {
  const withoutFailures = { ...snapshot, outcomes: [] }
  assert.deepEqual((await Effect.runPromise(learn(withoutFailures).pipe(Effect.provide(evaluator)))).proposals, [])
  const refused = Evaluator.layerScripted(() => ({ durable_0: { probability: 1 }, issue_0: { probability: 0 } }))
  assert.deepEqual((await Effect.runPromise(learn(snapshot).pipe(Effect.provide(refused)))).proposals, [])
  const empty = await Effect.runPromise(learn({ ...snapshot, journal: [] }).pipe(Effect.provide(evaluator)))
  assert.deepEqual(empty.pages, [])
  assert.deepEqual(empty.proposals, [])
})

test("unmerged, duplicated or oversized history and unavailable judgment fail without output", async () => {
  for (const invalid of [{ ...snapshot, state: "working" }, { ...snapshot, outcomes: [snapshot.outcomes[0]!, snapshot.outcomes[0]!] },
    { ...snapshot, outcomes: Array.from({ length: 21 }, (_, i) => ({ todo: i + 1, failures: [] })) }]) {
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(learn(invalid as Snapshot).pipe(Effect.provide(evaluator)))))
  }
  const failing = Evaluator.layerScripted(() => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "offline" })))
  assert.ok(Exit.isFailure(await Effect.runPromiseExit(learn(snapshot).pipe(Effect.provide(failing)))))
})

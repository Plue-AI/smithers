// Deep reviewed and polished by a human on 2026-08-10.

/**
 * `Action.retry` re-runs a block while keeping the durable identity of the
 * dispatches inside it: every attempt sees an incremented `CurrentAttempt`,
 * and each dispatch position keeps the ordinal it was allocated on the
 * attempt that first reached it. A nested block shares the enclosing block's
 * pinned ordinals and folds its own cursor positions back on exit.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Effect, Latch, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { effect } from "./Harness.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

/** The one step the host flow is made of; each case supplies its body. */
const Block = Action.make("Retry/Block", {
  payload: { id: Schema.String },
  success: Schema.Number
})

const Host = Flow.make("Retry/Host", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id,
  body: (payload) => Block.call(payload)
})

const run = (
  body: Effect.Effect<number, never, Crypto.Crypto | FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime>,
  id: string
): Effect.Effect<number, never, Crypto.Crypto> =>
  Host.execute({ id }, { executionId: id }).pipe(
    Effect.provide(
      layerWired(Layer.mergeAll(Block.toLayer(() => body), Interpreter.layer(Host)))
    ),
    // The literal payload above always satisfies the schema, so the typed
    // `SchemaError` on `execute` cannot occur here.
    Effect.orDie
  )

describe("Action.retry", () => {
  effect("increments CurrentAttempt for every attempt of the block", () =>
    Effect.gen(function*() {
      const attempts: Array<number> = []
      const body = Effect.gen(function*() {
        const attempt = yield* Action.CurrentAttempt
        attempts.push(attempt)
        return attempt < 3 ? yield* Effect.fail("again") : attempt
      }).pipe(Action.retry({ times: 5 }), Effect.orDie)

      expect(yield* run(body, "attempts")).toBe(3)
      expect(attempts).toEqual([1, 2, 3])
    }))

  effect("pins each dispatch position to its own identity across attempts", () =>
    Effect.gen(function*() {
      let executions = 0
      const step = Action.make({
        name: "Retry/step",
        success: Schema.Number,
        execute: Effect.sync(() => ++executions)
      })
      let rounds = 0
      const body = Effect.gen(function*() {
        rounds++
        // two dispatches of one declaration: distinct positions, distinct
        // identities, both replayed on the second attempt
        const first = yield* step
        const second = yield* step
        if (rounds === 1) return yield* Effect.fail("retry once")
        return first + second
      }).pipe(Action.retry({ times: 3 }), Effect.orDie)

      // Each attempt dispatches both positions; the attempt number is part of
      // the recorded outcome, so the second attempt runs them again.
      expect(yield* run(body, "pinned")).toBe(7)
      expect(executions).toBe(4)
      expect(rounds).toBe(2)
    }))

  effect("a nested block shares the enclosing block's pinned ordinals", () =>
    Effect.gen(function*() {
      let executions = 0
      const inner = Action.make({
        name: "Retry/inner",
        success: Schema.Number,
        execute: Effect.sync(() => ++executions)
      })
      const before = Action.make({
        name: "Retry/before",
        success: Schema.Number,
        execute: Effect.sync(() => ++executions)
      })
      let outerRounds = 0
      let innerRounds = 0
      const body = Effect.gen(function*() {
        outerRounds++
        // a dispatch before the nested block, so the block is entered with a
        // non-empty cursor view it must rewind to rather than to zero
        yield* before
        const value = yield* Effect.gen(function*() {
          innerRounds++
          const dispatched = yield* inner
          return innerRounds === 1 ? yield* Effect.fail("inner again") : dispatched
        }).pipe(Action.retry({ times: 3 }))
        return outerRounds === 1 ? yield* Effect.fail("outer again") : value
      }).pipe(Action.retry({ times: 3 }), Effect.orDie)

      // The inner block retries once inside the first outer attempt. On the
      // second outer attempt it starts from attempt 1 again and, because the
      // nested block shares the enclosing block's pinned ordinal, the dispatch
      // resolves to the identity already recorded for (position, attempt 1)
      // and replays that outcome instead of executing again.
      expect(yield* run(body, "nested")).toBe(2)
      expect(executions).toBe(4)
      expect(outerRounds).toBe(2)
      expect(innerRounds).toBe(3)
    }))

  effect("concurrent sibling retry blocks cannot rewind each other's dispatch ordinal", () =>
    Effect.gen(function*() {
      const rightDispatched = yield* Latch.make()
      const leftRetried = yield* Latch.make()
      const leftKeys: Array<string> = []
      const rightKeys: Array<string> = []
      const rightValues: Array<number> = []
      let leftAttempts = 0
      let leftExecutions = 0
      let rightExecutions = 0

      const left = Action.make({
        name: "Retry/concurrent-left",
        success: Schema.Number,
        execute: Effect.gen(function*() {
          const key = yield* Action.CurrentInvocationKey
          expect(key).toBeDefined()
          leftKeys.push(key!)
          return ++leftExecutions
        })
      })
      const right = Action.make({
        name: "Retry/concurrent-right",
        success: Schema.Number,
        execute: Effect.gen(function*() {
          const key = yield* Action.CurrentInvocationKey
          expect(key).toBeDefined()
          rightKeys.push(key!)
          return ++rightExecutions
        })
      })

      const leftBlock = Effect.gen(function*() {
        leftAttempts++
        yield* left
        if (leftAttempts === 1) {
          yield* rightDispatched.await
          return yield* Effect.fail("retry left")
        }
        yield* leftRetried.open
        return 1
      }).pipe(Action.retry({ times: 2 }), Effect.orDie)

      const rightBlock = Effect.gen(function*() {
        rightValues.push(yield* right)
        yield* rightDispatched.open
        yield* leftRetried.await
        rightValues.push(yield* right)
        return rightValues[0]! + rightValues[1]!
      }).pipe(Action.retry({ times: 2 }), Effect.orDie)

      const body = Effect.all([leftBlock, rightBlock], { concurrency: "unbounded" }).pipe(
        Effect.map(([leftValue, rightValue]) => leftValue + rightValue),
        Action.retry({ times: 1 }),
        Effect.orDie
      )

      expect(yield* run(body, "concurrent-siblings")).toBe(4)
      expect(leftAttempts).toBe(2)
      expect(leftExecutions).toBe(2)
      expect(rightExecutions).toBe(2)
      expect(rightValues).toEqual([1, 2])
      expect(new Set(leftKeys).size).toBe(1)
      expect(new Set(rightKeys).size).toBe(2)
    }))
})

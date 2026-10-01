import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

const flow = Flow.make("ExecutionIdentityConflict/authoring", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: () => Node.succeed(1)
})
const conflict = new FlowRuntime.ExecutionIdentityConflict({
  executionId: "existing",
  field: "payload",
  status: "running",
  expected: "first",
  actual: "second",
  message: "cannot reuse"
})
const defect = new Error("unrelated defect")
// This package owns authoring, not execution. Override only its runtime port;
// the real memory and SQLite admission behavior is covered in engine packages.
const failing = (cause: Cause.Cause<never>, called: () => void = () => {}) =>
  Layer.effect(
    FlowRuntime.FlowRuntime,
    Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
      FlowRuntime.FlowRuntime.of({
        ...runtime,
        execute: () => Effect.sync(called).pipe(Effect.andThen(Effect.failCause(cause)))
      }))
  ).pipe(Layer.provide(layerMemory))

const observe = (cause: Cause.Cause<never>) =>
  withCrypto(
    flow.execute({ value: 1 }, { executionId: "existing" }).pipe(
      Effect.exit,
      Effect.provide(failing(cause)),
      Effect.scoped
    )
  )

describe("execute admission refusal conversion", () => {
  it.effect("converts the sole identity defect to the same typed failure", () =>
    Effect.gen(function*() {
      const exit = yield* observe(Cause.die(conflict))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBe(conflict)
      }
    }))

  for (
    const [name, cause] of [
      ["unrelated defect", Cause.die(defect)],
      ["conflict combined with another defect", Cause.combine(Cause.die(conflict), Cause.die(defect))],
      ["conflict combined with interruption", Cause.combine(Cause.die(conflict), Cause.interrupt(17))],
      ["sole interruption", Cause.interrupt(17)]
    ] as const
  ) {
    it.effect(`preserves ${name} without hiding a cause`, () =>
      Effect.gen(function*() {
        const exit = yield* observe(cause)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons).toHaveLength(cause.reasons.length)
          for (const [index, original] of cause.reasons.entries()) {
            const observed = exit.cause.reasons[index]!
            expect(observed._tag).toBe(original._tag)
            if (Cause.isDieReason(original)) {
              expect(Cause.isDieReason(observed) && observed.defect).toBe(original.defect)
            } else if (Cause.isInterruptReason(original)) {
              expect(Cause.isInterruptReason(observed) && observed.fiberId).toBe(original.fiberId)
            }
          }
        }
      }))
  }

  it.effect("rejects invalid payload as SchemaError before contacting the runtime", () =>
    Effect.gen(function*() {
      let calls = 0
      const exit = yield* withCrypto(
        flow.execute({ value: "invalid" as unknown as number }, {
          executionId: "existing"
        }).pipe(Effect.exit, Effect.provide(failing(Cause.die(conflict), () => calls++)), Effect.scoped)
      )
      expect(calls).toBe(0)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(false)
        expect(exit.cause.reasons.find(Cause.isFailReason)?.error).toBeInstanceOf(Schema.SchemaError)
      }
    }))
})

// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { effect, pollUntil } from "./Harness.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

describe("Flow.make payload and schema defaults", () => {
  effect("accepts an already-built payload schema as well as a field record", () => {
    const fields = Flow.make("Definition/fields", {
      payload: { id: Schema.String },
      body: () => Node.succeed(undefined)
    })
    const struct = Schema.Struct({ id: Schema.String })
    const built = Flow.make("Definition/built", { payload: struct, body: () => Node.succeed(undefined) })
    return Effect.sync(() => {
      // a field record is wrapped; a schema is adopted as-is
      expect(built.payloadSchema).toBe(struct)
      expect(fields.payloadSchema).not.toBe(struct)
      expect(fields.payloadSchema.make({ id: "a" })).toEqual({ id: "a" })
      expect(built.payloadSchema.make({ id: "a" })).toEqual({ id: "a" })
    })
  })

  effect("defaults success to Void and error to Never when neither is declared", () => {
    const Step = Action.make("Definition/defaults/step", {
      payload: { id: Schema.String }
    })
    const flow = Flow.make("Definition/defaults", {
      payload: { id: Schema.String },
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(
      Layer.mergeAll(Step.toLayer(() => Effect.void), Interpreter.layer(flow))
    )
    return Effect.gen(function*() {
      expect(flow.successSchema.ast).toBe(Schema.Void.ast)
      expect(flow.errorSchema.ast).toBe(Schema.Never.ast)
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  effect("keeps declared success and error schemas instead of the defaults", () => {
    const Step = Action.make("Definition/declared/step", {
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Definition/declared", {
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(
      Layer.mergeAll(Step.toLayer(() => Effect.succeed(1)), Interpreter.layer(flow))
    )
    return Effect.gen(function*() {
      expect(flow.successSchema.ast).toBe(Schema.Number.ast)
      expect(flow.errorSchema.ast).toBe(Schema.String.ast)
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("a flow definition is an inert callable proto object, per effect's Workflow shape", () => {
    // `makeProto` builds the definition on a function object so it mirrors
    // effect's `Workflow`. Invoking it is not part of the API: it must be a
    // no-op that neither throws nor mutates the definition.
    const flow = Flow.make("Definition/proto", { payload: { id: Schema.String }, body: () => Node.succeed(undefined) })
    return Effect.sync(() => {
      expect(typeof flow).toBe("function")
      expect((flow as unknown as () => unknown)()).toBeUndefined()
      expect(flow._tag).toBe("Definition/proto")
    })
  })
})

describe("Flow.make requires a body", () => {
  it("refuses a declaration with nothing to plan, at the type level", () => {
    // The two nouns of `docs/concepts/flows-and-actions.md` are
    // stratified by the compiler, not by prose: a flow with nothing to plan is
    // a category error, and the work it described is an Action. The
    // directive is the assertion — tsc fails the check when the call below
    // compiles.
    expect(() => {
      // @ts-expect-error -- a flow declares a body or a prompt.
      Flow.make("Definition/no-body", { payload: { id: Schema.String } })
    }).toThrow(/body.*prompt/)

    const declared = Flow.make("Definition/required-body", {
      payload: { id: Schema.String },
      body: () => Node.succeed(undefined)
    })
    expectTypeOf(declared.body).toBeFunction()
    expectTypeOf(declared.body).not.toBeNullable()
    // The erased shape every engine helper reads is required too, so no
    // consumer is left with an optional-body branch to write.
    expectTypeOf<Flow.Any["body"]>().not.toBeNullable()
    expect(typeof declared.body).toBe("function")
  })

  it("rejects a body whose settled value contradicts its success schema", () => {
    // @ts-expect-error -- a Number body cannot satisfy a String success contract.
    Flow.make("Definition/wrong-success", {
      payload: {},
      success: Schema.String,
      body: () => Node.succeed(42)
    })

    const valid = Flow.make("Definition/right-success", {
      payload: {},
      success: Schema.String,
      body: () => Node.succeed("forty-two")
    })
    expect(valid.body({}).ast).toEqual({ _tag: "Succeed", value: "forty-two" })
  })
})

describe("Flow definition combinators", () => {
  it("declaration rollback layer needs only FlowRuntime, like the module helper", () => {
    const Step = Action.make("Definition/rollback-types/step", {
      payload: {},
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Definition/rollback-types", {
      payload: {},
      success: Schema.String,
      error: Schema.String,
      body: (payload) => Step.call(payload)
    })
    const moduleLayer = Step.toLayer(() => Flow.withRollback(Effect.succeed("reserved"), () => Effect.void))
    const definitionLayer = Step.toLayer(() => flow.withRollback(Effect.succeed("reserved"), () => Effect.void))
    const moduleRequirements: Layer.Layer<
      Action.Requirement<"Definition/rollback-types/step">,
      never,
      FlowRuntime.FlowRuntime
    > = moduleLayer
    const definitionRequirements: typeof moduleRequirements = definitionLayer
    expectTypeOf(definitionRequirements).toEqualTypeOf(moduleRequirements)
  })

  effect("withRollback is reachable from the definition as well as the module", () => {
    const rolledBack: Array<string> = []
    const Step = Action.make("Definition/rollback/step", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const flow = Flow.make("Definition/rollback", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          yield* flow.withRollback(
            Effect.succeed("resource"),
            (value: string) => Effect.sync(() => void rolledBack.push(`undo:${value}`))
          )
          return yield* Effect.fail("boom")
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(rolledBack).toEqual(["undo:resource"])
    }).pipe(Effect.provide(layer))
  })

  effect("the definition-level combinator does not roll back a successful step", () => {
    const rolledBack: Array<string> = []
    const Step = Action.make("Definition/rollback-ok/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Definition/rollback-ok", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        flow.withRollback(
          Effect.succeed("kept"),
          (value: string) => Effect.sync(() => void rolledBack.push(`undo:${value}`))
        )
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe("kept")
      expect(rolledBack).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("concurrent action bookkeeping", () => {
  effect("an action finishing while a sibling still runs does not release the suspension latch", () => {
    const events: Array<string> = []
    const quick = Action.make({
      name: "Definition/quick",
      success: Schema.String,
      execute: Effect.sync(() => {
        events.push("quick")
        return "quick"
      })
    })
    const slow = Action.make({
      name: "Definition/slow-sibling",
      success: Schema.String,
      execute: Effect.gen(function*() {
        for (let i = 0; i < 8; i++) yield* Effect.yieldNow
        events.push("slow")
        return "slow"
      })
    })
    const Pair = Action.make("Definition/concurrent-pair/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Definition/concurrent-pair", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => Pair.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Pair.toLayer(() =>
        Effect.map(
          Effect.all([slow, quick], { concurrency: "unbounded" }),
          ([a, b]) => `${a}+${b}`
        )
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-pair" })).toBe("slow+quick")
      // the quick action settled first, while the slow one was still in flight
      expect(events).toEqual(["quick", "slow"])
    }).pipe(Effect.provide(layer))
  })

  effect("preserves the cause of an inline action suspended inside raceAll", () => {
    const Step = Action.make("Definition/race-suspension/step", {
      payload: {},
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Definition/race-suspension", {
      payload: {},
      success: Schema.String,
      error: Schema.String,
      body: () => Step.call({})
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        DurableDeferred.raceAll({
          name: "suspended-failure",
          success: Schema.String,
          error: Schema.String,
          effects: [Action.make({
            name: "Definition/race-suspension/failing",
            success: Schema.String,
            error: Schema.String,
            execute: Effect.fail("race-boom")
          })]
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      yield* flow.execute({}, { executionId: "run-race-suspend", discard: true })
      const suspended = yield* pollUntil(flow.poll("run-race-suspend"), (result) => result._tag === "Suspended", {
        turns: 200
      })
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        expect(String(suspended.value.cause)).toContain("race-boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("combines the causes of several actions that suspend together", () => {
    // Two actions suspend with a cause each: the instance must accumulate
    // both, not drop the first.
    const failing = (name: string, reason: string, delay: number) =>
      Action.make({
        name,
        success: Schema.String,
        error: Schema.String,
        execute: Effect.gen(function*() {
          for (let i = 0; i < delay; i++) yield* Effect.yieldNow
          return yield* Effect.fail(reason)
        })
      })
    const Both = Action.make("Definition/two-suspensions/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Definition/two-suspensions", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      body: (payload) => Both.call(payload)
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = layerWired(Layer.mergeAll(
      Both.toLayer(() =>
        Effect.map(
          Effect.all([failing("Definition/f1", "first-boom", 1), failing("Definition/f2", "second-boom", 2)], {
            concurrency: "unbounded",
            mode: "result"
          }),
          () => "unreachable"
        )
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-two-suspend", discard: true })
      const suspended = yield* pollUntil(
        flow.poll("run-two-suspend"),
        (result) => result._tag === "Suspended",
        { turns: 200 }
      )
      expect(Option.isSome(suspended)).toBe(true)
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        const cause = String(suspended.value.cause)
        expect(cause).toContain("first-boom")
        expect(cause).toContain("second-boom")
      }
    }).pipe(Effect.provide(layer))
  })
})

describe("suspension while siblings are still running", () => {
  effect("carries the suspending action's cause and waits for the running sibling", () => {
    // `wrapActionResult` must (1) merge the cause reported by a suspended
    // action onto the instance and (2) hold suspension open until every
    // concurrently running action has settled — otherwise a sibling is
    // abandoned mid-flight and re-runs on resume.
    const events: Array<string> = []
    const failing = Action.make({
      name: "Definition/failing",
      success: Schema.String,
      error: Schema.String,
      execute: Effect.gen(function*() {
        events.push("failing:start")
        // let the sibling start before this one suspends the flow
        for (let i = 0; i < 3; i++) yield* Effect.yieldNow
        return yield* Effect.fail("gate-closed")
      })
    })
    const slow = Action.make({
      name: "Definition/slow",
      success: Schema.String,
      execute: Effect.gen(function*() {
        events.push("slow:start")
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow
        events.push("slow:end")
        return "slow"
      })
    })
    const Pair = Action.make("Definition/suspend-with-sibling/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Definition/suspend-with-sibling", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      body: (payload) => Pair.call(payload)
    }).annotate(Flow.SuspendOnFailure, true)

    let attempts = 0
    const layer = layerWired(Layer.mergeAll(
      Pair.toLayer(() =>
        Effect.suspend(() => {
          attempts++
          return attempts === 1
            ? Effect.map(
              Effect.all([failing, slow], { concurrency: "unbounded" }),
              ([a, b]) => `${a}+${b}`
            )
            : Effect.succeed("recovered")
        })
      ),
      Interpreter.layer(flow)
    ))

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-sibling", discard: true })
      const suspended = yield* pollUntil(
        flow.poll("run-sibling"),
        (result) => result._tag === "Suspended",
        { turns: 200 }
      )
      expect(Option.isSome(suspended)).toBe(true)
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        expect(String(suspended.value.cause)).toContain("gate-closed")
      }
      // the sibling that had already started was allowed to finish
      expect(events).toContain("slow:start")
      expect(events).toContain("slow:end")

      yield* flow.resume("run-sibling")
      const done = yield* pollUntil(
        flow.poll("run-sibling"),
        (result) => result._tag === "Complete",
        { turns: 200 }
      )
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("recovered")
    }).pipe(Effect.provide(layer))
  })
})

describe("typed caller-input errors", () => {
  effect("fails execute typed but makes executionId die for the same invalid payload", () => {
    const flow = Flow.make("Definition/invalid-payload", {
      payload: { count: Schema.Number },
      success: Schema.Number,
      body: ({ count }) => Node.succeed(count)
    })
    const layer = layerWired(Interpreter.layer(flow))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(flow.execute(
        { count: "not-a-number" } as unknown as { readonly count: number },
        { executionId: "run-invalid-payload" }
      ))
      // Caller input is data, not wiring: the failure is the schema's own
      // typed error, and its rendering names the offending field.
      expect(error).toMatchObject({ _tag: "SchemaError" })
      expect(String(error)).toContain("count")

      const idExit = yield* flow.executionId(
        { count: "not-a-number" } as unknown as { readonly count: number }
      ).pipe(Effect.exit)
      expect(Exit.isFailure(idExit)).toBe(true)
      expect(Exit.isFailure(idExit) && Cause.hasDies(idExit.cause)).toBe(true)
      expect(Exit.isFailure(idExit) && idExit.cause.toString()).toContain("count")
    }).pipe(Effect.provide(layer))
  })

  effect("fails poll on an unknown execution id with a typed not-found naming the id", () => {
    const flow = Flow.make("Definition/unknown-poll", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: () => Node.succeed("done")
    })
    const layer = layerWired(Interpreter.layer(flow))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(flow.poll("never-started"))
      expect(error).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        code: "execution_not_found",
        executionId: "never-started"
      })
      expect(String(error)).toContain("never-started")
    }).pipe(Effect.provide(layer))
  })
})

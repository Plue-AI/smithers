/**
 * The three settlements a bodied round can produce, at the authoring package's
 * own boundary: the `Handoff` result beside `Complete` and `Suspended`, the
 * guard that recognizes an outcome value, and what the interpreter does with
 * each of `done` / `to` / `park`.
 *
 * Following a handoff to the next round is the ENGINE's job, so the port
 * fixture here settles a handed-off round as itself; `@smthrs/engine` and
 * `@smthrs/engine-store` own the lineage tests.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import { readFileSync } from "node:fs"
import { withCrypto } from "./Crypto.ts"
import { layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

const Increment = Action.make("trampoline/increment", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const increments = Increment.toLayer(({ value }) => Effect.succeed(value + 1))

/** The declaration shape the recursive body names itself under. */
type CounterFlow = Flow.Flow<
  "trampoline/counter",
  Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
  typeof Schema.Number,
  typeof Schema.Never,
  // The self-handoff drops its requirements, so the lineage names only the
  // action its own round calls and the type stays finite.
  Action.Requirement<"trampoline/increment">
>

const Counter: CounterFlow = Flow.make("trampoline/counter", {
  payload: { value: Schema.Number, target: Schema.Number },
  success: Schema.Number,
  body: ({ target, value }: { readonly value: number; readonly target: number }) =>
    Increment.call({ value }).pipe(
      Node.branch({
        if: (next) => next >= target,
        then: (next) => Flow.done(next),
        else: (next) => Counter.to({ value: next, target })
      })
    )
})

const Parking = Flow.make("trampoline/parking", {
  payload: { token: Schema.String },
  success: Schema.Number,
  body: ({ token }) => Flow.park({ reason: "approval", token })
})

const EncodedTarget = Flow.make("trampoline/encoded-target", {
  payload: { count: Schema.NumberFromString },
  success: Schema.Number,
  body: () => Node.succeed(0)
})

const EncodedSource = Flow.make("trampoline/encoded-source", {
  payload: {},
  success: Schema.Number,
  body: () => EncodedTarget.to({ count: 2 })
})

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations>
) => layerWired(Layer.merge(increments, registration))

describe("Flow.Handoff", () => {
  it.effect("is a Result beside Complete and Suspended, and survives the result codec", () =>
    Effect.gen(function*() {
      const handoff = new Flow.Handoff({ flow: "trampoline/counter", payload: { value: 1 } })

      expect(Flow.isResult(handoff)).toBe(true)
      expect(handoff._tag).toBe("Handoff")

      const codec = Schema.toCodecJson(
        Flow.Result({ success: Schema.Number, error: Schema.Never })
      )
      const encoded = yield* withCrypto(Schema.encodeEffect(codec)(handoff))
      expect(encoded).toEqual({
        _tag: "Handoff",
        flow: "trampoline/counter",
        payload: { value: 1 }
      })
      const decoded = yield* withCrypto(Schema.decodeUnknownEffect(codec)(encoded))
      expect(decoded._tag).toBe("Handoff")
      expect(decoded._tag === "Handoff" && decoded.flow).toBe("trampoline/counter")
    }))

  it.effect("records itself on the instance, so intoResult answers with it", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Parking, "handoff-instance")

      const result = yield* withCrypto(
        Effect.succeed("ignored").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              instance.handoff = new Flow.Handoff({ flow: "next", payload: { n: 2 } })
            })
          ),
          Flow.intoResult,
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
      )

      // The value the handler returned is discarded: a round that handed off
      // produced no answer of its own.
      expect(result._tag).toBe("Handoff")
      expect(result._tag === "Handoff" && result.payload).toEqual({ n: 2 })
    }))
})

describe("round scope contract", () => {
  for (
    const path of [
      "docs/concepts/suspension-and-replay.md",
      "docs/concepts/trampoline-rounds.md",
      "docs/guides/cancel-and-roll-back.md",
      "src/Flow/Flow.ts",
      "src/Flow/Runtime.ts"
    ]
  ) {
    it(`${path} documents the rollback boundary at handoff`, () => {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
        .replace(/\s*\*\s?/g, " ")
        .replace(/\s+/g, " ")
      expect(text).not.toContain("not when a round ends")
      expect(text).toContain(
        "A handoff completes the round successfully and discards its `withRollback` registrations."
      )
    })
  }

  it.effect("discards round 1 rollback before round 2 in the same lineage fails", () =>
    Effect.gen(function*() {
      const first = makeInstance(Parking, "rollback-round-1")
      const second = { ...makeInstance(Parking, "rollback-round-2"), lineageId: first.lineageId }
      const rollbacks: Array<string> = []
      const finalizerExits: Array<Exit.Exit<unknown, unknown>> = []
      const register = (value: string) =>
        Flow.withRollback(
          Effect.succeed(value),
          (reserved) =>
            Effect.sync(() => {
              rollbacks.push(reserved)
            })
        )

      const handoff = yield* Effect.gen(function*() {
        yield* register("round-1")
        yield* Flow.addFinalizer((exit) =>
          Effect.sync(() => {
            finalizerExits.push(exit)
          })
        )
        first.handoff = new Flow.Handoff({ flow: Parking._tag, payload: { token: "next" } })
      }).pipe(
        Flow.provideScope,
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, first)
      )
      expect(handoff._tag).toBe("Handoff")
      expect(finalizerExits).toEqual([Exit.void])
      expect(rollbacks).toEqual([])

      // The package's port fixture does not follow handoffs. Drive the next
      // instance explicitly, as the engine does with a fresh round scope.
      const failure = yield* Effect.gen(function*() {
        yield* register("round-2")
        return yield* Effect.fail("round-2 failed")
      }).pipe(
        Flow.provideScope,
        Flow.intoResult,
        Effect.provideService(FlowRuntime.FlowInstance, second)
      )
      expect(failure).toEqual(new Flow.Complete({ exit: Exit.fail("round-2 failed") }))
      expect(rollbacks).toEqual(["round-2"])
      expect(finalizerExits).toEqual([Exit.void])
    }))
})

describe("Flow.Outcome.isOutcome", () => {
  it("recognizes explicitly authored settlements without treating lookalike data as control", () => {
    const done = Graph.nodes(Graph.build(Flow.done(1)))[0]?.payload
    const parked = Graph.nodes(Graph.build(Flow.park({ reason: "quota" })))[0]?.payload

    expect(Flow.isOutcome(done)).toBe(true)
    expect(Flow.isOutcome(parked)).toBe(true)
    expect(Flow.isOutcome({ _tag: "Done", value: 1 })).toBe(false)
    expect(Flow.isOutcome({ _tag: "To", flow: "f", payload: {} })).toBe(false)
    expect(Flow.isOutcome({ _tag: "Park", reason: { reason: "quota" } })).toBe(false)
    expect(Flow.isOutcome({ _tag: "Complete" })).toBe(false)
    expect(Flow.isOutcome({ _tag: "To" })).toBe(false)
    expect(Flow.isOutcome({ _tag: "Park", reason: {} })).toBe(false)
    expect(Flow.isOutcome({ value: 1 })).toBe(false)
    expect(Flow.isOutcome(undefined)).toBe(false)
  })
})

describe("the interpreter settles a body's root outcome", () => {
  it.effect("registers a handoff target from only the source layer", () =>
    Effect.gen(function*() {
      const Target = Flow.make("trampoline/registered-target", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })
      const Source = Flow.make("trampoline/registered-source", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Target.to({ value })
      })

      const settled = yield* withCrypto(
        Effect.gen(function*() {
          const handoff: unknown = yield* Source.execute({ value: 4 }, { executionId: "registered-source" })
          expect(Flow.isResult(handoff) && handoff._tag).toBe("Handoff")
          // This fixture returns each round's settlement; drive the next round
          // explicitly, using the declaration registered by the handoff site.
          return yield* Target.execute({ value: 4 }, { executionId: "registered-target" })
        }).pipe(Effect.provide(wired(Interpreter.layer(Source))))
      )

      expect(settled).toBe(5)
    }))

  it.effect("returns ordinary success data whose shape resembles a park request", () =>
    Effect.gen(function*() {
      const value = { _tag: "Park" as const, reason: { reason: "ordinary data" } }
      const Ordinary = Flow.make("trampoline/ordinary-park-data", {
        payload: {},
        success: Schema.Struct({
          _tag: Schema.Literal("Park"),
          reason: Schema.Struct({ reason: Schema.String })
        }),
        body: () => Node.succeed(value)
      })
      const result = yield* withCrypto(
        Ordinary.execute({}, { executionId: "ordinary-park-data" }).pipe(
          Effect.provide(wired(Interpreter.layer(Ordinary)))
        )
      )
      expect(result).toEqual(value)
    }))

  it("records a to invocation as a handoff site in the static graph", () => {
    const graph = Graph.build(Counter, { value: 0, target: 10 })
    const handoff = Graph.nodes(graph).find(
      (node) => node.ast._tag === "FlowCall" && node.ast.mode === "handoff"
    )

    expect(handoff?.ast).toMatchObject({
      _tag: "FlowCall",
      flow: "trampoline/counter",
      mode: "handoff"
    })
  })

  it.effect("answers with the value a done arm carried", () =>
    Effect.gen(function*() {
      const value = yield* withCrypto(
        Counter.execute({ value: 9, target: 10 }, { executionId: "settle-done" }).pipe(
          Effect.provide(wired(Interpreter.layer(Counter)))
        )
      )

      expect(value).toBe(10)
    }))

  it.effect("hands off when the arm taken is a to invocation", () =>
    Effect.gen(function*() {
      const settled = yield* withCrypto(
        (Counter.execute({ value: 0, target: 10 }, { executionId: "settle-to" }) as Effect.Effect<
          unknown,
          never,
          FlowRuntime.FlowRuntime
        >).pipe(Effect.provide(wired(Interpreter.layer(Counter))))
      )

      expect(Flow.isResult(settled) && settled._tag).toBe("Handoff")
      expect(
        Flow.isResult(settled) && settled._tag === "Handoff" ? settled.payload : undefined
      ).toEqual({ value: 1, target: 10 })
    }))

  it.effect("encodes the target payload before settling Handoff", () =>
    Effect.gen(function*() {
      const settled = yield* withCrypto(
        (EncodedSource.execute({}, { executionId: "settle-encoded-to" }) as Effect.Effect<
          unknown,
          never,
          FlowRuntime.FlowRuntime
        >).pipe(Effect.provide(wired(Interpreter.layer(EncodedSource))))
      )

      expect(
        Flow.isResult(settled) && settled._tag === "Handoff" ? settled.payload : undefined
      ).toEqual({ count: "2" })
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("parks under the reason the body declared", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const executionId = yield* Parking.execute({ token: "req-7" }, {
            executionId: "settle-park",
            discard: true
          })
          let polled = yield* Parking.poll(executionId)
          for (let index = 0; index < 300 && Option.isNone(polled); index++) {
            yield* Effect.sleep(1)
            polled = yield* Parking.poll(executionId)
          }
          return polled
        }).pipe(Effect.provide(wired(Interpreter.layer(Parking))))
      )

      expect(Option.isSome(result) && result.value._tag).toBe("Suspended")
    }))

  it.effect("leaves a body that settles with an ordinary value alone", () =>
    Effect.gen(function*() {
      const Plain = Flow.make("trampoline/plain", {
        payload: { value: Schema.Number },
        success: Schema.Number,
        body: ({ value }) => Increment.call({ value })
      })

      const settled = yield* withCrypto(
        Plain.execute({ value: 4 }, { executionId: "settle-plain" }).pipe(
          Effect.provide(wired(Interpreter.layer(Plain)))
        )
      )

      expect(settled).toBe(5)
    }))
})

describe("Flow.MaxRoundsExceeded", () => {
  it("carries the lineage, the budget, and the round that was refused", () => {
    const error = new Flow.MaxRoundsExceeded({
      flowName: "trampoline/counter",
      lineageId: "lineage-1",
      maxRounds: 3,
      roundOrdinal: 3,
      message: "past the budget"
    })

    expect(error._tag).toBe("@smthrs/flow/MaxRoundsExceeded")
    expect(error.code).toBe("max_rounds_exceeded")
    expect(error.roundOrdinal).toBe(3)
  })

  it("rejects a non-positive or non-integral round budget at declaration time", () => {
    const declare = (maxRounds: number) =>
      Flow.make("trampoline/invalid-budget", {
        payload: {},
        maxRounds,
        body: () => Node.succeed(undefined)
      })

    expect(() => declare(0)).toThrow(RangeError)
    expect(() => declare(1.5)).toThrow(RangeError)
  })
})

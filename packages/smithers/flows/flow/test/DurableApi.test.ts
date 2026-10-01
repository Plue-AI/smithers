import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, DurableDeferred, DurableQueue, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Layer, Option, Schema, SchemaGetter } from "effect"
import type * as Crypto from "effect/Crypto"
import { PersistedQueue } from "effect/unstable/persistence"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const Read = Action.make("DurableApi/read", { payload: { value: Schema.String }, success: Schema.String })
const pipeline = Flow.make("DurableApi/pipeline", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: () => "fixed",
  body: Node.capture(
    { action: Read.name, implementationVersion: "DurableApi/v1" },
    (payload: { readonly value: string }) => Read.call(payload)
  )
})

const configured = (handler: (payload: { readonly value: string }) => Effect.Effect<string>) =>
  Interpreter.layerWithImplementations(pipeline, Read.toLayer(handler)).pipe(Layer.provideMerge(layerMemory))

describe("explicit execution identity", () => {
  it.effect("refuses an invalid explicit key before starting work", () =>
    withCrypto(
      Effect.gen(function*() {
        let runs = 0
        const exit = yield* Effect.exit(
          pipeline.ensure({ value: "same" }, { key: undefined as never }).pipe(
            Effect.provide(configured(() =>
              Effect.sync(() => {
                runs++
                return "bad"
              })
            ))
          )
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Schema.SchemaError)
        expect(runs).toBe(0)
      })
    ))

  it.effect("execute starts independent equal unkeyed requests by default", () =>
    withCrypto(
      Effect.gen(function*() {
        let runs = 0
        const unkeyed = Flow.make("DurableApi/unkeyed", {
          payload: { value: Schema.String },
          success: Schema.String,
          body: Node.capture(
            { action: Read.name, implementationVersion: "DurableApi/v1" },
            (payload: { readonly value: string }) => Read.call(payload)
          )
        })
        const runtime = Interpreter.layerWithImplementations(
          unkeyed,
          Read.toLayer(({ value }) =>
            Effect.sync(() => {
              runs++
              return value
            })
          )
        )
          .pipe(Layer.provideMerge(layerMemory))
        yield* Effect.gen(function*() {
          expect(yield* unkeyed.execute({ value: "same" })).toBe("same")
          expect(yield* unkeyed.execute({ value: "same" })).toBe("same")
          const captured = yield* unkeyed.execute({ value: "same" }, { discard: true })
          expect(yield* unkeyed.execute({ value: "same" }, { executionId: captured })).toBe("same")
          expect(runs).toBe(3)
        }).pipe(Effect.provide(runtime))
      })
    ))

  it.effect("starts independent equal requests and explicitly rejoins a caller key", () =>
    withCrypto(
      Effect.gen(function*() {
        let runs = 0
        const result = yield* Effect.gen(function*() {
          const first = yield* pipeline.start({ value: "same" })
          const second = yield* pipeline.start({ value: "same" })
          expect(first).not.toBe(second)
          expect(yield* pipeline.execute({ value: "same" }, { executionId: first })).toBe("same")
          expect(yield* pipeline.execute({ value: "same" }, { executionId: second })).toBe("same")
          const third = yield* pipeline.ensure({ value: "same" }, { key: "request-3" })
          const rejoined = yield* pipeline.ensure({ value: "same" }, { key: "request-3" })
          expect(third).toBe(rejoined)
          expect(yield* pipeline.execute({ value: "same" }, { executionId: third })).toBe("same")
          const existing = yield* pipeline.poll(third)
          expect(Option.isSome(existing)).toBe(true)
          return [first, second, third]
        }).pipe(Effect.provide(configured(({ value }) =>
          Effect.sync(() => {
            runs++
            return value
          })
        )))
        expect(new Set(result).size).toBe(3)
        expect(runs).toBe(3)
      })
    ))
})

describe("declared durable policy", () => {
  it.effect("propagates payload-derived identity, typed file boundary, and retry policy on annotated copies", () => {
    const policy = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 })
    const mark = Context.Reference<string>("DurableApi/mark", { defaultValue: () => "default" })
    const declared = Action.make("DurableApi/files", {
      payload: { value: Schema.Number },
      success: Schema.Number,
      idempotencyKey: ({ value }) => ({ value }),
      fileBoundary: ({ value }) => ({ readSet: [], writeSet: [`result-${value}.txt`], boundaryMode: "hard" }),
      retryPolicy: policy
    })
    return Effect.gen(function*() {
      const observed: Action.Any[] = []
      const capturing = Layer.succeed(FlowRuntime.FlowRuntime)(
        {
          register: (_flow: Flow.Any, handler: (payload: { value: number }) => Action.Any) =>
            Effect.sync(() => {
              observed.push(handler({ value: 2 }))
            })
        } as unknown as FlowRuntime.FlowRuntime["Service"]
      )
      for (
        const copy of [declared, declared.annotate(mark, "one"), declared.annotateMerge(Context.make(mark, "two"))]
      ) {
        yield* Effect.void.pipe(
          Effect.provide(copy.toLayer(({ value }) => Effect.succeed(value)).pipe(Layer.provide(capturing)))
        )
      }
      expect(observed).toHaveLength(3)
      // Every dispatch shares one exit schema, so the engine's parser cache hits.
      const [first, second] = observed as unknown as ReadonlyArray<Action.Action<Schema.Number, Schema.Never, never>>
      expect(second!.exitSchema).toBe(first!.exitSchema)
      expect(second!.exitSchemaPartial).toBe(first!.exitSchemaPartial)
      for (const action of observed) {
        expect(action.idempotencyKey).toEqual({ value: 2 })
        expect(action.retryPolicy).toBe(policy)
        expect(action.fileBoundary).toEqual({ readSet: [], writeSet: ["result-2.txt"], boundaryMode: "hard" })
        expect(action.metadata).toEqual(action.fileBoundary)
      }
      const inline = Action.make({
        name: "DurableApi/inline",
        execute: Effect.void,
        fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" }
      })
      expect(inline.metadata).toEqual(inline.fileBoundary)
    })
  })

  it.effect("system declarations accept a payload-derived idempotency key", () => {
    const declared = Action.makeSystem("DurableApi/system", {
      payload: { value: Schema.Number },
      idempotencyKey: ({ value }) => ({ value })
    })
    return Effect.gen(function*() {
      const observed: Action.Any[] = []
      const capturing = Layer.succeed(FlowRuntime.FlowRuntime)(
        {
          register: (_flow: Flow.Any, handler: (payload: { value: number }) => Action.Any) =>
            Effect.sync(() => {
              observed.push(handler({ value: 7 }))
            })
        } as unknown as FlowRuntime.FlowRuntime["Service"]
      )
      yield* Effect.void.pipe(Effect.provide(declared.toLayer(() => Effect.void).pipe(Layer.provide(capturing))))
      expect(observed.map((action) => action.idempotencyKey)).toEqual([{ value: 7 }])
    })
  })

  it("durable deferreds with the same schemas share one exit schema", () => {
    const first = DurableDeferred.make("DurableApi/deferred-a", { success: Schema.String })
    const second = DurableDeferred.make("DurableApi/deferred-b", { success: Schema.String })
    expect(second.exitSchema).toBe(first.exitSchema)
    expect(DurableDeferred.make("DurableApi/deferred-c").exitSchema).toBe(
      DurableDeferred.make("DurableApi/deferred-d").exitSchema
    )
  })

  it.effect("accepts a fixed declared boundary and preserves static identities", () => {
    const declared = Action.make("DurableApi/fixed", {
      payload: {},
      implementationVersion: "fixed/v1",
      idempotencyKey: "static",
      fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" }
    })
    const flow = Flow.make("DurableApi/fixed-flow", {
      payload: {},
      body: Node.capture(
        { action: declared.name, implementationVersion: "DurableApi/fixed/v1" },
        () => declared.call({})
      )
    })
    return withCrypto(
      flow.execute({}).pipe(Effect.provide(
        Interpreter.layerWithImplementations(
          flow,
          declared.toLayer(() => Effect.void, { implementationVersion: "fixed/v1" })
        ).pipe(
          Layer.provideMerge(layerMemory)
        )
      ))
    )
  })
})

describe("implementation composition", () => {
  it.effect("keeps independently composed handlers isolated when they share a runtime", () =>
    withCrypto(
      Effect.gen(function*() {
        const first = Flow.make("DurableApi/isolated-first", {
          payload: { value: Schema.String },
          success: Schema.String,
          body: Node.capture(
            { action: Read.name, implementationVersion: "DurableApi/v1" },
            (payload: { readonly value: string }) => Read.call(payload)
          )
        })
        const second = Flow.make("DurableApi/isolated-second", {
          payload: { value: Schema.String },
          success: Schema.String,
          body: Node.capture(
            { action: Read.name, implementationVersion: "DurableApi/v1" },
            (payload: { readonly value: string }) => Read.call(payload)
          )
        })
        const runtime = Layer.merge(
          Interpreter.layerWithImplementations(first, Read.toLayer(() => Effect.succeed("first"))),
          Interpreter.layerWithImplementations(second, Read.toLayer(() => Effect.succeed("second")))
        ).pipe(Layer.provideMerge(layerMemory))
        yield* Effect.gen(function*() {
          expect(yield* Effect.serviceOption(Action.Implementations)).toEqual(Option.none())
          expect(yield* first.execute({ value: "same" })).toBe("first")
          expect(yield* second.execute({ value: "same" })).toBe("second")
        }).pipe(Effect.provide(runtime))
      })
    ))

  it.effect("rejects conflicting registrations before executing work", () =>
    withCrypto(
      Effect.gen(function*() {
        let runs = 0
        const implementations = Layer.merge(
          Read.toLayer(() =>
            Effect.sync(() => {
              runs++
              return "first"
            })
          ),
          Read.toLayer(() =>
            Effect.sync(() => {
              runs++
              return "second"
            })
          )
        )
        const exit = yield* Effect.exit(
          pipeline.execute({ value: "x" }).pipe(Effect.provide(
            Interpreter.layerWithImplementations(pipeline, implementations).pipe(Layer.provideMerge(layerMemory))
          ))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const defect = Cause.squash(exit.cause)
          expect(defect).toBeInstanceOf(Action.DuplicateImplementation)
          expect((defect as Error).message).toContain("already has an implementation")
          // A recorded defect is JSON-encoded; the message must survive the round trip.
          const Defect = Schema.Defect()
          const recorded = Schema.decodeUnknownSync(Defect)(Schema.encodeUnknownSync(Defect)(defect)) as Error
          expect(recorded.message).toContain(`Action "${Read.name}" already has an implementation`)
          expect(recorded.message).toContain("override: true")
        }
        expect(runs).toBe(0)
      })
    ))

  it.effect("isolates composed registries and preflights missing graph handlers", () =>
    withCrypto(
      Effect.gen(function*() {
        expect(yield* pipeline.execute({ value: "x" }).pipe(Effect.provide(configured(() => Effect.succeed("first")))))
          .toBe("first")
        expect(yield* pipeline.execute({ value: "x" }).pipe(Effect.provide(configured(() => Effect.succeed("second")))))
          .toBe("second")
        const other = Action.make("DurableApi/missing", { payload: {}, success: Schema.String })
        let runs = 0
        const both = Flow.make("DurableApi/both", {
          payload: {},
          success: Schema.Struct({ one: Schema.String, two: Schema.String }),
          body: Node.capture({ actions: [Read.name, other.name], implementationVersion: "DurableApi/both/v1" }, () =>
            Node.all({ one: Read.call({ value: "one" }), two: other.call({}) }))
        })
        const incomplete = Read.toLayer(() =>
          Effect.sync(() => {
            runs++
            return "one"
          })
        )
        const exit = yield* Effect.exit(
          both.execute({}).pipe(Effect.provide(
            Interpreter.layerWithImplementations(
              both,
              incomplete as Layer.Layer<
                Action.Requirement<"DurableApi/read"> | Action.Requirement<"DurableApi/missing">,
                never,
                FlowRuntime.FlowRuntime
              >
            ).pipe(Layer.provideMerge(layerMemory))
          ))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ code: "unresolved_action" })
        }
        expect(runs).toBe(0)
      })
    ))
})

const negativeTypes = () => {
  // @ts-expect-error The composition must provide the flow's action requirements.
  Interpreter.layerWithImplementations(pipeline, Layer.empty)
  Action.make("DurableApi/invalid-boundary", {
    payload: {},
    // @ts-expect-error Boundaries validate their mode at authoring time.
    fileBoundary: { readSet: [], writeSet: [], boundaryMode: "weak" }
  })
}
void negativeTypes

class Encoder
  extends Context.Service<Encoder, { readonly encode: (value: string) => string }>()("DurableApi/Encoder")
{}

/** A success codec whose encode side, and only its encode side, needs `Encoder`. */
const encoded = Schema.String.pipe(Schema.decodeTo(Schema.String, {
  decode: SchemaGetter.transform((value: string) => value),
  encode: SchemaGetter.transformEffect((value: string) =>
    Effect.gen(function*() {
      const encoder = yield* Encoder
      return encoder.encode(value)
    })
  )
}))

const host = Flow.make("DurableApi/requirements", { payload: {}, body: () => Node.succeed(undefined) })

const countingEncoder = () => {
  const state = { encodes: 0 }
  const service = Encoder.of({
    encode: (value) => {
      state.encodes++
      return value
    }
  })
  return { state, service }
}

describe("advertised requirements", () => {
  it.effect("DurableDeferred.into advertises the encoding services it records the exit with", () =>
    Effect.gen(function*() {
      const recorded = DurableDeferred.into(
        Effect.succeed("ok"),
        DurableDeferred.make("DurableApi/into", { success: encoded })
      )
      expectTypeOf<Effect.Services<typeof recorded>>().toEqualTypeOf<
        FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Encoder
      >()
      const { state, service } = countingEncoder()
      const exit = yield* Effect.exit(recorded.pipe(
        Effect.provideService(Encoder, service),
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(host, "into")),
        Effect.provide(layerMemory)
      ))
      expect(exit).toStrictEqual(Exit.succeed("ok"))
      expect(state.encodes).toBe(1)
    }))

  it.effect("Action.raceAll advertises Crypto and the encoding services that persist the winner", () =>
    Effect.gen(function*() {
      const race = Action.raceAll("DurableApi/race", [
        Action.make({ name: "DurableApi/race/encoded", success: encoded, execute: Effect.succeed("ok") })
      ])
      expectTypeOf<Crypto.Crypto | Encoder>().toMatchTypeOf<Effect.Services<typeof race>>()
      const { state, service } = countingEncoder()
      const exit = yield* Effect.exit(withCrypto(race.pipe(
        Effect.provideService(Encoder, service),
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(host, "race")),
        Effect.provide(layerMemory)
      )))
      expect(exit).toStrictEqual(Exit.succeed("ok"))
      expect(state.encodes).toBeGreaterThan(0)
    }))

  // Runs on its own fiber: the suspension after the offer interrupts the caller.
  it("DurableQueue.process advertises the Crypto its invocation key needs", async () => {
    const queue = DurableQueue.make({
      name: "DurableApi/queue",
      payload: Schema.Struct({}),
      success: Schema.String,
      idempotencyKey: () => "one"
    })
    const processed = DurableQueue.process(queue, {})
    expectTypeOf<Effect.Services<typeof processed>>().toEqualTypeOf<
      | FlowRuntime.FlowRuntime
      | FlowRuntime.FlowInstance
      | Crypto.Crypto
      | PersistedQueue.PersistedQueueFactory
    >()
    // The factory is inert, so the call suspends after keying and offering.
    let offers = 0
    const factory = PersistedQueue.PersistedQueueFactory.of({
      make: () => Effect.succeed({ offer: () => Effect.sync(() => void offers++) } as never)
    })
    const exit = await Effect.runPromiseExit(withCrypto(processed.pipe(
      Effect.provideService(PersistedQueue.PersistedQueueFactory, factory),
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(host, "queue")),
      Effect.provide(layerMemory)
    )))
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain("Service not found")
    expect(offers).toBe(1)
  })
})

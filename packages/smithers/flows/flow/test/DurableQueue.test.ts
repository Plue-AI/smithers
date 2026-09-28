// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, DurableQueue, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Fiber, Layer, Logger, Option, Schedule, Schema, Tracer } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { PersistedQueue } from "effect/unstable/persistence"
import { effectOnTestClock as effect, isComplete, pollUntil } from "./Harness.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const PersistedQueueLayer = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreMemory)
)

describe("DurableQueue", () => {
  const Queue = DurableQueue.make({
    name: "DurableQueue/SuppliedKey",
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id
  })
  const Offer = Action.make("DurableQueue/SuppliedKey/offer", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String
  })
  const Flow_ = Flow.make("DurableQueue/SuppliedKey", {
    payload: { id: Schema.String, value: Schema.Number },
    success: Schema.Number,
    error: Schema.String,
    idempotencyKey: ({ id }) => id,
    body: (payload) => Offer.call(payload)
  })
  const successLayer = Layer.mergeAll(
    Offer.toLayer(({ id, value }) => DurableQueue.process(Queue, { id, value })),
    Interpreter.layer(Flow_),
    DurableQueue.worker(Queue, ({ value }) => Effect.succeed(value + 1))
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(PersistedQueueLayer)
  )

  effect("processes queued work through the supplied-key engine seam", () =>
    Effect.gen(function*() {
      const executionId = yield* Flow_.execute({ id: "success", value: 41 }, { discard: true })
      const result = yield* pollUntil(Flow_.poll(executionId), isComplete, { turns: 10, advance: "10 millis" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(42)
      }
    }).pipe(Effect.provide(successLayer)))

  effect("propagates queue worker failures", () => {
    const Offer = Action.make("DurableQueue/Failure/offer", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const Failure = Flow.make("DurableQueue/Failure", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id }) => DurableQueue.process(Queue, { id, value: 0 }).pipe(Effect.asVoid)),
      Interpreter.layer(Failure),
      DurableQueue.worker(Queue, () => Effect.fail("boom"))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* Failure.execute({ id: "failure" }, { discard: true })
      const result = yield* pollUntil(Failure.poll(executionId), isComplete, { turns: 10, advance: "10 millis" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isFailure(result.value.exit)) {
        expect(result.value.exit.cause.reasons.find(Cause.isFailReason)?.error).toBe("boom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("accepts an already-built payload schema as well as a field record", () => {
    // `make` adopts a schema as-is and wraps a field record; both forms must
    // round-trip an item through a worker identically.
    const payloadSchema = Schema.Struct({ id: Schema.String, value: Schema.Number })
    const SchemaQueue = DurableQueue.make({
      name: "DurableQueue/SchemaPayload",
      payload: payloadSchema,
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    expect(SchemaQueue.payloadSchema).toBe(payloadSchema)

    const Offer = Action.make("DurableQueue/SchemaPayload/offer", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String
    })
    const SchemaFlow = Flow.make("DurableQueue/SchemaPayload", {
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Offer.call(payload)
    })
    const layer = Layer.mergeAll(
      Offer.toLayer(({ id, value }) => DurableQueue.process(SchemaQueue, { id, value })),
      Interpreter.layer(SchemaFlow),
      DurableQueue.worker(SchemaQueue, ({ value }) => Effect.succeed(value * 2))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(layerMemory),
      Layer.provideMerge(PersistedQueueLayer)
    )

    return Effect.gen(function*() {
      const executionId = yield* SchemaFlow.execute({ id: "schema", value: 21 }, { discard: true })
      const result = yield* pollUntil(SchemaFlow.poll(executionId), isComplete, { turns: 10, advance: "10 millis" })
      expect(
        Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit) &&
          result.value.exit.value
      ).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  it("refuses invalid concurrency before opening the persisted queue", () => {
    const declare = (concurrency: number) => () =>
      DurableQueue.makeWorker(Queue, () => Effect.succeed(0), { concurrency })

    for (const invalid of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(declare(invalid)).toThrow(RangeError)
      expect(declare(invalid)).toThrow(/concurrency/)
      expect(declare(invalid)).toThrow(String(invalid))
    }
    expect(declare(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  effect("logs a malformed item token at error and continues the worker loop", () => {
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/MalformedWorker",
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    let handled = 0

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(
          WorkerQueue,
          ({ value }) => Effect.sync(() => (handled++, value + 1))
        ),
        { startImmediately: true }
      )
      yield* queue.offer({
        token: "*".repeat(100) as DurableDeferred.Token,
        payload: { id: "bad", value: 1 },
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        sampled: false
      }, { id: "bad" })
      for (let turn = 0; turn < 50 && !logs.some((entry) => entry.level === "Error"); turn++) {
        yield* Effect.yieldNow
      }

      const completion = DurableDeferred.make(`${WorkerQueue.deferred.name}/valid`, {
        success: WorkerQueue.deferred.successSchema,
        error: WorkerQueue.deferred.errorSchema
      })
      const token = new DurableDeferred.TokenParsed({
        flowName: "DurableQueue/MalformedWorker/Host",
        executionId: "worker",
        deferredName: completion.name
      }).asToken
      yield* queue.offer({
        token,
        payload: { id: "valid", value: 41 },
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        sampled: false
      }, { id: "valid" })
      for (let turn = 0; turn < 50 && handled === 0; turn++) yield* Effect.yieldNow

      expect(handled).toBe(1)
      const reported = logs.find((entry) => entry.level === "Error")
      expect(reported?.message).toContain(WorkerQueue.name)
      expect(reported?.message).toContain("64")
      expect(reported?.message).toContain("characters dropped")
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer)
    )
  })

  effect("refuses an item whose token names a deferred this queue does not own", () => {
    // Regression: the worker completed whatever deferred a stored token named,
    // so a forged item could settle a WaitFor gate, a human task, or another
    // queue's wait under this queue's success schema.
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/ForeignToken",
      payload: { id: Schema.String, value: Schema.Number },
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    const handled: Array<string> = []
    const tokenFor = (deferredName: string) =>
      new DurableDeferred.TokenParsed({
        flowName: "DurableQueue/ForeignToken/Host",
        executionId: "victim",
        deferredName
      }).asToken

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(
          WorkerQueue,
          ({ id, value }) => Effect.sync(() => (handled.push(id), value + 1))
        ),
        { startImmediately: true }
      )
      for (
        const [id, deferredName] of [
          ["gate", "approve-deploy"],
          ["sibling", `${WorkerQueue.deferred.name}/other`],
          ["prefix", `${WorkerQueue.deferred.name}/prefix/extra`],
          ["long", `approve-${"x".repeat(200)}`]
        ] as const
      ) {
        yield* queue.offer({
          token: tokenFor(deferredName),
          payload: { id, value: 1 },
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          sampled: false
        }, { id })
      }
      yield* queue.offer({
        token: tokenFor(`${WorkerQueue.deferred.name}/valid`),
        payload: { id: "valid", value: 41 },
        traceId: "1".repeat(32),
        spanId: "1".repeat(16),
        sampled: false
      }, { id: "valid" })
      for (let turn = 0; turn < 100 && handled.length === 0; turn++) yield* Effect.yieldNow

      expect(handled).toEqual(["valid"])
      const refused = logs.filter((entry) => entry.level === "Error").map((entry) => entry.message)
      expect(refused).toHaveLength(4)
      expect(refused[0]).toContain("approve-deploy")
      expect(refused[1]).toContain(`${WorkerQueue.deferred.name}/other`)
      expect(refused[2]).toContain(`${WorkerQueue.deferred.name}/prefix/extra`)
      expect(refused[3]).toContain(`approve-${"x".repeat(120)} [80 characters dropped]`)
      expect(refused[3]).not.toContain("x".repeat(121))
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer)
    )
  })

  effect("links the worker span only to a stored parent with trace-context ids", () => {
    const WorkerQueue = DurableQueue.make({
      name: "DurableQueue/TraceParent",
      payload: { id: Schema.String },
      success: Schema.Void,
      idempotencyKey: ({ id }) => id
    })
    const itemSchema = Schema.Struct({
      token: DurableDeferred.Token,
      payload: WorkerQueue.payloadSchema,
      traceId: Schema.String,
      spanId: Schema.String,
      sampled: Schema.Boolean
    })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const handled: Array<string> = []

    return Effect.gen(function*() {
      const queue = yield* PersistedQueue.make({
        name: `DurableQueue/${WorkerQueue.name}`,
        schema: itemSchema
      })
      yield* Effect.forkChild(
        DurableQueue.makeWorker(WorkerQueue, ({ id }) => Effect.sync(() => void handled.push(id))),
        { startImmediately: true }
      )
      for (
        const [id, traceId, spanId] of [
          ["forged", "attacker-chosen-trace", "attacker-span"],
          ["linked", "a".repeat(32), "b".repeat(16)]
        ] as const
      ) {
        yield* queue.offer({
          token: new DurableDeferred.TokenParsed({
            flowName: "DurableQueue/TraceParent/Host",
            executionId: id,
            deferredName: `${WorkerQueue.deferred.name}/${id}`
          }).asToken,
          payload: { id },
          traceId,
          spanId,
          sampled: true
        }, { id })
      }
      for (let turn = 0; turn < 100 && handled.length < 2; turn++) yield* Effect.yieldNow

      expect(handled).toEqual(["forged", "linked"])
      const workerSpans = spans.filter((span) => span.name === `DurableQueue/${WorkerQueue.name}/worker`)
      expect(workerSpans).toHaveLength(2)
      const parents = workerSpans.map((span) => Option.getOrUndefined(span.parent))
      expect(parents[0]).toBeUndefined()
      expect(parents[1]?.traceId).toBe("a".repeat(32))
      expect(parents[1]?.spanId).toBe("b".repeat(16))
    }).pipe(
      Effect.provide(layerMemory),
      Effect.provide(PersistedQueueLayer),
      Effect.provideService(Tracer.Tracer, tracer)
    )
  })

  effect("backs off before retrying a persistently failing take", () => {
    const logs: Array<{ readonly level: string; readonly message: string }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: String(entry.message) })
    })
    const store = PersistedQueue.PersistedQueueStore.of({
      cleanup: () => Effect.void,
      offer: () => Effect.void,
      take: () => Effect.fail(new PersistedQueue.PersistedQueueError({ message: "take unavailable" }))
    })
    const failingQueueLayer = PersistedQueue.layer.pipe(
      Layer.provide(Layer.succeed(PersistedQueue.PersistedQueueStore)(store))
    )

    return Effect.gen(function*() {
      yield* Effect.forkChild(
        DurableQueue.makeWorker(Queue, () => Effect.succeed(0)),
        { startImmediately: true }
      )
      for (let turn = 0; turn < 50 && logs.length === 0; turn++) yield* Effect.yieldNow
      expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(1)

      yield* TestClock.adjust("499 millis")
      expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(1)
      yield* TestClock.adjust("1 milli")
      for (let turn = 0; turn < 50 && logs.length === 1; turn++) yield* Effect.yieldNow
      expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(2)
    }).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.provide(layerMemory),
      Effect.provide(failingQueueLayer)
    )
  })

  const itemSchema = Schema.Struct({
    token: DurableDeferred.Token,
    payload: Queue.payloadSchema,
    traceId: Schema.String,
    spanId: Schema.String,
    sampled: Schema.Boolean
  })

  const offerFailureLayer = (offer: PersistedQueue.PersistedQueueStore["Service"]["offer"]) =>
    PersistedQueue.layer.pipe(Layer.provide(
      Layer.succeed(PersistedQueue.PersistedQueueStore)({
        cleanup: () => Effect.void,
        offer,
        take: () => Effect.never
      })
    ))

  effect("exhausts a supplied offer retry schedule as a defect after three offers", () => {
    let offers = 0
    const error = new PersistedQueue.PersistedQueueError({ message: "offer unavailable" })
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(DurableQueue.process(Queue, { id: "retry", value: 0 }, {
        retrySchedule: Schedule.recurs(2)
      }))
      expect(offers).toBe(3)
      expect(exit).toEqual(Exit.die(error))
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "retry")),
      Effect.provide(layerMemory),
      Effect.provide(offerFailureLayer(() =>
        Effect.suspend(() => {
          offers++
          return Effect.fail(error)
        })
      ))
    )
  })

  effect("the default offer schedule keeps retrying past three attempts", () => {
    let offers = 0
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(DurableQueue.process(Queue, { id: "default-retry", value: 0 }), {
        startImmediately: true
      })
      for (let turn = 0; turn < 50 && offers === 0; turn++) yield* Effect.yieldNow
      expect(offers).toBe(1)
      yield* TestClock.adjust(499)
      expect(offers).toBe(1)
      yield* TestClock.adjust(1)
      expect(offers).toBe(2)
      yield* TestClock.adjust(750)
      expect(offers).toBe(3)
      yield* TestClock.adjust(1125)
      expect(offers).toBe(4)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(fiber)
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "default-retry")),
      Effect.provide(layerMemory),
      Effect.provide(offerFailureLayer(() =>
        Effect.suspend(() => {
          offers++
          return Effect.fail(new PersistedQueue.PersistedQueueError({ message: "offer unavailable" }))
        })
      ))
    )
  })

  effect("invalid payloads die with SchemaError before opening the queue", () => {
    let opened = 0
    return Effect.gen(function*() {
      const exit = yield* Effect.exit(DurableQueue.process(Queue, { id: 1 } as never))
      expect(Exit.isFailure(exit) && exit.cause.reasons).toEqual([
        expect.objectContaining({ _tag: "Die", defect: expect.objectContaining({ _tag: "SchemaError" }) })
      ])
      expect(opened).toBe(0)
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "invalid")),
      Effect.provide(layerMemory),
      Effect.provideService(PersistedQueue.PersistedQueueFactory, {
        make: () =>
          Effect.sync(() => {
            opened++
            throw new Error("must not open queue")
          })
      })
    )
  })

  effect("an offer SchemaError dies immediately without retrying", () => {
    let offers = 0
    return Effect.gen(function*() {
      const schemaExit = yield* Effect.exit(Schema.decodeUnknownEffect(Schema.String)(1))
      if (!Exit.isFailure(schemaExit)) throw new Error("expected invalid string")
      const reason = schemaExit.cause.reasons.find(Cause.isFailReason)!
      const exit = yield* Effect.exit(
        DurableQueue.process(Queue, { id: "offer-schema", value: 0 }, {
          retrySchedule: Schedule.recurs(2)
        }).pipe(Effect.provideService(PersistedQueue.PersistedQueueFactory, {
          make: () =>
            Effect.succeed({
              [PersistedQueue.TypeId]: PersistedQueue.TypeId,
              offer: () =>
                Effect.suspend(() => {
                  offers++
                  return Effect.fail(reason.error)
                }),
              take: () => Effect.never
            })
        }))
      )
      expect(offers).toBe(1)
      expect(exit).toEqual(Exit.die(reason.error))
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Flow_, "offer-schema")),
      Effect.provide(layerMemory)
    )
  })

  effect("offers have per-run, per-occurrence identity and replay keeps the token", () => {
    const offered: Array<{ id: string; token: string }> = []
    const waits: Array<FlowRuntime.FlowInstance["Service"]["waiting"]> = []
    return Effect.gen(function*() {
      const tokens: Array<string> = []
      const offer = (instance: FlowRuntime.FlowInstance["Service"]) =>
        Effect.gen(function*() {
          const result = yield* DurableQueue.process(Queue, { id: "same", value: 0 }).pipe(Flow.intoResult)
          expect(result._tag).toBe("Suspended")
          const token = offered[offered.length - 1]!.token
          waits.push(instance.waiting)
          tokens.push(token)
        }).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance))
      const instance = makeInstance(Flow_, "identity")
      yield* offer(instance)
      yield* offer(instance)
      yield* offer(makeInstance(Flow_, "other-run"))
      yield* offer(makeInstance(Flow_, "identity"))
      expect(new Set(tokens.slice(0, 3)).size).toBe(3)
      expect(tokens[3]).toBe(tokens[0])
      expect(new Set(offered.slice(0, 3).map((item) => item.id)).size).toBe(3)
      expect(offered[3]!.id).toBe(offered[0]!.id)
      expect(waits).toEqual(tokens.map((token) => ({ reason: "event", token })))
    }).pipe(
      Effect.provide(layerMemory),
      Effect.provide(offerFailureLayer((options) =>
        Effect.sync(() => {
          const item = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.String }))(options.element)
          offered.push({ id: options.id, token: item.token })
        })
      ))
    )
  })

  for (const maxAttempts of [2, 3]) {
    effect(`completion-write failures rerun the handler with maxAttempts=${maxAttempts}`, () => {
      let handled = 0
      let writes = 0
      const logs: Array<{ level: string; annotations: Record<string, unknown> }> = []
      const capture = Logger.make((entry) => {
        logs.push({ level: entry.logLevel, annotations: Logger.formatStructured.log(entry).annotations })
      })
      const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
        const base = yield* FlowRuntime.FlowRuntime
        return FlowRuntime.FlowRuntime.of({
          ...base,
          deferredDone: (deferred, options) =>
            Effect.suspend(() => {
              if (options.deferredName.startsWith(Queue.deferred.name) && ++writes <= 2) {
                return Effect.die("completion store unavailable")
              }
              return base.deferredDone(deferred, options)
            })
        })
      })).pipe(Layer.provide(layerMemory))
      const layer = Layer.mergeAll(
        Offer.toLayer((payload) => DurableQueue.process(Queue, payload)),
        Interpreter.layer(Flow_),
        DurableQueue.worker(Queue, ({ value }) => Effect.sync(() => (handled++, value + 1)), { maxAttempts })
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(runtime),
        Layer.provideMerge(PersistedQueueLayer)
      )
      return Effect.gen(function*() {
        const id = yield* Flow_.execute({ id: `write-${maxAttempts}`, value: 41 }, { discard: true })
        for (let turn = 0; turn < 50 && writes === 0; turn++) yield* Effect.yieldNow
        yield* TestClock.adjust(1500)
        const result = yield* pollUntil(Flow_.poll(id), isComplete, { turns: 10, advance: "10 millis" })
        expect(handled).toBe(maxAttempts)
        expect(writes).toBe(maxAttempts)
        const errors = logs.filter((entry) => entry.level === "Error")
        expect(errors).toHaveLength(2)
        expect(errors[0]!.annotations.queueName).toBe(Queue.name)
        expect(errors[0]!.annotations.token).toEqual(expect.any(String))
        expect(errors[1]!.annotations.attempt).toBe(2)
        expect(errors[1]!.annotations.maxAttempts).toBe(maxAttempts)
        expect(errors[1]!.annotations.exhausted).toBe(maxAttempts === 2)
        if (maxAttempts === 3) {
          expect(Option.isSome(result) && result.value._tag === "Complete" && result.value.exit).toEqual(
            Exit.succeed(42)
          )
        } else {
          expect(Option.isSome(result) && result.value._tag).toBe("Suspended")
        }
      }).pipe(Effect.provide(layer), Effect.provide(Logger.layer([capture])))
    })
  }

  for (const mixed of [false, true]) {
    effect(
      mixed
        ? "workers strip interrupts from mixed handler failures"
        : "interrupt-only handler exits requeue without an attempt",
      () => {
        const recorded: Array<Exit.Exit<unknown, unknown>> = []
        const runtime = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
          const base = yield* FlowRuntime.FlowRuntime
          return FlowRuntime.FlowRuntime.of({
            ...base,
            deferredDone: (deferred, options) => {
              recorded.push(options.exit)
              return base.deferredDone(deferred, options)
            }
          })
        })).pipe(Layer.provide(layerMemory))
        return Effect.gen(function*() {
          const queue = yield* PersistedQueue.make({ name: `DurableQueue/${Queue.name}`, schema: itemSchema })
          const token = new DurableDeferred.TokenParsed({
            flowName: Flow_._tag,
            executionId: "interrupt",
            deferredName: `${Queue.deferred.name}/interrupt`
          }).asToken
          yield* queue.offer({
            token,
            payload: { id: "interrupt", value: 0 },
            traceId: "0".repeat(32),
            spanId: "0".repeat(16),
            sampled: false
          }, { id: "interrupt" })
          let handled = 0
          const worker = yield* Effect.forkChild(
            DurableQueue.makeWorker(Queue, () =>
              Effect.gen(function*() {
                handled++
                if (mixed) {
                  return yield* Effect.failCause(Cause.fromReasons([
                    ...Cause.fail("boom").reasons,
                    ...Cause.interrupt(7).reasons
                  ]))
                }
                const child = yield* Effect.forkChild(Effect.never)
                yield* Fiber.interrupt(child)
                return yield* Fiber.join(child)
              }), { maxAttempts: 1 }),
            { startImmediately: true }
          )
          for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
          expect(handled).toBe(1)
          yield* Fiber.interrupt(worker)
          if (mixed) {
            expect(recorded).toHaveLength(1)
            const exit = recorded[0]!
            if (!Exit.isFailure(exit)) throw new Error("expected handler failure")
            expect(exit.cause.reasons).toEqual([expect.objectContaining({ _tag: "Fail", error: "boom" })])
          } else {
            expect(recorded).toEqual([])
            const take = yield* Effect.forkChild(queue.take((item, metadata) => Effect.succeed({ item, metadata })), {
              startImmediately: true
            })
            for (let turn = 0; turn < 50 && take.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
            expect(take.pollUnsafe()).toEqual(Exit.succeed({
              item: expect.objectContaining({ token }),
              metadata: { id: "interrupt", attempts: 1 }
            }))
            yield* Fiber.interrupt(take)
          }
        }).pipe(Effect.provide(runtime), Effect.provide(PersistedQueueLayer))
      }
    )
  }
})

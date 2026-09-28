import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Cause, Deferred, Effect, Layer, Logger, Metric, References, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  InvalidJournalLoggerOptions,
  layerJournalForwarding,
  maximumCapacity,
  maximumSnapshotBytes,
  maximumSnapshotDepth,
  maximumSnapshotMembers,
  TelemetryLog,
  truncatedMarker,
  unrenderableMarker
} from "../src/JournalLogger.ts"
import { droppedLogRecords } from "../src/Metric.ts"

const run = <A, E>(program: Effect.Effect<A, E, never>) => Effect.runPromise(program.pipe(Effect.scoped))
const runId = (value: string): JournalEvent.RunId => Schema.decodeUnknownSync(JournalEvent.RunId)(value)

/** The malformation `Resource` refuses, used here as an independent oracle. */
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * The exact work a synchronous block does over string buffers: code units the
 * bounding scanner reads one at a time, and code units handed to a full UTF-8
 * encode. Those are the two mechanisms a multi-pass bound repeats, and both are
 * integers no machine load can move.
 */
const bufferPasses = <A>(body: () => A): {
  readonly result: A
  readonly unitsRead: number
  readonly unitsEncoded: number
} => {
  const charCodeAt = String.prototype.charCodeAt
  const encode = TextEncoder.prototype.encode
  let unitsRead = 0
  let unitsEncoded = 0
  String.prototype.charCodeAt = function(this: string, index: number): number {
    unitsRead += 1
    return charCodeAt.call(this, index)
  }
  TextEncoder.prototype.encode = function(this: TextEncoder, input?: string): ReturnType<TextEncoder["encode"]> {
    unitsEncoded += input === undefined ? 0 : input.length
    return encode.call(this, input)
  }
  try {
    const result = body()
    return { result, unitsRead, unitsEncoded }
  } finally {
    String.prototype.charCodeAt = charCodeAt
    TextEncoder.prototype.encode = encode
  }
}

/** Waits for an out-of-band worker effect without pinning a wall-clock delay. */
const settled = (predicate: () => boolean) =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 400 && !predicate(); attempt++) yield* Effect.sleep("5 millis")
  })

/** A journal stand-in whose receipts are accepted in arrival order. */
const acceptingJournal = (onEmit: (input: JournalEvent.Input) => Effect.Effect<void, Journal.JournalError>) => {
  let sequence = 0
  return Journal.layerNoop({
    emitLossy: (input) =>
      onEmit(input).pipe(
        Effect.map(() => ({
          _tag: "Accepted" as const,
          seq: sequence as JournalEvent.Seq,
          sourceSeq: sequence++ as JournalEvent.SourceSeq
        }))
      )
  })
}

/** A seeded generator, so a red property run is reproducible from its seed. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}

/**
 * Values chosen to attack the snapshot: identity traps, unreadable members,
 * malformed text, and payloads past every declared ceiling.
 */
const hostileValue = (next: () => number, depth: number): unknown => {
  const pick = Math.floor(next() * 16)
  switch (pick) {
    case 0: {
      const cycle: { self?: unknown } = {}
      cycle.self = cycle
      return cycle
    }
    case 1:
      return Object.defineProperty({}, "value", {
        enumerable: true,
        get: () => {
          throw new Error("must not run")
        }
      })
    case 2: {
      const revoked = Proxy.revocable({ value: "secret" }, {})
      revoked.revoke()
      return { revoked: revoked.proxy }
    }
    case 3:
      return "\u{1F600}".repeat(1 + Math.floor(next() * 64))
    case 4:
      return `${"\ud800"}lone${"\udfff"}`
    case 5:
      return depth > 6 ? "leaf" : { next: hostileValue(next, depth + 1) }
    case 6:
      return Array.from({ length: maximumSnapshotMembers + 8 }, (_, index) => index)
    case 7:
      return { apiKey: "x".repeat(maximumSnapshotBytes) }
    case 8:
      return 2n ** 70n
    case 9:
      return Symbol("hostile")
    case 10:
      return () => undefined
    case 11:
      return new Date(next() > 0.5 ? 0 : Number.NaN)
    case 12:
      return new Uint8Array([1, 2, 3])
    case 13:
      return { token: "sk-live-abcdefgh", nested: depth > 4 ? null : hostileValue(next, depth + 1) }
    case 14:
      return [Number.NaN, Number.POSITIVE_INFINITY, true, null, "\u0000"]
    default:
      return `plain-${Math.floor(next() * 1000)}`
  }
}

/** Collects only the warnings a forwarding worker reports to the ambient set. */
const warningSink = () => {
  const warnings: Array<{ message: unknown; annotations: Readonly<Record<string, unknown>> }> = []
  const output: Array<string> = []
  const logger = Logger.make<unknown, void>((options) => {
    if (options.logLevel !== "Warn") return
    output.push(Logger.formatJson.log(options))
    warnings.push({
      message: options.message,
      annotations: options.fiber.getRef(References.CurrentLogAnnotations)
    })
  })
  return { warnings, output, logger }
}

const entriesEventually = (
  journal: Journal.Service,
  id: JournalEvent.RunId,
  count: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, Journal.JournalError> =>
  Effect.gen(function*() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const page = yield* journal.entries({ runId: id, limit: 100 })
      if (page.entries.length >= count) return page.entries
      yield* Effect.sleep("5 millis")
    }
    return (yield* journal.entries({ runId: id, limit: 100 })).entries
  })

const logOnce = (id: JournalEvent.RunId, message: unknown) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(message)
    yield* Effect.sleep("10 millis")
  }).pipe(Effect.provide(layerJournalForwarding({ runId: id })), Effect.scoped)

describe("JournalLogger", () => {
  it("forwards a runtime-decodable versioned record without changing the logged effect", async () => {
    const id = runId("obs-run")
    const result = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("hello")
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(result).toMatchObject({
      version: 1,
      level: "Info",
      message: ["hello"],
      cause: { version: 1, reasons: [] }
    })
  })

  it("lets the journal allocate distinct identities across restarted and concurrent logger scopes", async () => {
    const id = runId("restart-run")
    const entries = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* logOnce(id, "first")
        yield* logOnce(id, "second")
        yield* Effect.all([logOnce(id, "third"), logOnce(id, "fourth")], { concurrency: "unbounded" })
        return yield* entriesEventually(journal, id, 4)
      }).pipe(Effect.provide(TestJournal.layer()))
    )

    expect(entries.slice(0, 2).map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ message: ["first"] }),
      expect.objectContaining({ message: ["second"] })
    ])
    expect(entries.slice(2).map((entry) => (entry.payload as TelemetryLog).message).sort()).toEqual([
      ["fourth"],
      ["third"]
    ])
    expect(new Set(entries.map((entry) => entry.sourceSeq)).size).toBe(4)
  })

  it("snapshots mutable messages and annotations before asynchronous delivery", async () => {
    const id = runId("snapshot-run")
    const message = { value: "before", nested: { token: "sk-live-abcdefgh" } }
    const annotation = { value: "annotation-before" }
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo(message).pipe(Effect.annotateLogs({ snapshot: annotation }))
        message.value = "after"
        message.nested.token = "after"
        annotation.value = "annotation-after"
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload.message).toEqual([{ value: "before", nested: { token: "[REDACTED]" } }])
    expect(payload.annotations).toEqual({ snapshot: { value: "annotation-before" } })
  })

  it("names cycles, accessors, revoked proxies, binaries, and bounded excess", async () => {
    const id = runId("hostile-run")
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new Error("must not run")
      }
    })
    const revoked = Proxy.revocable({ value: "secret" }, {})
    revoked.revoke()
    const many = Object.fromEntries(
      Array.from({ length: maximumSnapshotMembers + 10 }, (_, index) => [`key-${index}`, index])
    )

    const payloads = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        // Effect itself probes top-level messages for its Cause type id, which
        // necessarily touches a revoked proxy before any logger runs. Nesting
        // it exercises the forwarding boundary without tripping that upstream
        // precondition.
        yield* Effect.logInfo(cycle, accessor, { revoked: revoked.proxy }, new Uint8Array([1, 2]), many, 1n, undefined)
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload).message as ReadonlyArray<unknown>
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payloads[0]).toEqual({ self: "[Circular]" })
    expect(payloads[1]).toEqual({ value: unrenderableMarker })
    expect(payloads[2]).toEqual({ revoked: unrenderableMarker })
    expect(payloads[3]).toBe("[Binary]")
    expect(payloads[4]).toMatchObject({ [truncatedMarker]: truncatedMarker })
    expect(payloads.slice(5)).toEqual([truncatedMarker])
  })

  it("detaches every supported value shape within explicit depth and byte ceilings", async () => {
    const id = runId("value-shapes-run")
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let depth = 0; depth <= maximumSnapshotDepth + 1; depth++) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    const sparse = new Array<unknown>(2)
    sparse[1] = "tail"
    const descriptorless = new Proxy({}, {
      ownKeys: () => ["missing"],
      getOwnPropertyDescriptor: () => undefined
    })
    const unreadable = new Proxy({}, {
      ownKeys: () => {
        throw new Error("unreadable keys")
      }
    })
    const hostileError = new Proxy(new Error("boom"), {
      get: (target, key, receiver) => {
        if (key === "stack") throw new Error("unreadable stack")
        return Reflect.get(target, key, receiver)
      }
    })

    const entries = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo(
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NaN,
          true,
          false,
          null,
          1n,
          undefined,
          () => undefined,
          Symbol("shape"),
          new Date(0),
          new Date(Number.NaN),
          hostileError,
          sparse,
          descriptorless,
          unreadable,
          deep
        )
        yield* Effect.logInfo("x".repeat(maximumSnapshotBytes + 100), "after-budget")
        yield* Effect.logInfo(
          "x".repeat(maximumSnapshotBytes - 100),
          "y".repeat(200)
        )
        yield* Effect.logInfo("spanned").pipe(Effect.withSpan("journal-logger-span"))
        return yield* entriesEventually(journal, id, 4)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const shapes = Schema.decodeUnknownSync(TelemetryLog)(entries[0]!.payload)
      .message as ReadonlyArray<unknown>
    expect(shapes.slice(0, 7)).toEqual(["Infinity", "-Infinity", "NaN", true, false, null, "1n"])
    expect(shapes[7]).toBe("[Undefined]")
    expect(shapes[8]).toBe("[Function]")
    expect(shapes[9]).toBe("[Symbol]")
    expect(shapes[10]).toBe("1970-01-01T00:00:00.000Z")
    expect(shapes[11]).toBe(unrenderableMarker)
    expect(shapes[12]).toMatchObject({ name: "Error", message: "boom", stack: unrenderableMarker })
    expect(shapes[13]).toEqual([unrenderableMarker, "tail"])
    expect(shapes[14]).toEqual({ missing: unrenderableMarker })
    expect(shapes[15]).toBe(unrenderableMarker)
    expect(JSON.stringify(shapes[16])).toContain("[Deep]")

    const bounded = Schema.decodeUnknownSync(TelemetryLog)(entries[1]!.payload)
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(maximumSnapshotBytes)
    expect(JSON.stringify(bounded.message)).toContain(truncatedMarker)

    const secondBounded = Schema.decodeUnknownSync(TelemetryLog)(entries[2]!.payload)
    expect(JSON.stringify(secondBounded.message)).toContain(truncatedMarker)

    const spanned = Schema.decodeUnknownSync(TelemetryLog)(entries[3]!.payload)
    expect(spanned.traceId).toBeTypeOf("string")
    expect(spanned.spanId).toBeTypeOf("string")
  })

  it("keeps the logger callback total when runtime-owned metadata is unreadable", async () => {
    const id = runId("metadata-fallback-run")
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.withFiber((fiber) =>
          Effect.sync(() => {
            const logger = [...fiber.getRef(Logger.CurrentLoggers)][0]!
            logger.log({
              message: ["unreachable"],
              logLevel: "Info",
              cause: Cause.empty,
              fiber: {
                id: fiber.id,
                get context(): never {
                  throw new Error("unreadable fiber context")
                }
              } as never,
              date: new Date(0)
            })
          })
        )
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload).toMatchObject({
      message: unrenderableMarker,
      annotations: {},
      cause: { version: 1, reasons: [] },
      timestamp: "1970-01-01T00:00:00.000Z"
    })
  })

  it("persists ordered fail, defect, and interrupt reasons with redaction", async () => {
    const id = runId("cause-run")
    const cause = Cause.combine(
      Cause.fail(new Error("request failed token=sk-live-abcdefgh")),
      Cause.combine(
        Cause.die({ apiKey: "secret" }),
        Cause.combine(Cause.interrupt(41), Cause.interrupt())
      )
    )
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", cause)
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload.cause.reasons).toMatchObject([
      { _tag: "Fail", error: { name: "Error", message: "request failed token=[REDACTED]" } },
      { _tag: "Die", defect: { apiKey: "[REDACTED]" } },
      { _tag: "Interrupt", fiberId: 41 },
      { _tag: "Interrupt", fiberId: null }
    ])
  })

  it("keeps tagged error fields and system error diagnostics through the snapshot", async () => {
    const id = runId("tagged-error-run")
    class ActionFailed extends Schema.TaggedError<ActionFailed>()("ActionFailed", {
      code: Schema.String,
      actionId: Schema.String,
      cause: Schema.optional(Schema.Unknown)
    }) {}
    const systemError = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
      syscall: "open",
      path: "/tmp/missing token=sk-live-abcdefgh"
    })
    const tagged = new ActionFailed({ code: "quota_exhausted", actionId: "action-7", cause: systemError })
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", Cause.combine(Cause.fail(tagged), Cause.die(systemError)))
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const [failed, died] = payload.cause.reasons as ReadonlyArray<{ error?: unknown; defect?: unknown }>
    expect(failed!.error).toMatchObject({
      name: "ActionFailed",
      message: "",
      _tag: "ActionFailed",
      code: "quota_exhausted",
      actionId: "action-7",
      cause: { name: "Error", code: "ENOENT", syscall: "open", path: "/tmp/missing token=[REDACTED]" }
    })
    expect(died!.defect).toMatchObject({
      name: "Error",
      message: "ENOENT: no such file",
      code: "ENOENT",
      syscall: "open",
      path: "/tmp/missing token=[REDACTED]"
    })
  })

  it("marks the snapshot truncated when an error carries more own properties than the member budget", async () => {
    const id = runId("wide-error-run")
    const wide = Object.assign(
      new Error("wide"),
      Object.fromEntries(Array.from({ length: maximumSnapshotMembers + 8 }, (_, index) => [`field${index}`, index]))
    )
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", Cause.die(wide))
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const [died] = payload.cause.reasons as ReadonlyArray<{ defect?: unknown }>
    const defect = died!.defect as Record<string, unknown>
    expect(defect[truncatedMarker]).toEqual(truncatedMarker)
    expect(Object.keys(defect).length).toBeLessThanOrEqual(maximumSnapshotMembers + 1)
  })

  it("marks an own error property the snapshot must not read rather than running its getter", async () => {
    const id = runId("accessor-error-run")
    const withAccessor = Object.defineProperty(new Error("accessor"), "detail", {
      enumerable: true,
      get: () => {
        throw new Error("must not run")
      }
    })
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", Cause.die(withAccessor))
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const [died] = payload.cause.reasons as ReadonlyArray<{ defect?: unknown }>
    expect(died!.defect).toMatchObject({ name: "Error", message: "accessor", detail: unrenderableMarker })
  })

  it("keeps the standard error fields when an error refuses to enumerate its own keys", async () => {
    const id = runId("unenumerable-error-run")
    // An `ownKeys` trap is the one way the own-property walk can throw, and a
    // logger that rethrows there loses the record it was asked to forward.
    const refuses = new Proxy(new Error("ownKeys refuses"), {
      ownKeys: () => {
        throw new Error("ownKeys trap refuses")
      }
    })
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", Cause.die(refuses))
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const [died] = payload.cause.reasons as ReadonlyArray<{ defect?: unknown }>
    expect(Object.keys(died!.defect as Record<string, unknown>).sort()).toEqual(["cause", "message", "name", "stack"])
    expect(died!.defect).toMatchObject({ name: "Error", message: "ownKeys refuses" })
  })

  it("drops a record when the bounded queue is actually saturated", async () => {
    const id = runId("overflow-run")
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const seen: Array<JournalEvent.Input> = []
    let sequence = 0
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("first")
        yield* Deferred.await(entered)
        yield* Effect.logInfo("second")
        yield* Effect.logInfo("dropped")
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("20 millis")
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: id, capacity: 1 }),
            Journal.layerNoop({
              emitLossy: (input) =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.tap(() => Effect.sync(() => seen.push(input))),
                  Effect.map(() => ({
                    _tag: "Accepted" as const,
                    seq: sequence as JournalEvent.Seq,
                    sourceSeq: sequence++ as JournalEvent.SourceSeq
                  }))
                )
            })
          )
        )
      )
    )
    expect(seen.map((input) => (input.payload as TelemetryLog).message)).toEqual([["first"], ["second"]])
  })

  it("rejects invalid options before starting a lossy worker", async () => {
    const invalid: ReadonlyArray<readonly [string, unknown]> = [
      ["runId", ""],
      ["runId", `run${String.fromCharCode(0)}id`],
      ["runId", "\ud800"],
      ["runId", "x".repeat(JournalEvent.maxIdentifierLength + 1)],
      ["capacity", 0],
      ["capacity", maximumCapacity + 1],
      ["capacity", 1.5],
      ["capacity", Number.NaN],
      ["capacity", Number.POSITIVE_INFINITY],
      ["options", null]
    ]
    for (const [path, value] of invalid) {
      const options = path === "options"
        ? value
        : path === "runId"
        ? { runId: value }
        : { runId: runId("valid-run"), capacity: value }
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            Layer.provide(layerJournalForwarding(options as never), Journal.layerNoop())
          )
        )
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const failure = Result.getOrUndefined(Cause.findError(exit.cause))
        expect(failure).toBeInstanceOf(InvalidJournalLoggerOptions)
        expect((failure as InvalidJournalLoggerOptions).path).toContain(path)
      }
    }
  })

  it("accepts the exact queue-capacity boundaries", async () => {
    for (const capacity of [1, maximumCapacity]) {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            Layer.provide(
              layerJournalForwarding({
                runId: runId(`capacity-${capacity}`),
                capacity,
                ...(capacity === 1 ? { minimumLogLevel: "Debug" as const } : {})
              }),
              Journal.layerNoop()
            )
          )
        )
      )
      expect(exit._tag).toBe("Success")
    }
  })

  it("preserves scope interruption while a journal write is in flight", async () => {
    const entered = Deferred.makeUnsafe<void>()
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("closing")
        yield* Deferred.await(entered)
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("interrupt-run") }),
            Journal.layerNoop({
              emitLossy: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            })
          )
        )
      )
    )
  })

  it("returns from a journal flush with a record still queued, and only a poll with the scope open sees it", async () => {
    const id = runId("flush-run")
    const entered = Deferred.makeUnsafe<void>()
    const attempted: Array<unknown> = []
    let flushes = 0
    // The shape the shutdown guidance has to survive: one admission is in
    // flight, a second record waits in the forwarder's own queue, and the
    // journal has nothing pending of its own to settle.
    const stalled = Journal.layerNoop({
      emitLossy: (input) =>
        Effect.sync(() => attempted.push(input.payload)).pipe(
          Effect.andThen(Deferred.succeed(entered, undefined)),
          Effect.andThen(Effect.never)
        ),
      flush: Effect.sync(() => {
        flushes += 1
      })
    })
    await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("in flight")
        yield* Deferred.await(entered)
        yield* Effect.logInfo("queued")
        yield* journal.flush
      }).pipe(Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id, capacity: 1 }), stalled)))
    )

    expect(flushes).toBe(1)
    // Flushing the journal admitted nothing new, and closing the scope
    // discarded the queued record rather than draining it.
    expect(attempted.map((payload) => (payload as TelemetryLog).message)).toEqual([["in flight"]])

    const polled = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo("first")
        yield* Effect.logInfo("second")
        return yield* entriesEventually(journal, id, 2)
      }).pipe(Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer())))
    )

    expect(polled.map((entry) => (entry.payload as TelemetryLog).message)).toEqual([["first"], ["second"]])
  })

  it("keeps the ambient loggers when asked to merge with them", async () => {
    const seen: Array<unknown> = []
    const ambient = Logger.make<unknown, void>((options) => seen.push(options.message))
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("merged")
        yield* Effect.sleep("10 millis")
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            layerJournalForwarding({ runId: runId("obs-merge"), mergeWithExisting: true }),
            Layer.merge(TestJournal.layer(), Logger.layer([ambient], { mergeWithExisting: false }))
          )
        )
      )
    )

    expect(seen).toEqual([["merged"]])
  })

  it("never lets a truncated key overwrite a member already in the record", async () => {
    const id = runId("key-collision-run")
    // Byte arithmetic: key "a[Truncated]" (14) + "keep" (6) + key "apiKey" (8)
    // + the filler string (its length + 2) leaves exactly 16 bytes, so the
    // oversized third key truncates to the prefix "a" and reads "a[Truncated]".
    const fillerLength = maximumSnapshotBytes - 14 - 6 - 8 - 2 - 16
    const message = {
      [`a${truncatedMarker}`]: "keep",
      apiKey: "x".repeat(fillerLength),
      [`a${"b".repeat(maximumSnapshotBytes)}`]: "overwrite"
    }
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo(message)
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const [record] = payload.message as ReadonlyArray<Record<string, unknown>>
    expect(record![`a${truncatedMarker}`]).toBe("keep")
    expect(record![truncatedMarker]).toBe(truncatedMarker)
  })

  it("never lets a truncated error field overwrite one already in the defect", async () => {
    const id = runId("error-key-collision-run")
    const failure = new Error("m")
    failure.name = "E"
    failure.stack = "s"
    // Byte arithmetic: message ["failed"] (8), then the standard error fields
    // "E", "m", "s", and "[Undefined]" (22), then key "a[Truncated]" (14) +
    // "keep" (6) + key "apiKey" (8) + the filler string (its length + 2)
    // leaves exactly 16 bytes, so the oversized last key reads "a[Truncated]".
    const fillerLength = maximumSnapshotBytes - 8 - 22 - 14 - 6 - 8 - 2 - 16
    Object.assign(failure, {
      [`a${truncatedMarker}`]: "keep",
      apiKey: "x".repeat(fillerLength),
      [`a${"b".repeat(maximumSnapshotBytes)}`]: "overwrite"
    })
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("failed", Cause.die(failure))
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const [died] = payload.cause.reasons as ReadonlyArray<{ defect?: unknown }>
    const defect = died!.defect as Record<string, unknown>
    expect(defect[`a${truncatedMarker}`]).toBe("keep")
    expect(defect[truncatedMarker]).toBe(truncatedMarker)
  })

  it("keeps annotations a record when one logged value spends the whole snapshot budget", async () => {
    const id = runId("spent-budget-run")
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logInfo({ apiKey: "x".repeat(maximumSnapshotBytes) }).pipe(
          Effect.annotateLogs({ lane: "spent" })
        )
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload.message).toEqual([{ apiKey: "[REDACTED]" }])
    expect(payload.annotations).toEqual({ [truncatedMarker]: truncatedMarker })
  })

  it("names an unusable annotations reference instead of writing a scalar", async () => {
    const id = runId("annotation-shape-run")
    const payloads = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.withFiber((fiber) =>
          Effect.sync(() => {
            const logger = [...fiber.getRef(Logger.CurrentLoggers)][0]!
            for (const annotations of [null, ["not", "a", "record"]]) {
              logger.log({
                message: ["shape"],
                logLevel: "Info",
                cause: Cause.empty,
                fiber: {
                  id: fiber.id,
                  context: fiber.context,
                  getRef: () => annotations
                } as never,
                date: new Date(0)
              })
            }
          })
        )
        const entries = yield* entriesEventually(journal, id, 2)
        return entries.map((entry) => Schema.decodeUnknownSync(TelemetryLog)(entry.payload))
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payloads.map((payload) => payload.annotations)).toEqual([
      { [truncatedMarker]: truncatedMarker },
      { [truncatedMarker]: truncatedMarker }
    ])
  })

  it("degrades to a decodable total record when the projection fails its own schema", async () => {
    const id = runId("schema-guard-run")
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        // A negative interrupt identity is outside `TelemetryInterrupt`, so the
        // projected payload is a durable row no consumer could decode.
        yield* Effect.logError("refused", Cause.interrupt(-1))
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    expect(payload).toMatchObject({
      level: "Error",
      message: truncatedMarker,
      annotations: {},
      cause: { version: 1, reasons: [] }
    })
  })

  it("bounds a multi-megabyte record in one pass and never retains half a surrogate pair", async () => {
    const id = runId("bounded-cost-run")
    const astral = "\u{1F600}".repeat(600_000)
    const escaped = `"\\\n\u0001aéあ𐀀\u{1F600}`.repeat(200_000)
    const malformed = `${"\ud800"}lone${"\udfff"}`.repeat(200_000)
    const inputs = [astral, escaped, malformed]
    const { passes, payloads } = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        const measured = yield* Effect.withFiber((fiber) =>
          Effect.sync(() => {
            const logger = [...fiber.getRef(Logger.CurrentLoggers)][0]!
            const emit = (message: unknown) =>
              logger.log({
                message,
                logLevel: "Info",
                cause: Cause.empty,
                fiber: fiber as never,
                date: new Date(0)
              })
            return inputs.map((input) => bufferPasses(() => emit(input)))
          })
        )
        const entries = yield* entriesEventually(journal, id, inputs.length)
        return {
          passes: measured,
          payloads: entries.map((entry) => Schema.decodeUnknownSync(TelemetryLog)(entry.payload))
        }
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    inputs.forEach((input, index) => {
      const pass = passes[index]!
      // One forward pass costs at most one read per byte it spends: a lone code
      // unit is one read for at least one byte, and a surrogate lookahead is
      // two reads for four bytes. The scan stops at the budget, so a bounded
      // single pass cannot read past `maximumSnapshotBytes` units however the
      // input is shaped, and the two reads that overflow the budget end it.
      expect(pass.unitsRead, `code units read for input ${index}`)
        .toBeLessThanOrEqual(maximumSnapshotBytes + 2)
      // The same statement from the other side: the scan is bounded by the
      // budget, not by the input, so it never walks the multi-megabyte tail it
      // is dropping.
      expect(pass.unitsRead, `code units read for input ${index}`).toBeLessThan(input.length)
      // The only full encode on this path is the single size check on the
      // bounded projection. Its JSON is one snapshot's worth of bytes plus the
      // record envelope, and a UTF-16 unit never outweighs its UTF-8 byte, so
      // one pass stays inside this bound. The binary search this replaced
      // re-encoded the input about twenty times; even one extra encode of the
      // smallest input here adds 1,200,000 units and trips it.
      expect(pass.unitsEncoded, `code units encoded for input ${index}`)
        .toBeLessThanOrEqual(maximumSnapshotBytes + 64 * 1024)
    })

    for (const payload of payloads) {
      const message = payload.message as string
      expect(message.endsWith(truncatedMarker)).toBe(true)
      expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(maximumSnapshotBytes)
    }
    // A cut inside a surrogate pair would leave text this package's own
    // `Resource` validator refuses. The last input was malformed on arrival,
    // so only the astral and escaped records carry that guarantee.
    expect(loneSurrogate.test(payloads[0]!.message as string)).toBe(false)
    expect(loneSurrogate.test(payloads[1]!.message as string)).toBe(false)
  })

  it.each(
    [
      { name: "Accepted", receipt: { _tag: "Accepted" }, losses: 0 },
      { name: "Duplicate pending", receipt: { _tag: "Duplicate", status: "pending" }, losses: 0 },
      { name: "Duplicate committed", receipt: { _tag: "Duplicate", status: "committed" }, losses: 0 },
      { name: "Dropped", receipt: { _tag: "Dropped", policy: "drop-newest" }, losses: 2 }
    ] as const
  )("counts $name admission losses exactly", async ({ receipt, losses }) => {
    const sink = warningSink()
    let attempts = 0
    const dropped = await run(
      Effect.gen(function*() {
        const before = yield* Metric.value(droppedLogRecords)
        yield* Effect.logInfo("first")
        yield* Effect.logInfo("second")
        yield* settled(() => attempts === 2)
        return (yield* Metric.value(droppedLogRecords)).count - before.count
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("receipt-run") }),
            Layer.merge(
              Journal.layerNoop({
                emitLossy: () =>
                  Effect.sync(() => ({
                    ...receipt,
                    seq: attempts as JournalEvent.Seq,
                    sourceSeq: attempts++ as JournalEvent.SourceSeq
                  }))
              }),
              Logger.layer([sink.logger], { mergeWithExisting: false })
            )
          )
        )
      )
    )

    expect(attempts).toBe(2)
    expect(dropped).toBe(losses)
    expect(sink.warnings).toEqual([])
  })

  it("reports and counts a journal delivery failure, then keeps forwarding", async () => {
    const sink = warningSink()
    const delivered: Array<unknown> = []
    let attempts = 0
    const dropped = await run(
      Effect.gen(function*() {
        const before = yield* Metric.value(droppedLogRecords)
        yield* Effect.logInfo("refused")
        yield* settled(() => sink.warnings.length >= 1)
        yield* Effect.logInfo("accepted")
        yield* settled(() => delivered.length >= 1)
        return (yield* Metric.value(droppedLogRecords)).count - before.count
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("delivery-failure-run") }),
            Layer.merge(
              acceptingJournal((input) => {
                attempts += 1
                return attempts === 1
                  ? Effect.fail(
                    new Journal.JournalError({
                      code: "journal_closed",
                      message: "connection failed password=synthetic-review-secret-123456",
                      cause: { password: "synthetic-review-secret-123456" }
                    })
                  )
                  : Effect.sync(() => {
                    delivered.push((input.payload as TelemetryLog).message)
                  })
              }),
              Logger.layer([sink.logger], { mergeWithExisting: false })
            )
          )
        )
      )
    )

    expect(sink.warnings).toHaveLength(1)
    expect(sink.output.join("\n")).not.toContain("synthetic-review-secret-123456")
    expect(sink.warnings[0]?.message).toEqual(["A telemetry log record could not be forwarded"])
    expect(sink.warnings[0]?.annotations).toEqual({
      runId: "delivery-failure-run",
      code: "journal_forwarding_failed"
    })
    expect(delivered).toEqual([["accepted"]])
    expect(dropped).toBe(1)
  })

  it("survives a journal defect instead of dying for the rest of the run", async () => {
    const sink = warningSink()
    const delivered: Array<unknown> = []
    let attempts = 0
    const dropped = await run(
      Effect.gen(function*() {
        const before = yield* Metric.value(droppedLogRecords)
        yield* Effect.logInfo("defective")
        yield* settled(() => sink.warnings.length >= 1)
        yield* Effect.logInfo("recovered")
        yield* settled(() => delivered.length >= 1)
        return (yield* Metric.value(droppedLogRecords)).count - before.count
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("defect-run") }),
            Layer.merge(
              acceptingJournal((input) => {
                attempts += 1
                if (attempts === 1) {
                  return Effect.die({
                    message: "journal driver exploded password=synthetic-review-secret-123456",
                    password: "synthetic-review-secret-123456"
                  })
                }
                return Effect.sync(() => {
                  delivered.push((input.payload as TelemetryLog).message)
                })
              }),
              Logger.layer([sink.logger], { mergeWithExisting: false })
            )
          )
        )
      )
    )

    expect(sink.warnings).toHaveLength(1)
    expect(sink.output.join("\n")).not.toContain("synthetic-review-secret-123456")
    expect(sink.warnings[0]?.message).toEqual(["The telemetry forwarding worker recovered from a defect"])
    expect(sink.warnings[0]?.annotations).toEqual({
      runId: "defect-run",
      code: "journal_forwarding_defect"
    })
    expect(delivered).toEqual([["recovered"]])
    expect(dropped).toBe(1)
  })

  it("treats interruption as fatal rather than recovering from it like a defect", async () => {
    const sink = warningSink()
    const delivered: Array<unknown> = []
    let attempts = 0
    await run(
      Effect.gen(function*() {
        yield* Effect.logInfo("interrupted")
        yield* Effect.sleep("40 millis")
        yield* Effect.logInfo("never drained")
        yield* Effect.sleep("40 millis")
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("worker-interrupt-run") }),
            Layer.merge(
              acceptingJournal(() => {
                attempts += 1
                return attempts === 1 ? Effect.interrupt : Effect.sync(() => {
                  delivered.push(attempts)
                })
              }),
              Logger.layer([sink.logger], { mergeWithExisting: false })
            )
          )
        )
      )
    )

    expect(sink.warnings).toEqual([])
    expect(delivered).toEqual([])
  })

  it("counts the record a saturated queue drops", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const dropped = await run(
      Effect.gen(function*() {
        const before = yield* Metric.value(droppedLogRecords)
        yield* Effect.logInfo("first")
        yield* Deferred.await(entered)
        yield* Effect.logInfo("second")
        yield* Effect.logInfo("dropped")
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("20 millis")
        return (yield* Metric.value(droppedLogRecords)).count - before.count
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("overflow-metric-run"), capacity: 1 }),
            acceptingJournal(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          )
        )
      )
    )

    expect(dropped).toBe(1)
  })

  it("never traverses a record the saturated queue cannot admit", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let traversals = 0
    // A proxy counts the own-key walk the snapshot performs, so an admitted
    // record and a dropped one are told apart by the work each one costs.
    const diagnostic = new Proxy({ detail: "content" }, {
      ownKeys: (target) => {
        traversals++
        return Reflect.ownKeys(target)
      }
    })
    const counted = await run(
      Effect.gen(function*() {
        const before = yield* Metric.value(droppedLogRecords)
        yield* Effect.logInfo(diagnostic)
        yield* Deferred.await(entered)
        yield* Effect.logInfo(diagnostic)
        const admitted = traversals
        yield* Effect.logInfo(diagnostic)
        const saturated = traversals
        yield* Deferred.succeed(release, undefined)
        yield* Effect.sleep("20 millis")
        return {
          admitted,
          saturated,
          dropped: (yield* Metric.value(droppedLogRecords)).count - before.count
        }
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("saturated-traversal-run"), capacity: 1 }),
            acceptingJournal(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
          )
        )
      )
    )

    expect(counted.admitted).toBeGreaterThan(0)
    expect(counted.saturated).toBe(counted.admitted)
    expect(counted.dropped).toBe(1)
  })

  it("leaves an application-chosen minimum level alone and replaces the ambient loggers by default", async () => {
    const seen: Array<unknown> = []
    const ambient = Logger.make<unknown, void>((options) => seen.push(options.message))
    const id = runId("defaults-run")
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logDebug("below the effect default")
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            layerJournalForwarding({ runId: id }),
            Layer.merge(TestJournal.layer(), Logger.layer([ambient], { mergeWithExisting: false }))
          )
        ),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )

    expect(payload.level).toBe("Debug")
    expect(seen).toEqual([])
  })

  it("freezes the durable telemetry.log wire shape", async () => {
    const id = runId("golden-run")
    const cause = Cause.combine(
      Cause.fail({ code: "golden_failure" }),
      Cause.combine(Cause.die({ reason: "golden_defect" }), Cause.combine(Cause.interrupt(7), Cause.interrupt()))
    )
    const payload = await run(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        yield* Effect.logError("golden", cause).pipe(
          Effect.annotateLogs({ lane: "golden", attempt: 2 }),
          Effect.withSpan("golden-span")
        )
        const [entry] = yield* entriesEventually(journal, id, 1)
        return Schema.decodeUnknownSync(TelemetryLog)(entry!.payload)
      }).pipe(
        Effect.provide(Layer.provideMerge(layerJournalForwarding({ runId: id }), TestJournal.layer()))
      )
    )

    const { fiberId, spanId, timestamp, traceId, ...frozen } = payload
    expect(frozen).toEqual({
      version: 1,
      level: "Error",
      message: ["golden"],
      annotations: { lane: "golden", attempt: 2 },
      cause: {
        version: 1,
        reasons: [
          { _tag: "Fail", error: { code: "golden_failure" } },
          { _tag: "Die", defect: { reason: "golden_defect" } },
          { _tag: "Interrupt", fiberId: 7 },
          { _tag: "Interrupt", fiberId: null }
        ]
      }
    })
    expect(Number.isInteger(fiberId) && fiberId >= 0).toBe(true)
    expect(traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(spanId).toMatch(/^[0-9a-f]{16}$/)
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it("keeps every generated payload decodable and inside the byte ceiling", async () => {
    const seed = 0x5eed_1234
    const next = mulberry32(seed)
    const captured: Array<JournalEvent.Input> = []
    const records = 200
    await run(
      Effect.gen(function*() {
        for (let index = 0; index < records; index++) {
          yield* Effect.logInfo({ value: hostileValue(next, 0) }).pipe(
            Effect.annotateLogs({ note: { value: hostileValue(next, 0) } })
          )
        }
        yield* settled(() => captured.length >= records)
      }).pipe(
        Effect.provide(
          Layer.provide(
            layerJournalForwarding({ runId: runId("property-run"), capacity: maximumCapacity }),
            acceptingJournal((input) =>
              Effect.sync(() => {
                captured.push(input)
              })
            )
          )
        )
      )
    )

    expect(captured, `seed ${seed}`).toHaveLength(records)
    for (const [index, input] of captured.entries()) {
      const decoded = () => Schema.decodeUnknownSync(TelemetryLog)(input.payload)
      expect(decoded, `seed ${seed}, record ${index}`).not.toThrow()
      expect(
        new TextEncoder().encode(JSON.stringify(input.payload)).byteLength,
        `seed ${seed}, record ${index}`
      ).toBeLessThanOrEqual(maximumSnapshotBytes)
    }
  })
})

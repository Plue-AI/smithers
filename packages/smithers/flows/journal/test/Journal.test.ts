import { describe, expect, it } from "@effect/vitest"
import { DatabaseError, DurableWriter, type Service as WriterService } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Deferred, Effect, Fiber, Layer, PubSub, Schema, Stream, Tracer } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as Statement from "effect/unstable/sql/Statement"
import { EntriesOptions, Journal, JournalError, maxEntriesLimit } from "../src/Journal.ts"
import {
  Entry,
  Input,
  makeEventId,
  maxIdentifierLength,
  type RunId,
  type Seq,
  type SourceId,
  type SourceSeq
} from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as Projection from "../src/Projection.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId
const sourceSeq = (value: number): SourceSeq => value as SourceSeq

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) =>
  it.effect(name, () => body().pipe(Effect.provide(TestClock.layer())))

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown,
  sequence?: SourceSeq
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    ...(sequence === undefined ? {} : { sourceSeq: sequence }),
    eventType,
    payload
  }, { disableChecks: true })

/**
 * Lets a valid raw sequence pass schema decode, then exposes a different value
 * from the constructed model. The tightened public schemas now reject the
 * allocation ceiling before the service's defensive checks, so this models a
 * hostile untyped caller changing the public class prototype at that boundary
 * and keeps those required runtime guards exercised.
 */
const withDecodedSequence = <A, E, R>(
  model: { readonly prototype: object },
  field: "seq" | "sourceSeq",
  value: number,
  use: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.getOwnPropertyDescriptor(model.prototype, field)
      Object.defineProperty(model.prototype, field, {
        configurable: true,
        get: () => value,
        set: function(this: object) {
          Object.defineProperty(this, field, {
            configurable: true,
            enumerable: true,
            value,
            writable: true
          })
        }
      })
      return previous
    }),
    () => use,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          Reflect.deleteProperty(model.prototype, field)
        } else {
          Object.defineProperty(model.prototype, field, previous)
        }
      })
  )

const migratedDatabase = (
  database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer
) => Layer.provideMerge(Migrations.layer, database)

const journalLayer = (
  options: SqlJournal.SqlJournalOptions,
  database: Layer.Layer<DurableWriter | SqlClient.SqlClient> = TestDatabase.layer
) => SqlJournal.layer(options).pipe(Layer.provide(migratedDatabase(database)))

const runJournal = <A, E>(
  effect: Effect.Effect<A, E, Journal | Scope.Scope>,
  options: SqlJournal.SqlJournalOptions = {
    capacity: 128,
    overflow: "reject"
  }
) =>
  effect.pipe(
    Effect.provide(journalLayer(options)),
    Effect.scoped
  )

const gateWrites = (gate: Deferred.Deferred<void>): Layer.Layer<DurableWriter, never, DurableWriter> =>
  Layer.effect(
    DurableWriter,
    Effect.gen(function*() {
      const writer = yield* DurableWriter
      const write: WriterService["write"] = (effect) => Deferred.await(gate).pipe(Effect.andThen(writer.write(effect)))
      return DurableWriter.of({ write })
    })
  )

const gatedDatabase = (gate: Deferred.Deferred<void>): Layer.Layer<DurableWriter | SqlClient.SqlClient> =>
  Layer.provideMerge(gateWrites(gate), TestDatabase.layer)

const failedWrites: Layer.Layer<DurableWriter> = Layer.succeed(DurableWriter)(
  DurableWriter.of({
    write: () =>
      Effect.fail(
        new DatabaseError({
          code: "io",
          cause: new Error("sink unavailable")
        })
      ) as never
  })
)

const failedDatabase: Layer.Layer<DurableWriter | SqlClient.SqlClient> = Layer.provideMerge(
  failedWrites,
  TestDatabase.layer
)

const failedInsertDatabase: Layer.Layer<DurableWriter | SqlClient.SqlClient> = Layer.provideMerge(
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          return typeof statement.compile === "function" &&
              statement.compile()[0].includes("INSERT INTO flows_journal_events")
            ? Effect.fail(new DatabaseError({ code: "io", cause: new Error("insert unavailable") }))
            : statement
        }
      }) as SqlClient.SqlClient
    })
  ),
  TestDatabase.layer
)

const failedDatabaseWithReadSignal = (
  readStarted: Deferred.Deferred<void>
): Layer.Layer<DurableWriter | SqlClient.SqlClient> =>
  Layer.provideMerge(
    failedWrites,
    Layer.provideMerge(
      Layer.effect(
        SqlClient.SqlClient,
        Effect.gen(function*() {
          const base = yield* Effect.service(SqlClient.SqlClient)
          return new Proxy(base, {
            apply(target, thisArgument, argumentsList) {
              const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
              if (typeof statement.compile !== "function") {
                return statement
              }
              const [query] = statement.compile()
              return query.includes("AND seq >") && !query.includes("seq >=")
                ? Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(statement))
                : statement
            }
          }) as SqlClient.SqlClient
        })
      ),
      TestDatabase.layer
    )
  )

/**
 * A database whose writes fail until `repair` is called, modelling a transient
 * persistence outage that the queued writer fiber observes and that later
 * clears.
 */
const transientlyFailingDatabase = (): {
  readonly layer: Layer.Layer<DurableWriter | SqlClient.SqlClient>
  repair: () => void
} => {
  let broken = true
  return {
    repair: () => {
      broken = false
    },
    layer: Layer.provideMerge(
      Layer.effect(
        DurableWriter,
        Effect.gen(function*() {
          const writer = yield* DurableWriter
          const write: WriterService["write"] = (effect) =>
            broken
              ? Effect.fail(new DatabaseError({ code: "io", cause: new Error("sink unavailable") }))
              : writer.write(effect)
          return DurableWriter.of({ write })
        })
      ),
      TestDatabase.layer
    )
  }
}

const defectDatabase: Layer.Layer<DurableWriter | SqlClient.SqlClient> = Layer.provideMerge(
  Layer.succeed(DurableWriter)(
    DurableWriter.of({ write: () => Effect.die("sink defect") })
  ),
  TestDatabase.layer
)

interface InitializationOverride {
  readonly sequences?:
    | ReadonlyArray<{
      readonly run_id: string
      readonly next_seq: unknown
    }>
    | undefined
  readonly sourceSequences?:
    | ReadonlyArray<{
      readonly run_id: string
      readonly source_id: string
      readonly next_source_seq: unknown
    }>
    | undefined
  readonly sourceEvents?:
    | ReadonlyArray<{
      readonly run_id: string
      readonly seq: unknown
      readonly event_id: string
      readonly source_id: string
      readonly source_seq: unknown
      readonly emitted_at_ms: number
      readonly event_type: string
      readonly payload_json: string
      readonly meta_json: string
    }>
    | undefined
  readonly failSequences?: boolean | undefined
  readonly failSourceSequences?: boolean | undefined
  readonly failSourceEvents?: boolean | undefined
}

const overrideInitialization = (
  override: InitializationOverride
): Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      const sql = new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          // The allocation floors are read one run at a time now, so the
          // override answers the per-run `AS next` shape rather than the
          // whole-table `GROUP BY` shape it used to intercept.
          if (query.includes("MAX(seq) + 1")) {
            if (override.failSequences === true) {
              return Effect.fail(new DatabaseError({ code: "io" }))
            }
            if (override.sequences !== undefined) {
              return Effect.succeed(override.sequences.map((row) => ({ next: row.next_seq })))
            }
          }
          if (query.includes("MAX(source_seq) + 1")) {
            if (override.failSourceSequences === true) {
              return Effect.fail(new DatabaseError({ code: "io" }))
            }
            if (override.sourceSequences !== undefined) {
              return Effect.succeed(override.sourceSequences.map((row) => ({ next: row.next_source_seq })))
            }
          }
          if (
            query.includes("FROM flows_journal_events") &&
            !query.includes("MAX(") &&
            !query.includes("WHERE")
          ) {
            if (override.failSourceEvents === true) {
              return Effect.fail(new DatabaseError({ code: "io" }))
            }
            if (override.sourceEvents !== undefined) {
              return Effect.succeed(override.sourceEvents)
            }
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return sql
    })
  )

const racedDuplicateDatabase = (
  duplicateRunId: RunId,
  duplicateSourceId: SourceId,
  duplicateSourceSeq: SourceSeq
): Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      let armed = true
      const sql = new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (armed && query.includes("INSERT INTO flows_journal_events")) {
            armed = false
            return base`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${duplicateRunId}, 0,
                ${makeEventId(duplicateRunId, duplicateSourceId, duplicateSourceSeq)},
                ${duplicateSourceId}, ${duplicateSourceSeq}, 0,
                'event', '{"value":1}', 'null'
              )
            `.pipe(Effect.andThen(statement))
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return sql
    })
  )

/**
 * Commits one row from "another writer" while this journal reads its
 * allocation floor, so the identity the caller is admitting is already durable
 * by the time the queued insert reaches the unique index.
 *
 * The floor read is the injection point because admission itself no longer
 * reads: an explicit producer sequence is answered from the in-process index
 * or admitted optimistically, and the constraint settles it at the insert.
 */
const externalCommitDatabase = (
  duplicateRunId: RunId,
  duplicateSourceId: SourceId,
  duplicateSourceSeq: SourceSeq,
  payloadJson: string
): Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      let armed = true
      const sql = new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (armed && query.includes("MAX(seq) + 1")) {
            armed = false
            return base`
              INSERT INTO flows_journal_events (
                run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
                event_type, payload_json, meta_json
              ) VALUES (
                ${duplicateRunId}, 0,
                ${makeEventId(duplicateRunId, duplicateSourceId, duplicateSourceSeq)},
                ${duplicateSourceId}, ${duplicateSourceSeq}, 0,
                'event', ${payloadJson}, 'null'
              )
            `.pipe(Effect.andThen(statement))
          }
          return statement
        }
      }) as SqlClient.SqlClient
      return sql
    })
  )

interface ReadGate {
  armed: boolean
  readonly release: Deferred.Deferred<void>
  readonly started: Deferred.Deferred<void>
}

const readGatedDatabase = (gate: ReadGate): Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      const sql = new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (
            !gate.armed ||
            !query.includes("FROM flows_journal_events") ||
            !query.includes("AND seq >") ||
            query.includes("seq >=")
          ) {
            return statement
          }
          gate.armed = false
          return Deferred.succeed(gate.started, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
            Effect.andThen(statement)
          )
        }
      }) as SqlClient.SqlClient
      return sql
    })
  )

/** Parks the first canonical floor read before the admission identity check. */
const allocationReadGatedDatabase = (
  gate: ReadGate
): Layer.Layer<SqlClient.SqlClient, never, SqlClient.SqlClient> =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function*() {
      const base = yield* Effect.service(SqlClient.SqlClient)
      return new Proxy(base, {
        apply(target, thisArgument, argumentsList) {
          const statement = Reflect.apply(target, thisArgument, argumentsList) as Statement.Statement<unknown>
          const [query] = statement.compile()
          if (!gate.armed || !query.includes("MAX(seq) + 1")) {
            return statement
          }
          gate.armed = false
          return Deferred.succeed(gate.started, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
            Effect.andThen(statement)
          )
        }
      }) as SqlClient.SqlClient
    })
  )

describe("Journal", () => {
  effect("validates queue and batch options when constructing the layer", () =>
    Effect.gen(function*() {
      const failures = yield* Effect.forEach(
        [
          { capacity: 0, overflow: "reject" as const },
          { capacity: Number.NaN, overflow: "reject" as const },
          { capacity: 1, overflow: "reject" as const, batchSize: 0 },
          { capacity: 1, overflow: "reject" as const, batchSize: Number.NaN }
        ],
        (options) =>
          Effect.flip(
            Effect.scoped(
              Effect.gen(function*() {
                yield* Journal
              }).pipe(Effect.provide(journalLayer(options)))
            )
          )
      )
      expect(failures.every((failure) => failure instanceof JournalError)).toBe(true)
      expect(failures.map((failure) => failure instanceof JournalError ? failure.code : undefined)).toEqual([
        "invalid_event",
        "invalid_event",
        "invalid_event",
        "invalid_event"
      ])
    }))

  effect(
    "normalizes initialization failures and rejects invalid durable sequence cursors",
    () =>
      Effect.gen(function*() {
        const acquire = (override: InitializationOverride) =>
          Effect.flip(
            Effect.scoped(
              Effect.gen(function*() {
                yield* Journal
              }).pipe(
                Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
                Effect.provide(overrideInitialization(override)),
                Effect.provide(migratedDatabase())
              )
            )
          )
        const durableSourceEvent = (seq: number, durableSourceSeq: number) => ({
          run_id: "run",
          seq,
          event_id: "event-id",
          source_id: "source",
          source_seq: durableSourceSeq,
          emitted_at_ms: 0,
          event_type: "event",
          payload_json: "{}",
          meta_json: "null"
        })
        // Only the bounded source-event seed runs at construction now. The
        // allocation floors are read on first use, so their failures are
        // emit-time and live in the cell below.
        const failures = yield* Effect.all([
          acquire({
            sequences: [],
            sourceSequences: [],
            failSourceEvents: true
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(Number.MAX_SAFE_INTEGER + 1, 0)]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(0, Number.MAX_SAFE_INTEGER + 1)]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(Number.MAX_SAFE_INTEGER, 0)]
          }),
          acquire({
            sequences: [],
            sourceSequences: [],
            sourceEvents: [durableSourceEvent(0, Number.MAX_SAFE_INTEGER)]
          })
        ])
        expect(failures.every((failure) => failure instanceof JournalError)).toBe(true)
        expect(failures.map((failure) => failure instanceof JournalError ? failure.code : undefined)).toEqual([
          "sink_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed",
          "decode_failed"
        ])

        const runtimeFailure = yield* withDecodedSequence(
          Entry,
          "seq",
          Number.MAX_SAFE_INTEGER,
          acquire({ sourceEvents: [durableSourceEvent(0, 0)] })
        )
        expect(runtimeFailure).toBeInstanceOf(JournalError)
        expect(runtimeFailure instanceof JournalError ? runtimeFailure.code : undefined).toBe("decode_failed")
      })
  )

  effect(
    "normalizes allocation-floor read failures and rejects invalid durable cursors at emit",
    () => {
      const emitWith = (
        override: InitializationOverride,
        submission: Input = input(runId("run"), sourceId("source"), "event", {})
      ) =>
        Effect.flip(
          Effect.scoped(
            Effect.gen(function*() {
              const journal = yield* Journal
              return yield* journal.emitLossy(submission)
            }).pipe(
              Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
              Effect.provide(overrideInitialization(override)),
              Effect.provide(migratedDatabase())
            )
          )
        )
      return Effect.gen(function*() {
        const failures = yield* Effect.all([
          emitWith({ failSequences: true }),
          emitWith({ sequences: [{ run_id: "run", next_seq: 0 }], failSourceSequences: true }),
          emitWith({
            sequences: [{ run_id: "run", next_seq: Number.NaN }],
            sourceSequences: []
          }),
          emitWith({
            sequences: [{ run_id: "run", next_seq: -1 }],
            sourceSequences: []
          }),
          emitWith({
            sequences: [],
            sourceSequences: [{ run_id: "run", source_id: "source", next_source_seq: Number.NaN }]
          }),
          emitWith({
            sequences: [],
            sourceSequences: [{ run_id: "run", source_id: "source", next_source_seq: -1 }]
          })
        ])
        expect(failures.every((failure) => failure instanceof JournalError)).toBe(true)
        // A database that cannot answer the floor read is a sink failure; a
        // floor it answers with an unusable cursor is an invalid event, caught
        // by the same bounds check every allocation already runs.
        expect(failures.map((failure) => failure instanceof JournalError ? failure.code : undefined)).toEqual([
          "sink_failed",
          "sink_failed",
          "invalid_event",
          "invalid_event",
          "invalid_event",
          "invalid_event"
        ])

        const runtimeFailure = yield* withDecodedSequence(
          Input,
          "sourceSeq",
          Number.MAX_SAFE_INTEGER,
          emitWith(
            { failSequences: true, sourceEvents: [] },
            {
              runId: runId("run"),
              sourceId: sourceId("source"),
              sourceSeq: sourceSeq(0),
              eventType: "event",
              payload: {}
            } as Input
          )
        )
        expect(runtimeFailure).toBeInstanceOf(JournalError)
        expect(runtimeFailure instanceof JournalError ? runtimeFailure.code : undefined).toBe("invalid_event")
      })
    }
  )

  effect("continues sequence allocation from valid durable cursors", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const receipt = yield* journal.emitLossy(
          input(runId("continued"), sourceId("source"), "event", {})
        )
        expect(receipt).toMatchObject({ seq: 4, sourceSeq: 7 })
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [{ run_id: "continued", next_seq: 4 }],
          sourceSequences: [{
            run_id: "continued",
            source_id: "source",
            next_source_seq: 7
          }]
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("restores committed source identities for duplicate receipts", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const receipt = yield* journal.emitLossy(
          input(runId("restored"), sourceId("source"), "event", { value: 1 }, sourceSeq(5))
        )
        expect(receipt).toEqual({
          _tag: "Duplicate",
          seq: 3,
          sourceSeq: 5,
          status: "committed"
        })
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [{ run_id: "restored", next_seq: 4 }],
          sourceSequences: [{
            run_id: "restored",
            source_id: "source",
            next_source_seq: 6
          }],
          sourceEvents: [{
            run_id: "restored",
            seq: 3,
            event_id: "event-id",
            source_id: "source",
            source_seq: 5,
            emitted_at_ms: 0,
            event_type: "event",
            payload_json: "{\"value\":1}",
            meta_json: "null"
          }]
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("rejects an exhausted canonical sequence cursor at emit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failure = yield* Effect.flip(
          journal.emitLossy(input(runId("exhausted"), sourceId("source"), "event", {}))
        )
        expect(failure.code).toBe("invalid_event")
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [{
            run_id: "exhausted",
            next_seq: Number.MAX_SAFE_INTEGER
          }],
          sourceSequences: [],
          sourceEvents: []
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("keeps ill-formed identifiers out of the store and astral ones intact", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        // SQLite binds a lone surrogate as U+FFFD, so "\uD800" and "\uD801"
        // would land on ONE persisted run id: the second run's first event
        // would dedupe into the first run's row and a read by either id would
        // return the same history. The schema rejects them before they can
        // collide.
        const illFormed = [
          "\uD800",
          "\uD801",
          "run-\uD800",
          "\uDC00-run",
          "run-\uD800-tail"
        ]
        const failures = yield* Effect.forEach(
          illFormed,
          (candidate) => Effect.flip(journal.emitLossy(input(runId(candidate), sourceId("source"), "event", {})))
        )
        for (const failure of failures) {
          expect(failure.code).toBe("invalid_event")
          expect(failure.message).toBe("event violates the journal input contract")
        }
        // Ill-formed source ids and event types are refused on the same terms.
        expect(
          (yield* Effect.flip(journal.emitLossy(input(runId("run"), sourceId("\uD800"), "event", {})))).code
        ).toBe("invalid_event")
        expect(
          (yield* Effect.flip(journal.emitLossy(input(runId("run"), sourceId("source"), "\uD800", {})))).code
        ).toBe("invalid_event")

        // A valid astral pair is ordinary text and must round-trip exactly.
        const astral = "run-\u{1F600}"
        yield* journal.emitLossy(input(runId(astral), sourceId("source-\u{1F600}"), "event-\u{1F600}", {}))
        yield* journal.flush
        const page = yield* journal.entries({ runId: runId(astral), limit: 10 })
        expect(page.entries.map((entry) => [entry.runId, entry.sourceId, entry.eventType])).toEqual([
          [astral, "source-\u{1F600}", "event-\u{1F600}"]
        ])
      })
    ))

  effect("rejects an exhausted producer sequence cursor at emit", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        // No explicit `sourceSeq`, so the identity is allocated from the
        // producer floor. A floor at MAX_SAFE_INTEGER names an identity the
        // allocator cannot advance past, and the emit must say so rather than
        // mint a sequence it can never follow.
        const failure = yield* Effect.flip(
          journal.emitLossy(input(runId("exhausted-source"), sourceId("source"), "event", {}))
        )
        expect(failure.code).toBe("invalid_event")
        expect(failure.message).toBe("journal sequence is outside the allocatable safe integer range")
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 1, overflow: "reject" })),
        Effect.provide(overrideInitialization({
          sequences: [],
          sourceSequences: [{
            run_id: "exhausted-source",
            source_id: "source",
            next_source_seq: Number.MAX_SAFE_INTEGER
          }],
          sourceEvents: []
        })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("validates emitted envelopes, JSON values, sequence bounds, and clock time", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const validRun = runId("valid")
        const validSource = sourceId("source")
        const invalidInputs = [
          input(runId(""), validSource, "event", {}),
          input(validRun, sourceId(""), "event", {}),
          input(validRun, validSource, "", {}),
          input(validRun, validSource, "event", undefined),
          input(validRun, validSource, "event", BigInt(1)),
          new Input({
            runId: validRun,
            sourceId: validSource,
            eventType: "event",
            payload: {},
            meta: BigInt(1)
          }, { disableChecks: true }),
          input(validRun, validSource, "event", {}, sourceSeq(-1)),
          input(validRun, validSource, "event", {}, sourceSeq(Number.NaN)),
          input(validRun, validSource, "event", {}, sourceSeq(Number.MAX_SAFE_INTEGER)),
          {} as Input
        ]
        const failures = yield* Effect.forEach(
          invalidInputs,
          (invalid) => Effect.flip(journal.emitLossy(invalid))
        )
        yield* TestClock.setTime(-1)
        failures.push(
          yield* Effect.flip(
            journal.emitLossy(input(validRun, validSource, "event", {}))
          )
        )
        expect(failures.every((failure) => failure.code === "invalid_event")).toBe(true)
        yield* TestClock.setTime(0)

        const runtimeFailure = yield* withDecodedSequence(
          Input,
          "sourceSeq",
          Number.MAX_SAFE_INTEGER,
          Effect.flip(
            journal.emitDurableUnfenced({
              runId: validRun,
              sourceId: validSource,
              sourceSeq: sourceSeq(0),
              eventType: "event",
              payload: {}
            } as Input)
          )
        )
        expect(runtimeFailure.code).toBe("invalid_event")
        expect(runtimeFailure.message).toBe("journal sequence is outside the allocatable safe integer range")
      })
    ))

  effect("validates durable read cursors", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const failures = yield* Effect.all([
          Effect.flip(journal.entries({ runId: runId(""), limit: 1 })),
          Effect.flip(journal.entries({ runId: runId("run"), limit: 0 })),
          Effect.flip(journal.entries({ runId: runId("run"), limit: Number.NaN })),
          Effect.flip(journal.entries({
            runId: runId("run"),
            after: -2 as Seq,
            limit: 1
          })),
          Effect.flip(journal.entries({
            runId: runId("run"),
            after: Number.NaN as Seq,
            limit: 1
          }))
        ])
        expect(failures.every((failure) => failure.code === "invalid_event")).toBe(true)
      })
    ))

  effect("returns from emit before persistence", () => {
    const gate = Deferred.makeUnsafe<void>()
    const run = runId("nonblocking")
    const source = sourceId("producer")

    return Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const journal = yield* Journal
      const receipt = yield* journal.emitLossy(input(run, source, "read.completed", { path: "a" }))
      expect(receipt).toMatchObject({ _tag: "Accepted", seq: 0, sourceSeq: 0 })

      const before = yield* journal.entries({ runId: run, limit: 10 })
      expect(before.entries).toEqual([])

      const flushFiber = yield* Effect.forkChild(journal.flush, { startImmediately: true })
      yield* Effect.yieldNow
      expect(flushFiber.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(flushFiber)
      const after = yield* journal.entries({ runId: run, limit: 10 })
      expect(after.entries).toHaveLength(1)
      expect(after.entries[0]?.emittedAtMs).toBe(1_000)
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.provide(journalLayer({ capacity: 4, overflow: "reject" }, gatedDatabase(gate))),
      Effect.scoped
    )
  })

  effect("allocates canonical run sequences before admission across producers", () => {
    const firstRun = runId("source-sequences-a")
    const secondRun = runId("source-sequences-b")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const receipts = yield* Effect.forEach([
          [firstRun, sourceId("producer-a"), "one", 1] as const,
          [firstRun, sourceId("producer-b"), "two", 2] as const,
          [firstRun, sourceId("producer-a"), "three", 3] as const,
          [secondRun, sourceId("producer-a"), "one", 1] as const
        ], ([run, source, eventType, payload]) => journal.emitLossy(input(run, source, eventType, payload)))
        expect(receipts).toMatchObject([
          { _tag: "Accepted", seq: 0, sourceSeq: 0 },
          { _tag: "Accepted", seq: 1, sourceSeq: 0 },
          { _tag: "Accepted", seq: 2, sourceSeq: 1 },
          { _tag: "Accepted", seq: 0, sourceSeq: 0 }
        ])

        yield* journal.flush
        const entries = yield* journal.entries({ runId: firstRun, limit: 10 })
        expect(entries.entries.map((entry) => entry.seq)).toEqual([0, 1, 2])
        expect(entries.entries.map((entry) => entry.sourceSeq)).toEqual([0, 0, 1])
      })
    )
  })

  effect("serializes concurrent producers without duplicate canonical sequences", () => {
    const run = runId("concurrent")
    const work = Array.from({ length: 50 }, (_, index) => index)

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          work,
          (index) =>
            journal.emitLossy(
              input(
                run,
                sourceId(index % 2 === 0 ? "producer-a" : "producer-b"),
                "concurrent.event",
                { index }
              )
            ),
          { concurrency: "unbounded", discard: true }
        )
        yield* journal.flush
        const page = yield* journal.entries({ runId: run, limit: 100 })
        const sequences = page.entries.map((entry) => entry.seq)
        expect(sequences).toEqual(work)
        expect(new Set(sequences).size).toBe(work.length)
      }),
      { capacity: 128, overflow: "reject", batchSize: 8 }
    )
  })

  effect("streams and projects with a batchSize above the read page ceiling", () => {
    const run = runId("wide-batch")
    const source = sourceId("producer")
    const count = maxEntriesLimit + 1
    const counter = Projection.make({
      name: "count",
      initial: 0,
      reduce: (state: number) => Effect.succeed(state + 1)
    })

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        // `batchSize` governs the writer's transaction size. It must not leak
        // into `entries` as a read limit, where anything above
        // `maxEntriesLimit` is refused: an empty run has to stream at all.
        const empty = yield* journal.stream({ runId: run }).pipe(Stream.take(0), Stream.runCollect)
        expect(empty).toHaveLength(0)

        yield* Effect.forEach(
          Array.from({ length: count }, (_, index) => index),
          (value) => journal.emitLossy(input(run, source, "event", { value })),
          { discard: true }
        )
        yield* journal.flush
        const entries = yield* journal.stream({ runId: run }).pipe(Stream.take(count), Stream.runCollect)
        expect(entries.map((entry) => entry.seq)).toEqual(Array.from({ length: count }, (_, index) => index))

        const states = yield* journal.project(counter, { runId: run }).pipe(Stream.take(count + 1), Stream.runCollect)
        expect(states.at(-1)).toBe(count)
      }),
      { capacity: count, overflow: "reject", batchSize: 16_384 }
    )
  })

  effect("collapses an explicit identity raced by a durable commit onto the committed row", () => {
    const run = runId("concurrent-retry")
    const source = sourceId("producer")
    const candidate = input(run, source, "concurrent.event", { value: 1 }, sourceSeq(0))
    const gate: ReadGate = {
      armed: true,
      release: Deferred.makeUnsafe<void>(),
      started: Deferred.makeUnsafe<void>()
    }

    return Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal
        const lossy = yield* journal.emitLossy(candidate).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(gate.started)

        const durable = yield* journal.emitDurableUnfenced(candidate)
        yield* Deferred.succeed(gate.release, undefined)
        const retried = yield* Fiber.join(lossy)
        expect(durable).toMatchObject({ _tag: "Accepted", seq: 0, sourceSeq: 0 })
        // Floors are read before taking the run permit. The admission then
        // rechecks the in-process identity index, which the durable commit
        // populated while this caller waited. The documented Duplicate
        // receipt returns that committed sequence without a new reservation.
        expect(retried).toEqual({ _tag: "Duplicate", seq: 0, sourceSeq: 0, status: "committed" })

        yield* journal.flush
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries).toHaveLength(1)
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 8, overflow: "reject" })),
        Effect.provide(Layer.provideMerge(allocationReadGatedDatabase(gate), migratedDatabase()))
      )
    )
  })

  effect("makes reject, drop-newest, and drop-oldest observable", () =>
    Effect.forEach(
      ["reject", "drop-newest", "drop-oldest"] as const,
      (policy) => {
        const gate = Deferred.makeUnsafe<void>()
        const run = runId(`overflow-${policy}`)
        const source = sourceId("producer")
        return Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emitLossy(input(run, source, "event", { value: 1 }))
          yield* Effect.yieldNow
          yield* journal.emitLossy(input(run, source, "event", { value: 2 }))

          if (policy === "reject") {
            const failure = yield* Effect.flip(
              journal.emitLossy(input(run, source, "event", { value: 3 }))
            )
            expect(failure.code).toBe("queue_overflow")
          } else {
            const receipt = yield* journal.emitLossy(input(run, source, "event", { value: 3 }))
            expect(receipt).toMatchObject(
              policy === "drop-newest"
                ? { _tag: "Dropped", seq: 2, sourceSeq: 2, policy: "drop-newest" }
                : {
                  _tag: "Accepted",
                  seq: 2,
                  sourceSeq: 2,
                  evicted: { policy: "drop-oldest", count: 1 }
                }
            )
          }

          yield* Deferred.succeed(gate, undefined)
          yield* journal.flush
          const page = yield* journal.entries({ runId: run, limit: 10 })
          expect(page.entries.map((entry) => entry.seq)).toEqual(
            policy === "drop-oldest" ? [0, 2] : [0, 1]
          )
          expect(page.entries.map((entry) => entry.sourceSeq)).toEqual(
            policy === "drop-oldest" ? [0, 2] : [0, 1]
          )
        }).pipe(
          Effect.ensuring(Deferred.succeed(gate, undefined)),
          Effect.provide(
            journalLayer(
              { capacity: 1, overflow: policy, batchSize: 1 },
              gatedDatabase(gate)
            )
          ),
          Effect.scoped
        )
      },
      { discard: true }
    ))

  effect("readmits an overflowed source event once the queue drains, leaving its sequence a gap", () =>
    Effect.forEach(
      ["reject", "drop-newest"] as const,
      (policy) => {
        const gate = Deferred.makeUnsafe<void>()
        const run = runId(`overflow-retry-${policy}`)
        const source = sourceId("producer")
        // The exact input the producer will retry, explicitly sequenced so the
        // retry is byte-for-byte the same admission request.
        const overflowed = input(run, source, "event", { value: 2 }, sourceSeq(2))
        return Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emitLossy(input(run, source, "event", { value: 0 }, sourceSeq(0)))
          yield* Effect.yieldNow
          yield* journal.emitLossy(input(run, source, "event", { value: 1 }, sourceSeq(1)))

          // The queue is full; the third admission is refused.
          if (policy === "reject") {
            const failure = yield* Effect.flip(journal.emitLossy(overflowed))
            expect(failure.code).toBe("queue_overflow")
          } else {
            expect(yield* journal.emitLossy(overflowed)).toMatchObject({
              _tag: "Dropped",
              seq: 2,
              sourceSeq: 2,
              policy: "drop-newest"
            })
          }

          yield* Deferred.succeed(gate, undefined)
          yield* journal.flush

          // The retry is a fresh admission, not a replay of a receipt the
          // journal never issued: a refused emit is never retained in the
          // source-event index, so the producer must not be told `Duplicate`
          // for an event that was never queued or committed.
          const retried = yield* journal.emitLossy(overflowed)
          expect(retried._tag).toBe("Accepted")
          // Canonical sequence 2 was allocated by the refused emit and is never
          // reused: the retry takes 3. Allocation is `MAX(seq) + 1` and replay
          // is `ORDER BY seq`, so the gap is inert — but it is the documented
          // consequence of refusing after allocation, and it is pinned here.
          expect(retried.seq).toBe(3)
          expect(retried.sourceSeq).toBe(2)

          yield* journal.flush
          const page = yield* journal.entries({ runId: run, limit: 10 })
          expect(page.entries.map((entry) => entry.seq)).toEqual([0, 1, 3])
          // Exactly one durable row carries the retried producer sequence.
          expect(page.entries.filter((entry) => entry.sourceSeq === 2)).toHaveLength(1)
          expect(page.entries.map((entry) => entry.payload)).toEqual([
            { value: 0 },
            { value: 1 },
            { value: 2 }
          ])
        }).pipe(
          Effect.ensuring(Deferred.succeed(gate, undefined)),
          Effect.provide(journalLayer({ capacity: 1, overflow: policy, batchSize: 1 }, gatedDatabase(gate))),
          Effect.scoped
        )
      },
      { discard: true }
    ))

  effect("accepts a multi-megabyte payload when no byte cap is configured", () =>
    runJournal(
      Effect.gen(function*() {
        // `capacity` bounds the NUMBER of queued events, never their size, so
        // one event can be arbitrarily large unless the layer sets
        // `maxEntryBytes`. That option is off by default because a durable
        // engine already in flight may legitimately write large payloads, and a
        // cap introduced under it would refuse writes that used to succeed. The
        // cost of leaving it off is real and is stated on the option: a row this
        // size is replayed to every sync subscriber and time-travel consumer, so
        // it is paid on every read, not just the write. The `maxEntryBytes`
        // cases below pin the bounded contract.
        const journal = yield* Journal
        const run = runId("huge-payload")
        const huge = "x".repeat(5 * 1024 * 1024)

        const durable = yield* journal.emitDurableUnfenced(input(run, sourceId("durable"), "big", { blob: huge }))
        expect(durable._tag).toBe("Accepted")

        const lossy = yield* journal.emitLossy(input(run, sourceId("lossy"), "big", { blob: huge }))
        expect(lossy._tag).toBe("Accepted")
        yield* journal.flush

        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries).toHaveLength(2)
        for (const entry of page.entries) {
          expect((entry.payload as { readonly blob: string }).blob).toHaveLength(huge.length)
        }
      })
    ))

  effect("persists telemetry events through the same queue and changes subscription", () => {
    const run = runId("telemetry")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const subscription = yield* journal.changes
        const changed = yield* Effect.forkChild(PubSub.take(subscription), {
          startImmediately: true
        })
        yield* journal.emitLossy(
          input(run, sourceId("telemetry"), "telemetry.span", {
            durationMs: 4
          })
        )
        yield* journal.flush

        const notification = yield* Fiber.join(changed)
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(notification.eventType).toBe("telemetry.span")
        expect(page.entries).toHaveLength(1)
        expect(page.entries[0]?.eventId).toBe(notification.eventId)
      })
    )
  })

  effect("publishes a durable commit even when the emitter is interrupted right after COMMIT", () => {
    const run = runId("durable-interrupted-after-commit")
    // An interruption reaches a running fiber only at an op boundary. The
    // writer records the fiber's stack depth when the transaction returns; the
    // tracer's per-op hook interrupts at the first op evaluated below that
    // depth, which is past the writer and its `restore`, the window before
    // index update and publication that the mask must cover.
    type StackedFiber = { readonly _stack: ReadonlyArray<unknown> }
    const depth = (fiber: unknown) => (fiber as StackedFiber)._stack.length
    let committedAt: number | undefined
    const interruptAfterCommit: Layer.Layer<DurableWriter, never, DurableWriter> = Layer.effect(
      DurableWriter,
      Effect.gen(function*() {
        const writer = yield* DurableWriter
        const write: WriterService["write"] = (effect) =>
          writer.write(effect).pipe(
            Effect.tap(() => Effect.withFiber((fiber) => Effect.sync(() => (committedAt = depth(fiber)))))
          )
        return DurableWriter.of({ write })
      })
    )
    const tracer = Tracer.make({
      span: (options) => new Tracer.NativeSpan(options),
      context: (primitive, fiber) => {
        if (committedAt !== undefined && depth(fiber) < committedAt - 1) {
          committedAt = undefined
          fiber.interruptUnsafe()
        }
        return primitive["~effect/Effect/evaluate"](fiber)
      }
    })

    return Effect.gen(function*() {
      const journal = yield* Journal
      const subscription = yield* journal.changes
      const changed = yield* Effect.forkChild(PubSub.take(subscription), { startImmediately: true })
      const emitting = yield* Effect.forkChild(
        journal.emitDurableUnfenced(input(run, sourceId("durable"), "committed", { ok: true })).pipe(
          Effect.provideService(Tracer.Tracer, tracer)
        )
      )
      const exit = yield* Fiber.await(emitting)
      yield* Effect.yieldNow
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(exit._tag).toBe("Failure")
      expect(page.entries).toHaveLength(1)
      const notification = changed.pollUnsafe()
      expect(notification?._tag).toBe("Success")
      yield* Fiber.interrupt(changed)
    }).pipe(
      Effect.provide(journalLayer(
        { capacity: 128, overflow: "reject" },
        Layer.provideMerge(interruptAfterCommit, TestDatabase.layer)
      )),
      Effect.scoped
    )
  })

  effect("isolates changes subscribers from recursive entry mutation", () => {
    const run = runId("changes-frozen")
    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const leftSubscription = yield* journal.changes
        const rightSubscription = yield* journal.changes
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: run,
            sourceId: sourceId("producer"),
            sourceSeq: sourceSeq(0),
            eventType: "original",
            payload: { nested: { value: 1 }, list: [{ value: 2 }] },
            meta: { nested: { value: 3 } }
          }, { disableChecks: true })
        )

        const left = yield* PubSub.take(leftSubscription)
        const right = yield* PubSub.take(rightSubscription)
        expect(Object.isFrozen(left)).toBe(true)
        expect(Object.isFrozen(left.payload)).toBe(true)
        expect(Object.isFrozen((left.payload as { nested: object }).nested)).toBe(true)
        expect(Object.isFrozen((left.payload as { list: Array<unknown> }).list)).toBe(true)

        expect(() => {
          ;(left as unknown as { eventType: string }).eventType = "mutated"
        }).toThrow(TypeError)
        expect(() => {
          ;(left.payload as { nested: { value: number } }).nested.value = 99
        }).toThrow(TypeError)
        expect(() => {
          ;(left.payload as { list: Array<{ value: number }> }).list[0]!.value = 99
        }).toThrow(TypeError)
        expect(() => {
          ;(left.meta as { nested: { value: number } }).nested.value = 99
        }).toThrow(TypeError)

        expect(right).toMatchObject({
          eventType: "original",
          payload: { nested: { value: 1 }, list: [{ value: 2 }] },
          meta: { nested: { value: 3 } }
        })
        const persisted = yield* journal.entries({ runId: run, limit: 1 })
        expect(persisted.entries[0]).toMatchObject({
          eventType: "original",
          payload: { nested: { value: 1 }, list: [{ value: 2 }] },
          meta: { nested: { value: 3 } }
        })
      })
    )
  })

  effect("closes the replay-then-live subscription race without loss or duplication", () => {
    const run = runId("replay-live")
    const source = sourceId("producer")
    const gate: ReadGate = {
      armed: false,
      release: Deferred.makeUnsafe<void>(),
      started: Deferred.makeUnsafe<void>()
    }
    const database = Layer.provideMerge(readGatedDatabase(gate), migratedDatabase())

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, source, "historical", { value: 1 }))
      yield* journal.flush

      yield* Effect.sync(() => {
        gate.armed = true
      })
      const collected = yield* journal.stream({ runId: run }).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(gate.started)
      yield* journal.emitLossy(input(run, source, "live", { value: 2 }))
      yield* journal.flush
      yield* Deferred.succeed(gate.release, undefined)

      const entries = yield* Fiber.join(collected)
      expect(entries.map((entry) => entry.seq)).toEqual([0, 1])
      expect(new Set(entries.map((entry) => entry.eventId)).size).toBe(2)
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate.release, undefined)),
      Effect.provide(
        SqlJournal.layer({
          capacity: 128,
          overflow: "reject"
        }).pipe(Layer.provide(database))
      ),
      Effect.scoped
    )
  })

  effect("replays after an explicit cursor and drains multiple internal pages", () => {
    const run = runId("stream-cursor")
    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          Array.from({ length: 23 }, (_, index) => index),
          (value) => journal.emitLossy(input(run, sourceId("producer"), "event", { value })),
          { discard: true }
        )
        yield* journal.flush
        const entries = yield* journal.stream({
          runId: run,
          afterSequence: 2 as Seq
        }).pipe(Stream.take(20), Stream.runCollect)
        expect(entries.map((entry) => entry.seq)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 3)
        )
        expect(new Set(entries.map((entry) => entry.eventId))).toHaveLength(20)
      }),
      { capacity: 32, overflow: "reject", batchSize: 3 }
    )
  })

  effect("keeps a shared run subscription until its final consumer closes", () =>
    runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const first = yield* journal.stream({ runId: runId("shared-subscription") }).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        const second = yield* journal.stream({ runId: runId("shared-subscription") }).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(first)
        yield* Fiber.interrupt(second)
      })
    ))

  effect("reads durable entries in pages", () => {
    const run = runId("paging")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          [0, 1, 2, 3, 4],
          (value) => journal.emitLossy(input(run, source, "paged", { value })),
          { discard: true }
        )
        yield* journal.flush

        const first = yield* journal.entries({ runId: run, limit: 2 })
        const second = yield* journal.entries({
          runId: run,
          after: first.entries.at(-1)!.seq,
          limit: 2
        })
        const third = yield* journal.entries({
          runId: run,
          after: second.entries.at(-1)!.seq,
          limit: 2
        })
        expect(first).toMatchObject({ hasMore: true })
        expect(second).toMatchObject({ hasMore: true })
        expect(third).toMatchObject({ hasMore: false })
        expect(
          [...first.entries, ...second.entries, ...third.entries].map((entry) => entry.seq)
        ).toEqual([0, 1, 2, 3, 4])
      })
    )
  })

  effect("bounds entries pages in the schema and the service", () => {
    const run = runId("bounded-page")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(input(run, source, "first", {}))
        yield* journal.emitLossy(input(run, source, "second", {}))
        yield* journal.flush

        const page = yield* journal.entries({ runId: run, limit: maxEntriesLimit })
        expect(page.entries.map((entry) => entry.eventType)).toEqual(["first", "second"])
        expect(page.hasMore).toBe(false)

        const failure = yield* Effect.flip(
          journal.entries({ runId: run, limit: maxEntriesLimit + 1 })
        )
        expect(failure.code).toBe("invalid_event")
        expect(() =>
          Schema.decodeUnknownSync(EntriesOptions)({
            runId: run,
            limit: maxEntriesLimit + 1
          })
        ).toThrow()
      })
    )
  })

  effect("reports each lost batch once and keeps accepting work while the sink is down", () => {
    const run = runId("sink-failure")
    const source = sourceId("producer")

    return Effect.gen(function*() {
      const journal = yield* Journal
      const receipt = yield* journal.emitLossy(input(run, source, "event", {}))
      expect(receipt._tag).toBe("Accepted")

      const flushFailure = yield* Effect.flip(journal.flush)
      expect(flushFailure.code).toBe("sink_failed")
      // The loss is spent: a flush with nothing outstanding has nothing to
      // report and must not re-raise a stale failure.
      yield* journal.flush
      // The writer survived, so the channel still admits work — and the next
      // lost batch is reported on its own flush.
      const later = yield* journal.emitLossy(input(run, source, "later", {}))
      expect(later._tag).toBe("Accepted")
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject" }, failedDatabase)
      ),
      Effect.scoped
    )
  })

  effect("rolls back a lossy batch when an individual SQL statement fails", () => {
    const run = runId("statement-failure")
    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, sourceId("producer"), "event", {}))
      const failure = yield* Effect.flip(journal.flush)
      expect(failure.code).toBe("sink_failed")
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries).toEqual([])
    }).pipe(
      Effect.provide(journalLayer({ capacity: 4, overflow: "reject" }, failedInsertDatabase)),
      Effect.scoped
    )
  })

  effect("commits healthy lossy entries beside one idempotency conflict", () => {
    const run = runId("isolated-conflict")
    const source = sourceId("producer")
    const gate = Deferred.makeUnsafe<void>()

    return Effect.gen(function*() {
      const journal = yield* Journal
      const sql = yield* Effect.service(SqlClient.SqlClient)
      expect((yield* journal.emitLossy(input(run, source, "conflict", { value: 99 }, sourceSeq(0))))._tag)
        .toBe("Accepted")
      expect((yield* journal.emitLossy(input(run, source, "healthy-1", { value: 1 }, sourceSeq(1))))._tag)
        .toBe("Accepted")
      expect((yield* journal.emitLossy(input(run, source, "healthy-2", { value: 2 }, sourceSeq(2))))._tag)
        .toBe("Accepted")

      // The identity is still free during synchronous admission. A competing
      // writer claims it only after all three entries are co-batched.
      yield* sql`
        INSERT INTO flows_journal_events (
          run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
          event_type, payload_json, meta_json
        ) VALUES (
          ${run}, 0, ${makeEventId(run, source, sourceSeq(0))}, ${source}, 0, 0,
          'original', '{"value":0}', 'null'
        )
      `

      yield* Deferred.succeed(gate, undefined)
      const failure = yield* Effect.flip(journal.flush)
      expect(failure.code).toBe("idempotency_conflict")
      expect(failure.message).toContain("producer:0")

      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual([
        "original",
        "healthy-1",
        "healthy-2"
      ])
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.provide(Layer.provideMerge(
        SqlJournal.layer({ capacity: 8, overflow: "reject", batchSize: 3 }),
        migratedDatabase(gatedDatabase(gate))
      )),
      Effect.scoped
    )
  })

  effect("keeps the durable channel writable after a lossy sink failure", () => {
    const run = runId("sink-failure-durable")
    const source = sourceId("producer")
    const database = transientlyFailingDatabase()

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, source, "queued", {}))
      // The queued writer loses the batch on the transient outage.
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      // The database recovers; the lossless lifecycle channel must recover too.
      database.repair()
      const receipt = yield* journal.emitDurableUnfenced(input(run, source, "lifecycle", {}))
      expect(receipt._tag).toBe("Accepted")
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["lifecycle"])
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject" }, database.layer)
      ),
      Effect.scoped
    )
  })

  effect("wakes live stream consumers when the sink fails", () => {
    const run = runId("sink-failure-stream")
    const readStarted = Deferred.makeUnsafe<void>()
    return Effect.gen(function*() {
      const journal = yield* Journal
      const consumer = yield* journal.stream({ runId: run }).pipe(
        Stream.runDrain,
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(readStarted)
      yield* journal.emitLossy(input(run, sourceId("producer"), "event", {}))
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
      expect((yield* Effect.flip(Fiber.join(consumer))).code).toBe("sink_failed")
    }).pipe(
      Effect.provide(
        journalLayer(
          { capacity: 4, overflow: "reject" },
          failedDatabaseWithReadSignal(readStarted)
        )
      ),
      Effect.scoped
    )
  })

  effect("recovers the lossy writer after a transient sink outage", () => {
    const run = runId("sink-failure-recovers")
    const source = sourceId("producer")
    const database = transientlyFailingDatabase()

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, source, "lost", {}))
      // Let the writer lose the batch with nobody waiting on it: the loss must
      // still reach the next flush rather than vanish.
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* Effect.yieldNow
      }
      // The outage is reported once, to the first flush after it.
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      // The latch must not survive the outage: once the database recovers the
      // queued writer keeps draining and `flush` — which durable delivery in
      // engine-store calls with `orDie` — succeeds again.
      database.repair()
      const receipt = yield* journal.emitLossy(input(run, source, "written", {}))
      expect(receipt._tag).toBe("Accepted")
      yield* journal.flush
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["written"])
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject" }, database.layer)
      ),
      Effect.scoped
    )
  })

  effect("re-admits the exact producer identity after its failed batch was lost", () => {
    const run = runId("sink-failure-retry-identity")
    const source = sourceId("producer")
    const database = transientlyFailingDatabase()

    return Effect.gen(function*() {
      const journal = yield* Journal
      const retried = input(run, source, "event", { value: 1 }, sourceSeq(7))
      expect((yield* journal.emitLossy(retried))._tag).toBe("Accepted")
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      database.repair()
      const accepted = yield* journal.emitLossy(retried)
      expect(accepted._tag).toBe("Accepted")
      yield* journal.flush
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries).toHaveLength(1)
      expect(page.entries[0]).toMatchObject({ sourceSeq: 7, eventType: "event" })
    }).pipe(
      Effect.provide(journalLayer({ capacity: 4, overflow: "reject" }, database.layer)),
      Effect.scoped
    )
  })

  effect("never vouches for entries still queued behind a lost batch", () => {
    const run = runId("sink-failure-queued-behind")
    const source = sourceId("producer")
    const gate = Deferred.makeUnsafe<void>()
    // Loses the first batch, then holds every later batch at `gate`, so the
    // entries queued behind the loss are provably still unpersisted while the
    // flush under test runs.
    const database = Layer.provideMerge(
      Layer.effect(
        DurableWriter,
        Effect.gen(function*() {
          const inner = yield* DurableWriter
          let first = true
          const write: WriterService["write"] = (effect) => {
            if (first) {
              first = false
              return Effect.fail(new DatabaseError({ code: "io", cause: new Error("sink unavailable") }))
            }
            return Deferred.await(gate).pipe(Effect.andThen(inner.write(effect)))
          }
          return DurableWriter.of({ write })
        })
      ),
      TestDatabase.layer
    )

    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, source, "lost", {}))
      yield* journal.emitLossy(input(run, source, "queued", {}))
      // Let the writer lose the first batch and block on the second.
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* Effect.yieldNow
      }
      // The loss is reported once, to this flush.
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")

      // The writer survived the loss and still holds `queued`, so the next
      // flush must not claim durability for it.
      const pendingFlush = yield* journal.flush.pipe(Effect.forkChild({ startImmediately: true }))
      for (let attempt = 0; attempt < 8; attempt++) {
        yield* Effect.yieldNow
      }
      expect(pendingFlush.pollUnsafe()).toBe(undefined)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(pendingFlush)
      const page = yield* journal.entries({ runId: run, limit: 10 })
      expect(page.entries.map((entry) => entry.eventType)).toEqual(["queued"])

      // The counter is not desynchronized either: a later entry still gets a
      // truthful flush.
      yield* journal.emitLossy(input(run, source, "after", {}))
      yield* journal.flush
      const after = yield* journal.entries({ runId: run, limit: 10 })
      expect(after.entries.map((entry) => entry.eventType)).toEqual(["queued", "after"])
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 8, overflow: "reject", batchSize: 1 }, database)
      ),
      Effect.scoped
    )
  })

  effect("converts writer defects to sink_failed", () => {
    const run = runId("sink-defect")
    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(input(run, sourceId("producer"), "event", {}))
      expect((yield* Effect.flip(journal.flush)).code).toBe("sink_failed")
    }).pipe(
      Effect.provide(
        journalLayer({ capacity: 4, overflow: "reject" }, defectDatabase)
      ),
      Effect.scoped
    )
  })

  effect("reports closed operations after the journal scope ends", () =>
    Effect.gen(function*() {
      const closed = yield* Effect.scoped(
        Effect.gen(function*() {
          return yield* Journal
        }).pipe(Effect.provide(journalLayer({ capacity: 1, overflow: "reject" })))
      )
      expect((yield* Effect.flip(closed.flush)).code).toBe("journal_closed")
      expect(
        (yield* Effect.flip(
          closed.emitLossy(input(runId("closed"), sourceId("source"), "event", {}))
        )).code
      ).toBe("journal_closed")
    }))

  effect("drains accepted events when the journal scope closes", () => {
    const run = runId("scope-drain")
    const gate = Deferred.makeUnsafe<void>()
    const emitted = Deferred.makeUnsafe<void>()

    return Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const closing = yield* Effect.scoped(
        Effect.gen(function*() {
          const journal = yield* Journal
          yield* journal.emitLossy(
            input(run, sourceId("producer"), "before-close", { ok: true })
          )
          yield* Deferred.succeed(emitted, undefined)
        }).pipe(
          Effect.provide(
            SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
              Layer.provide(gateWrites(gate))
            )
          )
        )
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(emitted)
      yield* Effect.yieldNow
      expect(closing.pollUnsafe()).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(closing)
      const rows = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM flows_journal_events WHERE run_id = ${run}
        `
      expect(rows.map((row) => row.seq)).toEqual([0])
    }).pipe(
      Effect.ensuring(Deferred.succeed(gate, undefined)),
      Effect.provide(migratedDatabase()),
      Effect.scoped
    )
  })

  effect("deduplicates a retried source event id", () => {
    const run = runId("dedupe")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const retried = input(run, source, "retried", { value: 1 }, sourceSeq(5))
        const accepted = yield* journal.emitLossy(retried)
        const pendingDuplicate = yield* journal.emitLossy(retried)
        yield* journal.flush
        const committedDuplicate = yield* journal.emitLossy(retried)

        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(accepted).toMatchObject({
          _tag: "Accepted",
          seq: 0,
          sourceSeq: 5
        })
        expect(pendingDuplicate).toEqual({
          _tag: "Duplicate",
          seq: 0,
          sourceSeq: 5,
          status: "pending"
        })
        expect(committedDuplicate).toEqual({
          _tag: "Duplicate",
          seq: 0,
          sourceSeq: 5,
          status: "committed"
        })
        expect(page.entries).toHaveLength(1)
        expect(page.entries[0]).toMatchObject({
          seq: 0 as Seq,
          sourceSeq: 5
        })
      })
    )
  })

  effect("recognizes a duplicate committed between the preflight read and insert", () => {
    const duplicateRunId = runId("raced-dedupe")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      yield* journal.emitLossy(
        input(duplicateRunId, duplicateSourceId, "event", { value: 1 }, duplicateSourceSeq)
      )
      yield* journal.flush
      const page = yield* journal.entries({ runId: duplicateRunId, limit: 10 })
      expect(page.entries).toHaveLength(1)
      expect(page.entries[0]?.sourceSeq).toBe(5)
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            Layer.provideMerge(
              racedDuplicateDatabase(
                duplicateRunId,
                duplicateSourceId,
                duplicateSourceSeq
              ),
              migratedDatabase()
            )
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("collapses onto a matching external commit at the insert", () => {
    const duplicateRunId = runId("external-dedupe")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      const event = input(
        duplicateRunId,
        duplicateSourceId,
        "event",
        { value: 1 },
        duplicateSourceSeq
      )
      // Admission cannot know about the external row: it reads nothing.
      expect(yield* journal.emitLossy(event)).toMatchObject({ _tag: "Accepted", sourceSeq: 5 })
      yield* journal.flush
      const page = yield* journal.entries({ runId: duplicateRunId, limit: 10 })
      expect(page.entries.map((entry) => [entry.seq, entry.sourceSeq])).toEqual([[0, 5]])
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            Layer.provideMerge(
              externalCommitDatabase(
                duplicateRunId,
                duplicateSourceId,
                duplicateSourceSeq,
                "{\"value\":1}"
              ),
              migratedDatabase()
            )
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("refuses a divergent external commit at the insert, and reports it through flush", () => {
    const duplicateRunId = runId("external-conflict")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      // The conflict is now the insert's answer rather than a preflight read's,
      // so it reaches the caller through the flush barrier instead of the emit.
      // The evidence already in the table is what survives either way.
      expect(
        yield* journal.emitLossy(
          input(duplicateRunId, duplicateSourceId, "event", { value: 1 }, duplicateSourceSeq)
        )
      ).toMatchObject({ _tag: "Accepted", sourceSeq: 5 })
      const failure = yield* Effect.flip(journal.flush)
      expect(failure.code).toBe("idempotency_conflict")
      const page = yield* journal.entries({ runId: duplicateRunId, limit: 10 })
      expect(page.entries.map((entry) => entry.payload)).toEqual([{ value: 2 }])
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            Layer.provideMerge(
              externalCommitDatabase(
                duplicateRunId,
                duplicateSourceId,
                duplicateSourceSeq,
                "{\"value\":2}"
              ),
              migratedDatabase()
            )
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("settles a divergent external commit as a duplicate when the producer owns the identity", () => {
    const duplicateRunId = runId("external-identity")
    const duplicateSourceId = sourceId("producer")
    const duplicateSourceSeq = sourceSeq(5)
    return Effect.gen(function*() {
      const journal = yield* Journal
      // `dedupe: "identity"` is the producer saying the sequence is derived
      // from the event, so bytes that differ are metadata about the
      // observation. The committed row stands and the flush stays clean.
      expect(
        yield* journal.emitLossy(
          new Input({
            runId: duplicateRunId,
            sourceId: duplicateSourceId,
            sourceSeq: duplicateSourceSeq,
            dedupe: "identity",
            eventType: "event",
            payload: { value: 1 }
          }, { disableChecks: true })
        )
      ).toMatchObject({ _tag: "Accepted", sourceSeq: 5 })
      yield* journal.flush
      const page = yield* journal.entries({ runId: duplicateRunId, limit: 10 })
      expect(page.entries.map((entry) => entry.payload)).toEqual([{ value: 2 }])
    }).pipe(
      Effect.provide(
        SqlJournal.layer({ capacity: 4, overflow: "reject" }).pipe(
          Layer.provide(
            Layer.provideMerge(
              externalCommitDatabase(
                duplicateRunId,
                duplicateSourceId,
                duplicateSourceSeq,
                "{\"value\":2}"
              ),
              migratedDatabase()
            )
          )
        )
      ),
      Effect.scoped
    )
  })

  effect("fails loudly when an idempotency key is reused with divergent content", () => {
    const run = runId("dedupe-conflict")
    const source = sourceId("producer")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(input(run, source, "retried", { value: 1 }, sourceSeq(5)))
        yield* journal.flush
        const failure = yield* Effect.flip(
          journal.emitLossy(input(run, source, "retried", { value: 2 }, sourceSeq(5)))
        )
        expect(failure.code).toBe("idempotency_conflict")
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries.map((entry) => entry.payload)).toEqual([{ value: 1 }])
      })
    )
  })

  effect("appends above sequences committed by another writer after initialization", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const journal = yield* Journal
        // The floor is read on first use, so a foreign row written before this
        // process ever touched the run is simply seen. This foreign write
        // lands AFTER the floor is cached, overtaking the next reservation.
        yield* journal.emitLossy(
          input(runId("sequence-conflict"), sourceId("producer"), "first", {})
        )
        yield* journal.flush
        yield* sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'sequence-conflict', 1, 'external', 'external', 0, 0,
            'external', '{}', 'null'
          )
        `
        yield* journal.emitLossy(
          input(runId("sequence-conflict"), sourceId("other-producer"), "event", {})
        )
        yield* journal.flush
        const page = yield* journal.entries({ runId: runId("sequence-conflict"), limit: 10 })
        expect(page.entries.map((entry) => entry.seq)).toEqual([0, 1, 2])
        expect(page.entries.map((entry) => entry.sourceId)).toEqual(["producer", "external", "other-producer"])
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 4, overflow: "reject" })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("rejects corrupt durable journal rows with decode_failed", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const journal = yield* Journal
        yield* TestDatabase.checks(sql, false)
        yield* sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'corrupt-json', 0, 'corrupt-json', 'source', 0, 0,
            'event', 'not-json', 'null'
          )
        `
        const invalidJson = yield* Effect.flip(
          journal.entries({ runId: runId("corrupt-json"), limit: 1 })
        )
        yield* sql`
          INSERT INTO flows_journal_events (
            run_id, seq, event_id, source_id, source_seq, emitted_at_ms,
            event_type, payload_json, meta_json
          ) VALUES (
            'corrupt-schema', 0, 'corrupt-schema', 'source', -1, 0,
            'event', '{}', 'null'
          )
        `
        const invalidSchema = yield* Effect.flip(
          journal.entries({ runId: runId("corrupt-schema"), limit: 1 })
        )
        expect([invalidJson.code, invalidSchema.code]).toEqual([
          "decode_failed",
          "decode_failed"
        ])
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 4, overflow: "reject" })),
        Effect.provide(migratedDatabase())
      )
    ))

  effect("normalizes SQL read failures", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const journal = yield* Journal
        yield* sql`DROP TABLE flows_journal_events ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        const failure = yield* Effect.flip(
          journal.entries({ runId: runId("missing-table"), limit: 1 })
        )
        expect(failure.code).toBe("read_failed")
      }).pipe(
        Effect.provide(SqlJournal.layer({ capacity: 4, overflow: "reject" })),
        Effect.provide(migratedDatabase())
      )
    ))
})

describe("makeEventId injectivity (D5)", () => {
  // `makeEventId` is a pure function of exactly `(run_id, source_id,
  // source_seq)`, so for rows this journal minted, `UNIQUE (event_id)` and
  // `UNIQUE (run_id, source_id, source_seq)` reject the same second insert.
  // `selectExisting` still queries both, because a forked run also carries
  // rows whose event id `createFork` rewrote — the property asserted here is
  // what makes the two predicates agree everywhere else.
  const id = (run: string, source: string, sequence: number) =>
    makeEventId(runId(run), sourceId(source), sourceSeq(sequence))

  it("maps distinct triples to distinct event ids", () => {
    const triples: ReadonlyArray<readonly [string, string, number]> = [
      ["run", "source", 0],
      ["run", "source", 1],
      ["run", "other", 0],
      ["other", "source", 0],
      // The separator-injection corners: a run id ending in what looks like a
      // length prefix, and ids whose concatenation would otherwise coincide.
      ["run:source", "", 0],
      ["run", ":source", 0],
      ["ru", "nsource", 0],
      ["run1", "source", 0],
      ["run", "source1", 0],
      ["run", "source", 10]
    ]
    const ids = triples.map(([run, source, sequence]) => id(run, source, sequence))

    expect(new Set(ids).size).toBe(triples.length)
  })

  it("is a pure function of the triple", () => {
    expect(id("run", "source", 3)).toBe(id("run", "source", 3))
  })
})

describe("span attributes", () => {
  // Effect.fn does not auto-capture arguments, so each journal operation
  // annotates its own span. The capturing tracer follows
  // `reference/effect/packages/effect/test/unstable/http/HttpMiddleware.test.ts`.
  effect("Journal.emitDurableUnfenced annotates its span with the event identity", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(
          input(runId("run-span"), sourceId("source-span"), "step.started", { ok: true })
        )
      })
    ).pipe(
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.map(() => {
        const span = spans.find((candidate) => candidate.name === "Journal.emitDurableUnfenced")
        expect(span).toBeDefined()
        expect(span?.attributes.get("runId")).toBe("run-span")
        expect(span?.attributes.get("sourceId")).toBe("source-span")
        expect(span?.attributes.get("eventType")).toBe("step.started")
      })
    )
  })
})

/**
 * The read boundary decodes the schemas the package publishes.
 *
 * `EntriesOptions`, `StreamOptions`, `CheckpointOptions`, `CompactOptions` and
 * `RunId` already carry the non-empty, well-formed, bounded contract, but the
 * service used to hand-check a subset of it: a lone-surrogate run id was
 * refused at `emit` and answered with an empty page at `entries`, so a caller
 * could read with an identifier the writer would never accept.
 */
describe("SqlJournal read boundaries", () => {
  const owner: OwnerId = { hostId: "host", pid: 1, nonce: "nonce" }
  const illFormed = runId("\uD800")

  for (
    const [name, bad] of [
      ["empty", runId("")],
      ["lone-surrogate", illFormed],
      ["over-long", runId("r".repeat(maxIdentifierLength + 1))]
    ] as const
  ) {
    effect(`refuses an ${name} runId on every read and maintenance method`, () =>
      runJournal(
        Effect.gen(function*() {
          const journal = yield* Journal
          const codes = yield* Effect.all([
            Effect.flip(journal.entries({ runId: bad, limit: 10 })),
            Effect.flip(Stream.runCollect(journal.stream({ runId: bad }))),
            Effect.flip(journal.latestCheckpoint(bad)),
            Effect.flip(journal.checkpoint({ runId: bad, seq: 0 as Seq, state: null }, owner)),
            Effect.flip(journal.compact({ runId: bad }, owner))
          ])
          expect(codes.map((failure) => (failure as JournalError).code)).toEqual([
            "invalid_event",
            "invalid_event",
            "invalid_event",
            "invalid_event",
            "invalid_event"
          ])
        })
      ))
  }

  effect("refuses a NUL-bearing identifier as a caller fault, not a sink outage", () =>
    runJournal(
      Effect.gen(function*() {
        // SQLite's `length()` stops at the first NUL, so the column's own
        // `CHECK (length(run_id) > 0)` refused this write and the caller was
        // told `sink_failed`: the database looked broken because of an
        // identifier the caller had just supplied.
        const journal = yield* Journal
        const nul = String.fromCharCode(0)
        const failures = yield* Effect.all([
          Effect.flip(journal.emitDurableUnfenced(input(runId(`${nul}run`), sourceId("s"), "e", null))),
          Effect.flip(journal.emitDurableUnfenced(input(runId("run"), sourceId(`${nul}s`), "e", null))),
          Effect.flip(journal.emitDurableUnfenced(input(runId("run"), sourceId("s"), `${nul}e`, null)))
        ])
        for (const failure of failures) expect(failure.code).toBe("invalid_event")
      })
    ))

  effect("accepts a well-formed astral identifier end to end", () =>
    runJournal(
      Effect.gen(function*() {
        // The well-formedness check must refuse only UNPAIRED surrogates. A
        // valid pair is ordinary text the store round-trips.
        const journal = yield* Journal
        const run = runId("run-\u{1F600}")
        yield* journal.emitDurableUnfenced(input(run, sourceId("source-\u{1F600}"), "step.\u{1F600}", { ok: true }))
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries.map((entry) => [entry.runId, entry.sourceId, entry.eventType])).toEqual([
          [run, "source-\u{1F600}", "step.\u{1F600}"]
        ])
      })
    ))
})

/**
 * `capacity` bounds how MANY entries the queue and the `changes` buffer hold,
 * never how large one is. `maxEntryBytes` is the opt-in byte bound; it is off by
 * default so a running engine that legitimately writes large payloads is not
 * refused by an upgrade.
 */
describe("SqlJournal maxEntryBytes", () => {
  const run = runId("bounded")
  // `{"blob":"…"}` around the string: 11 bytes of envelope for the payload plus
  // the 4 bytes of `null` meta.
  const envelopeBytes = 15
  const cap = envelopeBytes + 64

  /**
   * An entry carrying `meta`. The shared `input` helper leaves `meta` at its
   * default `null`, which weighs a constant four bytes and so cannot tell a
   * counted meta from an ignored one.
   */
  const withMeta = (source: string, eventType: string, payload: unknown, meta: unknown): Input =>
    new Input({ runId: run, sourceId: sourceId(source), eventType, payload, meta }, { disableChecks: true })

  const withCap = <A, E>(body: Effect.Effect<A, E, Journal | Scope.Scope>) =>
    body.pipe(
      Effect.provide(journalLayer({ capacity: 16, overflow: "reject", maxEntryBytes: cap })),
      Effect.scoped
    )

  for (const [name, bytes] of [["zero", 0], ["fractional", 1.5]] as const) {
    effect(`refuses a ${name} maxEntryBytes at layer construction`, () =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          Effect.scoped(Effect.provide(
            Effect.service(Journal),
            journalLayer({ capacity: 16, overflow: "reject", maxEntryBytes: bytes })
          ))
        )
        expect((failure as JournalError).code).toBe("invalid_event")
        expect((failure as JournalError).message).toContain("maxEntryBytes")
      }))
  }

  effect("accepts an entry at the bound and refuses the next byte on both channels", () =>
    withCap(
      Effect.gen(function*() {
        const journal = yield* Journal
        const atBound = "x".repeat(cap - envelopeBytes)
        const overBound = `${atBound}x`

        expect((yield* journal.emitDurableUnfenced(input(run, sourceId("durable"), "fits", { blob: atBound })))._tag)
          .toBe("Accepted")
        expect((yield* journal.emitLossy(input(run, sourceId("lossy"), "fits", { blob: atBound })))._tag)
          .toBe("Accepted")
        yield* journal.flush

        const durable = yield* Effect.flip(
          journal.emitDurableUnfenced(input(run, sourceId("durable"), "over", { blob: overBound }))
        )
        const lossy = yield* Effect.flip(journal.emitLossy(input(run, sourceId("lossy"), "over", { blob: overBound })))
        for (const failure of [durable, lossy]) {
          expect(failure.code).toBe("invalid_event")
          expect(failure.message).toContain("maxEntryBytes")
        }

        // The bound is checked before allocation, so a refused entry costs no
        // sequence: the next accepted event takes the one the refusal would
        // have consumed.
        const next = yield* journal.emitDurableUnfenced(input(run, sourceId("durable"), "after", { blob: "y" }))
        expect(next).toMatchObject({ _tag: "Accepted", seq: 2 })
      })
    ))

  effect("measures UTF-8 bytes rather than JavaScript string length", () =>
    withCap(
      Effect.gen(function*() {
        const journal = yield* Journal
        // Each string weighs the 64 bytes the cap leaves for payload content
        // and each is shorter than that as a JavaScript string: "\u00e9" is one
        // char and two bytes, "\u{1D11E}" is two chars and four. JSON.stringify
        // emits both verbatim, so the persisted bytes are the UTF-8 bytes.
        for (
          const [name, atBound] of [["two-byte", "\u00e9".repeat(32)], ["astral", "\u{1D11E}".repeat(16)]] as const
        ) {
          expect((yield* journal.emitDurableUnfenced(input(run, sourceId(name), "fits", { blob: atBound })))._tag)
            .toBe("Accepted")

          const failure = yield* Effect.flip(
            journal.emitDurableUnfenced(input(run, sourceId(name), "over", { blob: `${atBound}x` }))
          )
          expect(failure.code).toBe("invalid_event")
          expect(failure.message).toContain(`event is ${cap + 1} bytes`)
        }
      })
    ))

  effect("counts the encoded meta and leaves a refused entry unallocated", () =>
    withCap(
      Effect.gen(function*() {
        const journal = yield* Journal
        // `{"blob":"x"}` is 12 bytes and the meta envelope `{"tag":""}` is 10,
        // so 57 bytes of meta content reach the cap exactly: 28 two-byte
        // characters and one ASCII byte.
        const payload = { blob: "x" }
        const atBound = `${"\u00e9".repeat(28)}z`

        expect((yield* journal.emitDurableUnfenced(withMeta("meta", "fits", payload, { tag: atBound })))._tag)
          .toBe("Accepted")

        // One byte of meta over the bound, then meta alone far over it while
        // the payload stays well under: a meta counted as a constant admits
        // both.
        for (
          const [meta, bytes] of [
            [{ tag: `${atBound}x` }, cap + 1],
            [{ tag: "x".repeat(100) }, 122]
          ] as const
        ) {
          const failure = yield* Effect.flip(journal.emitDurableUnfenced(withMeta("meta", "over", payload, meta)))
          expect(failure.code).toBe("invalid_event")
          expect(failure.message).toContain(`event is ${bytes} bytes`)
        }

        // The refusals ran before allocation, so neither the run sequence nor
        // the producer sequence moved and nothing extra was persisted.
        const next = yield* journal.emitDurableUnfenced(withMeta("meta", "after", payload, { tag: "z" }))
        expect(next).toMatchObject({ _tag: "Accepted", seq: 1, sourceSeq: 1 })
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries.map((entry) => [entry.seq, entry.eventType])).toEqual([[0, "fits"], [1, "after"]])
      })
    ))

  effect("sizes the entry after redaction", () =>
    withCap(
      Effect.gen(function*() {
        const journal = yield* Journal
        // Raw, this entry is thousands of bytes over the cap. The default
        // redactor replaces both credential values first, and the bound is
        // measured on the bytes that actually persist.
        const receipt = yield* journal.emitDurableUnfenced(
          withMeta("redacted", "secret", { apiKey: "s".repeat(4096) }, { sessionKey: "s".repeat(4096) })
        )
        expect(receipt._tag).toBe("Accepted")

        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries.map((entry) => [entry.payload, entry.meta])).toEqual([
          [{ apiKey: "[REDACTED]" }, { sessionKey: "[REDACTED]" }]
        ])
      })
    ))
})

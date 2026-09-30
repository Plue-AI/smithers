/**
 * Failure, gap, and reconnect behavior of the browser-safe sync client.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import * as Latch from "effect/Latch"
import * as Logger from "effect/Logger"
import { TestClock } from "effect/testing"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError, SyncGapError } from "../src/SyncError.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"
import { entry } from "./fixtures/entry.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

interface Stub {
  readonly read?: (
    request: SyncProtocol.ReadRequest
  ) => Effect.Effect<SyncProtocol.ReadResponse, unknown>
  readonly subscribe?: (
    request: SyncProtocol.SubscribeRequest
  ) => Stream.Stream<SyncProtocol.Frame, unknown>
}

const stubClient = (stub: Stub) =>
  Effect.runSync(SyncClient.make({
    client: {
      "Sync.Read": stub.read ??
        (() => Effect.succeed({ entries: [], cursors: [], done: true })),
      "Sync.Subscribe": stub.subscribe ?? (() => Stream.empty)
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  }))

const id = runId("failures")
const scope = { _tag: "Run", runId: id } as const

describe("SyncClient failure paths", () => {
  it.effect("fails with a gap error when a frame starts beyond the covered cursor", () =>
    Effect.gen(function*() {
      const client = stubClient({
        subscribe: () =>
          Stream.succeed<SyncProtocol.Frame>({
            generation: 0,
            _tag: "Entries",
            runId: id,
            fromSeq: seq(5),
            toSeq: seq(5),
            entries: [entry("failures", 5)]
          })
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncGapError)
        expect(failure).toMatchObject({ runId: id, expectedFrom: 0, receivedFrom: 5 })
      }
    }))

  it.effect("accepts holes inside a covered interval without reporting a gap", () =>
    Effect.gen(function*() {
      const client = stubClient({
        subscribe: () =>
          Stream.succeed<SyncProtocol.Frame>({
            generation: 0,
            _tag: "Entries",
            runId: id,
            // the server covered 0..7 but only entry 7 survived admission
            fromSeq: seq(0),
            toSeq: seq(7),
            entries: [entry("failures", 7)]
          })
      })

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([7])
    }))

  it.effect("drops frames the client has already materialized", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls++
          return calls === 1
            ? Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId: id,
              fromSeq: seq(0),
              toSeq: seq(1),
              entries: [entry("failures", 0), entry("failures", 1)]
            })
            : Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              // a redelivery of an already-consumed interval
              _tag: "Entries",
              runId: id,
              fromSeq: seq(0),
              toSeq: seq(1),
              entries: [entry("failures", 0), entry("failures", 1)]
            })
        }
      })

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
      )
      const cursors = (yield* client.progress).delivered

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
      expect(cursors).toEqual([{ generation: 0, runId: id, afterSeq: 1 }])
    }))

  it.effect("emits only the entries after the supplied cursor", () =>
    Effect.gen(function*() {
      const client = stubClient({
        subscribe: () =>
          Stream.succeed<SyncProtocol.Frame>({
            generation: 0,
            _tag: "Entries",
            runId: id,
            fromSeq: seq(0),
            toSeq: seq(3),
            entries: [entry("failures", 1), entry("failures", 2), entry("failures", 3)]
          })
      })

      const entries = yield* (
        client.subscribe({ scope, cursors: [{ generation: 0, runId: id, afterSeq: seq(2) }] }).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([3])
    }))

  it.effect("fails with a closed error when the server terminates the subscription", () =>
    Effect.gen(function*() {
      const client = stubClient({
        subscribe: () => Stream.succeed<SyncProtocol.Frame>({ _tag: "Closed", reason: "shutdown" })
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncError)
        expect((failure as SyncError).code).toBe("closed")
      }
    }))

  it.effect("ignores heartbeat frames", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls++
          return calls === 1
            ? Stream.succeed<SyncProtocol.Frame>({ _tag: "Heartbeat" })
            : Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId: id,
              fromSeq: seq(0),
              toSeq: seq(0),
              entries: [entry("failures", 0)]
            })
        }
      })

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0])
      expect(calls).toBeGreaterThan(1)
    }))

  it.effect("reconnects after a transport failure and resumes from the acknowledged cursor", () =>
    Effect.gen(function*() {
      let calls = 0
      const seen: Array<SyncProtocol.WorkspaceCursor> = []
      const client = stubClient({
        subscribe: (request) => {
          calls++
          seen.push(request.cursors)
          if (calls === 1) {
            return Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId: id,
              fromSeq: seq(0),
              toSeq: seq(0),
              entries: [entry("failures", 0)]
            })
          }
          if (calls === 2) {
            return Stream.fail(new Error("socket reset"))
          }
          return Stream.succeed<SyncProtocol.Frame>({
            generation: 0,
            _tag: "Entries",
            runId: id,
            fromSeq: seq(1),
            toSeq: seq(1),
            entries: [entry("failures", 1)]
          })
        }
      })

      const entries = yield* (
        Effect.gen(function*() {
          const fiber = yield* Stream.runCollect(
            client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2))
          ).pipe(Effect.forkChild({ startImmediately: true }))
          // The transport failure re-dials only after the reconnect backoff.
          yield* TestClock.adjust(500)
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(TestClock.layer()))
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
      // the retry after the transport failure resumes at the acknowledged cursor
      expect(seen[2]).toEqual([{ generation: 0, runId: id, afterSeq: 0 }])
    }))

  it.effect("does not spin through repeated live disconnects before retry time advances", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls += 1
          return calls <= 3 ? Stream.fail(new Error("socket reset")) : Stream.never
        }
      })

      const attemptsBeforeTimeAdvanced = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const fiber = yield* Stream.runDrain(client.subscribe({ scope, cursors: [] })).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            for (let turn = 0; turn < 8; turn += 1) yield* Effect.yieldNow
            const attempts = calls
            yield* Fiber.interrupt(fiber)
            return attempts
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )

      expect(attemptsBeforeTimeAdvanced).toBe(1)
    }))

  it.effect("stops live work when the consumer cancels the subscription", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls += 1
          return Stream.never
        }
      })

      const result = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const fiber = yield* Stream.runDrain(client.subscribe({ scope, cursors: [] })).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            yield* Effect.yieldNow
            yield* Fiber.interrupt(fiber)
            const atCancellation = calls
            yield* TestClock.adjust("1 day")
            yield* Effect.yieldNow
            return { afterTimeAdvanced: calls, atCancellation }
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )

      expect(result).toEqual({ atCancellation: 1, afterTimeAdvanced: 1 })
    }))

  it.effect("surfaces a bootstrap transport failure as a transport error", () =>
    Effect.gen(function*() {
      const client = stubClient({
        read: () => Effect.fail(new Error("read failed"))
      })

      const exit = yield* Effect.exit(
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncError)
        expect(failure).toMatchObject({ code: "transport_failed", message: "read failed" })
      }
    }))

  it.effect("keeps paging while the bootstrap read reports more durable entries", () =>
    Effect.gen(function*() {
      let reads = 0
      const requested: Array<SyncProtocol.WorkspaceCursor> = []
      const client = stubClient({
        read: (request) => {
          reads++
          requested.push(request.cursors)
          return reads === 1
            ? Effect.succeed({
              entries: [entry("failures", 0)],
              cursors: [{ generation: 0, runId: id, afterSeq: seq(0) }],
              done: false
            })
            : Effect.succeed({
              entries: [entry("failures", 1)],
              cursors: [{ generation: 0, runId: id, afterSeq: seq(1) }],
              done: true
            })
        }
      })

      const entries = yield* (
        client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runCollect)
      )

      expect(Array.from(entries).map((value) => value.seq)).toEqual([0, 1])
      expect(requested[0]).toEqual([])
      expect(reads).toBe(2)
    }))

  // An incomplete page with no entries can never converge: the next read
  // would carry the same cursors and receive the same page. The client fails
  // typed on the first such page instead of re-reading in a hot loop.
  it.effect("does not spin on an incomplete bootstrap page that makes no progress", () =>
    Effect.gen(function*() {
      let reads = 0
      const client = stubClient({
        read: () => {
          reads += 1
          return reads <= 3
            ? Effect.succeed({ entries: [], cursors: [], done: false })
            : Effect.never
        }
      })

      const readsBeforeTimeAdvanced = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const fiber = yield* Stream.runDrain(client.subscribe({ scope, cursors: [] })).pipe(
              Effect.forkChild({ startImmediately: true })
            )
            for (let turn = 0; turn < 8; turn += 1) yield* Effect.yieldNow
            const count = reads
            yield* Fiber.interrupt(fiber)
            return count
          })
        ).pipe(Effect.provide(TestClock.layer()))
      )

      expect(readsBeforeTimeAdvanced).toBe(1)
    }))

  it.effect("fails without reopening an empty completed subscription window", () =>
    Effect.gen(function*() {
      let calls = 0
      const client = stubClient({
        subscribe: () => {
          calls++
          // Bound the pre-fix loop so the regression fails without a timeout.
          return calls <= 3 ? Stream.empty : Stream.fail(new SyncError({ code: "closed", message: "probe limit" }))
        }
      })
      const before = yield* client.progress
      const failure = yield* Effect.flip(client.subscribe({ scope, cursors: [] }).pipe(Stream.runDrain))
      expect(calls).toBe(1)
      expect(failure).toMatchObject({
        code: "protocol_violation",
        message: "Subscription window closed without frames"
      })
      expect(yield* client.progress).toEqual(before)
    }))

  // A whole-workspace subscription merges every covered run, so one compacted
  // run used to take the whole subscription down: the refusal was untyped, the
  // client retried only `transport_failed`, and every resubscribe carried the
  // same cursors and earned the same refusal.
  it.effect("resyncs a compacted run from its checkpoint instead of losing the workspace subscription", () =>
    Effect.gen(function*() {
      const compacted = runId("compacted")
      const requested: Array<SyncProtocol.WorkspaceCursor> = []
      const client = stubClient({
        read: (request) => {
          requested.push(request.cursors)
          const covered = request.cursors.find((cursor) => cursor.runId === compacted)?.afterSeq ?? -1
          return covered < 12
            ? Effect.fail(
              new SyncError({
                code: "compacted",
                message: "run compacted is compacted through sequence 12",
                resync: { runId: compacted, checkpointSeq: seq(12), generation: 0 }
              })
            )
            : Effect.succeed({
              entries: [entry("compacted", 13), entry("healthy", 0)],
              cursors: [
                { generation: 0, runId: compacted, afterSeq: seq(13) },
                { generation: 0, runId: runId("healthy"), afterSeq: seq(0) }
              ],
              done: true
            })
        }
      })

      const entries = yield* (
        client.subscribe({
          scope: { _tag: "Workspace" },
          cursors: [],
          onResync: ({ runId, checkpointSeq }) => Effect.succeed({ runId, afterSeq: checkpointSeq })
        }).pipe(
          Stream.take(2),
          Stream.runCollect
        )
      )

      expect(Array.from(entries).map((value) => `${value.runId}:${value.seq}`)).toEqual([
        "compacted:13",
        "healthy:0"
      ])
      expect(requested).toEqual([[], [{ generation: 0, runId: compacted, afterSeq: 12 }]])
    }))

  // A resync that cannot move the cursor forward would re-read the same
  // refusal forever, so it stays a typed failure the caller can see.
  it.effect("does not spin on a compacted refusal that names no reachable checkpoint", () =>
    Effect.gen(function*() {
      const scenarios = [
        {
          name: "no checkpoint at all",
          cursors: [] as SyncProtocol.WorkspaceCursor,
          failure: new SyncError({ code: "compacted", message: "compacted with no floor" })
        },
        {
          name: "a checkpoint the subscription already covers",
          cursors: [{ generation: 0, runId: id, afterSeq: seq(12) }],
          failure: new SyncError({
            code: "compacted",
            message: "compacted through sequence 12",
            resync: { runId: id, checkpointSeq: seq(12), generation: 0 }
          })
        }
      ]

      for (const scenario of scenarios) {
        let reads = 0
        const client = stubClient({
          read: () => {
            reads += 1
            return Effect.fail(scenario.failure)
          }
        })

        const exit = yield* Effect.exit(
          client.subscribe({ scope, cursors: scenario.cursors }).pipe(Stream.take(1), Stream.runCollect)
        )

        expect(Exit.isFailure(exit), scenario.name).toBe(true)
        expect(reads, scenario.name).toBe(1)
        if (Exit.isFailure(exit)) {
          const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
          expect(failure).toMatchObject({ code: "compacted" })
        }
      }
    }))

  it.effect("makeNoop fails every subscription and reports no cursors", () =>
    Effect.gen(function*() {
      const noop = SyncClient.makeNoop()
      const exit = yield* Effect.exit(
        noop.subscribe({ scope, cursors: [] }).pipe(Stream.runCollect)
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect((failure as SyncError).code).toBe("closed")
      }
      expect((yield* noop.progress).delivered).toEqual([])
    }))

  it("waits out the reconnect backoff instead of re-dialing immediately, logging the failure cause", async () => {
    let calls = 0
    const client = stubClient({
      subscribe: () => {
        calls++
        return calls === 1
          ? Stream.fail(new Error("socket reset"))
          : Stream.succeed<SyncProtocol.Frame>({
            generation: 0,
            _tag: "Entries",
            runId: id,
            fromSeq: seq(0),
            toSeq: seq(0),
            entries: [entry("failures", 0)]
          })
      }
    })
    const logs: Array<{ readonly message: string; readonly cause: Cause.Cause<unknown> }> = []
    const capture = Logger.make((options) => {
      logs.push({ message: String(options.message), cause: options.cause })
    })

    const { callsBeforeBackoff, entries } = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Stream.runCollect(
          client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1))
        ).pipe(Effect.forkChild({ startImmediately: true }))
        // Without the schedule the second dial would already have happened —
        // this is exactly the zero-backoff hot loop the policy prevents.
        const dialed = calls
        yield* TestClock.adjust(500)
        return { callsBeforeBackoff: dialed, entries: yield* Fiber.join(fiber) }
      }).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provide(TestClock.layer())
      )
    )

    expect(callsBeforeBackoff).toBe(1)
    expect(calls).toBe(2)
    expect(Array.from(entries).map((value) => value.seq)).toEqual([0])
    const warning = logs.find((log) => log.message.includes("reconnecting with backoff"))
    expect(warning).toBeDefined()
    expect(
      warning!.cause.reasons.filter(Cause.isFailReason).map((reason) => (reason.error as SyncError).code)
    ).toEqual(["transport_failed"])
  })

  it("does not retry a gap failure through the reconnect policy", async () => {
    let calls = 0
    const client = stubClient({
      subscribe: () => {
        calls++
        return Stream.succeed<SyncProtocol.Frame>({
          generation: 0,
          _tag: "Entries",
          runId: id,
          fromSeq: seq(5),
          toSeq: seq(5),
          entries: [entry("failures", 5)]
        })
      }
    })

    const exit = await Effect.runPromiseExit(
      client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runCollect).pipe(
        Effect.provide(TestClock.layer())
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(calls).toBe(1)
  })

  it("never regresses the shared acknowledged cursor when a lagging subscription commits", async () => {
    const gate = Latch.makeUnsafe(false)
    const laggingStarted = Latch.makeUnsafe(false)
    let calls = 0
    const client = stubClient({
      subscribe: () => {
        calls++
        if (calls === 1) {
          // The lagging subscription: entry 0 now, entry 1 once the gate opens.
          return Stream.concat(
            Stream.succeed<SyncProtocol.Frame>({
              generation: 0,
              _tag: "Entries",
              runId: id,
              fromSeq: seq(0),
              toSeq: seq(0),
              entries: [entry("failures", 0)]
            }),
            Stream.concat(
              Stream.drain(Stream.fromEffect(Latch.open(laggingStarted).pipe(Effect.andThen(Latch.await(gate))))),
              Stream.succeed<SyncProtocol.Frame>({
                generation: 0,
                _tag: "Entries",
                runId: id,
                fromSeq: seq(1),
                toSeq: seq(1),
                entries: [entry("failures", 1)]
              })
            )
          )
        }
        // The fast subscription: catches the run up to seq 5.
        return Stream.succeed<SyncProtocol.Frame>({
          generation: 0,
          _tag: "Entries",
          runId: id,
          fromSeq: seq(1),
          toSeq: seq(5),
          entries: [entry("failures", 4), entry("failures", 5)]
        })
      }
    })

    const cursors = await Effect.runPromise(
      Effect.gen(function*() {
        const lagging = yield* Stream.runCollect(
          client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2))
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Latch.await(laggingStarted)
        // A second subscription advances the shared cursor to 5 while the
        // first still holds 0; the first's late commit of 1 must not move it
        // backward.
        yield* Stream.runDrain(client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2)))
        yield* Latch.open(gate)
        yield* Fiber.join(lagging)
        return (yield* client.progress).delivered
      })
    )

    expect(cursors).toEqual([{ generation: 0, runId: id, afterSeq: 5 }])
  })
})

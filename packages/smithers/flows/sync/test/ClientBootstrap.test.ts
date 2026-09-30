/**
 * The catch-up half of replay-then-follow: what the client asks for on each
 * page, what it accepts back, and what it does with a page it does not accept.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Data, Effect, Stream } from "effect"
import { expectTypeOf } from "vitest"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError, type SyncGapError } from "../src/SyncError.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import { entry } from "./fixtures/entry.ts"

const target = "catch-up" as JournalEvent.RunId
const foreign = "somebody-elses-run" as JournalEvent.RunId
const scope = { _tag: "Run", runId: target } as const

/** A consumer's own restoration failure, outside the wire vocabulary. */
class CheckpointMissing extends Data.TaggedError("CheckpointMissing")<{ readonly checkpointSeq: number }> {}

/** A consumer's own transaction failure, outside the wire vocabulary. */
class RolledBack extends Data.TaggedError("RolledBack")<{ readonly seq: number }> {}

/**
 * A server that honours the cursors it is handed, which is the only kind of
 * server a paging bug shows up against: a stub that ignores them answers a
 * stale request and a fresh one identically.
 */
const cursorHonouringServer = (total: number, pageSize: number) => {
  const requested: Array<SyncProtocol.WorkspaceCursor> = []
  const read = (request: SyncProtocol.ReadRequest) =>
    Effect.sync(() => {
      requested.push(request.cursors)
      const after = request.cursors.find((cursor) => cursor.runId === target)?.afterSeq ?? -1
      const entries = Array.from(
        { length: Math.min(pageSize, total - (after + 1)) },
        (_, index) => entry(target, after + 1 + index)
      )
      const last = entries.at(-1)
      return {
        cursors: last === undefined ? request.cursors : [{ generation: 0, afterSeq: last.seq, runId: target }],
        done: after + entries.length + 1 >= total,
        entries
      }
    })
  return {
    client: {
      "Sync.Read": read,
      "Sync.Subscribe": () => Stream.never as Stream.Stream<SyncProtocol.Frame>
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"],
    requested
  }
}

/** A server that answers every read with one fixed page. */
const fixedPage = (response: {
  readonly entries: ReadonlyArray<JournalEvent.Entry>
  readonly cursors: SyncProtocol.WorkspaceCursor
  readonly done: boolean
}) =>
  ({
    "Sync.Read": () => Effect.succeed(response),
    "Sync.Subscribe": () => Stream.never as Stream.Stream<SyncProtocol.Frame>
  }) as unknown as Parameters<typeof SyncClient.make>[0]["client"]

describe("SyncClient bootstrap paging", () => {
  // The RPC payload was built where the recursive call was WRITTEN, so page
  // N+1's cursors were snapshotted as page N was mapped, before a single one
  // of its entries had reached `commit`. Read 2k+2 therefore repeated read
  // 2k+1's request and the server correctly re-served the page it had just
  // served: a run of N entries was delivered roughly 2N times.
  it.effect("advances its request cursor on every page, so no entry is delivered twice", () =>
    Effect.gen(function*() {
      const total = 600
      const { client, requested } = cursorHonouringServer(total, 256)
      const sync = yield* SyncClient.make({ client })
      const entries = yield* Stream.runCollect(
        Stream.take(sync.subscribe({ scope, cursors: [] }), total)
      )
      const seqs = Array.from(entries, (value) => value.seq)

      expect(seqs).toHaveLength(total)
      expect(new Set(seqs).size).toBe(total)
      expect(seqs).toEqual(Array.from({ length: total }, (_, index) => index))
      // Three pages, and each one asks from where the last one ended.
      expect(requested).toHaveLength(3)
      expect(requested[0]).toEqual([])
      expect(requested[1]).toEqual([{ generation: 0, runId: target, afterSeq: 255 }])
      expect(requested[2]).toEqual([{ generation: 0, runId: target, afterSeq: 511 }])
    }))

  it.effect("asks for the configured bootstrap page size", () =>
    Effect.gen(function*() {
      const { client } = cursorHonouringServer(4, 2)
      const sync = yield* SyncClient.makeWith({ bootstrapLimit: 2, client })
      const entries = yield* Stream.runCollect(Stream.take(sync.subscribe({ scope, cursors: [] }), 4))

      expect(Array.from(entries, (value) => value.seq)).toEqual([0, 1, 2, 3])
    }))
})

describe("SyncClient bootstrap page validation", () => {
  // The live path has admitted, never trusted, its frames since it was
  // written. The catch-up path took every schema-valid page on faith, so a
  // compromised or buggy server could move the cursor of a run the caller
  // never asked about.
  it.effect("refuses a page carrying an entry outside the request's scope", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.make({
        client: fixedPage({ cursors: [], done: true, entries: [entry(foreign, 0)] })
      })
      const failure = yield* Effect.flip(
        Stream.runCollect(Stream.take(sync.subscribe({ scope, cursors: [] }), 1))
      )

      expect(SyncError.is(failure)).toBe(true)
      expect((failure as SyncError).code).toBe("protocol_violation")
      expect((yield* sync.progress).delivered).toEqual([])
    }))

  it.effect("refuses a page whose sequences repeat or move backwards", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.make({
        client: fixedPage({ cursors: [], done: true, entries: [entry(target, 1), entry(target, 1)] })
      })
      const failure = yield* Effect.flip(
        Stream.runCollect(Stream.take(sync.subscribe({ scope, cursors: [] }), 2))
      )

      expect((failure as SyncError).code).toBe("protocol_violation")
      expect((failure as SyncError).message).toContain("ascend strictly")
    }))

  // Serving an entry at or below the cursor the request carried is both a
  // redelivery and, on an incomplete page, a page that can never converge.
  it.effect("refuses a page that serves an entry the request had already covered", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.make({
        client: fixedPage({ cursors: [], done: false, entries: [entry(target, 3)] })
      })
      const failure = yield* Effect.flip(
        Stream.runCollect(
          Stream.take(
            sync.subscribe({ cursors: [{ generation: 0, runId: target, afterSeq: 5 as JournalEvent.Seq }], scope }),
            1
          )
        )
      )

      expect((failure as SyncError).code).toBe("protocol_violation")
      expect((failure as SyncError).message).toContain("requested cursor")
    }))

  it.effect("refuses a page that echoes one run's cursor twice", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.make({
        client: fixedPage({
          cursors: [
            { generation: 0, runId: target, afterSeq: 0 as JournalEvent.Seq },
            { generation: 0, runId: target, afterSeq: 1 as JournalEvent.Seq }
          ],
          done: true,
          entries: [entry(target, 0)]
        })
      })
      const failure = yield* Effect.flip(
        Stream.runCollect(Stream.take(sync.subscribe({ scope, cursors: [] }), 1))
      )

      expect((failure as SyncError).code).toBe("protocol_violation")
      expect((failure as SyncError).message).toContain("more than once")
    }))
})

describe("SyncClient subscription policy", () => {
  it.effect("refuses a credit that is not a positive safe integer", () =>
    Effect.gen(function*() {
      const { client } = cursorHonouringServer(1, 1)
      const sync = yield* SyncClient.make({ client })
      const failure = yield* Effect.flip(
        Stream.runCollect(sync.subscribe({ credit: 0, cursors: [], scope }))
      )

      expect((failure as SyncError).code).toBe("invalid_request")
      expect((failure as SyncError).message).toContain("SyncClient.SubscribeOptions.credit")
    }))

  // The client used to accept either value and then refuse every `subscribe`
  // and every `snapshot` under it, which reported a composition's mistake once
  // per operation. The policy is checked where it enters, so the constructor
  // is what fails.
  it.effect("refuses a frame ceiling or page size that is not a positive safe integer", () =>
    Effect.gen(function*() {
      const { client } = cursorHonouringServer(1, 1)
      const bytesFailure = yield* Effect.flip(SyncClient.makeWith({ client, maxFrameBytes: Number.NaN }))
      const limitFailure = yield* Effect.flip(SyncClient.makeWith({ bootstrapLimit: 0, client }))

      expect(bytesFailure.code).toBe("invalid_request")
      expect(bytesFailure.message).toContain("maxFrameBytes")
      expect(limitFailure.code).toBe("invalid_request")
      expect(limitFailure.message).toContain("bootstrapLimit")
    }))
})

describe("SyncClient transport failures", () => {
  // `SyncError.cause` is the declared error schema of every RPC, so what it
  // carries is bounded: an unbounded host object counted against no ceiling
  // and had no defined wire form.
  it.effect("renders a transport failure's cause as a bounded string", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.fail(new Error("x".repeat(10_000))),
          "Sync.Subscribe": () => Stream.never as Stream.Stream<SyncProtocol.Frame>
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const failure = yield* Effect.flip(Stream.runCollect(sync.subscribe({ scope, cursors: [] })))

      expect((failure as SyncError).code).toBe("transport_failed")
      const cause = (failure as SyncError).cause
      expect(typeof cause).toBe("string")
      expect((cause as string).length).toBeLessThan(600)
      expect(cause).toContain("(truncated)")
      // `message` is the OTHER unbounded string this error carries, and it
      // used to take the host's sentence verbatim: bounding only `cause` moved
      // the same 10,000 characters one field over.
      expect((failure as SyncError).message.length).toBeLessThan(600)
      expect((failure as SyncError).message).toContain("(truncated)")
    }))

  // A value the local check accepts and the WIRE schema refuses is not a
  // transport failure, but it arrived through the same channel a dropped
  // connection does, and `follow` retried it under backoff forever.
  it.effect("refuses a credit or bootstrap limit the wire schema would reject", () =>
    Effect.gen(function*() {
      const { client } = cursorHonouringServer(1, 1)
      const overCredit = yield* SyncClient.make({ client })
      const creditFailure = yield* Effect.flip(
        Stream.runCollect(
          overCredit.subscribe({ scope, cursors: [], credit: SyncProtocol.maxSubscribeCredit + 1 })
        )
      )
      const limitFailure = yield* Effect.flip(
        SyncClient.makeWith({ bootstrapLimit: SyncProtocol.maxReadLimit + 1, client })
      )

      expect((creditFailure as SyncError).code).toBe("invalid_request")
      expect((creditFailure as SyncError).message).toContain("credit")
      expect(limitFailure.code).toBe("invalid_request")
      expect(limitFailure.message).toContain("bootstrapLimit")
    }))
})

describe("SyncClient consumer acknowledgement", () => {
  // Without `apply` the cursor advances as the entry is handed over, which is
  // the weaker promise `RunCursor`'s JSDoc now states. With it, the cursor
  // means what the schema says: the last sequence the consumer materialized.
  it.effect("holds the cursor back when the consumer's own apply step fails", () =>
    Effect.gen(function*() {
      const { client } = cursorHonouringServer(3, 3)
      const applied: Array<number> = []
      const sync = yield* SyncClient.make({ client })
      const failure = yield* Effect.flip(
        Stream.runCollect(
          sync.subscribe({
            apply: (value) =>
              value.seq === 1
                ? Effect.fail(new SyncError({ code: "unknown", message: "apply failed" }))
                : Effect.sync(() => {
                  applied.push(value.seq)
                }),
            cursors: [],
            scope
          })
        )
      )

      expect((failure as SyncError).message).toBe("apply failed")
      expect(applied).toEqual([0])
      // Sequence 1 was never applied, so it is never acknowledged either: the
      // next subscription from these cursors delivers it again.
      expect((yield* sync.progress).delivered).toEqual([{ generation: 0, runId: target, afterSeq: 0 }])
    }))

  it.effect("advances the cursor through an apply step that succeeds", () =>
    Effect.gen(function*() {
      const { client } = cursorHonouringServer(2, 2)
      const applied: Array<number> = []
      const sync = yield* SyncClient.make({ client })
      yield* Stream.runDrain(
        Stream.take(
          sync.subscribe({
            apply: (value) =>
              Effect.sync(() => {
                applied.push(value.seq)
              }),
            cursors: [],
            scope
          }),
          2
        )
      )

      expect(applied).toEqual([0, 1])
      expect((yield* sync.progress).delivered).toEqual([{ generation: 0, runId: target, afterSeq: 1 }])
    }))
})

describe("SyncClient compaction seam", () => {
  /** A server that refuses the first read as compacted, then serves normally. */
  const compactingServer = (checkpointSeq: number) => {
    let refused = false
    return {
      "Sync.Read": (request: SyncProtocol.ReadRequest) =>
        Effect.suspend(() => {
          if (refused) {
            return Effect.succeed({
              cursors: request.cursors,
              done: true,
              entries: [entry(target, checkpointSeq + 1)]
            })
          }
          refused = true
          return Effect.fail(
            new SyncError({
              code: "compacted",
              message: "compacted",
              resync: { checkpointSeq: checkpointSeq as JournalEvent.Seq, runId: target, generation: 0 }
            })
          )
        }),
      "Sync.Subscribe": () => Stream.never as Stream.Stream<SyncProtocol.Frame>
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  }

  // The entries below the checkpoint are deleted and this wire carries no
  // state to stand in for them, so the hole is real. `onResync` is the point
  // at which a consumer fills it, and the cursor moves only after it succeeds.
  it.effect("runs the consumer's resync hook before moving the cursor past a compaction", () =>
    Effect.gen(function*() {
      const seen: Array<SyncProtocol.Resync> = []
      const sync = yield* SyncClient.make({ client: compactingServer(12) })
      const entries = yield* Stream.runCollect(
        Stream.take(
          sync.subscribe({
            cursors: [],
            onResync: (resync) =>
              Effect.sync(() => {
                seen.push(resync)
                return { runId: resync.runId, afterSeq: resync.checkpointSeq }
              }),
            scope
          }),
          1
        )
      )

      expect(seen).toEqual([{ runId: target, checkpointSeq: 12, generation: 0 }])
      expect(Array.from(entries, (value) => value.seq)).toEqual([13])
    }))

  it.effect("leaves the cursor where it was when the resync hook refuses", () =>
    Effect.gen(function*() {
      const sync = yield* SyncClient.make({ client: compactingServer(12) })
      const failure = yield* Effect.flip(
        Stream.runCollect(
          Stream.take(
            sync.subscribe({
              cursors: [],
              onResync: () => Effect.fail(new SyncError({ code: "unknown", message: "cannot restore state" })),
              scope
            }),
            1
          )
        )
      )

      expect((failure as SyncError).message).toBe("cannot restore state")
      expect((yield* sync.progress).delivered).toEqual([])
    }))

  it.effect("fails with the consumer's own callback errors, typed in the stream's error channel", () =>
    Effect.gen(function*() {
      const follow = (restorable: boolean) =>
        Effect.flatMap(SyncClient.make({ client: compactingServer(12) }), (sync) => {
          const following = sync.subscribe({
            cursors: [],
            scope,
            onResync: (resync) =>
              restorable
                ? Effect.succeed({ runId: resync.runId, afterSeq: resync.checkpointSeq })
                : Effect.fail(new CheckpointMissing({ checkpointSeq: resync.checkpointSeq })),
            apply: (applied) => Effect.fail(new RolledBack({ seq: applied.seq }))
          })
          expectTypeOf(following).toEqualTypeOf<
            Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError | CheckpointMissing | RolledBack>
          >()
          return Effect.map(Effect.flip(Stream.runDrain(following)), (failure) => [failure, sync] as const)
        })

      const [unrestored, refused] = yield* follow(false)
      expect(unrestored).toEqual(new CheckpointMissing({ checkpointSeq: 12 }))
      expect(SyncError.is(unrestored)).toBe(false)
      expect(yield* refused.progress).toEqual({ delivered: [], applied: [] })

      const [unapplied, restored] = yield* follow(true)
      expect(unapplied).toEqual(new RolledBack({ seq: 13 }))
      expect(SyncError.is(unapplied)).toBe(false)
      expect(yield* restored.progress).toEqual({
        delivered: [{ generation: 0, runId: target, afterSeq: 12 }],
        applied: [{ generation: 0, runId: target, afterSeq: 12 }]
      })
    }))
})

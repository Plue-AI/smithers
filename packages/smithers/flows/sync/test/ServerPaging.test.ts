/**
 * Workspace read paging boundaries and journal failure mapping.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"
import { entry } from "./fixtures/entry.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceId = "source" as JournalEvent.SourceId
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

// Non-branch reads are fail-closed; this suite tests paging mechanics, so its
// server runs every request as the workspace principal.
const principal = SyncPrincipal.workspace("paging-suite")
const asWorkspace = (server: SyncServer.Service): SyncServer.Service => ({
  snapshot: (request) => Effect.provideService(server.snapshot(request), SyncPrincipal.SyncPrincipal, principal),
  read: (request) => Effect.provideService(server.read(request), SyncPrincipal.SyncPrincipal, principal),
  subscribe: (request) => Stream.provideService(server.subscribe(request), SyncPrincipal.SyncPrincipal, principal)
})

const makeServer = (
  runs: ReadonlyArray<JournalEvent.RunId>,
  journal: Partial<Journal.Service>
) =>
  SyncServer.makeLive.pipe(
    Effect.provide(
      Layer.mergeAll(Journal.layerNoop(journal), RunCatalog.layerStatic(runs))
    ),
    Effect.map(asWorkspace)
  )

const pagesOf = (entries: ReadonlyMap<JournalEvent.RunId, ReadonlyArray<JournalEvent.Entry>>) => ({
  entries: ({ after, limit, runId: id }: Journal.EntriesOptions) => {
    const all = entries.get(id) ?? []
    const visible = all.filter((candidate) => after === undefined || candidate.seq > after)
    const page = visible.slice(0, limit)
    return Effect.succeed({
      entries: page,
      hasMore: page.length < visible.length
    } as Journal.EntriesPage)
  }
} satisfies Partial<Journal.Service>)

const empty = runId("empty-run")
const busy = runId("busy-run")
const workspace = { _tag: "Workspace" } as const

describe("SyncServer.read across a workspace", () => {
  it.effect("omits a run with no entries from the returned cursors", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [empty, busy],
            pagesOf(new Map([[busy, [entry(busy, 0), entry(busy, 1)]]]))
          )
          return yield* server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 })
        })
      )

      expect(response.entries.map((value) => value.seq)).toEqual([0, 1])
      expect(response.cursors).toEqual([{ generation: 0, runId: busy, afterSeq: 1 }])
      expect(response.done).toBe(true)
    }))

  it.effect("preserves a supplied cursor for a run that yields no new entries", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [empty, busy],
            pagesOf(new Map([[empty, [entry(empty, 7)]], [busy, [entry(busy, 0)]]]))
          )
          return yield* server.read({
            protocolVersion: 1,
            scope: workspace,
            cursors: [{ generation: 0, runId: empty, afterSeq: seq(7) }],
            limit: 10
          })
        })
      )

      expect(response.entries.map((value) => value.runId)).toEqual([busy])
      expect(response.cursors).toEqual([
        { generation: 0, runId: empty, afterSeq: 7 },
        { generation: 0, runId: busy, afterSeq: 0 }
      ])
    }))

  // The limit is shared before it is spent: two covered runs and a budget of
  // two serves one entry of each, not two of whichever run sorts first. The
  // page is still incomplete, because `busy` has more.
  it.effect("stops at the limit and reports the page as incomplete", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [busy, empty],
            pagesOf(
              new Map([
                [busy, [entry(busy, 0), entry(busy, 1)]],
                [empty, [entry(empty, 0)]]
              ])
            )
          )
          return yield* server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 2 })
        })
      )

      expect(response.entries.map((value) => value.runId)).toEqual([busy, empty])
      expect(response.done).toBe(false)
    }))

  it.effect("reports done as false when a single run still has more durable entries", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [busy],
            pagesOf(new Map([[busy, [entry(busy, 0), entry(busy, 1), entry(busy, 2)]]]))
          )
          return yield* server.read({ protocolVersion: 1, scope: { _tag: "Run", runId: busy }, cursors: [], limit: 2 })
        })
      )

      expect(response.entries.map((value) => value.seq)).toEqual([0, 1])
      expect(response.done).toBe(false)
      expect(response.cursors).toEqual([{ generation: 0, runId: busy, afterSeq: 1 }])
    }))

  // The journal's own message is the SQLite driver's: it carries SQL text,
  // table and column names, and constraint identifiers, and a follower may
  // hold nothing but a branch share link. What crosses is the run the read was
  // issued for and the journal's stable code, never the sentence it wrote.
  it.effect("maps a journal read failure to a transport-neutral SyncError carrying no host detail", () =>
    Effect.gen(function*() {
      const cause = new Journal.JournalError({ code: "journal_closed", message: "journal offline" })
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer([busy], { entries: () => Effect.fail(cause) })
          return yield* Effect.flip(server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 }))
        })
      )
      expect(failure).toBeInstanceOf(SyncError)
      // A shut-down journal is a fact this boundary can also state, so it
      // crosses as `closed` rather than as an unexplained fault. Only the
      // journal's SENTENCE is refused, never its enumerated code.
      expect(failure.code).toBe("closed")
      expect(failure.message).toBe(`Journal read failed for run ${busy}`)
      expect(failure.message).not.toContain("journal offline")
      expect(failure.cause).toContain("journal_closed")
      expect(failure.cause).not.toContain("journal offline")
    }))

  // A journal code with no counterpart here stays unclassified. Inventing a
  // sync code for a storage-layer distinction a follower cannot act on would
  // say more than is known.
  it.effect("keeps a journal code this boundary does not declare unclassified", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer([busy], {
            entries: () => Effect.fail(new Journal.JournalError({ code: "fence_lost", message: "fence lost" }))
          })
          return yield* Effect.flip(server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 }))
        })
      )

      expect(failure.code).toBe("unknown")
      expect(failure.cause).toContain("fence_lost")
    }))

  // Queue overflow and a payload the journal could not decode are the same
  // facts as this boundary's own backpressure and decode refusal.
  it.effect("states an overflowing journal queue as backpressure and a decode fault as decode_failed", () =>
    Effect.gen(function*() {
      const codes = yield* (
        Effect.gen(function*() {
          const overflow = yield* Effect.flip(
            (yield* makeServer([busy], {
              entries: () => Effect.fail(new Journal.JournalError({ code: "queue_overflow", message: "full" }))
            })).read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 })
          )
          const decode = yield* Effect.flip(
            (yield* makeServer([busy], {
              entries: () => Effect.fail(new Journal.JournalError({ code: "decode_failed", message: "bad row" }))
            })).read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 })
          )
          return [overflow.code, decode.code]
        })
      )

      expect(codes).toEqual(["backpressure", "decode_failed"])
    }))

  // Compaction is a recoverable refusal with a documented resume point, not an
  // unclassified fault. Folding it into `unknown` threw away the checkpoint and
  // with it any way for the follower to resync.
  it.effect("surfaces a compacted journal read as a typed resync target", () =>
    Effect.gen(function*() {
      const cause = new Journal.JournalError({
        code: "compacted",
        message: "run busy-run is compacted through sequence 12; resync from its checkpoint",
        checkpointSeq: seq(12)
      })
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer([busy], { entries: () => Effect.fail(cause) })
          return yield* Effect.flip(server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 }))
        })
      )

      expect(failure.code).toBe("compacted")
      expect(failure.resync).toEqual({ runId: busy, checkpointSeq: 12, generation: 0 })
      // The resume point is the payload; the cause names the journal code and
      // not the message the journal wrote around it.
      expect(failure.cause).toContain(cause.code)
      expect(failure.cause).not.toContain("resync from its checkpoint")

      // A floor the journal reports while the generation is still unread
      // names no generation rather than guessing one.
      const unfenced = yield* Effect.flip(Effect.flatMap(
        makeServer([busy], { generation: () => Effect.fail(cause) }),
        (server) => server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 })
      ))
      expect(unfenced.resync).toEqual({ runId: busy, checkpointSeq: 12 })
    }))

  // A compacted error the journal raised without a floor carries no resume
  // point, so it stays an unclassified failure rather than pretending to one.
  it.effect("keeps a compacted journal error without a checkpoint unclassified", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer([busy], {
            entries: () => Effect.fail(new Journal.JournalError({ code: "compacted", message: "no floor recorded" }))
          })
          return yield* Effect.flip(server.read({ protocolVersion: 1, scope: workspace, cursors: [], limit: 10 }))
        })
      )

      expect(failure.code).toBe("unknown")
      expect(failure.resync).toBeUndefined()
    }))
})

describe("SyncServer.subscribe over a workspace scope", () => {
  it.effect("interleaves catalog runs and stops at the credit limit", () =>
    Effect.gen(function*() {
      const frames = yield* (
        Effect.gen(function*() {
          // A workspace subscription serves its runs through the paged
          // `entries` read, not through a per-run follow stream.
          const server = yield* makeServer([busy, empty], {
            entries: ({ after, runId: id }) =>
              Effect.succeed({
                entries: [entry(id, 0), entry(id, 1)].filter((value) => after === undefined || value.seq > after),
                hasMore: false
              })
          })
          return yield* Stream.runCollect(
            server.subscribe({ protocolVersion: 1, scope: workspace, cursors: [], credit: 3 })
          )
        })
      )

      expect(frames.length).toBe(3)
      expect(new Set(frames.map((frame) => (frame as { runId: string }).runId))).toEqual(
        new Set([busy, empty])
      )
    }))
})

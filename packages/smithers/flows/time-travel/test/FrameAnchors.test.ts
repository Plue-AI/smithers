/**
 * The derived half of a frame: anchors, state, and attempts.
 *
 * `docs/concepts/derived-state.md` makes frame state DERIVED — the only
 * things stored per frame are the jj pointer and the plan digest, and both
 * arrive through a projection of the engine's own records rather than an engine
 * write. These cases pin the fold, its carried-pointer resolution, and the
 * store contract both implementations answer.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SnapshotProjector from "../src/internal/SnapshotProjector.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const lineageId = "run/root"

interface Fixture {
  readonly seq: number
  readonly eventType: string
  readonly payload: unknown
  readonly lineageId?: string | undefined
}

/** A journal double that pages exactly like the SQL one, with no live tail. */
const pagingJournal = (fixtures: ReadonlyArray<Fixture>, pageSize: number) =>
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({
      entries: (options) => {
        const after = options.after
        const remaining = fixtures.filter((fixture) => after === undefined || fixture.seq > after)
        const page = remaining.slice(0, Math.min(options.limit, pageSize))
        return Effect.succeed({
          entries: page.map((fixture) => ({
            runId: "run" as JournalEvent.RunId,
            seq: fixture.seq as JournalEvent.Seq,
            eventId: `e${fixture.seq}`,
            sourceId: "test" as JournalEvent.SourceId,
            sourceSeq: fixture.seq as JournalEvent.SourceSeq,
            emittedAtMs: 0,
            eventType: fixture.eventType,
            payload: fixture.payload,
            meta: "lineageId" in fixture && fixture.lineageId === undefined
              ? {}
              : { lineageId: fixture.lineageId ?? lineageId }
          })) as unknown as ReadonlyArray<JournalEvent.Entry>,
          hasMore: remaining.length > page.length
        })
      }
    })
  )

const projectInto = (
  fixtures: ReadonlyArray<Fixture>,
  options: { readonly pageSize?: number } = {}
) => {
  const store = MemoryTimeTravelStore.make()
  return SnapshotProjector.project("run", { pageSize: 2 }).pipe(
    Effect.provide(pagingJournal(fixtures, options.pageSize ?? 2)),
    Effect.provideService(TimeTravelStore.TimeTravelStore, store),
    Effect.map((state) => ({ state, snapshots: store.state().snapshots }))
  )
}

describe("the snapshot projector", () => {
  it.effect("offers the same anchor fold through the journal projection interface", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const projection = SnapshotProjector.projection(store)
      const entry = (seq: number, eventType: string, payload: unknown): JournalEvent.Entry =>
        ({
          runId: "run" as JournalEvent.RunId,
          seq: seq as JournalEvent.Seq,
          eventId: `projection:${seq}`,
          sourceId: "test" as JournalEvent.SourceId,
          sourceSeq: seq as JournalEvent.SourceSeq,
          emittedAtMs: 0,
          eventType,
          payload,
          meta: { lineageId }
        }) as JournalEvent.Entry
      const planned = yield* projection.reduce(
        projection.initial,
        entry(0, "flows.engine.plan-recorded", { digest: "plan" })
      )
      expect(store.state().snapshots).toEqual([])
      const anchored = yield* projection.reduce(
        planned,
        entry(1, "flows.engine.snapshot-identified", { snapshotId: "change" })
      )
      expect(anchored.anchors).toBe(1)
      expect(store.state().snapshots).toEqual([{
        runId: "run",
        frame: { lineageId, seq: 1 },
        changeId: "change",
        planDigest: "plan"
      }])
    }))

  it.effect("resumes at the greatest anchor regardless of listing order and ignores another run", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const anchors: ReadonlyArray<TimeTravelStore.Snapshot> = [
        { runId: "other", frame: { lineageId: "other/root", seq: 100 }, changeId: "foreign" },
        { runId: "run", frame: { lineageId: "latest", seq: 10 }, changeId: "latest" },
        { runId: "run", frame: { lineageId: "older", seq: 2 }, changeId: "older" },
        { runId: "run", frame: { lineageId: "middle", seq: 5 }, changeId: "middle" }
      ]
      const reads: Array<number | undefined> = []
      const result = yield* SnapshotProjector.project("run").pipe(
        Effect.provideService(TimeTravelStore.TimeTravelStore, {
          ...store,
          latestSnapshots: () => Effect.succeed(anchors)
        }),
        Effect.provideService(
          Journal.Journal,
          Journal.makeNoop({
            entries: (request) => {
              reads.push(request.after)
              return Effect.succeed({ entries: [], hasMore: false })
            }
          })
        )
      )
      expect(reads).toEqual([undefined, 10])
      expect(Object.keys(result.lineages).sort()).toEqual(["latest", "middle", "older"])
      expect(result.anchors).toBe(0)
    }))

  it.effect("resolves a carried anchor to the last real pointer, and stamps the plan digest in force", () =>
    Effect.gen(function*() {
      const result = yield* projectInto([
        // No pointer yet: a carried anchor before any snapshot has nothing to
        // carry, and inventing one would be worse than recording none.
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } },
        { seq: 3, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 4, eventType: "flows.engine.subgraph-appended", payload: { digest: "plan-b" } },
        { seq: 5, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        // Records the fold has no business in.
        { seq: 6, eventType: "flows.engine.attempt-finished", payload: {} }
      ])

      expect(result.state).toEqual({
        lineages: { [lineageId]: { changeId: "change-1", planDigest: "plan-b" } },
        anchors: 3
      })
      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-1", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId, seq: 3 }, changeId: "change-1", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId, seq: 5 }, changeId: "change-1", planDigest: "plan-b" }
      ])
    }))

  it.effect("carries the jj operation with its pointer, and a new pointer replaces both", () =>
    Effect.gen(function*() {
      const result = yield* projectInto([
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "c1", operationId: "op1" } },
        { seq: 1, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "c2" } },
        { seq: 3, eventType: "flows.engine.snapshot-identified", payload: { carried: true } }
      ])

      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 0 }, changeId: "c1", operationId: "op1" },
        { runId: "run", frame: { lineageId, seq: 1 }, changeId: "c1", operationId: "op1" },
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "c2" },
        { runId: "run", frame: { lineageId, seq: 3 }, changeId: "c2" }
      ])
    }))

  it.effect("resumes a lineage's operation from its stored anchor, so a carried record keeps it", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      yield* store.recordSnapshot({ runId: "run", frame: { lineageId, seq: 0 }, changeId: "c1", operationId: "op1" })
      const state = yield* SnapshotProjector.project("run", { pageSize: 2 }).pipe(
        Effect.provide(pagingJournal([
          { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "c1", operationId: "op1" } },
          { seq: 1, eventType: "flows.engine.snapshot-identified", payload: { carried: true } }
        ], 2)),
        Effect.provideService(TimeTravelStore.TimeTravelStore, store)
      )
      expect(state.lineages[lineageId]).toEqual({ changeId: "c1", operationId: "op1", planDigest: undefined })
      expect(yield* store.snapshotAt("run", { lineageId, seq: 1 })).toEqual({
        runId: "run",
        frame: { lineageId, seq: 1 },
        changeId: "c1",
        operationId: "op1"
      })
    }))

  it.effect("anchors a graph recorded with no digest, and keeps the digest a naming record put in force", () =>
    Effect.gen(function*() {
      // An interpreted flow records the graph it was driven from and has no
      // plan id and no digest to name. Refusing that record left the run with
      // no anchor at all, so a rewind to a real snapshot reported that the
      // frame had no jj pointer.
      const result = yield* projectInto([
        { seq: 0, eventType: "flows.engine.plan-recorded", payload: { flow: "build", generation: 0, nodes: 3 } },
        { seq: 1, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } },
        { seq: 2, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
        // A later record that names none puts none in force; it does not
        // clear the digest the naming record put there.
        { seq: 3, eventType: "flows.engine.subgraph-appended", payload: { generation: 1, nodeIds: ["a"] } },
        { seq: 4, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-2" } }
      ])

      expect(result.state).toEqual({
        lineages: { [lineageId]: { changeId: "change-2", planDigest: "plan-a" } },
        anchors: 2
      })
      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 1 }, changeId: "change-1" },
        { runId: "run", frame: { lineageId, seq: 4 }, changeId: "change-2", planDigest: "plan-a" }
      ])
    }))

  it.effect("ignores unrelated events but fails closed on malformed known events", () =>
    Effect.gen(function*() {
      const unrelated = yield* projectInto([
        { seq: 0, eventType: "another.package.event", payload: { digest: 42 } }
      ])
      expect(unrelated.state).toEqual({ lineages: {}, anchors: 0 })

      const malformed = [
        [{ seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "x" }, lineageId: undefined }],
        // A plan digest is lineage-scoped, so a plan record with no lineage
        // is corrupt evidence exactly as a snapshot record with none is.
        [{ seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: "x" }, lineageId: undefined }],
        [{ seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: 42 } }],
        [{ seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: 7 } }],
        [{ seq: 0, eventType: "flows.engine.plan-recorded", payload: { version: 2, digest: "future" } }]
      ] satisfies ReadonlyArray<ReadonlyArray<Fixture>>
      const failures = yield* Effect.forEach(malformed, (fixtures) => Effect.flip(projectInto(fixtures)))
      expect(failures.map((failure) => (failure as { readonly code: string }).code)).toEqual([
        "invalid",
        "invalid",
        "invalid",
        "invalid",
        "invalid"
      ])
      expect((failures[1] as { readonly message: string }).message).toBe(
        "plan event e0 has corrupt lineage metadata"
      )
    }))

  it.effect("resolves a carried anchor from its own lineage when lineages interleave across pages", () =>
    Effect.gen(function*() {
      // One run, two lineages, two records per page. Lineage B's first carried
      // record arrives before B has named any pointer, and every later carried
      // record on either lineage must resolve to THAT lineage's last explicit
      // snapshot. The fold used to keep one run-wide pointer, so B@1 recorded
      // A's change and A@4 recorded B's.
      const result = yield* projectInto([
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-a" } },
        { seq: 1, eventType: "flows.engine.snapshot-identified", payload: { carried: true }, lineageId: "run/b" },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        {
          seq: 3,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-b" },
          lineageId: "run/b"
        },
        { seq: 4, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 5, eventType: "flows.engine.snapshot-identified", payload: { carried: true }, lineageId: "run/b" }
      ], { pageSize: 2 })

      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 0 }, changeId: "change-a" },
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 3 }, changeId: "change-b" },
        { runId: "run", frame: { lineageId, seq: 4 }, changeId: "change-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 5 }, changeId: "change-b" }
      ])
      expect(result.state).toEqual({
        lineages: {
          [lineageId]: { changeId: "change-a", planDigest: undefined },
          "run/b": { changeId: "change-b", planDigest: undefined }
        },
        anchors: 5
      })
    }))

  it.effect("keeps the plan digest in force per lineage", () =>
    Effect.gen(function*() {
      const result = yield* projectInto([
        { seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
        { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-b" }, lineageId: "run/b" },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-a" } },
        {
          seq: 3,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-b" },
          lineageId: "run/b"
        },
        // A lineage that recorded no plan anchors without a digest, whatever
        // the other lineages put in force.
        {
          seq: 4,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-c" },
          lineageId: "run/c"
        }
      ])

      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-a", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 3 }, changeId: "change-b", planDigest: "plan-b" },
        { runId: "run", frame: { lineageId: "run/c", seq: 4 }, changeId: "change-c" }
      ])
    }))

  it.effect("is idempotent: the same journal folded twice leaves one anchor per frame", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const fixtures: ReadonlyArray<Fixture> = [
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } }
      ]
      yield* (
        SnapshotProjector.project("run").pipe(
          Effect.andThen(SnapshotProjector.project("run")),
          Effect.provide(pagingJournal(fixtures, 10)),
          Effect.provideService(TimeTravelStore.TimeTravelStore, store)
        )
      )

      expect(store.state().snapshots).toHaveLength(1)
    }))

  /** A journal double that pages like the SQL one and records what was asked of it. */
  const countingJournal = (fixtures: ReadonlyArray<Fixture>, pageSize: number) => {
    const reads: Array<{ readonly after: number | undefined; readonly eventTypes: boolean }> = []
    const layer = Layer.succeed(
      Journal.Journal,
      Journal.makeNoop({
        entries: (options) => {
          reads.push({ after: options.after, eventTypes: options.eventTypes !== undefined })
          const after = options.after
          const remaining = fixtures.filter((fixture) =>
            (after === undefined || fixture.seq > after) &&
            (options.eventTypes === undefined || options.eventTypes.includes(fixture.eventType))
          )
          const page = remaining.slice(0, Math.min(options.limit, pageSize))
          return Effect.succeed({
            entries: page.map((fixture) => ({
              runId: "run" as JournalEvent.RunId,
              seq: fixture.seq as JournalEvent.Seq,
              eventId: `e${fixture.seq}`,
              sourceId: "test" as JournalEvent.SourceId,
              sourceSeq: fixture.seq as JournalEvent.SourceSeq,
              emittedAtMs: 0,
              eventType: fixture.eventType,
              payload: fixture.payload,
              meta: { lineageId: fixture.lineageId ?? lineageId }
            })) as unknown as ReadonlyArray<JournalEvent.Entry>,
            hasMore: remaining.length > page.length
          })
        }
      })
    )
    return { layer, reads }
  }

  /** Counts the anchors a store is asked to write, by either write. */
  const countingStore = () => {
    const store = MemoryTimeTravelStore.make()
    let writes = 0
    const counting = TimeTravelStore.make({
      ...store,
      recordSnapshot: (snapshot) =>
        store.recordSnapshot(snapshot).pipe(Effect.tap(() => Effect.sync(() => void writes++))),
      recordSnapshots: (batch) =>
        store.recordSnapshots(batch).pipe(Effect.tap(() => Effect.sync(() => void (writes += batch.length))))
    })
    return { store, counting, writes: () => writes }
  }

  const snapshotAt = (seq: number, lineage?: string): Fixture => ({
    seq,
    eventType: "flows.engine.snapshot-identified",
    payload: seq === 0 ? { snapshotId: "change-0" } : { carried: true },
    ...(lineage === undefined ? {} : { lineageId: lineage })
  })

  it.effect("resumes from the recorded anchors: a second fold of an unchanged run writes nothing and re-reads nothing", () =>
    Effect.gen(function*() {
      const fixtures = Array.from({ length: 7 }, (_, seq) => snapshotAt(seq))
      const journal = countingJournal(fixtures, 3)
      const { counting, store, writes } = countingStore()
      const run = (options: SnapshotProjector.ProjectOptions = {}) =>
        SnapshotProjector.project("run", { pageSize: 3, ...options }).pipe(
          Effect.provide(journal.layer),
          Effect.provideService(TimeTravelStore.TimeTravelStore, counting)
        )

      const first = yield* run()
      expect(first.anchors).toBe(7)
      expect(writes()).toBe(7)
      expect(store.state().snapshots).toHaveLength(7)

      journal.reads.length = 0
      const second = yield* run()
      expect(second.anchors).toBe(0)
      expect(second.lineages).toEqual({ [lineageId]: { changeId: "change-0", planDigest: undefined } })
      expect(writes()).toBe(7)
      // One page for the plan records at or below the mark, one page after it.
      expect(journal.reads).toEqual([{ after: undefined, eventTypes: true }, { after: 6, eventTypes: false }])
      expect(store.state().snapshots).toHaveLength(7)

      // A third fold sees the appended entry and only that entry.
      fixtures.push(snapshotAt(7))
      journal.reads.length = 0
      const third = yield* run()
      expect(third.anchors).toBe(1)
      expect(writes()).toBe(8)
      expect(journal.reads.filter((read) => !read.eventTypes)).toEqual([{ after: 6, eventTypes: false }])
      expect(store.state().snapshots.at(-1)).toEqual({
        runId: "run",
        frame: { lineageId, seq: 7 },
        changeId: "change-0"
      })
    }))

  it.effect("writes each page's anchors as one batch", () =>
    Effect.gen(function*() {
      const fixtures = Array.from({ length: 5 }, (_, seq) => snapshotAt(seq))
      const store = MemoryTimeTravelStore.make()
      const batches: Array<number> = []
      const counting = TimeTravelStore.make({
        ...store,
        recordSnapshot: () => Effect.die("the driver must batch, never write one anchor at a time"),
        recordSnapshots: (batch) =>
          store.recordSnapshots(batch).pipe(Effect.tap(() => Effect.sync(() => void batches.push(batch.length))))
      })
      yield* (
        SnapshotProjector.project("run", { pageSize: 2 }).pipe(
          Effect.provide(countingJournal(fixtures, 2).layer),
          Effect.provideService(TimeTravelStore.TimeTravelStore, counting)
        )
      )
      expect(batches).toEqual([2, 2, 1])
      expect(store.state().snapshots).toHaveLength(5)
    }))

  it.effect("resuming keeps a plan recorded below the mark on a lineage that had not anchored yet", () =>
    Effect.gen(function*() {
      const fixtures: Array<Fixture> = [
        { seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
        { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-b" }, lineageId: "run/b" },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-a" } },
        // The root lineage's plan changes after its last anchor: no anchor holds plan-a2.
        { seq: 3, eventType: "flows.engine.subgraph-appended", payload: { digest: "plan-a2" } }
      ]
      const journal = countingJournal(fixtures, 10)
      const store = MemoryTimeTravelStore.make()
      const run = () =>
        SnapshotProjector.project("run").pipe(
          Effect.provide(journal.layer),
          Effect.provideService(TimeTravelStore.TimeTravelStore, store)
        )
      yield* run()
      // Both plan records sit below the anchored high-water mark, one on a lineage with no anchor.
      fixtures.push(
        {
          seq: 4,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-b" },
          lineageId: "run/b"
        },
        { seq: 5, eventType: "flows.engine.snapshot-identified", payload: { carried: true } }
      )
      const resumed = yield* run()

      expect(resumed.lineages).toEqual({
        [lineageId]: { changeId: "change-a", planDigest: "plan-a2" },
        "run/b": { changeId: "change-b", planDigest: "plan-b" }
      })
      expect(store.state().snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-a", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 4 }, changeId: "change-b", planDigest: "plan-b" },
        { runId: "run", frame: { lineageId, seq: 5 }, changeId: "change-a", planDigest: "plan-a2" }
      ])
    }))

  it.effect("stops at the verb's frame and honours the history cap on what it has left to read", () =>
    Effect.gen(function*() {
      const fixtures = Array.from({ length: 10 }, (_, seq) => snapshotAt(seq))
      const journal = countingJournal(fixtures, 4)
      const store = MemoryTimeTravelStore.make()
      const run = (options: SnapshotProjector.ProjectOptions) =>
        SnapshotProjector.project("run", { pageSize: 4, ...options }).pipe(
          Effect.provide(journal.layer),
          Effect.provideService(TimeTravelStore.TimeTravelStore, store)
        )

      const bounded = yield* run({ upTo: 5 })
      expect(bounded.anchors).toBe(6)
      expect(store.state().snapshots.map((snapshot) => snapshot.frame.seq)).toEqual([0, 1, 2, 3, 4, 5])
      // Two pages reach seq 5; the third page is never asked for.
      expect(journal.reads.filter((read) => !read.eventTypes)).toEqual([{ after: undefined, eventTypes: false }, {
        after: 3,
        eventTypes: false
      }])

      // Anchored through the frame already: nothing to read past the plan records.
      journal.reads.length = 0
      const current = yield* run({ upTo: 3 })
      expect(current.anchors).toBe(0)
      expect(journal.reads.filter((read) => !read.eventTypes)).toEqual([])

      // The cap counts only the entries above the mark.
      const capped = yield* Effect.flip(run({ maxEntries: 3 }))
      expect(capped).toMatchObject({
        code: "limit_exceeded",
        message: "anchor refresh of run would read more than 3 journal entries; raise maxHistoryEntries to allow it"
      })
      expect(store.state().snapshots).toHaveLength(6)
      const rest = yield* run({ maxEntries: 4 })
      expect(rest.anchors).toBe(4)
      expect(store.state().snapshots).toHaveLength(10)
    }))
})

describe("the memory store's derived reads", () => {
  const store = MemoryTimeTravelStore.make({
    records: [
      {
        runId: "run",
        seq: 0,
        eventId: "e0",
        lineageId,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "created",
          state: { version: 1, flowName: "Demo", payload: { seed: 1 } }
        }
      },
      {
        runId: "run",
        seq: 1,
        eventId: "e1",
        lineageId,
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "a",
          attempt: 1
        }
      },
      // A decision that carries no state leaves the fold where it was.
      {
        runId: "run",
        seq: 2,
        eventId: "e2",
        lineageId,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "claim-lost"
        }
      },
      // Not an attempt record shape, and a record of another lineage.
      { runId: "run", seq: 3, eventId: "e3", lineageId, eventType: "flows.engine.attempt-started", payload: {} },
      {
        runId: "run",
        seq: 4,
        eventId: "e4",
        lineageId: "run/other",
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "b",
          attempt: 1
        }
      },
      {
        runId: "run",
        seq: 5,
        eventId: "e5",
        lineageId,
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "b",
          attempt: 1
        }
      }
    ]
  })

  it.effect("rebuilds state at a frame from the decisions up to it", () =>
    Effect.gen(function*() {
      expect(yield* (store.stateAt("run", { lineageId, seq: 4 }))).toBe(
        JSON.stringify({ version: 1, flowName: "Demo", payload: { seed: 1 } })
      )
      // Before the `created` decision there is nothing to rebuild.
      expect(yield* (store.stateAt("run", { lineageId, seq: 0 }))).toBeDefined()
      expect(yield* (store.stateAt("other", { lineageId, seq: 9 }))).toBeUndefined()
    }))

  it.effect("collects the attempts admitted at a frame, deduplicated and lineage-filtered", () =>
    Effect.gen(function*() {
      const valid = MemoryTimeTravelStore.make({
        records: store.state().records.filter((record) => record.eventId !== "e3").concat({
          runId: "run",
          seq: 2,
          eventId: "duplicate",
          lineageId,
          eventType: "flows.engine.attempt-started",
          payload: { stepKeyDigest: "a", attempt: 1 }
        })
      })
      expect(yield* valid.attemptsAt("run", { lineageId, seq: 4 })).toEqual([
        { stepKeyDigest: "a", attempt: 1 }
      ])
      expect(yield* valid.attemptsAt("run", { lineageId, seq: 5 })).toEqual([
        { stepKeyDigest: "a", attempt: 1 },
        { stepKeyDigest: "b", attempt: 1 }
      ])
      expect(yield* (store.attemptsAt("run", { lineageId, seq: 1 }))).toEqual([
        { stepKeyDigest: "a", attempt: 1 }
      ])
      expect((yield* Effect.flip(store.attemptsAt("run", { lineageId, seq: 4 }))).code).toBe("invalid")
      expect((yield* Effect.flip(store.attemptsAt("run", { lineageId, seq: 5 }))).code).toBe("invalid")
    }))

  it.effect("upserts an anchor and rolls the write back on an injected failure", () =>
    Effect.gen(function*() {
      const writable = MemoryTimeTravelStore.make()
      const anchor: TimeTravelStore.Snapshot = { runId: "run", frame: { lineageId, seq: 1 }, changeId: "c1" }
      yield* (writable.recordSnapshot(anchor))
      yield* (writable.recordSnapshot({ ...anchor, changeId: "c2" }))
      expect(writable.state().snapshots).toEqual([{ ...anchor, changeId: "c2" }])

      const failing = MemoryTimeTravelStore.make({ failAt: "recordSnapshot" })
      const failure = yield* (Effect.flip(failing.recordSnapshot(anchor)))
      expect(failure).toMatchObject({ code: "unknown" })
      expect(failing.state().snapshots).toEqual([])
    }))
})

describe("the store facade", () => {
  it.effect("reports every derived read as unavailable until an implementation supplies it", () =>
    Effect.gen(function*() {
      const noop = TimeTravelStore.makeNoop()
      const failures = yield* (
        Effect.all([
          Effect.flip(noop.recordSnapshot({ runId: "run", frame: { lineageId, seq: 0 }, changeId: "c" })),
          Effect.flip(noop.stateAt("run", { lineageId, seq: 0 })),
          Effect.flip(noop.attemptsAt("run", { lineageId, seq: 0 }))
        ])
      )
      expect(failures.map((failure) => failure.message)).toEqual([
        "recordSnapshot is unavailable",
        "stateAt is unavailable",
        "attemptsAt is unavailable"
      ])
    }))
})

describe("the projector's read failures", () => {
  it.effect("fails a repeated continuation page instead of spinning", () =>
    Effect.gen(function*() {
      const repeated = {
        runId: "run" as JournalEvent.RunId,
        seq: 0 as JournalEvent.Seq,
        eventId: "repeated",
        sourceId: "test" as JournalEvent.SourceId,
        sourceSeq: 0 as JournalEvent.SourceSeq,
        emittedAtMs: 0,
        eventType: "unrelated",
        payload: {},
        meta: { lineageId }
      }
      const failure = yield* Effect.flip(
        SnapshotProjector.project("run").pipe(
          Effect.provide(Layer.succeed(
            Journal.Journal,
            Journal.makeNoop({ entries: () => Effect.succeed({ entries: [repeated], hasMore: true }) })
          )),
          Effect.provideService(TimeTravelStore.TimeTravelStore, MemoryTimeTravelStore.make())
        )
      )

      expect(failure).toMatchObject({ code: "invalid", message: "snapshot pagination did not advance for run" })
    }))

  it.effect("surfaces a journal it cannot page as a typed failure", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(SnapshotProjector.project("run")).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop())),
          Effect.provideService(TimeTravelStore.TimeTravelStore, MemoryTimeTravelStore.make())
        )
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not read run for anchoring" })
    }))
})

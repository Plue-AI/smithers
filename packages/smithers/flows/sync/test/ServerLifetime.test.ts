/**
 * What bounds a subscription in TIME and in the run set it covers: the signed
 * expiry of the credential that opened it, and the catalog it reconciles
 * against on every round.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Clock, Deferred, Effect, Fiber, Layer, PubSub, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as BranchProtocol from "../src/BranchProtocol.ts"
import * as BranchShare from "../src/BranchShare.ts"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"
import { entry } from "./fixtures/entry.ts"

const branchId = "lifetime-branch" as BranchProtocol.BranchId
const branchRun = BranchProtocol.branchRunId(branchId)
const seq = (value: number) => value as JournalEvent.Seq

const shareLayer = BranchShare.layerHmac({
  activeKid: "primary",
  keys: [{ kid: "primary", secret: Redacted.make("lifetime-secret-0123456789abcdef") }]
})

describe("subscription lifetime", () => {
  // A signed expiry is this package's only revocation mechanism, and a
  // subscription is authorized ONCE, at open. Without a deadline on the
  // stream, the holder of an expired share link kept reading for as long as
  // it declined to disconnect, and a quiet stream never re-authorized at all.
  it.effect("ends a branch subscription with unauthorized when its capability expires", () =>
    Effect.gen(function*() {
      // Opening the subscription verifies the capability through Web Crypto,
      // which is asynchronous. Advancing the clock before that resolves would
      // test the OPENING refusal instead of the expiry of an open stream, so
      // the journal stream reports when it is attached and the clock does not
      // move until then.
      const attached = yield* Deferred.make<void>()
      const failure = yield* (
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({
            access: "read",
            branchId,
            capabilityId: "lifetime-cap",
            ttlMs: 1_000
          })
          const server = yield* SyncServer.makeLive
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                server.subscribe({
                  protocolVersion: 1,
                  capability,
                  credit: 4096,
                  cursors: [],
                  scope: { _tag: "Run", runId: branchRun }
                })
              )
            ),
            { startImmediately: true }
          )
          yield* Deferred.await(attached)
          // The stream is quiet: nothing arrives, nothing is acknowledged, and
          // the only thing that can end it is the expiry.
          yield* TestClock.adjust("2 seconds")
          return yield* Fiber.join(following)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                stream: () => Stream.onStart(Stream.never, Deferred.succeed(attached, undefined))
              }),
              RunCatalog.layerStatic([branchRun]),
              shareLayer
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect(SyncError.is(failure)).toBe(true)
      expect(failure.code).toBe("unauthorized")
      expect(failure.message).toContain("expired")
    }))

  // An in-process owner presented no credential, so nothing can expire under
  // it and the stream must not acquire a deadline it never agreed to.
  it.effect("never expires a subscription opened by an in-process owner", () =>
    Effect.gen(function*() {
      const engineRun = "lifetime-engine" as JournalEvent.RunId
      const frames = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const collected = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.take(
                server.subscribe({
                  protocolVersion: 1,
                  credit: 4096,
                  cursors: [],
                  scope: { _tag: "Run", runId: engineRun }
                }),
                1
              )
            ),
            { startImmediately: true }
          )
          yield* TestClock.adjust("10 minutes")
          return yield* Fiber.join(collected)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({ stream: () => Stream.succeed(entry(engineRun, 0)) }),
              RunCatalog.layerStatic([engineRun]),
              SyncPrincipal.layerWorkspace("in-process-owner")
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect(Array.from(frames)).toHaveLength(1)
    }))

  // The header's expiry travels with the identity, so a workspace-scoped
  // subscription is bounded by the credential that authenticated it.
  it.effect("ends a workspace subscription when the workspace principal's credential expires", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } })
              )
            ),
            { startImmediately: true }
          )
          yield* TestClock.adjust("2 seconds")
          return yield* Fiber.join(following)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) }),
              RunCatalog.layerStatic([]),
              Layer.succeed(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("expiring", 1_000))
            )
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect((failure as SyncError).code).toBe("unauthorized")
    }))

  // A workspace subscription discovers runs AFTER it opens: reconciliation
  // admits a branch the catalog names later, under a capability whose expiry
  // was not part of the deadline the subscription opened with. Reducing that
  // admission to a yes threw the expiry away, so a branch found this way
  // streamed for as long as the subscription lived: the exact revocation hole
  // the deadline exists to close, reached by the one door still open.
  it.live("ends a subscription when a branch admitted after it opened expires", () =>
    Effect.gen(function*() {
      const listed = new Set<JournalEvent.RunId>()
      const served: Array<string> = []
      const outcome = yield* (
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({
            access: "read",
            branchId,
            capabilityId: "late-cap",
            ttlMs: 2_000
          })
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 25 })
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                Stream.tap(
                  server.subscribe({
                    protocolVersion: 1,
                    capability,
                    credit: 4096,
                    cursors: [],
                    scope: { _tag: "Workspace" }
                  }),
                  (frame) =>
                    Effect.sync(() => {
                      if (frame._tag === "Entries") {
                        for (const value of frame.entries) served.push(`${value.runId}:${value.seq}`)
                      }
                    })
                )
              )
            ),
            { startImmediately: true }
          )
          // The branch appears while the subscription is live and inside its
          // capability's window, so reconciliation is what admits it and the
          // next round serves it.
          listed.add(branchRun)
          yield* Effect.sleep("500 millis")
          const inWindow = [...served]
          // Now past the capability's own expiry.
          return [inWindow, yield* Fiber.join(following)] as const
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId, after }) =>
                  Effect.succeed({ entries: after === undefined ? [entry(runId, 0)] : [], hasMore: false })
              }),
              Layer.succeed(
                RunCatalog.RunCatalog,
                RunCatalog.RunCatalog.of({ changes: Stream.empty, list: Effect.sync(() => Array.from(listed)) })
              ),
              shareLayer,
              SyncPrincipal.layerWorkspace("late-branch-owner")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(outcome._tag).toBe("Some")
      const [inWindow, failure] = outcome._tag === "Some" ? outcome.value : [[], undefined]
      // The branch WAS served inside its window, so the case is about expiry
      // and not about the run never becoming visible.
      expect(inWindow).toContain(`${branchRun}:0`)
      expect(failure !== undefined && SyncError.is(failure)).toBe(true)
      expect((failure as SyncError).code).toBe("unauthorized")
      expect((failure as SyncError).message).toContain("expired")
    }))

  // Reconciliation lowers the deadline when it admits a branch, but the
  // interrupt armed at open knew only the opening expiry, and the lowered
  // deadline was checked at the START of the next round. A page read that
  // spanned the branch's expiry therefore returned and was served after the
  // capability had lapsed, by as much as the read took; a read that never
  // returned kept the subscription open for good. The interrupt now re-arms
  // whenever the deadline moves, so it ends the stream at the branch's expiry
  // whatever the round is doing.
  it.live("emits nothing from a late-admitted branch once its capability expires mid-read", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const served: Array<string> = []
      let lists = 0
      const outcome = yield* (
        Effect.gen(function*() {
          const share = yield* BranchShare.BranchShare
          const capability = yield* share.mint({
            access: "read",
            branchId,
            capabilityId: "mid-read-cap",
            ttlMs: 400
          })
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 10 })
          const following = yield* Effect.forkChild(
            Effect.flip(
              Stream.runDrain(
                Stream.tap(
                  server.subscribe({
                    protocolVersion: 1,
                    capability,
                    credit: 4096,
                    cursors: [],
                    scope: { _tag: "Workspace" }
                  }),
                  (frame) => Effect.sync(() => served.push(frame._tag))
                )
              )
            ),
            { startImmediately: true }
          )
          // The branch's first page is being read when its capability
          // expires; the read returns only afterwards.
          yield* Deferred.await(entered)
          yield* Effect.sleep(`${capability.claims.expiresAtMs - (yield* Clock.currentTimeMillis) + 100} millis`)
          yield* Deferred.succeed(release, undefined)
          return yield* Fiber.join(following)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) =>
                  Effect.gen(function*() {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                    return { entries: [entry(runId, 0)], hasMore: false }
                  })
              }),
              Layer.succeed(
                RunCatalog.RunCatalog,
                // Empty at open, so the branch is admitted by reconciliation
                // and its expiry is one the opening interrupt never saw.
                RunCatalog.RunCatalog.of({
                  changes: Stream.empty,
                  list: Effect.sync(() => ++lists === 1 ? [] : [branchRun])
                })
              ),
              shareLayer,
              SyncPrincipal.layerWorkspace("mid-read-owner")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(outcome._tag).toBe("Some")
      const failure = outcome._tag === "Some" ? outcome.value : undefined
      expect(lists).toBeGreaterThan(1)
      expect(failure !== undefined && SyncError.is(failure)).toBe(true)
      expect((failure as SyncError).code).toBe("unauthorized")
      expect(served).toEqual([])
    }))
})

describe("workspace tail catalog reconciliation", () => {
  /** A catalog whose run set the test moves under a live subscription. */
  const mutable = (initial: ReadonlyArray<JournalEvent.RunId>) => {
    const listed = new Set(initial)
    return {
      catalog: RunCatalog.RunCatalog.of({
        // `changes` is deliberately empty: the reconciliation must not depend
        // on a notification arriving, because both shipped catalogs publish
        // through a SLIDING feed that drops the oldest under load.
        changes: Stream.empty,
        list: Effect.sync(() => Array.from(listed))
      }),
      listed
    }
  }

  const runs = (count: number) =>
    Array.from({ length: count }, (_, index) => `reconcile-${index}` as JournalEvent.RunId)

  it.live("serves a run the catalog gains while the subscription is live, with no announcement", () =>
    Effect.gen(function*() {
      const [first, second] = runs(2)
      const { catalog, listed } = mutable([first!])
      const served = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 50 })
          const collected = yield* Effect.forkChild(
            Stream.runCollect(
              Stream.take(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } }),
                2
              )
            ),
            { startImmediately: true }
          )
          listed.add(second!)
          return yield* Fiber.join(collected)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) => Effect.succeed({ entries: [entry(runId, 0)], hasMore: false })
              }),
              Layer.succeed(RunCatalog.RunCatalog, catalog),
              SyncPrincipal.layerWorkspace("reconcile-suite")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(served._tag).toBe("Some")
      const frames = served._tag === "Some" ? Array.from(served.value) : []
      const ids = frames.map((frame) => frame._tag === "Entries" ? frame.runId : "")
      expect(new Set(ids)).toEqual(new Set([first, second]))
    }))

  it.live("stops querying a run the catalog stops naming", () =>
    Effect.gen(function*() {
      const [kept, collected] = runs(2)
      // A branch run with no `BranchShare` in scope is closed to this request,
      // so it enters the round's excluded set. Retention must drop it from
      // there too, or the set grows for the life of the subscription.
      const closed = BranchProtocol.branchRunId("reconcile-branch" as BranchProtocol.BranchId)
      const { catalog, listed } = mutable([kept!, collected!, closed])
      const reads: Array<JournalEvent.RunId> = []
      const outcome = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 10 })
          const following = yield* Effect.forkChild(
            Stream.runDrain(
              server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } })
            ),
            { startImmediately: true }
          )
          yield* Effect.sleep("100 millis")
          // Retention collecting a run is exactly "the read stops naming it".
          listed.delete(collected!)
          listed.delete(closed)
          // Let any round already in flight finish before the window opens,
          // so this observes steady state rather than the removal's own tick.
          yield* Effect.sleep("100 millis")
          reads.length = 0
          yield* Effect.sleep("200 millis")
          yield* Fiber.interrupt(following)
          return [...reads]
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ runId }) =>
                  Effect.sync(() => {
                    reads.push(runId)
                    return { entries: [], hasMore: false }
                  })
              }),
              Layer.succeed(RunCatalog.RunCatalog, catalog),
              SyncPrincipal.layerWorkspace("reconcile-suite")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(outcome._tag).toBe("Some")
      const observed = outcome._tag === "Some" ? outcome.value : []
      // Rounds keep visiting the run that is still listed...
      expect(observed).toContain(kept)
      // ...and never the one the catalog stopped naming.
      expect(observed).not.toContain(collected)
      expect(observed).not.toContain(closed)
    }))

  // `tail` used to recurse on itself while the journal reported more, so a run
  // that stayed one page behind never released its `flatMap` slot: with the
  // bound saturated by such runs the round never completed and the runs behind
  // them were never attached at all.
  it.live("serves a cold run behind a run that is permanently a page behind", () =>
    Effect.gen(function*() {
      const hot = "reconcile-a-hot" as JournalEvent.RunId
      const cold = "reconcile-z-cold" as JournalEvent.RunId
      const hotStarted = yield* Deferred.make<void>()
      let hotReads = 0
      let coldReadAfterHot = false
      const served = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ concurrency: 1, tailIntervalMs: 10 })
          const following = yield* Stream.runCollect(
            Stream.take(
              Stream.filter(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } }),
                (frame) => frame._tag === "Entries" && frame.runId === cold
              ),
              1
            )
          ).pipe(Effect.forkChild)
          yield* Deferred.await(hotStarted)
          return yield* Fiber.join(following)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after, runId }) =>
                  runId === hot
                    // Always progressing, always more: the shape that pinned a
                    // slot forever.
                    ? Effect.gen(function*() {
                      hotReads++
                      yield* Deferred.succeed(hotStarted, undefined)
                      return { entries: [entry(hot, (after ?? -1) + 1)], hasMore: true }
                    })
                    : Effect.sync(() => {
                      coldReadAfterHot = hotReads > 0
                      return { entries: after === undefined ? [entry(cold, 0)] : [], hasMore: false }
                    })
              }),
              RunCatalog.layerStatic([hot, cold]),
              SyncPrincipal.layerWorkspace("reconcile-suite")
            )
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(served._tag).toBe("Some")
      expect(hotReads).toBeGreaterThan(0)
      expect(coldReadAfterHot).toBe(true)
      if (served._tag === "Some") {
        expect(Array.from(served.value)).toEqual([{
          _tag: "Entries",
          generation: 0,
          runId: cold,
          fromSeq: 0,
          toSeq: 0,
          entries: [entry(cold, 0)]
        }])
      }
    }))
})

describe("workspace tail local wakes", () => {
  // A local append published a void wake, and a wake ran the same round the
  // interval runs: re-list the catalog, then one page read and two
  // generation reads for EVERY covered run. Ten spaced appends to one run in
  // a thousand-run workspace cost ten thousand page reads per follower. The
  // wake now names its run, and the round it starts reads the dirty runs
  // only; the catalog-wide round is the interval's and an announcement's.
  it.live("reads only the run a local append named", () =>
    Effect.gen(function*() {
      const ids = Array.from({ length: 50 }, (_, index) => `local-${index}` as JournalEvent.RunId)
      const target = ids[0]!
      const reads: Array<JournalEvent.RunId> = []
      let generations = 0
      let head = -1
      const delivered: Array<string> = []
      const outcome = yield* (
        Effect.gen(function*() {
          const commits = yield* PubSub.sliding<JournalEvent.Entry>(16)
          const server = yield* SyncServer.makeLiveWith({ tailIntervalMs: 60_000 }).pipe(
            Effect.provideService(
              Journal.Journal,
              Journal.makeNoop({
                changes: PubSub.subscribe(commits),
                generation: () =>
                  Effect.sync(() => {
                    generations++
                    return { generation: 0, afterSeq: -1 as JournalEvent.Seq }
                  }),
                entries: ({ after, runId }) =>
                  Effect.sync(() => {
                    reads.push(runId)
                    const unserved = runId === target && head > (after ?? -1)
                    return { entries: unserved ? [entry(runId, head)] : [], hasMore: false }
                  })
              })
            )
          )
          yield* Effect.forkChild(
            Stream.runDrain(
              Stream.tap(
                server.subscribe({ protocolVersion: 1, credit: 4096, cursors: [], scope: { _tag: "Workspace" } }),
                (frame) =>
                  Effect.sync(() =>
                    delivered.push(frame._tag === "Entries" ? `${frame.runId}:${frame.toSeq}` : frame._tag)
                  )
              )
            ),
            { startImmediately: true }
          )
          // The opening round reads every covered run once.
          while (reads.length < ids.length) yield* Effect.sleep("10 millis")
          yield* Effect.sleep("20 millis")
          const opening = { reads: reads.length, generations }
          for (let sequence = 0; sequence < 3; sequence++) {
            head = sequence
            yield* PubSub.publish(commits, entry(target, sequence))
            while (delivered.length < sequence + 1) yield* Effect.sleep("10 millis")
            yield* Effect.sleep("20 millis")
          }
          return { extraReads: reads.slice(opening.reads), extraGenerations: generations - opening.generations }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(RunCatalog.layerStatic(ids), SyncPrincipal.layerWorkspace("local-wake-suite"))
          ),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(outcome._tag).toBe("Some")
      const { extraGenerations, extraReads } = outcome._tag === "Some"
        ? outcome.value
        : { extraGenerations: -1, extraReads: [] }
      expect(delivered).toEqual([`${target}:0`, `${target}:1`, `${target}:2`])
      // One page read per append, for the appended run alone.
      expect(extraReads).toEqual([target, target, target])
      expect(extraGenerations).toBe(6)
    }))
})

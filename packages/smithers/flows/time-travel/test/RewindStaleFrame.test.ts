/**
 * A rewind's validated frame against a peer rewind that recreates its tail.
 *
 * Validation runs before the ownership claim. A complete peer rewind in that
 * window truncates the history and the run re-appends up to the same seq on
 * the same lineage, so the tail the first rewind observed is back while the
 * frame it validated belongs to another lineage. These cases drive the public
 * `TimeTravel.rewind` over the production SQL journal, run store, and store.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import * as TimeTravel from "../src/TimeTravel.ts"

const runId = "stale-frame"
const root = `${runId}/root`
const sibling = `${runId}/sibling`
const writer: OwnerId = { hostId: "writer-host", pid: 77, nonce: "writer-nonce" }

/** Runs once, in place of the first claim, before the real claim proceeds. */
let interpose: Effect.Effect<void, unknown> | undefined

const interposedRuns = Layer.effect(
  RunStore.RunStore,
  Effect.gen(function*() {
    const real = yield* RunStore.RunStore
    return {
      ...real,
      claim: (...args: Parameters<RunStore.Service["claim"]>) => {
        const hook = interpose
        interpose = undefined
        return hook === undefined
          ? real.claim(...args)
          : hook.pipe(Effect.orDie, Effect.andThen(real.claim(...args)))
      }
    }
  })
).pipe(Layer.provide(RunStore.layer))

const services = () => {
  const migrated = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
  const persistence = Layer.mergeAll(
    SqlJournal.layer({ capacity: 64, overflow: "reject" }),
    interposedRuns,
    CacheStore.layer,
    SqlTimeTravelStore.layer,
    Layer.succeed(Jj.Jj, Jj.makeNoop({}))
  ).pipe(Layer.provideMerge(migrated))
  return TimeTravel.TimeTravel.layer.pipe(Layer.provideMerge(persistence))
}

/** Owns the idle run, appends fenced records on the given lineages, and parks it. */
const appendOwned = (lineages: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const journal = yield* Journal.Journal
    yield* sql`
      UPDATE flows_runs
      SET status = 'running', owner_host_id = ${writer.hostId}, owner_pid = ${writer.pid},
          owner_nonce = ${writer.nonce}, heartbeat_at_ms = 0
      WHERE run_id = ${runId}
    `
    for (const lineageId of lineages) {
      yield* journal.emitDurable(
        new JournalEvent.Input({
          runId: runId as JournalEvent.RunId,
          sourceId: "writer" as JournalEvent.SourceId,
          eventType: "test.stale-frame",
          payload: null,
          meta: { lineageId }
        }),
        writer
      )
    }
    yield* journal.flush
    yield* sql`
      UPDATE flows_runs
      SET status = 'suspended', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL
      WHERE run_id = ${runId}
    `
  })

const history = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 10 })
  return page.entries.map((entry) => `${entry.seq}/${(entry.meta as { readonly lineageId: string }).lineageId}`)
})

const completedAudits = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql<{ readonly seq: number }>`
    SELECT seq FROM flows_time_travel_audits WHERE run_id = ${runId} AND status = 'completed' ORDER BY seq
  `
})

const seed = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
    VALUES (${runId}, 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "StaleFrame", payload: {} })})
  `
  yield* appendOwned([root, root, root])
})

describe("TimeTravel.rewind after a peer rewind recreates the validated tail", () => {
  it.effect("refuses a frame the peer's replacement history no longer holds", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const timeTravel = yield* TimeTravel.TimeTravel
        yield* seed
        expect(yield* history).toEqual([`0/${root}`, `1/${root}`, `2/${root}`])

        // B completes a rewind to frame 0 and the run re-appends to the same
        // tail seq and lineage A's validation observed.
        interpose = Effect.gen(function*() {
          yield* timeTravel.rewind({ runId, frame: { lineageId: root, seq: 0 } })
          yield* appendOwned([sibling, root])
        }).pipe(Effect.provideContext(yield* Effect.context<Journal.Journal | SqlClient.SqlClient>()))

        const failure = yield* Effect.flip(timeTravel.rewind({ runId, frame: { lineageId: root, seq: 1 } }))

        expect(interpose).toBeUndefined()
        expect(failure).toMatchObject({
          code: "not_found",
          message: `no record of lineage ${root} exists at seq 1 in ${runId}`
        })
        // B's replacement history survives and only B's rewind completed.
        expect(yield* history).toEqual([`0/${root}`, `1/${sibling}`, `2/${root}`])
        expect(yield* completedAudits).toEqual([{ seq: 0 }])
        // A fresh request agrees with the refusal.
        const fresh = yield* Effect.flip(timeTravel.rewind({ runId, frame: { lineageId: root, seq: 1 } }))
        expect(fresh.code).toBe("not_found")
      }).pipe(Effect.provide(services()))
    ))

  it.effect("refuses as busy when the peer rewrote history the frame still addresses", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const timeTravel = yield* TimeTravel.TimeTravel
        yield* seed

        // B rewinds to frame 1 and the run re-appends seq 2 on the same
        // lineage: A's frame record and tail are both back, in a new history.
        interpose = Effect.gen(function*() {
          yield* timeTravel.rewind({ runId, frame: { lineageId: root, seq: 1 } })
          yield* appendOwned([root])
        }).pipe(Effect.provideContext(yield* Effect.context<Journal.Journal | SqlClient.SqlClient>()))

        const failure = yield* Effect.flip(timeTravel.rewind({ runId, frame: { lineageId: root, seq: 1 } }))

        expect(failure).toMatchObject({ code: "busy", message: `journal history was rewritten for ${runId}` })
        expect(yield* history).toEqual([`0/${root}`, `1/${root}`, `2/${root}`])
        expect(yield* completedAudits).toEqual([{ seq: 1 }])
        // Revalidated against the current history, the same request succeeds.
        // A rewind's audit id is minted from the clock, which the test froze.
        yield* TestClock.adjust("1 millis")
        const retried = yield* timeTravel.rewind({ runId, frame: { lineageId: root, seq: 1 } })
        expect(retried.frame).toEqual({ lineageId: root, seq: 1 })
        expect(yield* history).toEqual([`0/${root}`, `1/${root}`])
      }).pipe(Effect.provide(services()))
    ))
})

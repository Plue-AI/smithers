import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as SqlTriggerStore from "../src/SqlTriggerStore.ts"
import * as TriggerStore from "../src/TriggerStore.ts"
import { storeConformance } from "./StoreConformance.ts"

const trigger = {
  id: "daily",
  flowId: "flow",
  input: {},
  cron: "0 0 * * *",
  overlap: "skip" as const,
  catchUp: "none" as const,
  maxCatchUp: 1,
  enabled: true
}
const layer = SqlTriggerStore.layer.pipe(Layer.provide(TestDatabase.layer))
// Keeps the SQL client visible so a test can write the row shapes an older
// schema or a corrupted write would leave behind.
const layerWithSql = SqlTriggerStore.layer.pipe(Layer.provideMerge(TestDatabase.layer))

storeConformance("SqlTriggerStore", layer)

describe("TriggerStore", () => {
  it("answers a fires query filtered by run through the run_id index", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* TriggerStore.TriggerStore
        return yield* TestDatabase.explain(
          sql,
          sql`SELECT * FROM flows_trigger_fires WHERE run_id = ${"run-1"}
        `
        )
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(plan.map((row) => row.detail).join("\n")).toContain("flows_trigger_fires_run_id")
  })

  it("settles a legacy launched row with no run id without clearing a newer reservation", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const sql = yield* SqlClient.SqlClient
        const registered = yield* store.register({ ...trigger, overlap: "supersede" })
        yield* sql`INSERT INTO flows_trigger_fires (trigger_id, occurrence_at_ms, outcome) VALUES ('daily', 1, 'launched')`
        yield* store.claimFire({ triggerId: "daily", occurrence: 2, expectedRevision: registered.revision })
        const before = yield* store.inspect("daily")
        yield* store.recordResult({ triggerId: "daily", occurrence: 1, outcome: "completed" })
        expect(yield* store.inspect("daily")).toEqual(before)
      }).pipe(Effect.provide(layerWithSql))
    )
  })

  it("rolls back both halves of buffered compensation when the pending write fails", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const sql = yield* SqlClient.SqlClient
        const registered = yield* store.register({ ...trigger, overlap: "buffer-one" })
        const fire = { triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision }
        yield* store.claimFire(fire)
        yield* store.claimFire({ ...fire, occurrence: 2 })
        yield* store.recordResult({ ...fire, outcome: "completed" })
        const pending = yield* store.claimPending(fire)
        if (
          pending._tag !== "Some" || !pending.value.claim.claimed || pending.value.claim.action !== "fire"
        ) return yield* Effect.die("expected reservation")
        const restore = { triggerId: trigger.id, occurrence: 2, reservationId: pending.value.claim.reservationId }
        const before = yield* store.inspect(trigger.id)
        yield* Dialect.trigger(sql, {
          name: `refuse_rearm`,
          table: `flows_triggers`,
          event: `AFTER UPDATE OF pending_at_ms`,
          when: `NEW.pending_at_ms IS NOT NULL`,
          reject: "rearm failed"
        })
        expect((yield* Effect.flip(store.restorePending(restore))).code).toBe("store")
        expect(yield* store.inspect(trigger.id)).toEqual(before)
        yield* TestDatabase.dropTrigger(sql, "refuse_rearm")
        yield* store.restorePending(restore)
        expect(yield* store.inspect(trigger.id)).toEqual({ pendingAt: 2 })
      }).pipe(Effect.provide(layerWithSql))
    )
  })

  it("refuses to register a cron the calendar never satisfies", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.flip(store.register({ ...trigger, cron: "0 0 30 2 *" }))
      }).pipe(Effect.provide(layer))
    )
    expect(error.code).toBe("unsatisfiable_cron")
  })

  it("revisions replacements", async () => {
    const program = Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const first = yield* store.register(trigger)
      const second = yield* store.register({ ...trigger, flowId: "other" })
      return { first, second }
    }).pipe(Effect.provide(layer))
    const result = await Effect.runPromise(program)
    expect(result.first.revision).toBe(1)
    expect(result.second.revision).toBe(2)
    expect(result.second.flowId).toBe("other")
  })

  it("retains an active run across buffered and skipped outcomes and clears it on completion", async () => {
    const program = Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const registered = yield* store.register({ ...trigger, overlap: "buffer-one" })
      yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
      yield* store.claimFire({ triggerId: trigger.id, occurrence: 2, expectedRevision: registered.revision })
      const updated = yield* store.register(trigger)
      yield* store.claimFire({ triggerId: trigger.id, occurrence: 3, expectedRevision: updated.revision })
      yield* store.recordResult({
        triggerId: trigger.id,
        occurrence: 1,
        outcome: "launched",
        runId: "run-1",
        reservationId: (yield* store.inspect(trigger.id)).activeRunId!
      })
      yield* store.recordResult({ triggerId: trigger.id, occurrence: 2, outcome: "buffered" })
      yield* store.recordResult({ triggerId: trigger.id, occurrence: 3, outcome: "skipped" })
      const active = yield* store.activeRun(trigger.id)
      yield* store.recordResult({
        triggerId: trigger.id,
        occurrence: 1,
        outcome: "completed",
        runId: "run-1"
      })
      const completed = yield* store.activeRun(trigger.id)
      return { active, completed }
    }).pipe(Effect.provide(layer))
    const result = await Effect.runPromise(program)
    expect(result.active).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(result.completed).toMatchObject({ _tag: "None" })
  })

  it("atomically applies overlap across different due occurrences", async () => {
    const program = Effect.gen(function*() {
      const store = yield* TriggerStore.TriggerStore
      const registered = yield* store.register(trigger)
      return yield* Effect.all([
        store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision }),
        store.claimFire({ triggerId: trigger.id, occurrence: 2, expectedRevision: registered.revision })
      ], { concurrency: "unbounded" })
    }).pipe(Effect.provide(layer))
    const claims = await Effect.runPromise(program)
    expect(claims.filter((claim) => claim.claimed && claim.action === "fire")).toHaveLength(1)
    expect(claims.filter((claim) => claim.claimed && claim.action === "skip")).toHaveLength(1)
  })

  it("reads back every optional column it wrote", async () => {
    const registered = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const written = yield* store.register({
          ...trigger,
          timezone: "America/New_York",
          overlap: "buffer-one",
          catchUp: "all",
          maxCatchUp: 4
        })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 7, expectedRevision: written.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 7,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        const withCursor = yield* store.get(trigger.id)
        return { written, withCursor }
      }).pipe(Effect.provide(layer))
    )
    expect(registered.written).toMatchObject({
      timezone: "America/New_York",
      overlap: "buffer-one",
      catchUp: "all",
      maxCatchUp: 4,
      enabled: true,
      revision: 1
    })
    expect(registered.written.lastFiredAt).toBeUndefined()
    expect(registered.withCursor).toMatchObject({ _tag: "Some" })
    expect(
      registered.withCursor._tag === "Some" ? registered.withCursor.value.lastFiredAt : undefined
    ).toBe(7)
  })

  it("answers None for a trigger that was never registered", async () => {
    const missing = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* store.get("absent")
      }).pipe(Effect.provide(layer))
    )
    expect(missing).toMatchObject({ _tag: "None" })
  })

  it("lists every trigger and only the enabled ones, in id order", async () => {
    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register({ ...trigger, id: "b-on" })
        yield* store.register({ ...trigger, id: "a-off", enabled: false })
        return { all: yield* store.list(), enabled: yield* store.listEnabled() }
      }).pipe(Effect.provide(layer))
    )
    expect(listed.all.map((row) => row.triggerId)).toEqual(["a-off", "b-on"])
    expect(listed.enabled.map((registered) => registered.id)).toEqual(["b-on"])
  })

  // `clearActive` is the documented exception: its compare-and-swap cannot tell
  // a missing trigger from a run id that no longer matches.
  it("leaves clearActive a no-op for a missing trigger and a stale run id", async () => {
    const active = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.clearActive("absent", "run-1")
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        yield* store.clearActive(trigger.id, "run-2")
        const stale = yield* store.activeRun(trigger.id)
        yield* store.clearActive(trigger.id, "run-1")
        return { stale, cleared: yield* store.activeRun(trigger.id) }
      }).pipe(Effect.provide(layer))
    )
    expect(active.stale).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(active.cleared).toMatchObject({ _tag: "None" })
  })

  it("coalesces buffered occurrences forward into the one slot", async () => {
    const pending = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        const empty = (yield* store.inspect(trigger.id)).pendingAt
        yield* store.setPending({ triggerId: trigger.id, occurrence: 20 })
        yield* store.setPending({ triggerId: trigger.id, occurrence: 10 })
        yield* store.setPending({ triggerId: trigger.id, occurrence: 30 })
        return { empty, buffered: (yield* store.inspect(trigger.id)).pendingAt }
      }).pipe(Effect.provide(layer))
    )
    expect(pending.empty).toBeUndefined()
    // One slot: a later occurrence replaces the buffer, an earlier one does
    // not. `claimPending` is what empties it, and only when a decision
    // consumes it.
    expect(pending.buffered).toBe(30)
  })

  // The cursor catch-up resumes from only ever moves forward. Settling run 1
  // after occurrence 2 was already skipped used to drag it back to 1 and
  // replay work the store had already recorded.
  it("never moves last_fired_at_ms backwards when an older run settles", async () => {
    const cursors = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 2, expectedRevision: registered.revision })
        const afterSkip = yield* store.get(trigger.id)
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "completed",
          runId: "run-1"
        })
        return { afterSkip, afterSettle: yield* store.get(trigger.id) }
      }).pipe(Effect.provide(layer))
    )
    const cursor = (option: typeof cursors.afterSkip) => option._tag === "Some" ? option.value.lastFiredAt : undefined
    expect(cursor(cursors.afterSkip)).toBe(2)
    expect(cursor(cursors.afterSettle)).toBe(2)
  })

  it("buffers under buffer-one and resumes the buffered occurrence only when asked", async () => {
    const claims = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...trigger, overlap: "buffer-one" })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        const buffered = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
        const again = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
        yield* store.recordResult({ triggerId: trigger.id, occurrence: 1, outcome: "completed" })
        const resumed = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision,
          resumeBuffered: true
        })
        return { buffered, again, resumed, pending: (yield* store.inspect(trigger.id)).pendingAt }
      }).pipe(Effect.provide(layer))
    )
    expect(claims.buffered).toMatchObject({ claimed: true, action: "buffer" })
    expect(claims.again).toMatchObject({ claimed: false })
    expect(claims.resumed).toMatchObject({ claimed: true, action: "fire" })
    expect(claims.pending).toBe(2)
  })

  it("reports the run it is superseding", async () => {
    const claim = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...trigger, overlap: "supersede" })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        return yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
      }).pipe(Effect.provide(layer))
    )
    expect(claim).toMatchObject({
      claimed: true,
      action: "supersede",
      activeRunId: "run-1",
      reservationId: expect.stringMatching(/^trigger-reservation:daily:[^:]+:2$/)
    })
  })

  it("refuses transformed JSON inputs instead of persisting their transformations", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        return yield* Effect.all([
          Effect.flip(store.register({ ...trigger, id: "nan", input: { n: Number.NaN } })),
          Effect.flip(store.register({
            ...trigger,
            id: "date",
            input: new Date("2026-01-01T00:00:00.000Z") as never
          }))
        ])
      }).pipe(Effect.provide(layer))
    )
    for (const error of errors) {
      expect(error).toMatchObject({ code: "invalid_trigger", path: "input" })
    }
  })

  it("snapshots input before the returned registration Effect runs", async () => {
    const stored = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const input = { value: 1 }
        const registration = store.register({ ...trigger, input })
        input.value = 2
        yield* registration
        return yield* store.get(trigger.id)
      }).pipe(Effect.provide(layer))
    )
    expect(stored).toMatchObject({ _tag: "Some", value: { input: { value: 1 } } })
  })

  // Schema.Json accepts an enumerable getter. Registration evaluates it while
  // taking the eager snapshot, so later changes to the getter's source cannot
  // change the persisted declaration.
  it("snapshots a getter to the value it produced at registration", async () => {
    let value = 1
    let reads = 0
    const input = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        reads++
        return value
      }
    }) as { readonly value: number }
    const stored = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registration = store.register({ ...trigger, input })
        value = 2
        yield* registration
        return yield* store.get(trigger.id)
      }).pipe(Effect.provide(layer))
    )
    expect(reads).toBe(2)
    expect(stored).toMatchObject({ _tag: "Some", value: { input: { value: 1 } } })
  })

  it("keeps pending_at_ms when claimPending fails after reading it", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.setPending({ triggerId: trigger.id, occurrence: 7 })
        const error = yield* Effect.flip(
          store.claimPending({
            triggerId: trigger.id,
            expectedRevision: registered.revision + 1
          })
        )
        const rows = yield* sql<{ readonly pending_at_ms: number | null }>`
          SELECT pending_at_ms FROM flows_triggers WHERE trigger_id = ${trigger.id}
        `
        return { error, pending: rows[0]?.pending_at_ms }
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(result.error.code).toBe("revision_mismatch")
    expect(result.pending).toBe(7)
  })

  it("restores a buffered occurrence when its launch reservation expires", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...trigger, overlap: "buffer-one" })
        yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 1,
          expectedRevision: registered.revision
        })
        yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
        yield* store.recordResult({ triggerId: trigger.id, occurrence: 1, outcome: "completed" })
        const resumed = yield* store.claimPending({
          triggerId: trigger.id,
          expectedRevision: registered.revision
        })
        yield* TestClock.adjust(TriggerStore.reservationLeaseMs + 1)
        const active = yield* store.activeRun(trigger.id)
        const rows = yield* sql<{ readonly pending_at_ms: number | null }>`
          SELECT pending_at_ms FROM flows_triggers WHERE trigger_id = ${trigger.id}
        `
        return { resumed, active, pending: rows[0]?.pending_at_ms }
      }).pipe(Effect.provide(layerWithSql), Effect.provide(TestClock.layer()))
    )
    expect(result.resumed).toMatchObject({
      _tag: "Some",
      value: { occurrence: 2, claim: { claimed: true, action: "fire" } }
    })
    expect(result.active).toMatchObject({ _tag: "None" })
    expect(result.pending).toBe(2)
  })

  it("clears a malformed expired reservation without inventing an occurrence", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register({ ...trigger, overlap: "supersede" })
        const malformed = `${TriggerStore.reservationPrefix}${trigger.id}:not-a-number`
        yield* sql`UPDATE flows_triggers
          SET active_run_id = ${malformed}, active_claimed_at_ms = 0
          WHERE trigger_id = ${trigger.id}`
        const claim = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 1,
          expectedRevision: registered.revision
        })
        yield* sql`UPDATE flows_triggers
          SET active_run_id = ${malformed}, active_claimed_at_ms = NULL
          WHERE trigger_id = ${trigger.id}`
        const reclaimed = yield* store.claimFire({
          triggerId: trigger.id,
          occurrence: 2,
          expectedRevision: registered.revision
        })
        yield* sql`UPDATE flows_triggers
          SET active_run_id = ${malformed}, active_claimed_at_ms = NULL
          WHERE trigger_id = ${trigger.id}`
        const occurrence = yield* store.activeOccurrence(trigger.id, malformed)
        const active = yield* store.activeRun(trigger.id)
        const rows = yield* sql<{ readonly pending_at_ms: number | null }>`
          SELECT pending_at_ms FROM flows_triggers WHERE trigger_id = ${trigger.id}
        `
        return { malformed, claim, reclaimed, occurrence, active, pending: rows[0]?.pending_at_ms }
      }).pipe(Effect.provide(layerWithSql), Effect.provide(TestClock.layer()))
    )
    expect(result.claim).toMatchObject({
      claimed: true,
      action: "supersede",
      activeRunId: result.malformed
    })
    expect(result.reclaimed).toMatchObject({ claimed: true, action: "fire" })
    expect(result.occurrence).toMatchObject({ _tag: "None" })
    expect(result.active).toMatchObject({ _tag: "None" })
    expect(result.pending).toBeNull()
  })

  it("reports a row it cannot decode as a store failure", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        yield* sql`UPDATE flows_triggers SET input_json = '{not json' WHERE trigger_id = ${trigger.id}`
        return yield* Effect.flip(store.get(trigger.id))
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(error.code).toBe("store")
    // The id belongs in the message: a shared database has many rows.
    expect(error.message).toBe("could not decode trigger row daily")
    expect(error.cause).toBeDefined()
  })

  // A tick lists every trigger before it isolates them one by one, so a
  // listing that failed on the first undecodable row stopped every healthy
  // schedule in the store, including the ones that had nothing wrong.
  it("isolates a row it cannot decode from the rest of a listing", async () => {
    const listing = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        yield* store.register({ ...trigger, id: "b-healthy" })
        yield* store.register({ ...trigger, id: "a-corrupt", enabled: false })
        yield* sql`UPDATE flows_triggers SET input_json = '{not json' WHERE trigger_id = 'a-corrupt'`
        return yield* store.list()
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(listing.map((row) => row.triggerId)).toEqual(["a-corrupt", "b-healthy"])
    const corrupt = listing[0]!.trigger
    expect(Result.isFailure(corrupt) ? corrupt.failure.message : null).toBe("could not decode trigger row a-corrupt")
    expect(Result.getOrThrow(listing[1]!.trigger)).toMatchObject({ id: "b-healthy", enabled: true })
  })

  // Two stores over one database is the ordinary shape of a restart. The
  // migrator records what it applied, so the second `make` must be a no-op
  // rather than an error or a second `ALTER TABLE`.
  it("applies its migrations exactly once across two store constructions", async () => {
    const survived = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* SqlTriggerStore.make
        yield* first.register(trigger)
        const second = yield* SqlTriggerStore.make
        return yield* second.get(trigger.id)
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(survived).toMatchObject({ _tag: "Some" })
  })

  // A read or a write the database itself refuses is a store failure, not a
  // typed refusal the store computed.
  it("reports a failing statement as a store read or write failure", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        yield* sql`DROP TABLE flows_trigger_fires ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        yield* sql`DROP TABLE flows_triggers ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        return {
          read: yield* Effect.flip(store.list()),
          write: yield* Effect.flip(
            store.recordResult({ triggerId: trigger.id, occurrence: 1, outcome: "completed" })
          )
        }
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(failures.read).toMatchObject({ code: "store", message: "trigger store read failed" })
    expect(failures.write).toMatchObject({ code: "store", message: "trigger store write failed" })
  })

  // The store owns its schema. A database whose `flows_triggers` already
  // carries the column migration 0002 adds cannot be migrated, and that has to
  // arrive as a store failure rather than as a defect out of the migrator.
  it("reports a migration it cannot apply as a store failure", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`CREATE TABLE flows_triggers (trigger_id TEXT PRIMARY KEY, active_claimed_at_ms INTEGER)`
        return yield* Effect.flip(SqlTriggerStore.make)
      }).pipe(Effect.provide(TestDatabase.layer))
    )
    expect(error).toMatchObject({ code: "store", message: "could not run trigger migrations" })
  })

  // The row is written and then read back. A concurrent delete between the two
  // leaves nothing to answer with, and the caller is told so rather than
  // handed a half-registered declaration.
  it("refuses to report a registration whose row disappeared under it", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const store = yield* TriggerStore.TriggerStore
        yield* Dialect.trigger(sql, {
          name: "vanish",
          table: "flows_triggers",
          event: "AFTER INSERT",
          body: "DELETE FROM flows_triggers WHERE trigger_id = NEW.trigger_id;"
        })
        return yield* Effect.flip(store.register(trigger))
      }).pipe(Effect.provide(layerWithSql))
    )
    expect(error).toMatchObject({ code: "store", message: "registered trigger disappeared" })
    expect(error.cause).toBeUndefined()
  })
})

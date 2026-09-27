import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * The durable `ControlRuntime`: the shared `ControlLive` contract, plus what
 * only a durable adapter can be asked — surviving a restart, refusing a stale
 * process's writes, and losing a claim race to a live peer.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DatabaseError, DurableWriter } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, Ownership, RunStore } from "@smthrs/run-store"
import { Context, type Crypto, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Control, type Service as ControlService } from "../src/Control.ts"
import { ClaimLost, PersistenceError, PlanDigestMismatch, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime, type RunQuery, type Service as ControlRuntimeService } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { delegateApproval } from "./ApprovalFixtures.ts"
import { contract, type Stack } from "./ControlContract.ts"
import { fileBundle } from "./DurableStack.ts"
import { park } from "./Park.ts"

/**
 * The durable journal bundle, with `Database` kept in the output so the control
 * runtime and the journal share one connection and therefore one transaction
 * boundary.
 */
const durableJournal = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
      TestDatabase.layer
    )
  )
)

/** A complete durable Control stack over one in-memory SQLite database. */
const durable = (
  options: {
    readonly executor?: ControlExecutor.Service | undefined
    readonly owner?: Ownership.OwnerId | undefined
    readonly database?:
      | Layer.Layer<DurableWriter | SqlClient.SqlClient | RunStore.RunStore, unknown>
      | undefined
  } = {}
): Layer.Layer<Stack | DurableWriter | SqlClient.SqlClient | RunStore.RunStore | Crypto.Crypto> => {
  const journal = options.database ?? durableJournal
  const runtime = SqlControlRuntime.layer(
    { owner: options.owner, approvalAuthority: delegateApproval({ id: "reviewer", kind: "test" }) }
  ).pipe(Layer.orDie)
  // The database is provided once, to the whole stack: `NodeDatabase.layer`
  // opens a fresh `:memory:` connection per build, so provisioning it to each
  // consumer separately would hand them unrelated databases.
  return Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      runtime,
      NotificationQueue.layer,
      ControlExecutor.layer(options.executor ?? ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ).pipe(Layer.provideMerge(Layer.merge(journal, NodeCrypto.layer))) as Layer.Layer<
    Stack | DurableWriter | SqlClient.SqlClient | RunStore.RunStore | Crypto.Crypto
  >
}

it("reads only the selected durable run page", async () => {
  let reads = 0
  const countedDatabase = Layer.effect(
    RunStore.RunStore,
    Effect.map(RunStore.RunStore, (store) => ({
      ...store,
      get: (runId: string) =>
        Effect.suspend(() => {
          reads += 1
          return store.get(runId)
        })
    }))
  ).pipe(Layer.provideMerge(durableJournal))
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      const sql = yield* SqlClient.SqlClient
      for (let index = 0; index < 23; index++) {
        const runId = `page-${String(index).padStart(2, "0")}`
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, parent_run_id, lineage_id)
        VALUES (${runId}, 'pending', 1, ${JSON.stringify({ version: 1, flowName: "page/test", payload: {} })},
          ${index === 0 ? null : "page-00"}, 'page-lineage')`
      }
      const cases: ReadonlyArray<RunQuery["filters"]> = [
        undefined,
        { flowId: "page/test" },
        { status: "accepted" },
        { lineageId: "page-lineage" },
        { parentRunId: "page-00" },
        { flowId: "page/test", status: "accepted", lineageId: "page-lineage", parentRunId: "page-00" }
      ]
      for (const filters of cases) {
        reads = 0
        let cursor: string | undefined
        const seen: Array<string> = []
        do {
          const before = reads
          const listed = yield* control.list({ _tag: "runs", filters, limit: 5, cursor })
          if (listed._tag !== "runs") return yield* Effect.die("expected runs")
          seen.push(...listed.items.map((run) => run.runId))
          expect(reads - before).toBe(listed.items.length)
          cursor = listed.nextCursor
        } while (cursor !== undefined && seen.length < 30)
        expect(new Set(seen).size).toBe(filters?.parentRunId === undefined ? 23 : 22)
        expect(reads).toBe(seen.length)
      }
    }).pipe(Effect.provide(durable({ database: countedDatabase })), Effect.scoped, Effect.orDie)
  )
})

it("selects terminal runs newest-first before decoding and paginates ties", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      const sql = yield* SqlClient.SqlClient
      for (let index = 0; index < 505; index++) {
        const runId = `history-${String(index).padStart(3, "0")}`
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES (${runId}, ${index === 504 ? "suspended" : "completed"}, ${Math.floor(index / 2)},
          ${JSON.stringify({ version: 1, flowName: "page/test", payload: {} })})`
      }
      const request = {
        _tag: "runs" as const,
        filters: { flowId: "page/test", terminal: true },
        order: "newest" as const,
        limit: 2
      }
      const first = yield* control.list(request)
      expect(first.items.map((row) => "runId" in row ? row.runId : "")).toEqual(["history-503", "history-502"])
      const second = yield* control.list({ ...request, cursor: first.nextCursor })
      expect(second.items.map((row) => "runId" in row ? row.runId : "")).toEqual(["history-501", "history-500"])
      const active = yield* control.list({ ...request, filters: { flowId: "page/test", terminal: false } })
      expect(active.items.map((row) => "runId" in row ? row.runId : "")).toEqual(["history-504"])
      expect(yield* Effect.flip(control.list({ _tag: "runs", filters: request.filters, cursor: first.nextCursor })))
        .toHaveProperty("code", "invalid_input")
    }).pipe(Effect.provide(durable()), Effect.scoped)
  )
})

it("continues a run cursor after deletion without decoding later rows", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      const sql = yield* SqlClient.SqlClient
      for (const runId of ["a", "b", "c", "d"]) {
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES (${runId}, 'pending', 1, ${JSON.stringify({ flowName: "page/test" })})`
      }
      const first = yield* control.list({ _tag: "runs", limit: 1 })
      expect(first.items).toMatchObject([{ runId: "a" }])
      yield* sql`DELETE FROM flows_runs WHERE run_id = 'a'`
      yield* sql`UPDATE flows_runs SET state_json = '[]' WHERE run_id = 'd'`
      const second = yield* control.list({ _tag: "runs", limit: 1, cursor: first.nextCursor })
      expect(second.items).toMatchObject([{ runId: "b" }])
      const third = yield* control.list({ _tag: "runs", limit: 1, cursor: second.nextCursor })
      expect(third.items).toMatchObject([{ runId: "c" }])
      expect(yield* Effect.flip(control.list({ _tag: "runs", limit: 1, cursor: third.nextCursor })))
        .toBeInstanceOf(PersistenceError)
    }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
  )
})

it("keeps advancing when retention removes a selected row before projection", async () => {
  const retainedDatabase = Layer.effect(
    RunStore.RunStore,
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const sql = yield* SqlClient.SqlClient
      return {
        ...store,
        get: (runId: string) =>
          Effect.gen(function*() {
            if (runId === "a") yield* sql`DELETE FROM flows_runs WHERE run_id = ${runId}`.pipe(Effect.orDie)
            return yield* store.get(runId)
          })
      }
    })
  ).pipe(Layer.provideMerge(durableJournal))
  await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      for (const runId of ["a", "b"]) {
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES (${runId}, 'pending', 1, ${JSON.stringify({ flowName: "page/test" })})`
      }
      const first = yield* runtime.queryRuns({ limit: 1 })
      expect(first.items).toEqual([])
      expect(first.nextCursor).toMatchObject({ runId: "a" })
      const second = yield* runtime.queryRuns({ limit: 1, cursor: first.nextCursor })
      expect(second.items.map((run) => run.runId)).toEqual(["b"])
      expect(second.nextCursor).toBeUndefined()
    }).pipe(Effect.provide(durable({ database: retainedDatabase })), Effect.scoped, Effect.orDie)
  )
})

it("keeps SQL query filters consistent with durable summary projections", async () => {
  await Effect.runPromise(
    Effect.gen(function*() {
      const runtime = yield* ControlRuntime
      const sql = yield* SqlClient.SqlClient
      const engine = { flowName: "engine/test" }
      const states = [
        { runId: "root", state: engine },
        { runId: "other", state: engine },
        { runId: "spawn", state: engine },
        { runId: "round", state: engine },
        { runId: "metadata", state: { ...engine, parentRunId: "root", lineageId: "lineage" } },
        {
          runId: "control",
          state: {
            runId: "control",
            flowId: "control/test",
            status: "waiting-approval",
            createdAt: 1,
            updatedAt: 1,
            parentRunId: "root",
            lineageId: "lineage"
          }
        }
      ]
      for (const row of states) {
        yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES (${row.runId}, 'pending', 1, ${JSON.stringify(row.state)})`
      }
      yield* sql`CREATE TABLE flows_run_parents (seq INTEGER PRIMARY KEY, child_id TEXT, parent_id TEXT)`
      yield* sql`INSERT INTO flows_run_parents (seq, child_id, parent_id)
      VALUES (1, 'spawn', 'root'), (2, 'spawn', 'other'), (3, 'round', 'other')`
      yield* sql`UPDATE flows_runs SET parent_run_id = 'spawn', lineage_id = 'lineage' WHERE run_id = 'round'`
      const all = yield* runtime.listRuns
      const cases: ReadonlyArray<RunQuery["filters"]> = [
        { parentRunId: "root" },
        { parentRunId: "spawn" },
        { parentRunId: "other" },
        { lineageId: "lineage" },
        { status: "waiting-approval" },
        { flowId: "engine/test", status: "accepted" }
      ]
      for (const filters of cases) {
        const expected = all.filter((run) =>
          Object.entries(filters!).every(([key, value]) => run[key as keyof typeof run] === value)
        ).map((run) => run.runId)
        const seen: Array<string> = []
        let cursor: RunQuery["cursor"]
        do {
          const page = yield* runtime.queryRuns({ filters, limit: 1, cursor })
          seen.push(...page.items.map((run) => run.runId))
          cursor = page.nextCursor
        } while (cursor !== undefined && seen.length < 10)
        expect(seen).toEqual(expected)
      }
    }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
  )
})

contract("durable", (executor) => durable(executor === undefined ? {} : { executor }))

/**
 * Two owner identities sharing one connection for sequential handoff cases.
 * The concurrent-resume case below opens independent connections instead.
 */
const twoOwners = <A, E>(
  use: (
    first: ControlRuntimeService,
    second: ControlRuntimeService,
    control: ControlService
  ) => Effect.Effect<A, E, Control | ControlRuntime>
): Promise<A> => {
  const shared = durableJournal
  return Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control
      const first = yield* ControlRuntime
      const second = yield* SqlControlRuntime.make().pipe(Effect.orDie)
      return yield* use(first, second, control)
    }).pipe(
      Effect.provide(durable({ database: shared })),
      Effect.scoped,
      Effect.orDie
    )
  )
}

const started = Effect.gen(function*() {
  const control = yield* Control
  const card = yield* control.plan({ flowId: "system/test", input: { suite: "durable" } })
  yield* control.approve({
    target: card.approval.target,
    scope: card.approval.scope,
    idempotencyKey: card.approval.idempotencyKey
  })
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  // The default executor declines and Control.run releases the launch. These
  // SQL-runtime cases exercise an owning process, so reclaim it first.
  yield* control.resume({ runId: receipt.runId, idempotencyKey: `resume:${receipt.runId}` })
  return { card, runId: receipt.runId }
})

describe("SqlControlRuntime", () => {
  it("preserves the first attribution when recovering legacy duplicate cancel requests", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const journal = yield* Journal.Journal
        const { runId } = yield* started
        for (const reason of ["first request", "duplicate request"]) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make(runId),
              sourceId: JournalEvent.SourceId.make("/control"),
              eventType: "control.run.cancel-requested",
              payload: { runId, reason }
            })
          )
        }
        expect((yield* runtime.getRun(runId)).cancellation?.reason).toBe("first request")
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )
  })

  it.each(["cancel-requested", "cancelled"])("recovers cancellation after a failed %s event", async (event) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const journal = yield* Journal.Journal
        const sql = yield* SqlClient.SqlClient
        const { runId } = yield* started
        let cleanedUp = false
        const owner = yield* Effect.never.pipe(
          Effect.ensuring(Effect.sync(() => {
            cleanedUp = true
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* runtime.registerFiber(runId, owner)
        let fail = true
        const failing = Journal.make({
          ...journal,
          emitDurableUnfenced: (input) =>
            Effect.gen(function*() {
              const receipt = yield* journal.emitDurableUnfenced(input)
              if (fail && input.eventType === `control.run.${event}`) {
                fail = false
                return yield* new Journal.JournalError({
                  code: "sink_failed",
                  message: "injected cancellation failure"
                })
              }
              return receipt
            })
        })
        const control = Context.get(
          yield* Layer.build(Layer.fresh(ControlLive.layer)).pipe(
            Effect.provide(Registry.layerNoop()),
            Effect.provideService(Journal.Journal, failing)
          ),
          Control
        )
        const request = { runId, idempotencyKey: "cancel:recovery" }
        expect(yield* Effect.flip(control.cancel(request))).toBeInstanceOf(PersistenceError)
        expect(cleanedUp).toBe(event === "cancelled")
        expect((yield* runtime.getRun(runId)).status).toBe("accepted")
        const events = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
        expect(events.entries.some((entry) => entry.eventType === "control.run.cancel-requested"))
          .toBe(event === "cancelled")
        expect(events.entries.some((entry) => entry.eventType === "control.run.cancelled")).toBe(false)
        const receipts =
          yield* sql`SELECT receipt_json FROM control_mutations WHERE mutation_key = 'cancel:cancel:recovery'`
        expect(receipts).toHaveLength(event === "cancelled" ? 1 : 0)
        expect(yield* control.cancel(request)).toEqual({ _tag: "Terminal", runId, status: "cancelled" })
        expect(cleanedUp).toBe(true)
        const committed = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 100 })
        expect(committed.entries.filter((entry) => entry.eventType === "control.run.cancel-requested")).toHaveLength(1)
        expect(committed.entries.filter((entry) => entry.eventType === "control.run.cancelled")).toHaveLength(1)
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )
  })

  it("reports a settlement writer failure without losing the cancellation fence", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const writer = yield* DurableWriter
        let fail = false
        const runtime = yield* SqlControlRuntime.make().pipe(Effect.provideService(DurableWriter, {
          write: (effect) =>
            Effect.suspend(() =>
              fail
                ? Effect.fail(new DatabaseError({ code: "unsupported" }))
                : writer.write(effect)
            )
        }))
        const control = Context.get(
          yield* Layer.build(Layer.fresh(ControlLive.layer)).pipe(
            Effect.provide(Registry.layerNoop()),
            Effect.provideService(ControlRuntime, runtime)
          ),
          Control
        )
        const { runId } = yield* started.pipe(Effect.provideService(Control, control))
        const fence = yield* runtime.claimFence(runId)
        fail = true
        const error = yield* Effect.flip(runtime.interrupt(runId))
        expect(error).toBeInstanceOf(PersistenceError)
        expect((error as PersistenceError).operation).toBe("settle an interrupted run")
        expect(yield* runtime.claimFence(runId)).toBe(fence)
        fail = false
        expect((yield* runtime.interrupt(runId)).status).toBe("cancelled")
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )
  })

  it.each([false, true])(
    "rolls back plan, key, token and event on journal failure (after insert: %s)",
    async (afterInsert) => {
      const observed = await Effect.runPromise(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const sql = yield* SqlClient.SqlClient
          const request = { flowId: "system/test", input: { atomic: true }, idempotencyKey: "atomic:plan" }
          const failing = Journal.make({
            ...journal,
            emitDurableUnfenced: (input) =>
              Effect.gen(function*() {
                if (afterInsert) yield* journal.emitDurableUnfenced(input)
                return yield* new Journal.JournalError({ code: "sink_failed", message: "injected plan event failure" })
              })
          })
          const control = Context.get(
            yield* Layer.build(Layer.fresh(ControlLive.layer)).pipe(
              Effect.provide(Registry.layerNoop()),
              Effect.provideService(Journal.Journal, failing)
            ),
            Control
          )
          const first = yield* Effect.flip(control.plan(request))
          const plans = yield* sql`SELECT * FROM control_plans`
          const keys = yield* sql`SELECT * FROM control_plan_keys`
          const tokens = yield* sql`SELECT * FROM control_tokens`
          const events = yield* journal.entries({ runId: JournalEvent.RunId.make("plan:plan-1"), limit: 10 })
          const restarted = yield* SqlControlRuntime.make()
          const retryControl = Context.get(
            yield* Layer.build(Layer.fresh(ControlLive.layer)).pipe(
              Effect.provide(Registry.layerNoop()),
              Effect.provideService(ControlRuntime, restarted)
            ),
            Control
          )
          const card = yield* retryControl.plan(request)
          const replay = yield* retryControl.plan(request)
          const committed = yield* journal.entries({ runId: JournalEvent.RunId.make(`plan:${card.planId}`), limit: 10 })
          return { first, plans, keys, tokens, events, card, replay, committed }
        }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
      )

      expect(observed.first).toBeInstanceOf(PersistenceError)
      expect(observed.plans).toHaveLength(0)
      expect(observed.keys).toHaveLength(0)
      expect(observed.tokens).toHaveLength(0)
      expect(observed.events.entries).toHaveLength(0)
      expect(observed.replay).toEqual(observed.card)
      expect(observed.committed.entries.map((entry) => entry.eventType)).toEqual(["control.plan.created"])
    }
  )

  it("repairs a plan committed without its creation event after restart", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const journal = yield* Journal.Journal
        const request = { flowId: "system/test", input: { legacy: true }, idempotencyKey: "legacy:plan" }
        // This is the state left by a crash between the old implementation's two writes.
        const original = yield* runtime.plan(request)
        const restarted = yield* SqlControlRuntime.make()
        const control = Context.get(
          yield* Layer.build(Layer.fresh(ControlLive.layer)).pipe(
            Effect.provide(Registry.layerNoop()),
            Effect.provideService(ControlRuntime, restarted)
          ),
          Control
        )
        const repaired = yield* control.plan(request)
        const replay = yield* control.plan(request)
        const events = yield* journal.entries({ runId: JournalEvent.RunId.make(`plan:${repaired.planId}`), limit: 10 })
        return { original, repaired, replay, events }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.repaired).toEqual(observed.original.card)
    expect(observed.replay).toEqual(observed.repaired)
    expect(observed.events.entries.map((entry) => entry.eventType)).toEqual(["control.plan.created"])
  })

  it("survives a restart: a second runtime over the same database sees the run", async () => {
    const shared = durableJournal
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { card, runId } = yield* started
        yield* park(runtime, runId)

        // Nothing of the first runtime is carried across — only the database.
        const restarted = yield* SqlControlRuntime.make({
          owner: { hostId: "local", pid: 2, nonce: "restarted" }
        }).pipe(Effect.orDie)
        const run = yield* restarted.getRun(runId)
        const plan = yield* restarted.getPlan(card.planId)
        const runs = yield* restarted.listRuns
        const grants = yield* restarted.grants
        const replay = yield* restarted.lookupMutation(`run:${`run:${card.planId}`}`, "x")
        const resumed = yield* restarted.resume(runId)
        return { run, plan, runs, grants, replay, resumed }
      }).pipe(
        Effect.provide(durable({ database: shared })),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.run.status).toBe("parked")
    expect(observed.plan.decision).toBe("approved")
    expect(observed.plan.decodedInput).toEqual({ suite: "durable" })
    expect(observed.runs.map((run) => run.runId)).toEqual([observed.run.runId])
    expect(observed.grants).toHaveLength(1)
    // A replay lookup under a different fingerprint is a conflict, not a hit.
    expect(observed.replay?._tag).toBe("Conflict")
    expect(observed.resumed.status).toBe("accepted")
  })

  it("scopes one request id to each run and persists who resolved it", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const firstRun = yield* started
        const secondRun = yield* started
        const approvalEnvelope = { capabilities: [], flows: ["ask"], budget: {} }
        const firstTarget = {
          _tag: "Node" as const,
          runId: firstRun.runId,
          requestId: "ask-shared",
          digest: "ask-digest",
          envelope: approvalEnvelope
        }
        const secondTarget = { ...firstTarget, runId: secondRun.runId }
        const first = yield* runtime.registerApproval(firstTarget)
        const second = yield* runtime.registerApproval(secondTarget)
        const decisionPrincipal = { id: "reviewer", kind: "test", stampedAt: 7 }

        yield* runtime.resolveApproval(first, "approved", decisionPrincipal)

        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly decisionPrincipalJson: string | null }>`
          SELECT decision_principal_json AS "decisionPrincipalJson"
          FROM control_tokens
          WHERE target_tag = 'Node'
            AND run_id = ${firstTarget.runId}
            AND target_id = ${firstTarget.requestId}
        `
        return {
          first,
          second,
          firstRunId: firstRun.runId,
          secondRunId: secondRun.runId,
          firstAfter: yield* runtime.registerApproval(firstTarget),
          secondAfter: yield* runtime.registerApproval(secondTarget),
          persistedPrincipal: rows[0]?.decisionPrincipalJson
        }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.first.target).toMatchObject({ _tag: "Node", runId: observed.firstRunId })
    expect(observed.second.target).toMatchObject({ _tag: "Node", runId: observed.secondRunId })
    expect(observed.firstRunId).not.toBe(observed.secondRunId)
    expect(observed.firstAfter).toMatchObject({
      _tag: "Approved",
      decisionPrincipal: { id: "reviewer", kind: "test", stampedAt: 7 }
    })
    expect(observed.secondAfter).toMatchObject({ _tag: "Pending" })
    expect(observed.persistedPrincipal).not.toBeNull()
    expect(JSON.parse(observed.persistedPrincipal ?? "null")).toEqual({
      id: "reviewer",
      kind: "test",
      stampedAt: 7
    })
  })

  it("keeps colliding plan and node token strings as distinct approvals", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { card } = yield* runtime.plan({ flowId: "system/test", input: { collision: true } })
        const { runId } = yield* started
        const nodeTarget = {
          _tag: "Node" as const,
          runId,
          requestId: card.planId,
          digest: card.digest,
          envelope: card.envelope
        }
        const node = yield* runtime.registerApproval(nodeTarget)
        yield* runtime.resolveApproval(node, "approved", { id: "reviewer", kind: "test", stampedAt: 7 })

        return {
          plan: yield* runtime.lookupApproval(card.approval.target),
          storedPlan: yield* runtime.getPlan(card.planId),
          node: yield* runtime.registerApproval(nodeTarget)
        }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.plan).toMatchObject({ _tag: "Pending", target: { _tag: "Plan" } })
    expect(observed.storedPlan.decision).toBe("pending")
    expect(observed.node).toMatchObject({ _tag: "Approved", target: { _tag: "Node" } })
  })

  it("still refuses a changed digest for one node approval identity", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const { runId } = yield* started
        const target = {
          _tag: "Node" as const,
          runId,
          requestId: "ask-digest",
          digest: "first",
          envelope: { capabilities: [], flows: ["ask"], budget: {} }
        }
        yield* runtime.registerApproval(target)
        return yield* Effect.flip(runtime.registerApproval({ ...target, digest: "second" }))
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(error).toBeInstanceOf(PlanDigestMismatch)
  })

  it("refuses a stale process's fenced write after a peer claims the run", async () => {
    const observed = await twoOwners((first, second, control) =>
      Effect.gen(function*() {
        const { runId } = yield* started
        const staleFence = yield* first.claimFence(runId)
        yield* park(first, runId)
        // The peer takes ownership. The first runtime still holds the fence it
        // had before the park, and that fence is now spent.
        const claimed = yield* second.resume(runId)
        const stale = yield* first.writeStatus(runId, staleFence, "running").pipe(Effect.flip)
        const peerFence = yield* second.claimFence(runId)
        const owned = yield* second.writeStatus(runId, peerFence, "running")
        const evicted = yield* first.claimFence(runId).pipe(Effect.flip)
        return { claimed, stale, owned, evicted }
      })
    )

    expect(observed.claimed.status).toBe("accepted")
    expect(observed.stale).toBeInstanceOf(ClaimLost)
    expect(observed.owned.status).toBe("running")
    expect(observed.evicted).toBeInstanceOf(ClaimLost)
  })

  it("takes over a running run whose owner is gone only once its lease has expired", async () => {
    const owner = { hostId: "mac", pid: 101, nonce: "first" }
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* ControlRuntime
        const store = yield* RunStore.RunStore
        const sql = yield* SqlClient.SqlClient
        const { runId } = yield* started
        const asked: Array<string> = []
        const successor = (hostId: string, alive: boolean) =>
          SqlControlRuntime.make({
            owner: { hostId, pid: 202, nonce: `${hostId}-successor` },
            isAlive: (expected, context) =>
              Effect.sync(() => {
                asked.push(`${expected.hostId}:${expected.pid} asked by ${context.claimant.hostId}`)
                return alive
              })
          }).pipe(Effect.orDie)
        // No liveness check: a running run is its owner's for good.
        const unchecked = yield* SqlControlRuntime.make({ owner: { hostId: "mac", pid: 303, nonce: "x" } }).pipe(
          Effect.orDie
        )
        const withoutCheck = yield* Effect.flip(unchecked.resume(runId))
        const ownerAlive = yield* Effect.flip((yield* successor("mac", true)).resume(runId))
        const leaseFresh = yield* Effect.flip((yield* successor("mac", false)).resume(runId))
        // The dead owner's lease runs out.
        yield* sql`UPDATE flows_runs SET heartbeat_at_ms = heartbeat_at_ms - 60000 WHERE run_id = ${runId}`
        const sameHost = yield* successor("mac", false)
        const taken = yield* sameHost.resume(runId)
        const fence = JSON.parse(yield* sameHost.claimFence(runId)) as Ownership.OwnerId
        const evicted = yield* Effect.flip(first.claimFence(runId))
        // Across hosts the claim rests on the expired lease alone.
        yield* sql`UPDATE flows_runs SET heartbeat_at_ms = heartbeat_at_ms - 60000 WHERE run_id = ${runId}`
        const otherHost = yield* successor("linux", false)
        const moved = yield* otherHost.resume(runId)
        const row = yield* store.get(runId)
        return { withoutCheck, ownerAlive, leaseFresh, taken, fence, evicted, moved, row, asked }
      }).pipe(Effect.provide(durable({ owner })), Effect.scoped, Effect.orDie)
    )

    expect(observed.withoutCheck).toBeInstanceOf(ClaimLost)
    expect(observed.ownerAlive).toBeInstanceOf(ClaimLost)
    expect(observed.leaseFresh).toBeInstanceOf(ClaimLost)
    expect(observed.taken.status).toBe("accepted")
    expect(observed.fence).toMatchObject({ hostId: "mac", pid: 202 })
    expect(observed.evicted).toBeInstanceOf(ClaimLost)
    expect(observed.moved.status).toBe("accepted")
    expect(observed.row.owner).toMatchObject({ hostId: "linux", pid: 202 })
    expect(observed.asked).toEqual([
      "mac:101 asked by mac",
      "mac:101 asked by mac",
      "mac:101 asked by mac",
      "mac:202 asked by linux"
    ])
  })

  it("lets exactly one of two concurrent resumes claim a parked run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "control-resume-race-"))
    try {
      await Effect.runPromise(
        Effect.gen(function*() {
          const filename = join(directory, "race.sqlite")
          const owners = [
            { hostId: "first", pid: 1, nonce: "first" },
            { hostId: "second", pid: 2, nonce: "second" }
          ] as const
          // Each build opens its own connection and writer over the same file.
          const firstServices = yield* Layer.build(durable({ database: fileBundle(filename), owner: owners[0] }))
          const secondServices = yield* Layer.build(durable({ database: fileBundle(filename), owner: owners[1] }))
          expect(Context.get(firstServices, SqlClient.SqlClient)).not.toBe(
            Context.get(secondServices, SqlClient.SqlClient)
          )
          const runtimes = [Context.get(firstServices, ControlRuntime), Context.get(secondServices, ControlRuntime)]
          const first = runtimes[0]!
          const second = runtimes[1]!
          const { runId } = yield* started.pipe(Effect.provide(firstServices))
          const firstFence = yield* first.claimFence(runId)
          yield* park(first, runId)
          yield* second.resume(runId)
          const secondFence = yield* second.claimFence(runId)
          yield* park(second, runId)
          const spentFences = [firstFence, secondFence]
          const ready = yield* Deferred.make<void>()
          let arrivals = 0
          const resumes = yield* Effect.all(
            runtimes.map((runtime) =>
              Effect.gen(function*() {
                if (++arrivals === 2) yield* Deferred.succeed(ready, undefined)
                yield* Deferred.await(ready)
                return yield* Effect.exit(runtime.resume(runId))
              })
            ),
            { concurrency: 2 }
          )
          const persisted = yield* Context.get(firstServices, RunStore.RunStore).get(runId)
          expect(persisted.status).toBe("running")
          expect(persisted.owner).not.toBeNull()
          const fences = yield* Effect.all(runtimes.map((runtime) => Effect.exit(runtime.claimFence(runId))))
          expect(resumes.filter(Exit.isSuccess)).toHaveLength(1)
          expect(fences.filter(Exit.isSuccess)).toHaveLength(1)
          const writes = yield* Effect.all(runtimes.map((runtime, index) => {
            const fence = fences[index]!
            return Effect.exit(runtime.writeStatus(
              runId,
              Exit.isSuccess(fence) ? fence.value : spentFences[index]!,
              "running"
            ))
          }))
          expect(writes.filter(Exit.isSuccess)).toHaveLength(1)
          for (let index = 0; index < runtimes.length; index++) {
            const resumed = resumes[index]!
            const fence = fences[index]!
            const written = writes[index]!
            if (owners[index]!.hostId === persisted.owner!.hostId) {
              expect(Exit.isSuccess(resumed)).toBe(true)
              expect(Exit.isSuccess(fence)).toBe(true)
              expect(Exit.isSuccess(written)).toBe(true)
              if (Exit.isSuccess(fence)) expect(JSON.parse(fence.value)).toEqual(persisted.owner)
            } else {
              expect(yield* Effect.flip(resumed)).toBeInstanceOf(ClaimLost)
              expect(yield* Effect.flip(fence)).toBeInstanceOf(ClaimLost)
              expect(yield* Effect.flip(written)).toBeInstanceOf(ClaimLost)
            }
          }
          expect((yield* Context.get(secondServices, RunStore.RunStore).get(runId)).owner).toEqual(persisted.owner)
        }).pipe(Effect.scoped, Effect.orDie)
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { spelling: "resume", launched: true },
    { spelling: "run", launched: true },
    { spelling: "resume", launched: false },
    { spelling: "run", launched: false }
  ])("journals explicit $spelling without approval delegation (launched=$launched)", async ({ spelling, launched }) => {
    const offered: string[] = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const sql = yield* SqlClient.SqlClient
        const store = yield* RunStore.RunStore
        const { runId } = yield* started
        yield* park(runtime, runId)
        // An engine-created row has no entry in the control launch index.
        if (!launched) yield* sql`DELETE FROM control_runs WHERE run_id = ${runId}`
        const before = yield* store.get(runId)
        const input = { runId, idempotencyKey: "resume:explicit" }
        const receipt = yield* spelling === "resume"
          ? control.resume(input)
          : control.run({ _tag: "Resume", ...input })
        expect(receipt._tag).toBe("Accepted")
        expect(yield* runtime.pendingResumes).toEqual([])
        expect(offered).toEqual([])
        const after = yield* store.get(runId)
        if (launched) {
          expect(after.status).toBe("running")
          expect((yield* runtime.getRun(runId)).status).toBe("accepted")
        } else {
          expect(after).toEqual(before)
          expect(yield* Effect.flip(runtime.claimFence(runId))).toBeInstanceOf(ClaimLost)
        }
        const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        expect(events.filter((event) => event.kind === "control.run.resume")).toHaveLength(2)
        expect(events.some((event) => event.kind === "control.run.resumed")).toBe(false)
      }).pipe(
        Effect.provide(durable({
          executor: {
            ...ControlExecutor.makeNoop(),
            resumeRun: ({ runId }) =>
              Effect.sync(() => {
                offered.push(runId)
                return "unknown" as const
              })
          }
        })),
        Effect.scoped,
        Effect.orDie
      )
    )
  })

  it.each(["accepted", "running"] as const)(
    "joins its own %s run and keeps the original fence usable",
    async (status) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const runtime = yield* ControlRuntime
          const { runId } = yield* started
          const fence = yield* runtime.claimFence(runId)
          if (status === "running") yield* runtime.writeStatus(runId, fence, status)
          const before = yield* runtime.getRun(runId)
          expect(yield* runtime.resume(runId)).toEqual(before)
          expect(yield* runtime.claimFence(runId)).toBe(fence)
          expect((yield* runtime.writeStatus(runId, fence, "completed")).status).toBe("completed")
        }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
      )
    }
  )

  it("refuses to interrupt a live run this process does not own", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        const { runId } = yield* started
        yield* park(first, runId)
        yield* second.resume(runId)
        const fence = yield* second.claimFence(runId)
        // Running, and owned by the peer: the terminal short-circuit B-12 adds
        // cannot answer this one, so the ownership check still has to.
        yield* second.writeStatus(runId, fence, "running")
        const interrupted = yield* first.interrupt(runId).pipe(Effect.flip)
        const evicted = yield* first.claimFence(runId).pipe(Effect.flip)
        return { interrupted, evicted }
      })
    )

    expect(observed.interrupted).toBeInstanceOf(ClaimLost)
    expect(observed.evicted).toBeInstanceOf(ClaimLost)
  })

  it("reports unknown ids and unknown flows as typed failures", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const missingFlow = yield* runtime.plan({ flowId: "system/nope", input: {} }).pipe(Effect.flip)
        const missingRun = yield* runtime.registerFiber(
          "run-absent",
          yield* Effect.void.pipe(Effect.forkChild({ startImmediately: true }))
        ).pipe(Effect.flip)
        const missingSignal = yield* runtime.deliveredSignals("run-absent").pipe(Effect.flip)
        const missingSignalWrite = yield* runtime.deliverSignal("run-absent", {
          name: "missing",
          payload: null
        }).pipe(Effect.flip)
        const badFence = yield* runtime.writeStatus("run-absent", "not json", "running").pipe(Effect.flip)
        return { missingFlow, missingRun, missingSignal, missingSignalWrite, badFence }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.missingFlow._tag).toBe("/control/FlowNotFound")
    expect(observed.missingRun).toBeInstanceOf(RunNotFound)
    expect(observed.missingSignal).toBeInstanceOf(RunNotFound)
    expect(observed.missingSignalWrite).toBeInstanceOf(RunNotFound)
    expect(observed.badFence).toBeInstanceOf(RunNotFound)
  })

  it("replays a plan for a repeated idempotency key and rejects a reused one", async () => {
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime
        const first = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "k" })
        const replay = yield* runtime.plan({ flowId: "system/test", input: { a: 1 }, idempotencyKey: "k" })
        const reused = yield* runtime.plan({ flowId: "system/test", input: { a: 2 }, idempotencyKey: "k" }).pipe(
          Effect.flip
        )
        const principal = yield* runtime.stampPrincipal()
        const flows = yield* runtime.listFlows
        return { first, replay, reused, principal, flows }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.first.created).toBe(true)
    expect(observed.replay).toEqual({ card: observed.first.card, created: false })
    expect(observed.reused._tag).toBe("/control/InvalidInput")
    expect(observed.principal.id).toBe("local")
    expect(observed.flows.length).toBeGreaterThan(0)
  })

  it("stamps a submitted principal over the composition's own", async () => {
    // The durable twin of the memory runtime's precedence. `Control.ts` says
    // the runtime supplies its own principal when the caller names none, so a
    // named one wins; the reverse would rename a server-authenticated operator
    // to whatever the host was composed with.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const composed = yield* SqlControlRuntime.make({ principal: { id: "composed", kind: "host" } }).pipe(
          Effect.orDie
        )
        const submitted = yield* composed.stampPrincipal({ id: "remote", kind: "bearer", stampedAt: 99 })
        const unnamed = yield* composed.stampPrincipal()
        return { submitted, unnamed }
      }).pipe(Effect.provide(durable()), Effect.scoped, Effect.orDie)
    )

    expect(observed.submitted).toMatchObject({ id: "remote", kind: "bearer" })
    expect(observed.submitted.stampedAt).not.toBe(99)
    expect(observed.unnamed).toMatchObject({ id: "composed", kind: "host" })
  })

  it("records and replays a mutation receipt across runtimes", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        yield* first.recordMutation("mut", "fp", { _tag: "Accepted", receiptId: "r", runId: "run-1" })
        const hit = yield* second.lookupMutation("mut", "fp")
        const miss = yield* second.lookupMutation("other", "fp")
        return { hit, miss }
      })
    )

    expect(observed.hit).toEqual({ _tag: "AlreadyApplied", receiptId: "r", runId: "run-1" })
    expect(observed.miss).toBeUndefined()
  })

  it("never lets a racing mutation overwrite the first durable receipt", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        yield* first.recordMutation("mut", "first", { _tag: "Accepted", receiptId: "first" })
        const rejected = yield* Effect.flip(
          second.recordMutation("mut", "second", { _tag: "Accepted", receiptId: "second" })
        )
        const retained = yield* second.lookupMutation("mut", "first")
        return { rejected, retained }
      })
    )

    expect(observed.rejected).toBeInstanceOf(PersistenceError)
    expect(observed.retained).toEqual({ _tag: "AlreadyApplied", receiptId: "first" })
  })

  it("allows a concurrent write while a finite snapshot page is being consumed", async () => {
    const pageStarted = Deferred.makeUnsafe<void>()
    const releasePage = Deferred.makeUnsafe<void>()
    let held = false
    const observedJournal = Layer.effect(
      Journal.Journal,
      Effect.map(Journal.Journal, (journal) =>
        Journal.make({
          ...journal,
          entries: (options) =>
            Effect.suspend(() => {
              if (held || options.limit !== 1024) return journal.entries(options)
              held = true
              return Deferred.succeed(pageStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releasePage)),
                Effect.andThen(journal.entries(options))
              )
            })
        }))
    )
    const runtime = SqlControlRuntime.layer().pipe(Layer.orDie)
    const notifications = NotificationQueue.layer.pipe(Layer.provide(observedJournal))
    const control = ControlLive.layer.pipe(
      Layer.provide([
        runtime,
        observedJournal,
        notifications,
        ControlExecutor.layerNoop(),
        Registry.layerNoop()
      ]),
      Layer.provideMerge(Layer.merge(durableJournal, NodeCrypto.layer))
    ) as Layer.Layer<Control>

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const { runId } = yield* started
        // A few seeds are enough: the page is held before it reads, so the
        // property under test is that holding it blocks no writer.
        for (let index = 0; index < 3; index++) {
          yield* control.signal({
            runId,
            signal: { name: `seed-${index}`, payload: null },
            idempotencyKey: `signal:seed-${index}`
          })
        }

        const snapshot = yield* control.watch({ runId, follow: false }).pipe(
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(pageStarted)
        // A writer blocked by the held page never settles, and the test
        // timeout reports it; a wall-clock bound here false-reds under load.
        const receipt = yield* control.signal({
          runId,
          signal: { name: "during-snapshot", payload: null },
          idempotencyKey: "signal:during-snapshot"
        })
        yield* Deferred.succeed(releasePage, undefined)
        const events = yield* Fiber.join(snapshot)
        return { events, receipt }
      }).pipe(
        Effect.provide(control),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.receipt._tag).toBe("Accepted")
    const signalNames = observed.events
      .filter((event) => event.kind === "control.signal.admitted")
      .map((event) => (event.payload as { readonly name: string }).name)
    expect(signalNames).toEqual(["seed-0", "seed-1", "seed-2"])
    expect(signalNames).not.toContain("during-snapshot")
  })

  it("hands both racers of a same-key plan the same card", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        const request = { flowId: "system/test", input: { suite: "race" }, idempotencyKey: "plan:race" }
        // `control_plan_keys.idempotency_key` is a primary key. Two runtimes
        // planning under one key used to make the loser fail the insert, so a
        // second operator asking for the same plan got a PersistenceError
        // instead of the card the key promises.
        return yield* Effect.all(
          [Effect.exit(first.plan(request)), Effect.exit(second.plan(request))],
          { concurrency: 2 }
        )
      })
    )

    const succeeded = observed.filter((exit) => exit._tag === "Success")
    expect(succeeded).toHaveLength(2)
    const answers = succeeded.map((exit) =>
      (exit as {
        readonly value: {
          readonly card: { readonly planId: string; readonly digest: string }
          readonly created: boolean
        }
      }).value
    )
    expect(new Set(answers.map((answer) => answer.card.planId)).size).toBe(1)
    expect(new Set(answers.map((answer) => answer.card.digest)).size).toBe(1)
    expect(answers.filter((answer) => answer.created)).toHaveLength(1)
  })

  it("still refuses a reused plan key that names a different intent", async () => {
    const observed = await twoOwners((first, second) =>
      Effect.gen(function*() {
        yield* first.plan({ flowId: "system/test", input: { suite: "one" }, idempotencyKey: "plan:reused" })
        return yield* Effect.exit(
          second.plan({ flowId: "system/test", input: { suite: "two" }, idempotencyKey: "plan:reused" })
        )
      })
    )

    expect(observed._tag).toBe("Failure")
  })

  it("owns no Node imports", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/SqlControlRuntime.ts", import.meta.url), "utf8")
    )
    expect(source).not.toMatch(/(?:from|import\s*)\s*["']node:/)
    expect(source).not.toContain(["@effect", "platform-node"].join("/"))
  })
})

it("commits the run and its idempotency receipt before handing it to the executor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "control-admission-"))
  const schema = directory.split("/").at(-1)!.replaceAll("-", "_")
  const postgres = process.env.SMITHERS_TEST_PG_URL ? new URL(process.env.SMITHERS_TEST_PG_URL) : undefined
  postgres?.searchParams.set("schema", schema)
  const filename = postgres?.toString() ?? join(directory, "control.db")
  let launches = 0
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const peer = Context.get(yield* Layer.build(NodeDatabase.layer({ filename })), SqlClient.SqlClient)
      if (postgres) yield* Effect.addFinalizer(() => peer`DROP SCHEMA ${peer(schema)} CASCADE`.pipe(Effect.orDie))
      const executor = ControlExecutor.makeNoop({
        launch: ({ run }) =>
          Effect.gen(function*() {
            launches++
            // A separate connection cannot read the writer's uncommitted row.
            const rows = yield* peer`SELECT run_id FROM flows_runs WHERE run_id = ${run.runId}`
            expect(rows).toEqual([{ run_id: run.runId }])
            const receipts = yield* peer`SELECT receipt_json FROM control_mutations`
            expect(receipts.some((row) => JSON.parse(String(row.receipt_json)).runId === run.runId)).toBe(true)
            return "accepted" as const
          }).pipe(Effect.orDie)
      })
      const services = yield* Layer.build(durable({ database: fileBundle(filename), executor }))
      const control = Context.get(services, Control)
      const card = yield* control.plan({ flowId: "system/test", input: {} })
      yield* control.approve({ ...card.approval, idempotencyKey: "approve:visible" })
      const input = {
        _tag: "Plan" as const,
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:visible"
      }
      const receipt = yield* control.run(input)
      expect(receipt._tag).toBe("Accepted")
      expect((yield* control.run(input))._tag).toBe("AlreadyApplied")
      expect(launches).toBe(1)
    })))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

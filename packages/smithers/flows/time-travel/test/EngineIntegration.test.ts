/**
 * Time travel over a journal an ORDINARY ENGINE RUN wrote.
 *
 * Every other suite in this package hand-authors the evidence it folds. That
 * made the whole feature untested against its only real producer, and it hid
 * the defect this file exists to pin: nothing in the engine populated
 * `meta.lineageId`, so `inspect` failed `not_found` on every production
 * journal, and a fork read the parent's CURRENT state and ALL of its attempts
 * rather than the ones its frame can explain.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import type * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import * as EngineStoreExports from "@smthrs/engine-store"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as PlanScheduler from "@smthrs/engine-store/PlanScheduler"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as CompensationHandlers from "../src/CompensationHandlers.ts"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravel } from "../src/TimeTravel.ts"
import type { TimeTravelError } from "../src/TimeTravelError.ts"

/**
 * The declared step the flow's body names.
 *
 * The composite handler this suite always had is ONE declared action rather
 * than four body nodes. What is under
 * test is time travel over an engine-written journal, so the fixture keeps the
 * action mix and the ordering the evidence assertions are written against;
 * decomposing it would rewrite the evidence rather than migrate the authoring
 * shape. The body still names an action instead of carrying code.
 */
const Post = Action.make("time-travel/Post", { payload: {}, success: Schema.String })
const Ledger = Flow.make("time-travel/Ledger", {
  payload: {},
  success: Schema.String,
  body: (payload) => Post.call(payload)
})
const Settled = DurableDeferred.make("time-travel/settled", { success: Schema.String })

/** The irreversible action whose boundary records a rewind has to assess. */
const notifyKind = "time-travel/Notify"

/**
 * Records every jj call so the tests can assert the workspace a fork lands in
 * is restored to the FRAME's pointer, not left at the parent's tree.
 */
const recordingJj = (calls: Array<string>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: (message) =>
        Effect.sync(() => {
          calls.push(`snapshot:${message}`)
          // A distinct change id: the engine must journal the commit id.
          return { commitId: `change-${calls.length}` as never, changeId: `moving-${calls.length}` as never }
        }),
      restore: (changeId) => Effect.sync(() => void calls.push(`restore:${changeId}`)),
      diff: () => Effect.succeed(""),
      workspaceAdd: (name, _path, revision) =>
        Effect.sync(() => void calls.push(`add:${name}${revision === undefined ? "" : `@${revision}`}`)),
      workspaceForget: (name) => Effect.sync(() => void calls.push(`forget:${name}`)),
      status: () => Effect.succeed("")
    })
  )

interface Harness {
  readonly notifications: Array<string>
  readonly jjCalls: Array<string>
}

/**
 * The production composition, over an in-memory database.
 *
 * `EngineStore.layer` is the real one — the same wiring an application uses —
 * which is the whole point: the lineage metadata under test has to be minted by
 * the engine itself, not by the test.
 */
const engineLayer = (harness: Harness, handlers: ReadonlyArray<CompensationHandlers.Handler>) => {
  const Credit = Action.make({
    name: "time-travel/Credit",
    success: Schema.Number,
    tier: "sealed",
    idempotencyKey: "time-travel/credit/v1",
    execute: Effect.succeed(30)
  })
  const Notify = Action.make({
    name: notifyKind,
    success: Schema.String,
    tier: "irreversible",
    idempotencyKey: "time-travel/notify/v1",
    execute: Effect.sync(() => {
      harness.notifications.push("sent")
      return "sent"
    })
  })
  // A compensable action is what OWNS a workspace pointer: the engine
  // snapshots the tree before it runs. Every later frame carries that pointer
  // forward, which is what gives a sealed action's frame a tier-2 address at
  // all.
  const Stage = Action.make({
    name: "time-travel/Stage",
    success: Schema.String,
    tier: "compensable",
    idempotencyKey: "time-travel/stage/v1",
    execute: Effect.succeed("staged")
  })
  const post = () =>
    Effect.gen(function*() {
      yield* Stage
      const amount = yield* Credit
      const receipt = yield* Notify
      const settled = yield* DurableDeferred.await(Settled)
      return `${amount}:${receipt}:${settled}`
    })

  const stores = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)))

  return Layer.mergeAll(Post.toLayer(post), Interpreter.layer(Ledger)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(TimeTravel.layer),
    Layer.provideMerge(CompensationHandlers.layer(handlers)),
    Layer.provideMerge(SqlTimeTravelStore.layer),
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: "time-travel-test" },
        journalSource: "time-travel-test",
        isAlive: () => Effect.succeed(false)
      })
    ),
    Layer.provideMerge(
      // NodeCrypto feeds the merged stack rather than sitting beside it:
      // OwnerIdentity.layer consumes the Crypto service at construction.
      Layer.mergeAll(
        stores,
        StepBoundary.layerTest(),
        recordingJj(harness.jjCalls),
        OwnerIdentity.layer
      ).pipe(Layer.provideMerge(NodeCrypto.layer))
    ),
    Layer.provideMerge(TestDatabase.layer)
  )
}

/**
 * What driving the flow asks of the environment. Inferred from the flow rather
 * than spelled out, so a body that re-executes the run after a rewind does not
 * have to name the interpreter's own services — and does not go stale when they
 * change.
 */
type LedgerServices = ReturnType<typeof Ledger.execute> extends Effect.Effect<infer _A, infer _E, infer R> ? R
  : never

const drive = <A, E>(
  handlers: ReadonlyArray<CompensationHandlers.Handler>,
  body: (harness: Harness) => Effect.Effect<
    A,
    E,
    | DurableWriter.DurableWriter
    | DurableEngineState.DurableEngineState
    | Journal.Journal
    | LedgerServices
    | RunStore.RunStore
    | SqlClient.SqlClient
    | TimeTravel
  >
) => {
  const harness: Harness = { notifications: [], jjCalls: [] }
  return Effect.gen(function*() {
    // Park the run at the deferred. It releases ownership on the way out,
    // which is the only state a rewind accepts.
    const running = yield* Ledger.execute({}, { executionId: "ledger-1" }).pipe(Effect.forkChild)
    const runs = yield* RunStore.RunStore
    // Parking is database I/O, which no count of scheduler turns waits for
    // on a server database.
    yield* TestDatabase.until(
      runs.get("ledger-1").pipe(
        Effect.option,
        Effect.map((row) => Option.isSome(row) && row.value.status === "suspended")
      )
    )
    expect((yield* runs.get("ledger-1")).status).toBe("suspended")
    // A rewind requires a quiescent executor. Stop this caller's automatic
    // resume loop while retaining the registered flow for the later replay.
    yield* Fiber.interrupt(running)
    const journal = yield* Journal.Journal
    yield* journal.flush
    return yield* body(harness)
  }).pipe(
    Effect.provide(engineLayer(harness, handlers)),
    Effect.scoped
  )
}

const entries = Effect.gen(function*() {
  const journal = yield* Journal.Journal
  const page = yield* journal.entries({ runId: "ledger-1" as JournalEvent.RunId, limit: 200 })
  return page.entries
})

/**
 * The run's root journal lineage, taken from the constructor that mints it.
 *
 * Re-derived on 2026-09-01. `FlowEngine.Lineage` moved the root address from
 * `<runId>/root` to a versioned encoded tuple so no two runs and node paths can
 * name one durable record. These frames used to spell the old form as a
 * literal, which addressed a lineage the engine no longer writes. Reading it
 * from the constructor keeps the frames tracking the encoding instead of one
 * spelling of it.
 */
const ledgerLineage = FlowEngine.Lineage.root("ledger-1")

/** The seq of the `nth` (1-based) record of `eventType`, which is where frames land. */
const seqOf = (
  committed: ReadonlyArray<JournalEvent.Entry>,
  eventType: string,
  nth = 1
): number => committed.filter((entry) => entry.eventType === eventType)[nth - 1]!.seq

const rewindWhenIdle = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    let result: A | undefined
    yield* TestDatabase.until(effect.pipe(
      Effect.map((value) => {
        result = value
        return true
      }),
      Effect.catch((error) => error.code === "busy" ? Effect.succeed(false) : Effect.fail(error))
    ))
    return result as A
  })

describe("time travel over an engine-written journal", () => {
  it("exports the engine record names consumed by time travel", () => {
    expect(EngineStoreExports).toHaveProperty("EventTypes", {
      runDecision: "flows.engine.run-decision",
      attemptStarted: "flows.engine.attempt-started",
      snapshotIdentified: "flows.engine.snapshot-identified",
      planRecorded: "flows.engine.plan-recorded",
      subgraphAppended: "flows.engine.subgraph-appended",
      deferredCompleted: "flows.engine.deferred-completed",
      clockScheduled: "flows.engine.clock-scheduled",
      childSpawnKind: "flows/engine-store/child-spawn"
    })
  })

  it.effect("writes every shared time-travel record name through the real engine", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const scope = yield* Effect.scope
        const engine = yield* FlowRuntime.FlowRuntime
        yield* Ledger.execute({}, { executionId: "ledger-1", discard: true })
        yield* engine.deferredDone(Settled, {
          flowName: Ledger._tag,
          executionId: "ledger-1",
          deferredName: Settled.name,
          exit: Exit.succeed("settled")
        })

        const started = yield* Deferred.make<void>()
        const child = Flow.make("time-travel/ContractChild", {
          payload: {},
          success: Schema.String,
          body: () => Post.call({})
        })
        const parent = Flow.make("time-travel/ContractParent", {
          payload: {},
          success: Schema.String,
          body: () => Post.call({})
        })
        yield* engine.register(child, () => Deferred.succeed(started, undefined).pipe(Effect.as("done")))
        yield* engine.register(parent, () =>
          Effect.gen(function*() {
            yield* engine.execute(child, { executionId: "contract-child", payload: {}, discard: true }).pipe(
              Effect.forkIn(scope)
            )
            yield* Deferred.await(started)
            yield* DurableClock.sleep({ name: "contract-clock", duration: 1000, inMemoryThreshold: 0 })
            return "done"
          }))
        yield* engine.execute(parent, { executionId: "contract-parent", payload: {}, discard: true })

        const runs = yield* RunStore.RunStore
        const owner = { hostId: "contract-test", pid: 1, nonce: "contract-test" }
        yield* runs.create("contract-plan", "{}")
        const row = yield* runs.get("contract-plan")
        yield* runs.claimAndOwn(
          "contract-plan",
          {
            status: row.status,
            owner: row.owner,
            heartbeatAtMs: row.heartbeatAtMs
          },
          owner,
          0
        )
        const draft = (id: string): Plan.NodeDraft => ({
          id,
          material: {
            version: KeyMaterial.version,
            kind: "sealed",
            body: id,
            inputs: [],
            layers: [],
            capabilities: []
          },
          effects: { reads: [], writes: [], boundaryMode: "hard" }
        })
        const plan = yield* Plan.compile({ planId: "contract-plan", flow: "contract", nodes: [draft("root")] })
        const scheduler = PlanScheduler.make({ runId: "contract-plan", owner, sourceId: "contract-test" })
        yield* scheduler.record(plan)
        yield* scheduler.append(yield* Plan.append(plan, [draft("child")]))

        const journal = yield* Journal.Journal
        yield* journal.flush
        const names = new Set<string>()
        for (const runId of ["ledger-1", "contract-parent", "contract-plan"]) {
          const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 200 })
          for (const entry of page.entries) {
            names.add(entry.eventType)
            if (entry.eventType === EffectBoundary.eventType) {
              const kind = (entry.payload as { effect?: { kind?: string } }).effect?.kind
              if (kind !== undefined) names.add(kind)
            }
          }
        }
        expect([...names]).toEqual(expect.arrayContaining(Object.values(EngineStoreExports.EventTypes)))
      }).pipe(
        Effect.provide(PlanStore.layer),
        Effect.provide(engineLayer({ notifications: [], jjCalls: [] }, []))
      )
    ))

  it.effect("blocks rewind past a real detached spawn while the child is running", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const scope = yield* Effect.scope
        const childStarted = yield* Deferred.make<void>()
        const releaseChild = yield* Deferred.make<string>()
        const child = Flow.make("time-travel/Spawned", {
          payload: {},
          success: Schema.String,
          body: () => Post.call({})
        })
        const parent = Flow.make("time-travel/Spawner", {
          payload: {},
          success: Schema.String,
          body: () => Post.call({})
        })
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(child, () =>
          Deferred.succeed(childStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseChild))))
        yield* engine.register(parent, () =>
          Effect.gen(function*() {
            yield* Action.make({
              name: "time-travel/SpawnStage",
              tier: "compensable",
              success: Schema.Void,
              idempotencyKey: "spawn-stage",
              execute: Effect.void
            })
            yield* engine.execute(child, { executionId: "spawn-child", payload: {}, discard: true }).pipe(
              Effect.forkIn(scope)
            )
            yield* Deferred.await(childStarted)
            return yield* DurableDeferred.await(Settled)
          }))
        // A rewind requires a quiescent executor, so this caller owns the
        // parent's execution and stops it once the run parks. Submitting the
        // parent as a DISCARDED execution put its follow loop in the
        // registration scope, out of this caller's reach: the loop re-drove
        // the parked run, writing a claim, a resume and a park, while the
        // rewind was validating, and the rewind then refused the moved journal
        // tail with `busy` instead of ever assessing the live child.
        const running = yield* engine.execute(parent, { executionId: "spawn-parent", payload: {} }).pipe(
          Effect.forkChild
        )
        const runs = yield* RunStore.RunStore
        yield* TestDatabase.until(
          runs.get("spawn-parent").pipe(
            Effect.option,
            Effect.map((row) =>
              Option.isSome(row) && row.value.status === "suspended"
            )
          )
        )
        yield* Fiber.interrupt(running)
        expect((yield* runs.get("spawn-child")).status).toBe("running")
        expect((yield* runs.get("spawn-parent")).status).toBe("suspended")
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "spawn-parent" as JournalEvent.RunId, limit: 100 })
        const spawn = page.entries.find((entry) =>
          entry.eventType === "flows.time-travel.effect-boundary"
          && (entry.payload as { effect?: { kind?: string } }).effect?.kind === "flows/engine-store/child-spawn"
        )!
        expect(spawn).toBeDefined()
        const frame = { lineageId: FlowEngine.Lineage.root("spawn-parent"), seq: spawn.seq - 1 }
        const store = yield* SqlTimeTravelStore.make
        expect(yield* store.descendants("spawn-parent", frame)).toEqual({
          attached: [],
          detached: [{
            parentRunId: "spawn-parent",
            parentSeq: spawn.seq,
            childRunId: "spawn-child",
            kind: "child",
            attached: false
          }]
        })
        const timeTravel = yield* TimeTravel
        expect(yield* Effect.flip(timeTravel.rewind({ runId: "spawn-parent", frame }))).toMatchObject({
          code: "live_child"
        })
        yield* Deferred.succeed(releaseChild, "done")
      }).pipe(Effect.provide(engineLayer({ notifications: [], jjCalls: [] }, [])))
    ))

  it.effect("folds an ordinary engine journal with no hand-emitted metadata", () =>
    Effect.gen(function*() {
      const result = yield* drive([], () =>
        Effect.gen(function*() {
          const committed = yield* entries
          const timeTravel = yield* TimeTravel
          const attempts = yield* timeTravel.inspect(
            { runId: "ledger-1", frame: { lineageId: ledgerLineage, seq: committed.at(-1)!.seq } },
            {
              initial: 0,
              reduce: (state: number, entry) => entry.eventType === "flows.engine.attempt-started" ? state + 1 : state
            }
          )
          return {
            attempts,
            lineages: [...new Set(committed.map((entry) => (entry.meta as { lineageId?: string }).lineageId))],
            anchored: committed.filter((entry) => entry.eventType === "flows.engine.snapshot-identified").length
          }
        }))

      // The engine minted one lineage for the run and stamped it on every record.
      expect(result.lineages).toEqual([ledgerLineage])
      // Four dispatches, and the fold saw them: the body's own step, then the
      // three actions its implementation runs before the deferred parks it.
      expect(result.attempts).toBe(4)
      // Every frame carries a tier-2 anchor, not just the compensable one.
      expect(result.anchored).toBe(4)
    }))

  it.effect("forks at a frame with the state and attempts of THAT frame, and spares the parent's tree", () =>
    Effect.gen(function*() {
      const result = yield* drive([], (harness) =>
        Effect.gen(function*() {
          const committed = yield* entries
          // Cut when the compensable and sealed actions had settled and the
          // irreversible one had not yet been admitted.
          const frameSeq = seqOf(committed, "flows.engine.attempt-finished", 2)
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const timeTravel = yield* TimeTravel
          const fork = yield* timeTravel.fork({
            runId: "ledger-1",
            frame: { lineageId: ledgerLineage, seq: frameSeq }
          })
          const state = yield* sql<{ readonly run_id: string; readonly state_json: string }>`
          SELECT run_id, state_json FROM flows_runs WHERE run_id IN ('ledger-1', ${fork.runId})
        `
          const attempts = yield* sql<{ readonly run_id: string; readonly step_key_digest: string }>`
          SELECT run_id, step_key_digest FROM flows_attempts
          WHERE run_id IN ('ledger-1', ${fork.runId})
        `
          return {
            fork,
            parentState: state.find((row) => row.run_id === "ledger-1")!.state_json,
            childState: state.find((row) => row.run_id === fork.runId)!.state_json,
            parentAttempts: attempts.filter((row) => row.run_id === "ledger-1").length,
            childAttempts: attempts.filter((row) => row.run_id === fork.runId).length,
            jjCalls: [...harness.jjCalls]
          }
        }))

      expect(result.fork.edge).toMatchObject({ parentRunId: "ledger-1", kind: "fork", attached: false })
      // The child's state is the state AT the frame, so it differs from the
      // parent's current state (which the parent kept driving past).
      expect(result.childState).not.toBe(result.parentState)
      // The parent recorded four attempts — the body's step and the three
      // actions under it; the child inherits only the ones its copied prefix
      // can explain.
      expect(result.parentAttempts).toBe(4)
      expect(result.childAttempts).toBe(3)
      // The fork gets its OWN workspace and leaves the parent's tree alone:
      // `Jj.restore` acts on the one working copy the layer is rooted at, so a
      // fork that called it would restore the parent, which a fork never
      // touches. The child lane is pinned at
      // the frame's recorded pointer at provisioning time instead:
      // `workspaceAdd` carries the revision.
      const add = result.jjCalls.find((call) => call.startsWith("add:"))
      expect(add).toBeDefined()
      expect(add).toContain("@change-")
      expect(result.jjCalls.some((call) => call.startsWith("restore:"))).toBe(false)
      expect(result.fork.warnings.join(" ")).not.toContain("lane default")
      // The irreversible effect the fork carried past is disclosed, never reverted.
      expect(result.fork.warnings.join(" ")).toContain(notifyKind)
      expect(result.fork.warnings.join(" ")).toContain("may execute again on the child")
    }))

  it.effect("blocks a rewind across an irreversible effect with no handler", () =>
    Effect.gen(function*() {
      const failure = yield* drive([], () =>
        Effect.gen(function*() {
          const committed = yield* entries
          const frameSeq = seqOf(committed, "flows.time-travel.effect-boundary") - 1
          const timeTravel = yield* TimeTravel
          return yield* Effect.flip(
            timeTravel.rewind({ runId: "ledger-1", frame: { lineageId: ledgerLineage, seq: frameSeq } })
          )
        }))

      expect((failure as TimeTravelError).code).toBe("irreversible")
    }))

  it.effect("compensates the same rewind once the engine composition contributes a handler", () =>
    Effect.gen(function*() {
      const reverted: Array<string> = []
      const result = yield* drive([{
        kind: notifyKind,
        tier: "irreversible",
        residue: (effect) => `Notification ${effect.id} was retracted, not un-sent.`,
        revert: (effect) =>
          Effect.sync(() => {
            reverted.push(effect.id)
            return { retracted: effect.id }
          }),
        // A retraction cannot itself be retracted; saying so is the point.
        rollback: () => Effect.void
      }], () =>
        Effect.gen(function*() {
          const committed = yield* entries
          const frameSeq = seqOf(committed, "flows.time-travel.effect-boundary") - 1
          const timeTravel = yield* TimeTravel
          const rewound = yield* timeTravel.rewind({
            runId: "ledger-1",
            frame: { lineageId: ledgerLineage, seq: frameSeq }
          })
          const remaining = yield* entries
          return { rewound, remaining: remaining.length, total: committed.length }
        }))

      expect(reverted).toHaveLength(1)
      expect(result.rewound.assessments.some((assessment) => assessment.classification === "revertible")).toBe(true)
      expect(result.rewound.archive.archived).toBeGreaterThan(0)
      expect(result.remaining).toBeLessThan(result.total)
    }))

  it.effect("parks a re-reached deferred after rewinding its completion", () =>
    Effect.gen(function*() {
      const result = yield* drive([], () =>
        Effect.gen(function*() {
          const beforeCompletion = yield* entries
          const frame = { lineageId: ledgerLineage, seq: beforeCompletion.at(-1)!.seq }
          const state = yield* DurableEngineState.DurableEngineState
          const journal = yield* Journal.Journal
          yield* journal.transact(
            Effect.gen(function*() {
              yield* state.completeDeferred({
                flowName: Ledger._tag,
                executionId: "ledger-1",
                deferredName: Settled.name,
                exit: Exit.succeed("discarded-future"),
                completedAtMs: 1
              })
              yield* journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: "ledger-1" as JournalEvent.RunId,
                  sourceId: "time-travel-test:discarded-completion" as JournalEvent.SourceId,
                  sourceSeq: 0 as JournalEvent.SourceSeq,
                  eventType: "flows.engine.deferred-completed",
                  payload: {
                    flowName: Ledger._tag,
                    executionId: "ledger-1",
                    deferredName: Settled.name,
                    exit: Exit.succeed("discarded-future")
                  },
                  meta: { lineageId: ledgerLineage }
                })
              )
            })
          )
          yield* journal.flush

          const timeTravel = yield* TimeTravel
          yield* timeTravel.rewind({ runId: "ledger-1", frame })
          yield* Ledger.execute({}, { executionId: "ledger-1", discard: true })

          const runs = yield* RunStore.RunStore
          const sql = yield* SqlClient.SqlClient
          return {
            row: yield* runs.get("ledger-1"),
            completions: yield* sql<{ readonly deferred_name: string }>`
              SELECT deferred_name FROM flows_deferred_completions
              WHERE execution_id = 'ledger-1'
            `
          }
        }))

      expect(result.row.status).toBe("suspended")
      expect(result.completions).toEqual([])
    }))
  it.effect("parks a completed approval again after rewinding from the next await", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const approval = Flow.make("time-travel/Approval", {
          payload: {},
          success: Schema.String,
          body: () => Post.call({})
        })
        const next = DurableDeferred.make("time-travel/next-approval", { success: Schema.String })
        let advances = 0
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(approval, () =>
          Effect.gen(function*() {
            yield* Action.make({
              name: "time-travel/ApprovalStage",
              tier: "compensable",
              success: Schema.Void,
              idempotencyKey: "approval-stage",
              execute: Effect.void
            })
            const approved = yield* DurableDeferred.await(Settled)
            advances++
            yield* DurableDeferred.await(next)
            return approved
          }))
        const execute = engine.execute(approval, { executionId: "approval-run", payload: {}, discard: true })
        yield* execute
        const journal = yield* Journal.Journal
        const before = yield* journal.entries({ runId: "approval-run" as JournalEvent.RunId, limit: 100 })
        const frame = { lineageId: FlowEngine.Lineage.root("approval-run"), seq: before.entries.at(-1)!.seq }
        yield* engine.deferredDone(Settled, {
          flowName: approval._tag,
          executionId: "approval-run",
          deferredName: Settled.name,
          exit: Exit.succeed("approved")
        })
        const runs = yield* RunStore.RunStore
        // The run is still `suspended` before the completion's re-drive claims
        // it, so the park that counts is the one after the step advanced.
        yield* TestDatabase.until(
          runs.get("approval-run").pipe(Effect.map((row) => advances > 0 && row.status === "suspended"))
        )
        expect((yield* runs.get("approval-run")).status).toBe("suspended")
        const state = yield* DurableEngineState.DurableEngineState
        let beforeRewind = advances
        expect(beforeRewind).toBeGreaterThan(0)
        const timeTravel = yield* TimeTravel
        yield* rewindWhenIdle(timeTravel.rewind({ runId: "approval-run", frame }))
        beforeRewind = advances
        yield* execute
        yield* TestDatabase.until(runs.get("approval-run").pipe(Effect.map((row) => row.status === "suspended")))
        expect((yield* runs.get("approval-run")).status).toBe("suspended")
        expect(advances).toBe(beforeRewind)
        expect(
          yield* state.deferred({ flowName: approval._tag, executionId: "approval-run", deferredName: Settled.name })
        )
          .toMatchObject({ _tag: "None" })
      }).pipe(Effect.provide(engineLayer({ notifications: [], jjCalls: [] }, [])))
    ))

  it.effect("re-arms a durable sleep after rewinding before it was scheduled", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const timer = Flow.make("time-travel/Timer", { payload: {}, success: Schema.String, body: () => Post.call({}) })
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(timer, () =>
          Effect.gen(function*() {
            yield* Action.make({
              name: "time-travel/TimerStage",
              tier: "compensable",
              success: Schema.Void,
              idempotencyKey: "timer-stage",
              execute: Effect.void
            })
            yield* DurableClock.sleep({ name: "rewind-sleep", duration: 1000, inMemoryThreshold: 0 })
            return yield* DurableDeferred.await(Settled)
          }))
        const execute = engine.execute(timer, { executionId: "clock-run", payload: {}, discard: true })
        yield* execute
        const journal = yield* Journal.Journal
        const before = yield* journal.entries({ runId: "clock-run" as JournalEvent.RunId, limit: 100 })
        const scheduled = before.entries.find((entry) => entry.eventType === "flows.engine.clock-scheduled")!
        const frame = { lineageId: FlowEngine.Lineage.root("clock-run"), seq: scheduled.seq - 1 }
        yield* TestClock.adjust(1000)
        const state = yield* DurableEngineState.DurableEngineState
        const address = { flowName: timer._tag, executionId: "clock-run", clockName: "rewind-sleep" }
        // Timer delivery wakes the driver; completion is persisted afterwards.
        yield* TestDatabase.until(
          state.clock(address).pipe(
            Effect.map((clock) => Option.isNone(clock) || clock.value.completedAtMs !== null)
          )
        )
        const clock = yield* state.clock(address)
        expect(clock).toMatchObject({ _tag: "Some", value: { completedAtMs: 1000 } })
        const timeTravel = yield* TimeTravel
        const runs = yield* RunStore.RunStore
        yield* TestDatabase.until(
          runs.get("clock-run").pipe(Effect.map((row) => row.status === "suspended" && row.owner === null))
        )
        yield* rewindWhenIdle(timeTravel.rewind({ runId: "clock-run", frame }))
        yield* execute
        expect(yield* state.clock(address)).toMatchObject({
          _tag: "Some",
          value: { dueAtMs: 2000, completedAtMs: null }
        })
        expect(yield* state.deferred({ ...address, deferredName: "DurableClock/rewind-sleep" })).toMatchObject({
          _tag: "None"
        })
        // The run parks on its timer again. A follower's elapsed poll re-drives
        // a timer park (only event parks are joined), so the status can leave
        // "suspended" between two reads; the wait itself is the assertion.
        yield* TestDatabase.until(runs.get("clock-run").pipe(Effect.map((row) => row.status === "suspended")))
      }).pipe(Effect.provide(engineLayer({ notifications: [], jjCalls: [] }, [])))
    ))

  it.effect("fires a durable sleep again after rewinding between its schedule and its completion", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const timer = Flow.make("time-travel/Timer", { payload: {}, success: Schema.String, body: () => Post.call({}) })
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(timer, () =>
          Effect.gen(function*() {
            yield* Action.make({
              name: "time-travel/TimerStage",
              tier: "compensable",
              success: Schema.Void,
              idempotencyKey: "timer-stage",
              execute: Effect.void
            })
            yield* DurableClock.sleep({ name: "rewind-sleep", duration: 1000, inMemoryThreshold: 0 })
            return yield* DurableDeferred.await(Settled)
          }))
        const execute = engine.execute(timer, { executionId: "fired-clock-run", payload: {}, discard: true })
        yield* execute
        const journal = yield* Journal.Journal
        const before = yield* journal.entries({ runId: "fired-clock-run" as JournalEvent.RunId, limit: 100 })
        const scheduled = before.entries.find((entry) => entry.eventType === "flows.engine.clock-scheduled")!
        const frame = { lineageId: FlowEngine.Lineage.root("fired-clock-run"), seq: scheduled.seq }
        yield* TestClock.adjust(1000)
        const state = yield* DurableEngineState.DurableEngineState
        const address = { flowName: timer._tag, executionId: "fired-clock-run", clockName: "rewind-sleep" }
        // Timer delivery wakes the driver; completion is persisted afterwards.
        yield* TestDatabase.until(
          state.clock(address).pipe(
            Effect.map((clock) => Option.isNone(clock) || clock.value.completedAtMs !== null)
          )
        )
        const clock = yield* state.clock(address)
        expect(clock).toMatchObject({ _tag: "Some", value: { completedAtMs: 1000 } })
        const timeTravel = yield* TimeTravel
        const runs = yield* RunStore.RunStore
        yield* TestDatabase.until(
          runs.get("fired-clock-run").pipe(Effect.map((row) => row.status === "suspended" && row.owner === null))
        )
        yield* rewindWhenIdle(timeTravel.rewind({ runId: "fired-clock-run", frame }))
        // The rewind keeps the fired clock row and drops the completion the
        // replayed sleep waits on, so the clock has to fire again.
        yield* execute
        yield* TestDatabase.until(
          state.deferred({ ...address, deferredName: "DurableClock/rewind-sleep" }).pipe(Effect.map(Option.isSome))
        )
        const deferred = yield* state.deferred({ ...address, deferredName: "DurableClock/rewind-sleep" })
        expect(deferred).toMatchObject({ _tag: "Some" })
        yield* TestDatabase.until(runs.get("fired-clock-run").pipe(Effect.map((row) => row.status === "suspended")))
        expect((yield* runs.get("fired-clock-run")).status).toBe("suspended")
      }).pipe(Effect.provide(engineLayer({ notifications: [], jjCalls: [] }, [])))
    ))
})

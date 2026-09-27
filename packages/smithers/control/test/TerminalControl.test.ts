import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * Control requests against runs this process does not own, and against runs
 * nobody owns any more.
 *
 * Three defects live here, and the first two are `interrupt` asking the wrong
 * question first.
 *
 * A terminal run has released its owner, so `ownedByUs` is false for every
 * process — including the one that ran it. Checking ownership before
 * terminality answered `ClaimLost` for a cancel of a completed run, which reads
 * as "somebody else has it" when the truth is "it already finished". `resume`
 * and `steer` both answer `Terminal` there; `cancel` has to as well, and it
 * must not journal a cancel request against a run that can never act on one
 * (triage B-12).
 *
 * A live run owned by another process is the other half. Cancellation is fiber
 * interruption and fibers are process-local, so the owning process is the only
 * one that can interrupt it — but the cancel still has to become durable, or a
 * second `flows` process, the UI, and a gateway can none of them stop a run.
 * The durable half is the engine row's `cancel_requested_at_ms`, written
 * through the `ControlExecutor.requestCancel` port, and the receipt for a
 * foreign live owner is `Accepted` rather than `ClaimLost` (triage B-10).
 *
 * The port write runs inside the control mutation's transaction, so a failure
 * rolls the whole cancel back: the control row never reaches `cancelled` while
 * the engine row is still running (triage B-11).
 *
 * Everything runs on the durable stack over real SQLite, because the claim
 * being tested is about two owners of one row and an in-memory double has one.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent, Migrations, SqlJournal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import { Clock, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Cancellation from "../src/Cancellation.ts"
import { Control } from "../src/Control.ts"
import { ClaimLost, PersistenceError } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"
import { park } from "./Park.ts"

/** One database for the whole stack, so two runtimes race over one set of rows. */
const database = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(
  Layer.provideMerge(
    Layer.provideMerge(DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]), TestDatabase.layer)
  )
)

/**
 * The control plane over an executor layer.
 *
 * The executor is a LAYER rather than a value because the cancel port writes
 * through the engine's `RunStore`, which only exists once the database layer
 * has been built. `AgentSession` acquires its services the same way.
 */
const plane = (executor: Layer.Layer<ControlExecutor.ControlExecutor, never, never>) =>
  Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      SqlControlRuntime.layer({}).pipe(Layer.orDie),
      NotificationQueue.layer,
      executor,
      Registry.layerNoop()
    )
  ).pipe(Layer.provideMerge(Layer.merge(database, NodeCrypto.layer)))

const run = <A, E, R>(
  body: Effect.Effect<A, E, R>,
  executor: Layer.Layer<ControlExecutor.ControlExecutor, never, never> = ControlExecutor.layerNoop()
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(body, plane(executor) as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie)
  )

/** Plans, approves, and starts one control-owned run. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    yield* runtime.resume(receipt.runId)
    return receipt.runId
  })

/**
 * Hands the run to a second owner identity and leaves it running there.
 *
 * A park releases the fence, the peer claims it, and the peer publishes it as
 * running: that is what "another live process owns this run" is to the store.
 */
const handOverToPeer = (runId: string) =>
  Effect.gen(function*() {
    const runtime = yield* ControlRuntime
    yield* park(runtime, runId)
    const peer = yield* SqlControlRuntime.make({
      owner: { hostId: "local", pid: 4242, nonce: "peer" }
    }).pipe(Effect.orDie)
    yield* peer.resume(runId)
    const fence = yield* peer.claimFence(runId)
    yield* peer.writeStatus(runId, fence, "running")
    return peer
  })

/** Every event type the run's journal carries, in order. */
const kinds = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 })
    return page.entries.map((entry) => entry.eventType)
  })

/** The engine-row write the production executor performs, and nothing else. */
const engineCancel = (recorded: Array<string>) =>
  Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      return ControlExecutor.makeNoop({
        requestCancel: Effect.fn("TestExecutor.requestCancel")(({ runId }) =>
          Effect.gen(function*() {
            const at = yield* Clock.currentTimeMillis
            const outcome = yield* store.requestCancel(runId, at).pipe(
              Effect.mapError((cause) =>
                new PersistenceError({
                  operation: "executor.requestCancel",
                  message: `The engine refused the cancel request for ${runId}`,
                  cause
                })
              )
            )
            recorded.push(`${runId}:${outcome._tag}`)
            if (outcome._tag === "NotFound") return "unknown" as const
            // The same three answers `AgentSession.requestCancel` gives, so a
            // repeat reaches `Control.cancel` as the repeat it is.
            return outcome._tag === "AlreadyRequested" ? "already-requested" as const : "recorded" as const
          })
        )
      })
    })
  ) as unknown as Layer.Layer<ControlExecutor.ControlExecutor, never, never>

/** An executor whose engine is unreachable, which is B-11's injected failure. */
const refusingEngine = ControlExecutor.layer(
  ControlExecutor.makeNoop({
    requestCancel: Effect.fn("TestExecutor.requestCancel")(({ runId }) =>
      Effect.fail(
        new PersistenceError({
          operation: "executor.requestCancel",
          message: `The engine refused the cancel request for ${runId}`
        })
      )
    )
  })
)

describe("cancelling a terminal run", () => {
  it("answers with the terminal receipt and journals no cancel request", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const runId = yield* start("completed")
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "completed")

      const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:completed" })
      return { runId, receipt, kinds: yield* kinds(runId) }
    }))

    expect(observed.receipt).toEqual({ _tag: "Terminal", runId: observed.runId, status: "completed" })
    expect(observed.kinds).not.toContain(Cancellation.requestedEventType)
  })

  it("answers the same way for a run that already cancelled", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const runId = yield* start("already-cancelled")
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "cancelled")
      return { runId, receipt: yield* control.cancel({ runId, idempotencyKey: "cancel:again" }) }
    }))

    expect(observed.receipt).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
  })
})

describe("cancelling a run another process owns", () => {
  it("records the cancel on the engine row and accepts it", async () => {
    const recorded: Array<string> = []
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const store = yield* RunStore.RunStore
        const runId = yield* start("foreign")
        yield* handOverToPeer(runId)

        const receipt = yield* control.cancel({
          runId,
          idempotencyKey: "cancel:foreign",
          reason: "the operator asked"
        })
        const row = yield* store.get(runId).pipe(Effect.orDie)
        return {
          runId,
          receipt,
          requestedAtMs: row.cancelRequestedAtMs,
          status: row.status,
          kinds: yield* kinds(runId)
        }
      }),
      engineCancel(recorded)
    )

    // Accepted, not ClaimLost: the request is durable and the owner will act
    // on it at its next cancel poll.
    expect(observed.receipt).toEqual({ _tag: "Accepted", receiptId: "cancel:foreign", runId: observed.runId })
    expect(observed.requestedAtMs).not.toBeNull()
    // The peer still owns a running row; nothing here forged a terminal status.
    expect(observed.status).toBe("running")
    expect(observed.kinds).toContain(Cancellation.requestedEventType)
    expect(recorded).toEqual([`${observed.runId}:CancelRequested`])
  })

  it("records the cancel for a run it owns too, before interrupting the fiber", async () => {
    const recorded: Array<string> = []
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const store = yield* RunStore.RunStore
        const runId = yield* start("owned")
        const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:owned" })
        const row = yield* store.get(runId).pipe(Effect.orDie)
        return { runId, receipt, requestedAtMs: row.cancelRequestedAtMs, status: row.status }
      }),
      engineCancel(recorded)
    )

    expect(observed.receipt).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
    expect(observed.requestedAtMs).not.toBeNull()
    expect(observed.status).toBe("cancelled")
    expect(recorded).toEqual([`${observed.runId}:CancelRequested`])
  })
})

/**
 * An executor whose engine row has already settled.
 *
 * This is the shipped CLI's shape, not a contrivance: `.flows/control.db` and
 * `.flows/engine.db` are two files with two `flows_runs` tables, so a run
 * process killed after the engine's terminal write and before the control
 * status transition leaves the control row non-terminal while the engine row
 * is `completed`. The port is the only place the control plane can learn that.
 */
const settledEngine = (status: "completed" | "failed" | "cancelled") =>
  ControlExecutor.layer(
    ControlExecutor.makeNoop({
      requestCancel: Effect.fn("TestExecutor.requestCancel")(() => Effect.succeed({ _tag: "Terminal", status }))
    })
  )

describe("cancelling a run whose engine row has already settled", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`reconciles the control row to the engine's ${status} status`, async () => {
      const observed = await run(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const runId = yield* start(`stale-control-row:${status}`)
          const before = yield* runtime.getRun(runId)

          const receipt = yield* control.cancel({ runId, idempotencyKey: `cancel:stale:${status}` })
          return { runId, before, receipt, after: yield* runtime.getRun(runId), kinds: yield* kinds(runId) }
        }),
        settledEngine(status)
      )

      // The engine's own terminal status resolves the B-11 disagreement. It
      // must never be replaced by the cancellation status the caller wanted.
      expect(observed.receipt).toEqual({ _tag: "Terminal", runId: observed.runId, status })
      expect(["completed", "failed", "cancelled"]).not.toContain(observed.before.status)
      expect(observed.after.status).toBe(status)
      expect(observed.kinds).toContain(`control.run.${status}`)
      // No attribution event either: nobody cancelled anything.
      expect(observed.kinds).not.toContain(Cancellation.requestedEventType)
    })
  }
})

describe("a cancel the engine refuses", () => {
  it("fails typed and leaves the control row exactly where it was", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const store = yield* RunStore.RunStore
        const runId = yield* start("engine-refuses")
        const before = yield* runtime.getRun(runId)
        const beforeRow = yield* store.get(runId).pipe(Effect.orDie)
        const failure = yield* Effect.flip(control.cancel({ runId, idempotencyKey: "cancel:refused" }))
        const summary = yield* runtime.getRun(runId)
        const row = yield* store.get(runId).pipe(Effect.orDie)
        return { failure, before, beforeRow, summary, row, kinds: yield* kinds(runId) }
      }),
      refusingEngine
    )

    expect(observed.failure).toBeInstanceOf(PersistenceError)
    // Neither database moved: the control row is not terminal, the engine row
    // carries no request, and the journal carries no cancellation nobody made.
    expect(observed.summary.status).toBe(observed.before.status)
    expect(["cancelled", "completed", "failed"]).not.toContain(observed.summary.status)
    expect(observed.row.status).toBe(observed.beforeRow.status)
    expect(observed.row.cancelRequestedAtMs).toBeNull()
    expect(observed.kinds).not.toContain(Cancellation.requestedEventType)
  })
})

describe("resuming a run another process owns", () => {
  it("answers ClaimLost while a peer holds the run accepted", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const runId = yield* start("peer-accepted")
      // A claim leaves the run `accepted`, and nothing rewrites that until the
      // run settles: only `Control.run` promotes to `running`, and only for its
      // own executor. A run a peer restarted therefore spends its whole second
      // life `accepted`, which is the state this asks about.
      yield* park(runtime, runId)
      const peer = yield* SqlControlRuntime.make({
        owner: { hostId: "local", pid: 4242, nonce: "peer" }
      }).pipe(Effect.orDie)
      yield* peer.resume(runId)
      const held = yield* runtime.getRun(runId)

      const failure = yield* Effect.flip(control.resume({ runId, idempotencyKey: "resume:peer-accepted" }))
      return { runId, held, failure, after: yield* runtime.getRun(runId), kinds: yield* kinds(runId) }
    }))

    expect(observed.held.status).toBe("accepted")
    // release policy 5.1: a live peer's run answers ClaimLost. Answering
    // `Accepted` here reported a restart that never happened and hid the peer.
    expect(observed.failure).toBeInstanceOf(ClaimLost)
    expect(observed.after.status).toBe("accepted")
    expect(observed.kinds).not.toContain("control.run.resume")
  })

  it("still delegates a run the engine parked, which no peer is holding", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const runId = yield* start("engine-parked")
      yield* park(runtime, runId)
      const receipt = yield* control.resume({ runId, idempotencyKey: "resume:engine-parked" })
      return { runId, receipt, after: yield* runtime.getRun(runId) }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    expect(observed.after.status).toBe("accepted")
  })
})

describe("cancelling a run nobody is driving", () => {
  it("settles the parked control row instead of accepting a request no owner will act on", async () => {
    const recorded: Array<string> = []
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const store = yield* RunStore.RunStore
        const runId = yield* start("parked-unowned")
        // The state a detached `smithers up -d` leaves behind when it parks on
        // an `ask` and exits: the row keeps its waiting reason, has released
        // its owner, and the process that wrote it is gone.
        yield* park(runtime, runId)

        const receipt = yield* control.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` })
        return {
          runId,
          receipt,
          summary: yield* runtime.getRun(runId),
          row: yield* store.get(runId).pipe(Effect.orDie),
          kinds: yield* kinds(runId)
        }
      }),
      engineCancel(recorded)
    )

    // A parked run has no owner, so no owner is ever going to act on the
    // durable request: the cancelling process is the only one that can finish
    // it. Answering `Accepted` and leaving the row parked left two runs that
    // `cancel`, `down`, and `gc` could not reach during the release rehearsal.
    expect(observed.receipt).toEqual({ _tag: "Terminal", runId: observed.runId, status: "cancelled" })
    expect(observed.summary.status).toBe("cancelled")
    // Both halves: the engine row carries the
    // request the engine settles on, and the control row is terminal now.
    expect(observed.row.cancelRequestedAtMs).not.toBeNull()
    expect(observed.kinds).toContain(Cancellation.requestedEventType)
    // `smithers run` waits on exactly this event to learn it has nothing left
    // to drive, and `gc` skips a run whose control row never went terminal.
    expect(observed.kinds).toContain("control.run.cancelled")
  })
})

describe("a cancel repeated against a run it cannot finish", () => {
  it("attributes the request once, however many times it is asked", async () => {
    const recorded: Array<string> = []
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start("repeat-attribution")
        yield* handOverToPeer(runId)
        const key = `cli:cancel:${runId}`
        const first = yield* control.cancel({ runId, idempotencyKey: key })
        const second = yield* control.cancel({ runId, idempotencyKey: key })
        const third = yield* control.cancel({ runId, idempotencyKey: key })
        return { runId, first, second, third, kinds: yield* kinds(runId) }
      }),
      engineCancel(recorded)
    )

    // Each ask still answers from the run rather than from a receipt.
    expect(observed.first._tag).toBe("Accepted")
    expect(observed.second._tag).toBe("Accepted")
    expect(observed.third._tag).toBe("Accepted")
    // One operator, one cancellation, one attribution record. `cancel` runs
    // with `replay: false`, so every repeat re-executes the whole effect, and
    // the release validation's three `cancel` calls plus one `down` left four
    // `control.run.cancel-requested` events for one cancellation.
    expect(observed.kinds.filter((kind) => kind === Cancellation.requestedEventType)).toHaveLength(1)
    // The engine row is asked every time — first-writer-wins keeps the
    // timestamp — and it is the store's own answer that says which ask was
    // the one that recorded it.
    expect(recorded).toEqual([
      `${observed.runId}:CancelRequested`,
      `${observed.runId}:AlreadyRequested`,
      `${observed.runId}:AlreadyRequested`
    ])
  })
})

describe("resuming a run that has already settled", () => {
  it("answers Terminal even when the resume key already carries a receipt", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runtime = yield* ControlRuntime
      const runId = yield* start("resume-settled")
      yield* park(runtime, runId)
      // The CLI derives one key per park, so a second `run --resume` against
      // the same park reuses it.
      const key = `cli:resume:${runId}`
      const first = yield* control.resume({ runId, idempotencyKey: key })
      const fence = yield* runtime.claimFence(runId)
      yield* runtime.writeStatus(runId, fence, "completed")
      const again = yield* control.resume({ runId, idempotencyKey: key })
      return { runId, first, again }
    }))

    expect(observed.first._tag).toBe("Accepted")
    // Terminality is read BEFORE the replay, as `cancel` reads it. Replaying
    // the recorded receipt answered `AlreadyApplied` for a run that had since
    // finished, which tells the operator a restart happened and says nothing
    // about the run they asked about (release validation, spec item 3).
    expect(observed.again).toEqual({ _tag: "Terminal", runId: observed.runId, status: "completed" })
  })
})

import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import * as PersistentDatabase from "./fixtures/PersistentDatabase.ts"
/**
 * Pins issue #53: a run whose owner dies without releasing it (SIGKILL, OOM,
 * power loss) stays `status='running'` with a frozen heartbeat and no waiting
 * row. The #39 sweep enumerated only `waitingRuns()`, so nothing ever
 * re-drove such a run — no steal (reachable only through `drive()`), no
 * cancel delivery (`requestCancel` was write-only forever). The periodic
 * sweep must also enumerate stale-running rows and re-drive them through the
 * existing claim/steal path — the analog of Temporal's task-timeout
 * re-dispatch.
 *
 * Uses the SQL `DurableEngineState` over the same database as `RunStore`,
 * because the hard-kill evidence (a `running` row with a stale
 * `heartbeat_at_ms`) lives in `flows_runs` itself.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { ReclaimFlow } from "./fixtures/LeaseReclaimFlow.ts"
import { withCrypto } from "./Sha256.ts"

const TestFlow = Flow.make("HardKillReclaim/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const makeDriver = (nonce: string) =>
  RunDriver.make({
    owner: { hostId: "reclaim-host", pid: 1, nonce },
    journalSource: "hard-kill-reclaim",
    // The dead owner is never alive: the steal path may proceed.
    isAlive: () => Effect.succeed(false),
    engine: Effect.succeed(fakeEngine)
  })

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(migratedDatabase))

/**
 * Simulates a hard-killed owner: a `running` row with a frozen heartbeat, a
 * dead owner, and no waiting row — exactly what SIGKILL leaves behind
 * (`releaseOwned` never ran, so nothing parked).
 */
const insertHardKilledRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter.DurableWriter
    const stateJson = JSON.stringify({
      version: 1,
      flowName: TestFlow._tag,
      payload: {}
    })
    yield* writer.write(sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        started_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json
      ) VALUES (
        ${runId},
        'running',
        0,
        0,
        'dead-host',
        424242,
        'dead-nonce',
        0,
        ${stateJson}
      )
    `).pipe(Effect.orDie)
  })

type Services = Layer.Success<typeof services> | TestClock.TestClock | Crypto.Crypto | Scope.Scope

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(Effect.scoped(effect).pipe(Effect.provide(services), Effect.provide(TestClock.layer())))

/** Everything `TestStores.layerAt` provides, so the file case says no `any`. */
type TestStoresServices = Layer.Success<ReturnType<typeof TestStores.layerAt>>

const staleAfterMs = Duration.toMillis(Ownership.heartbeatStaleAfter)
const heartbeatMs = Duration.toMillis(Ownership.heartbeatInterval)

const fixture = fileURLToPath(new URL("./fixtures/lease-reclaim-child.ts", import.meta.url))
const repositoryRoot = fileURLToPath(new URL("../../../../../", import.meta.url))

/**
 * Wall-clock budget for the process case, matching `DurableWaitingRestart`.
 *
 * The child boots an engine and runs migrations, which is most of the cost,
 * and coverage-instrumented workers multiply it. Finite, so a child that never
 * speaks still fails the gate rather than hanging it.
 */
const processBudget = 120_000

/** The child's first protocol line, or a failure naming what it did instead. */
/** Keep only the last 4 KiB of child output in an error message. */
const tail = (text: string): string => text.length > 4096 ? `...${text.slice(-4096)}` : text

const firstJsonLine = (child: ChildProcessWithoutNullStreams): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => {
      reject(new Error(`child did not produce a JSON line\n${tail(stderr)}\n${tail(stdout)}`))
    }, processBudget)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timeout)
      resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>)
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (cause) => {
      clearTimeout(timeout)
      reject(cause)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      reject(new Error(`child exited before its marker with ${code ?? signal}\n${tail(stderr)}\n${tail(stdout)}`))
    })
  })

const killHard = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  child.kill("SIGKILL")
  await once(child, "exit")
}

/** The engine decisions journaled for one run. */
const decisionsOf = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const entries = yield* journal.entries({ runId: runId as never, limit: 200 })
    return entries.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => entry.payload as { readonly decision: string; readonly evidence?: string })
  })

describe("hard-killed running runs are reclaimed (issue #53)", () => {
  it.effect("the sweep steals a stale-running run and re-drives it to completion", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("hard-kill-redrive")

        const driver = yield* makeDriver("owner-2")
        yield* driver.register(TestFlow, () => Effect.succeed("reclaimed"))

        // Cross the staleness horizon, then let the sweeper tick.
        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        let row = yield* store.get("hard-kill-redrive")
        for (let i = 0; i < 2000 && row.status !== "completed"; i++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(heartbeatMs)
          row = yield* store.get("hard-kill-redrive")
        }
        return { row }
      }))

      expect(result.row.status).toBe("completed")
      expect(result.row.owner).toBeNull()
    }))

  it.effect("reclaims across a real database file, from a composition that shares nothing", () =>
    Effect.gen(function*() {
      // Everything above this case runs against one in-memory connection, so
      // the reclaiming driver could in principle have been reading state the
      // dead owner's composition still held. Here the two compositions share a
      // FILE and nothing else: separate connections, separate stores, separate
      // owner identities, and the first one is fully closed before the second
      // opens. What the second reads has to have been on disk.
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "hard-kill-file-")))
      const filename = PersistentDatabase.filename(join(directory, "runs.db"))
      const runId = "hard-kill-across-a-file"
      const deadOwner: Ownership.OwnerId = { hostId: "dead-host", pid: 424242, nonce: "dead-nonce" }

      const onFile = <A, E>(
        body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope | TestStoresServices>
      ) => withCrypto(Effect.scoped(body).pipe(Effect.provide(TestStores.layerAt(filename))))

      const result = yield* Effect.gen(function*() {
        // The dead owner's composition: it claims the run and is killed, so
        // the row stays `running` under an owner whose heartbeat never moves
        // again. Written through the public store contract, which is the same
        // contract the driver's own claim goes through.
        const abandoned = yield* onFile(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          yield* store.create(runId, JSON.stringify({ version: 1, flowName: TestFlow._tag, payload: {} }))
          const claimed = yield* store.claimAndOwn(
            runId,
            { status: "pending", owner: null, heartbeatAtMs: null },
            deadOwner,
            0
          )
          return { claimed: claimed._tag, row: yield* store.get(runId) }
        }))

        yield* TestClock.adjust(staleAfterMs + heartbeatMs)

        // A completely separate composition, with NO application liveness
        // probe: the expired lease is the only evidence it has.
        const reclaimed = yield* onFile(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const driver = yield* RunDriver.make({
            owner: { hostId: "reclaim-host", pid: 2, nonce: "across-a-file" },
            journalSource: "hard-kill-reclaim",
            engine: Effect.succeed(fakeEngine)
          })
          yield* driver.register(TestFlow, () => Effect.succeed("reclaimed off disk"))
          let row = yield* store.get(runId)
          for (let i = 0; i < 2000 && row.status !== "completed"; i++) {
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
            yield* TestClock.adjust(heartbeatMs)
            row = yield* store.get(runId)
          }
          return row
        }))

        return { abandoned, reclaimed }
      }).pipe(Effect.ensuring(Effect.promise(async () => {
        await PersistentDatabase.remove(filename)
        await rm(directory, { recursive: true, force: true })
      })))

      // The evidence the first composition left, and the outcome the second
      // reached with nothing but that file.
      expect(result.abandoned.claimed).toBe("Activated")
      expect(result.abandoned.row.status).toBe("running")
      expect(result.abandoned.row.owner).toEqual(deadOwner)
      expect(result.reclaimed.status).toBe("completed")
      expect(result.reclaimed.owner).toBeNull()
    }))

  it("reclaims a run left running by a process that was actually SIGKILLed", async () => {
    // The two cases above describe a hard kill; this one performs it. A child
    // process composes a real `EngineStore` with NO `isAlive`, claims the run,
    // and starts running the flow; the parent kills it with SIGKILL, so no
    // finalizer runs, no release is written, and the row stays `running` under
    // an owner whose heartbeat stops where the process did. That is the state
    // an in-process scope close cannot produce: closing a scope runs
    // `releaseOwned`, and there is no seam that stops a driver's heartbeat
    // fiber without also running its finalizers.
    //
    // The reclaiming composition then runs on a `TestClock` set past the dead
    // owner's last real heartbeat by `heartbeatStaleAfter`. That is the
    // acceptance's clock adjustment, applied where a `TestClock` can reach:
    // the surviving driver's own now, not the dead process's. Nothing rewrites
    // the abandoned row.
    const directory = await mkdtemp(join(tmpdir(), "lease-reclaim-process-"))
    const filename = PersistentDatabase.filename(join(directory, "runs.db"))
    const runId = "lease-reclaim-after-sigkill"
    const child = spawn(process.execPath, [fixture, filename, runId], {
      cwd: repositoryRoot,
      // The fixture reads only argv; never hand it the parent's credentials.
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8" }
    })
    try {
      const marker = await firstJsonLine(child)
      expect(marker.status).toBe("running")
      await killHard(child)

      const result = await Effect.runPromise(
        withCrypto(
          Effect.scoped(Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const killed = yield* store.get(runId)
            // The dead owner's last heartbeat is a real wall-clock stamp; the
            // survivor's clock is set one staleness window past it.
            yield* TestClock.setTime((killed.heartbeatAtMs ?? 0) + staleAfterMs + heartbeatMs)
            const driver = yield* RunDriver.make({
              owner: { hostId: "reclaim-host", pid: process.pid, nonce: "after-a-sigkill" },
              journalSource: "hard-kill-reclaim",
              engine: Effect.succeed(fakeEngine)
            })
            yield* driver.register(ReclaimFlow, () => Effect.succeed("reclaimed after a real kill"))
            let row = yield* store.get(runId)
            // Ten ticks is ten seconds of clock, a third of the staleness
            // window: the horizon can only have been crossed by `setTime`
            // above, never by the ticking itself. Dropping `setTime` and
            // keeping this budget leaves the run `running`.
            for (let tick = 0; tick < 2000 && row.status !== "completed"; tick++) {
              yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
              yield* TestClock.adjust(heartbeatMs)
              row = yield* store.get(runId)
            }
            return { killed, row, decisions: yield* decisionsOf(runId) }
          })).pipe(
            Effect.provide(TestStores.layerAt(filename)),
            Effect.provide(TestClock.layer())
          )
        )
      )

      // What SIGKILL left: a running row owned by the dead process.
      expect(result.killed.status).toBe("running")
      expect(result.killed.owner?.hostId).toBe("lease-reclaim-child")
      expect(result.killed.owner?.pid).toBe(marker.pid)
      // What the survivor did with nothing but the expired lease.
      expect(result.row.status).toBe("completed")
      expect(result.row.owner).toBeNull()
      expect(result.decisions).toContainEqual(
        expect.objectContaining({ decision: "stolen-and-activated", evidence: "lease-expired" })
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await killHard(child)
      }
      await PersistentDatabase.remove(filename)
      await rm(directory, { recursive: true, force: true })
    }
  }, processBudget)

  it.effect("requestCancel against a hard-killed run is eventually delivered", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("hard-kill-cancel")

        // Another process (the CLI) durably requests cancellation while the
        // dead owner still nominally holds the run.
        yield* store.requestCancel("hard-kill-cancel", 1)

        const driver = yield* makeDriver("owner-2")
        // The flow body must never re-run: the re-activation cancel guard
        // closes the run instead.
        let bodyRuns = 0
        yield* driver.register(TestFlow, () =>
          Effect.sync(() => {
            bodyRuns += 1
          }).pipe(Effect.andThen(Effect.never)))

        yield* TestClock.adjust(staleAfterMs + heartbeatMs)
        let row = yield* store.get("hard-kill-cancel")
        for (let i = 0; i < 2000 && row.status !== "cancelled"; i++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(heartbeatMs)
          row = yield* store.get("hard-kill-cancel")
        }
        return { row, bodyRuns }
      }))

      expect(result.row.status).toBe("cancelled")
      expect(result.bodyRuns).toBe(0)
    }))

  it.effect("does not steal a running run whose heartbeat is still fresh", () =>
    Effect.gen(function*() {
      const result = yield* run(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* insertHardKilledRun("hard-kill-fresh")

        const driver = yield* makeDriver("owner-2")
        yield* driver.register(TestFlow, () => Effect.succeed("stolen-too-early"))

        // Tick well below the staleness horizon: the run must stay untouched.
        yield* TestClock.adjust(3 * heartbeatMs)
        const row = yield* store.get("hard-kill-fresh")
        return { row }
      }))

      expect(result.row.status).toBe("running")
      expect(result.row.owner).toEqual({ hostId: "dead-host", pid: 424242, nonce: "dead-nonce" })
    }))
})

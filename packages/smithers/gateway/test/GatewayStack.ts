import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * A whole gateway over one real SQLite database.
 *
 * Every suite in this package runs against this: a durable journal, a durable
 * run store, the SQL control runtime, `ControlLive`, the served projections,
 * the sync read path, and the assembled HTTP surface bound to an ephemeral
 * loopback port. Nothing is stubbed below the control plane, because the
 * behaviours these suites pin — an approval projected out of a parked run, a
 * cancellation's attribution, a child run's visibility — are exactly the
 * places a mocked control plane would agree with the gateway and disagree
 * with production.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import type * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import type * as ControlError from "@smthrs/control/ControlError"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, RunStore } from "@smthrs/run-store"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Projections from "../src/Projections.ts"

/** Monotonic producer sequence, so two identical fixture events both admit. */
let sequence = 0

/** A fresh SQLite file, removed when the layer's scope closes. */
export const databaseFile = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "smthrs-gateway-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
).pipe(Effect.map((directory) => join(directory, "control.db")))

/** Journal, run store, and writer over one real SQLite file. */
export const storage = (filename: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
      )
    )
  )

/**
 * The durable control plane, the read path, and the sync read path, over one
 * real database.
 *
 * @param options the acceptance port to launch runs through
 */
export const stack = (options: {
  readonly executor?: ControlExecutor.Service | undefined
  readonly approvalAuthority?: ApprovalAuthority.Service | undefined
} = {}) =>
  Layer.unwrap(
    Effect.map(databaseFile, (filename) =>
      Layer.mergeAll(
        Projections.layerWith({ heartbeatMillis: 50 }),
        SyncServer.layer,
        SyncAuth.layer
      ).pipe(
        Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
        Layer.provideMerge(ControlLive.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            SqlControlRuntime.layer({ approvalAuthority: options.approvalAuthority }).pipe(Layer.orDie),
            NotificationQueue.layer,
            ControlExecutor.layer(options.executor ?? ControlExecutor.makeNoop()),
            Registry.layerNoop()
          )
        ),
        Layer.provideMerge(Layer.merge(storage(filename), NodeCrypto.layer))
      ))
  )

/**
 * The same stack under the shipped keepalive cadence, for the one suite that
 * pins the default layer rather than the test cadence.
 */
export const defaultCadenceStack = Layer.unwrap(
  Effect.map(databaseFile, (filename) =>
    Layer.mergeAll(Projections.layer, SyncServer.layer, SyncAuth.layer).pipe(
      Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
      Layer.provideMerge(ControlLive.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          SqlControlRuntime.layer({}).pipe(Layer.orDie),
          NotificationQueue.layer,
          ControlExecutor.layer(ControlExecutor.makeNoop()),
          Registry.layerNoop()
        )
      ),
      Layer.provideMerge(Layer.merge(storage(filename), NodeCrypto.layer))
    ))
)

/**
 * The fence a driver writes a launched run's status under.
 *
 * Every suite here launches through the noop executor, and `ControlLive`
 * releases a launch its executor declines: the run keeps its public `accepted`
 * status and loses its owner, so it stays available to whichever executor
 * takes it up. A fixture that writes a status is that executor, so it claims
 * the run first, the way a real driver does, and fences under the claim it
 * won. A run this process already owns — one an accepting executor is driving
 * — is fenced directly, because a driver does not re-claim its own run.
 *
 * @param runId the run to fence
 */
export const driverFence = (
  runId: string
): Effect.Effect<
  string,
  ControlError.RunNotFound | ControlError.ClaimLost | ControlError.PersistenceError,
  ControlRuntime
> =>
  Effect.flatMap(ControlRuntime, (runtime) =>
    runtime.claimFence(runId).pipe(
      Effect.catchTag(
        "/control/ClaimLost",
        () => Effect.flatMap(runtime.resume(runId), () => runtime.claimFence(runId))
      )
    ))

/**
 * Writes one event into the durable journal, the way a run's activity reaches
 * it. Suites use this to give a run the activity a projection folds.
 *
 * The durable channel is deliberate: `emitLossy` returns once the optimistic
 * queue accepts an entry, so a projection read straight afterwards can
 * legitimately miss it, and a suite built on that races its own fixture.
 *
 * @param runId the run the event belongs to
 * @param eventType the control event kind
 * @param payload the event payload
 */
export const emit = (
  runId: string,
  eventType: string,
  payload: unknown
): Effect.Effect<void, never, Journal.Journal> =>
  Effect.flatMap(Journal.Journal, (journal) => {
    sequence += 1
    return Effect.orDie(
      journal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make("gateway-test"),
          sourceSeq: JournalEvent.SourceSeq.make(sequence),
          eventType,
          payload: JSON.parse(JSON.stringify(payload))
        })
      )
    ).pipe(Effect.asVoid)
  })

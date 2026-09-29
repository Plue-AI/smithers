import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * A complete durable `ControlLive` stack over one in-memory SQLite database.
 *
 * `TestStack` composes the deterministic in-memory runtime; this composes the
 * durable one, which is the only place run-store columns, journal rows, and
 * the control projection meet. Suites that assert on persisted lineage,
 * attribution, or steering delivery need that meeting point.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as DurableWriterModule from "@smthrs/database/DurableWriter"
import type { DurableWriter } from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import { Migrations as RunStoreMigrations, type Ownership, RunStore } from "@smthrs/run-store"
import type { Crypto } from "effect"
import { Layer } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as ApprovalAuthority from "../src/ApprovalAuthority.ts"
import type { Control } from "../src/Control.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import type { ControlRuntime } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

/**
 * The durable journal bundle, with `Database` kept in the output so the control
 * runtime and the journal share one connection and therefore one transaction
 * boundary.
 */
export const journalBundle: Layer.Layer<
  Journal.Journal | RunStore.RunStore | DurableWriter | SqlClient.SqlClient
> = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(
  Layer.provideMerge(
    Layer.provideMerge(
      DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
      TestDatabase.layer
    )
  )
) as Layer.Layer<Journal.Journal | RunStore.RunStore | DurableWriter | SqlClient.SqlClient>

/**
 * The same bundle over a real file on disk.
 *
 * An in-memory database dies with the process that opened it, so a suite built
 * on one can never rebuild a runtime over rows an earlier runtime wrote — the
 * exact thing a restart does. Passing this as `durable({ database })` twice
 * against one filename gives two runtimes over one set of rows.
 *
 * @param filename the SQLite file to open
 */
export const fileBundle = (
  filename: string
): Layer.Layer<Journal.Journal | RunStore.RunStore | DurableWriter | SqlClient.SqlClient> =>
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer
  ).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
        Layer.provideMerge(DurableWriterModule.layer(), NodeDatabase.layer({ filename }))
      )
    )
  ) as Layer.Layer<Journal.Journal | RunStore.RunStore | DurableWriter | SqlClient.SqlClient>

/** Everything a durable control suite may reach for. */
export type DurableStack =
  | Control
  | ControlRuntime
  | Journal.Journal
  | NotificationQueue.NotificationQueue
  | RunStore.RunStore
  | DurableWriter
  | SqlClient.SqlClient
  | Crypto.Crypto

/** Everything the control plane needs a database and a journal to supply. */
export type DurableStackDependencies =
  | Journal.Journal
  | RunStore.RunStore
  | DurableWriter
  | SqlClient.SqlClient
  | Crypto.Crypto

/**
 * The control plane over a database somebody else provides.
 *
 * `Layer.provideMerge` builds what it provides privately, so two branches that
 * each provide the same database layer get two databases. A suite that runs a
 * real engine beside the control plane has to provide one database to BOTH
 * branches at once, which is why this half is exported open.
 *
 * @param options the acceptance port and process identity to use
 */
export const controlPlane = (
  options: {
    readonly executor?: ControlExecutor.Service | undefined
    readonly owner?: Ownership.OwnerId | undefined
    readonly isAlive?: Ownership.LivenessCheck | undefined
    readonly approvalAuthority?: ApprovalAuthority.Service | undefined
    readonly loadFlows?: SqlControlRuntime.Options["loadFlows"]
    readonly currentFlows?: SqlControlRuntime.Options["currentFlows"]
    readonly adoptFlow?: SqlControlRuntime.Options["adoptFlow"]
    readonly engineVersion?: string | undefined
  } = {}
): Layer.Layer<Exclude<DurableStack, DurableStackDependencies>, never, DurableStackDependencies> =>
  Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(
      SqlControlRuntime.layer({
        owner: options.owner,
        isAlive: options.isAlive,
        approvalAuthority: options.approvalAuthority,
        loadFlows: options.loadFlows,
        currentFlows: options.currentFlows,
        adoptFlow: options.adoptFlow,
        engineVersion: options.engineVersion
      }).pipe(Layer.orDie),
      NotificationQueue.layer,
      ControlExecutor.layer(options.executor ?? ControlExecutor.makeNoop()),
      Registry.layerNoop()
    )
  ) as Layer.Layer<Exclude<DurableStack, DurableStackDependencies>, never, DurableStackDependencies>

/**
 * Builds the durable stack.
 *
 * @param options the acceptance port, process identity, and database to use
 */
export const durable = (
  options: {
    readonly executor?: ControlExecutor.Service | undefined
    readonly owner?: Ownership.OwnerId | undefined
    readonly isAlive?: Ownership.LivenessCheck | undefined
    readonly approvalAuthority?: ApprovalAuthority.Service | undefined
    readonly loadFlows?: SqlControlRuntime.Options["loadFlows"]
    readonly currentFlows?: SqlControlRuntime.Options["currentFlows"]
    readonly adoptFlow?: SqlControlRuntime.Options["adoptFlow"]
    readonly engineVersion?: string | undefined
    readonly database?: Layer.Layer<DurableWriter | SqlClient.SqlClient | RunStore.RunStore, unknown> | undefined
  } = {}
): Layer.Layer<DurableStack> =>
  controlPlane(options).pipe(
    Layer.provideMerge(Layer.merge(options.database ?? journalBundle, NodeCrypto.layer))
  ) as Layer.Layer<DurableStack>

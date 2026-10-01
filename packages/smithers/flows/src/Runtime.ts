/**
 * Platform-independent composition for the durable flows runtime.
 *
 * The SQL client and host services are injected. No driver is opened here;
 * native entrypoints compose their matching database and platform layers.
 *
 * Construction is ordered by layer dependencies: the SQLite parent directory
 * is created before the database opens, migrations finish before any store is
 * built, the durable engine is built over those stores, and `registerFlows`
 * finishes before the resulting services are exposed. The engine's own
 * registration hook then re-arms durable clocks and deferred wakes, so a
 * persisted run cannot resume through this composition before its flow has
 * been registered.
 *
 * @since 0.1.0
 */

import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { DurableWriter } from "@smthrs/database"
import {
  DurableEngineState,
  EngineStore,
  OwnerIdentity,
  type StepBoundary,
  type WorkspaceSandbox
} from "@smthrs/engine-store"
import * as Migrations from "@smthrs/engine-store/Migrations"
import { Action } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Workspace from "@smthrs/kernel/Workspace"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { type RegistryArgs, registryLayer } from "./internal/RegistryArgs.ts"

export { type Options, RuntimeConfigurationError } from "./internal/RuntimeOptions.ts"
import { decodeField, type Options, validate } from "./internal/RuntimeOptions.ts"

const nonEmpty = "must be a non-empty string"

/**
 * Provides the migrated database, durable stores, owner minter, workspace,
 * and local artifact store without constructing an engine.
 *
 * This is the lower-level seam for integrations that construct another
 * engine-backed service over the same storage context, such as the time-travel
 * example. Application entry points should normally use {@link layer}.
 *
 * @since 0.1.0
 * @category layers
 * @slop
 */
export const storage = (filename: string, workspaceRoot?: string) => {
  const configuredFilename = decodeField("filename", Schema.NonEmptyString, filename, nonEmpty)
  const configuredRoot = workspaceRoot === undefined
    ? undefined
    : decodeField("workspaceRoot", Schema.NonEmptyString, workspaceRoot, nonEmpty)
  return Layer.unwrap(Effect.gen(function*() {
    const path = yield* Path.Path
    const databaseRoot = /^postgres(?:ql)?:\/\//.test(configuredFilename)
      ? path.join(path.resolve(configuredRoot ?? "."), ".flows")
      : path.dirname(path.resolve(configuredFilename))
    const resolvedWorkspaceRoot = configuredRoot === undefined ? databaseRoot : path.resolve(configuredRoot)
    const database = Layer.provideMerge(Migrations.layer, DurableWriter.layer())
    return Layer.mergeAll(
      SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
      RunStore.layer,
      AttemptStore.layer,
      CacheStore.layer,
      DurableEngineState.layer,
      OwnerIdentity.layer,
      Workspace.layer(resolvedWorkspaceRoot),
      ArtifactStore.layerFileSystem({ directory: path.join(databaseRoot, "objects") })
    ).pipe(Layer.provideMerge(database))
  })).pipe(Layer.fresh)
}

/** Compose an isolated runtime from injected storage and execution services.
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
) => {
  const validated = validate(options)
  const execution = Layer.merge(stepBoundary, workspaceSandbox).pipe(
    Layer.provideMerge(storage(validated.filename, validated.workspaceRoot)),
    // Credential redaction covers the operator's terminal as well as the
    // journal (the release policy). It sits UNDER the engine so the
    // context the engine captures for an action body carries it: a line an
    // action, the harness, or an agent session writes leaves through the same
    // rules `@smthrs/journal` applies on the write path.
    Layer.provideMerge(RedactedLogger.layer())
  )
  const engineOptions: EngineStore.Options = {
    owner: validated.owner,
    journalSource: `${validated.owner.hostId}-engine`,
    isAlive: validated.isAlive,
    canExecute: validated.canExecute,
    requestResume: validated.requestResume,
    // What this host says about the tree it read its flows out of; every
    // recorded graph page carries it, and a host that says nothing records
    // nothing (D-068).
    sourceRevision: validated.sourceRevision
  }
  // A host that guards the ambient `Jj` for action bodies keeps the engine's
  // own snapshots on its privileged repository, as `layerHost` does.
  const engine = (validated.privilegedJj === undefined
    ? EngineStore.layer(engineOptions)
    : EngineStore.layerWithPrivilegedJj(engineOptions, validated.privilegedJj)).pipe(
    Layer.provideMerge(execution),
    // Under the engine, not beside it: `@smthrs/engine`
    // `FlowEngine/Dispatch` reads this reference off the context the engine
    // captures for an action dispatch, and a sibling layer is not in it.
    // Undeclared it stays absent, which is what every sealed key in this repo
    // is derived without today.
    Layer.provideMerge(
      validated.cacheEnvironment === undefined
        ? Layer.empty
        : Action.layerCacheEnvironment(validated.cacheEnvironment)
    )
  )
  // The registry is built BETWEEN the engine and the registration phase, so a
  // registration that reads a catalog off it — `@smthrs/registry`'s
  // `Executable.layer`, which turns every discovered descriptor into a
  // registered durable flow — has both the registry and the engine's own
  // context in hand, and the engine is still live before the first flow is
  // registered.
  // Constant store and registration layers must belong to this runtime's SQL
  // context. An enclosing control plane can build the same layer values over
  // another database; sharing their memoized instances crosses that boundary.
  return Layer.effectContext(Layer.build(
    registerFlows.pipe(Layer.provideMerge(registryLayer(registry)), Layer.provideMerge(engine), Layer.fresh)
  ))
}

/** Build the runtime in the caller's scope.
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = <
  BoundaryError,
  BoundaryRequirements,
  SandboxError,
  SandboxRequirements,
  Registered,
  RegistrationError,
  RegistrationRequirements,
  RegistryOut = never,
  RegistryError = never,
  RegistryRequirements = never
>(
  options: Options,
  stepBoundary: Layer.Layer<StepBoundary.Service, BoundaryError, BoundaryRequirements>,
  workspaceSandbox: Layer.Layer<WorkspaceSandbox.Service, SandboxError, SandboxRequirements>,
  registerFlows: Layer.Layer<Registered, RegistrationError, RegistrationRequirements>,
  ...registry: RegistryArgs<RegistryOut, RegistryError, RegistryRequirements>
) => Layer.build(layer(options, stepBoundary, workspaceSandbox, registerFlows, ...registry))

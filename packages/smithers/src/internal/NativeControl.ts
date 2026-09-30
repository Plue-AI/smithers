/** One private control/executor composition over existing native platform adapters.
 * @since 1.0.0
 */

import type * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Budget from "@smthrs/agent/Budget"
import * as Memory from "@smthrs/agent/Memory"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import {
  ApprovalAuthority,
  Control,
  ControlError,
  ControlExecutor,
  ControlRuntime,
  SqlControlRuntime,
  SystemFlows
} from "@smthrs/control"
import type * as ControlSchema from "@smthrs/control/ControlSchema"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import { ExecutionFacts } from "@smthrs/engine-store"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import type * as NodeFlowsRuntime from "@smthrs/flows/NodeRuntime"
import type * as GatewayServer from "@smthrs/gateway/GatewayServer"
import type * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as GatewayProjections from "@smthrs/gateway/Projections"
import * as QuickJSSandbox from "@smthrs/harness/QuickJSSandbox"
import type * as Sandbox from "@smthrs/harness/Sandbox"
import * as Steering from "@smthrs/harness/Steering"
import type { JjError } from "@smthrs/jj"
import { EngineEvent, SqlJournal } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import type * as KernelJj from "@smthrs/kernel/Jj"
import * as KernelPath from "@smthrs/kernel/Path"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as Workspace from "@smthrs/kernel/Workspace"
import type * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import * as Maintenance from "@smthrs/memory/Maintenance"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as RequestExecutor from "@smthrs/model/RequestExecutor"
import type { NotificationQueue } from "@smthrs/notifications"
import * as PersistedPlan from "@smthrs/plan/Plan"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { type AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import * as Checkpoints from "@smthrs/std/Checkpoints"
import * as Container from "@smthrs/std/Container"
import * as NativeSearch from "@smthrs/std/NativeSearch"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as SyncAuth from "@smthrs/sync/SyncAuth"
import * as SyncServer from "@smthrs/sync/SyncServer"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import { Cause, Clock, Context, Effect, Fiber, FileSystem, Layer, Option, SchemaIssue, Scope } from "effect"
import type { Crypto, Path } from "effect"
import * as Deferred from "effect/Deferred"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import type * as Application from "../Application.ts"
import * as CliError from "../CliError.ts"
import * as Serve from "../Serve.ts"
import { packageVersion } from "../Version.ts"
import * as AuthoredRebuild from "./AuthoredRebuild.ts"

import * as ControlAffinity from "./ControlAffinity.ts"
import * as ControlDatabasePath from "./ControlDatabasePath.ts"
import * as DatabaseLocation from "./DatabaseLocation.ts"
import * as EngineJournalSupervisor from "./EngineJournalSupervisor.ts"
import * as ExecutionDatabasePath from "./ExecutionDatabasePath.ts"
import * as Failure from "./Failure.ts"
import * as HealthHost from "./HealthHost.ts"
import * as LocalControl from "./LocalControl.ts"
import * as ModuleAdmission from "./ModuleAdmission.ts"
import * as ModuleAuthority from "./ModuleAuthority.ts"
import {
  askPolicy,
  cellLimits,
  checkpointStore,
  layerSeatCatalog,
  layerSeatEvaluator,
  layerSeatResolver,
  sealedContainer,
  testFlows,
  testRunner,
  toolServices
} from "./NativeEquipment.ts"
import * as NodeWorkspaceObservation from "./NodeWorkspaceObservation.ts"
import * as ReleasedChildResume from "./ReleasedChildResume.ts"
import * as RoleProfile from "./RoleProfile.ts"
import * as SourceRevision from "./SourceRevision.ts"
import * as SupervisorMemory from "./SupervisorMemory.ts"
import * as WorkspaceRouting from "./WorkspaceRouting.ts"

/** Match the TUI's repository-bounded instruction file precedence. */
const workspaceInstructions = (cwd: string): ReadonlyArray<{ readonly path: string; readonly text: string }> => {
  const files: Array<string> = []
  const global = join(homedir(), ".smithers", "agent", "AGENTS.md")
  if (existsSync(global)) files.push(global)
  const directories: Array<string> = []
  for (let directory = resolve(cwd);; directory = dirname(directory)) {
    directories.unshift(directory)
    if (existsSync(join(directory, ".jj")) || existsSync(join(directory, ".git"))) break
    if (dirname(directory) === directory) {
      directories.splice(0, directories.length - 1)
      break
    }
  }
  for (const directory of directories) {
    const first = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]
      .map((name) => join(directory, name)).find((path) => existsSync(path))
    if (first !== undefined && !files.includes(first)) files.push(first)
  }
  return files.map((path) => ({ path, text: readFileSync(path, "utf8") }))
}

/** Captured durable control services shared by native consumers.
 * @since 1.0.0
 * @private
 */
export interface EngineDurable extends Application.Engine {
  readonly stores: Layer.Layer<DurableWriter.DurableWriter | SqlClient | RunStore.RunStore>
  /**
   * What this composition's executor registered, read by the control runtime,
   * engine journal and gateway built over the same engine. Every engine owns
   * its own: two roots open in one process never plan from each other's
   * catalog or report each other's revision (#2746).
   */
  readonly host: HostState
}

/** The catalog, revision and executor one composition registered.
 * @since 1.0.0
 * @private
 */
export interface HostState {
  /**
   * The executable catalog this host's executor built, or `undefined` when it
   * has not built one.
   *
   * Planning a discovered flow needs the Executable behind its descriptor,
   * and the catalog is constructed by the executor layer, after the control
   * runtime it must answer. A plain reference rather than an awaited
   * `Deferred` is deliberate: a composition that only observes persisted runs (or a bare
   * `engineDurable`) never builds a catalog at all, and a plan that
   * awaited one would hang the command instead of answering it.
   */
  catalog: Executable.Catalog | undefined
  /**
   * The workspace revision the catalog above was read out of, or `undefined`
   * when this host cannot name one.
   *
   * It is set with `catalog` and for the same reason: a declaration site
   * is a path and a line, and the plans this host builds are built from the
   * modules that catalog holds, which were read off one tree at startup. A
   * reader that has this can ask for the file AT that revision rather than
   * for whatever is on disk when they open the tab, and a host that cannot
   * name one reports nothing rather than binding code to a moving tree
   * (D-068).
   *
   * It holds a revision only when a reading taken before the catalog was read
   * and a reading taken after it agree. A host is not alone on its tree, and
   * a write landing while the catalog is loading would otherwise be recorded
   * as a revision that does not describe the bytes the catalog holds.
   *
   * The engine reads it too, through the function its store is given: this
   * field is filled during registration, which runs after the engine layer
   * is composed, so the engine asks for the answer instead of being handed
   * one that did not exist yet.
   */
  revision: string | undefined
  /**
   * The registry and catalog rebuild this host's executor checks runs
   * against, or `undefined` when it has no executor. Set with `catalog`.
   *
   * Both are snapshots the control plane's own discovery does not refresh, so
   * an allowed drift that recorded the digest on disk handed the executor an
   * identity it did not hold: the resume was accepted and the run then failed
   * `LaunchFailed` (#2740). Adopting loads the new code through these first.
   */
  executor:
    | {
      readonly registry: Registry.Registry
      readonly refresh: Executable.Refresh | undefined
      /**
       * Runs `effect` in the host's transaction-free context. A resume
       * adopts inside the control mutation's SQL transaction, and a body
       * registered from there inherits it: every later run of that body
       * then failed "cannot start a transaction within a transaction".
       */
      readonly onHost: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
    }
    | undefined
}

/** A composition's host state before its executor registers anything. */
const emptyHost = (): HostState => ({ catalog: undefined, revision: undefined, executor: undefined })
/** Existing executable registration input to the native runtime final phase.
 * @since 1.0.0
 * @private
 */
export type ModuleRegistration = Layer.Layer<
  Executable.Catalog,
  never,
  | Executable.Registration
  | AgentAction.Host
  | Sandbox.Sandbox
  | Steering.Source
  | Exclude<Effect.Services<ReturnType<typeof AgentSession.make>>, Scope.Scope>
  | FileSystem.FileSystem
  | Path.Path
  | KernelJj.Jj
  | SqlClient
  | AttemptStore.AttemptStore
  | KernelChildProcessSpawner.ChildProcessSpawner
  | Budget.Budget
  | QuotaPolicy.QuotaClassifier
  | NotificationQueue.NotificationQueue
  | Evaluator.Evaluator
  | MemoryStore.MemoryStore
>

/** Everything the production executor is configured with beyond its stores.
 * @since 1.0.0
 * @private
 */
export interface ExecutorOptions {
  /** Product-host binding: require this exact catalog snapshot before admission. */
  readonly expectedSourceRevision?: string | undefined
  /** An explicit host judge, including an evidence-based offline script. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  /** Where seat credentials and the host's test declaration are read from. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /**
   * MCP servers to connect at startup, each projected into the run's flow
   * catalog by `@smthrs/mcp/McpFlows`, one more source alongside filesystem,
   * shell, and memory. A stdio server spawns through the guarded spawner; a
   * Streamable HTTP server is reached through the guarded egress `HttpClient`.
   * Empty by default: a host that names none behaves exactly as it always has.
   */
  readonly mcpServers?: ReadonlyArray<McpClient.ConnectOptions> | undefined
  /** The store the guarded filesystem and the spawner must both ask. */
  readonly grants?: Layer.Layer<GrantStore.GrantStore> | undefined
  readonly requestExecutor?: Layer.Layer<RequestExecutor.RequestExecutor> | undefined
  readonly quotaPolicy?: Layer.Layer<QuotaPolicy.QuotaClassifier> | undefined
  /** Seat-capacity parking policy forwarded to every agent run. */
  readonly capacity?: Agent.Options["capacity"]
  /** The checkout runs execute in, when it is not the project root. */
  readonly executionRoot?: string | undefined
  /** Where `engine.db` lives, when that is not the project root. */
  readonly stateRoot?: string | undefined
  /**
   * Whether this executor may drive a run. `false` builds the observing
   * executor described on `Application.Config.startsRuns`: no judge is
   * required and `launch` and `resumeRun` are unreachable.
   */
  readonly startsRuns?: boolean | undefined
  /** Planning imports authored modules without enabling launches or resumes. */
  readonly plansFlows?: boolean | undefined
  /** A human can answer this executor's in-run waits. */
  readonly approvalChannel?: boolean | undefined
  /**
   * Trusted native registrations using the existing executable catalog.
   * Built in the engine's registration phase with the guarded host platform;
   * every registered handler restores its owning approved control envelope.
   */
  readonly modules?: ModuleRegistration | undefined
  /**
   * Whether this executor imports a flow file its own runs write, while it
   * serves. Off by default; `Application.Config.rebuildAuthoredFlows` states
   * what turning it on means.
   */
  readonly rebuildAuthoredFlows?: boolean | undefined
}

/** Existing service implementations selected by the executable boundary.
 * @since 1.0.0
 * @private
 */
export interface Platform {
  readonly agentLimits?: {
    readonly modelCallMs: number
    readonly toolMs: number
    readonly taskMs: number
    readonly weights?: Budget.Weights | undefined
  } | undefined
  readonly host: Layer.Layer<NodeServices.NodeServices>
  readonly crypto: Layer.Layer<Crypto.Crypto>
  readonly database: (filename: string) => Layer.Layer<DurableWriter.DurableWriter | SqlClient>
  /** Opens an existing store read-only: no directory, migration, schema object or write lock. */
  readonly observe: (filename: string) => Layer.Layer<DurableWriter.DurableWriter | SqlClient>
  readonly runtime: typeof NodeFlowsRuntime.layer
  readonly jj: (root: string) => Layer.Layer<KernelJj.Jj, JjError, KernelChildProcessSpawner.ChildProcessSpawner>
  /** Private deployment policy around the already guarded standard file tools. */
  readonly filesystem?: (
    root: string,
    filesystem: FileSystem.FileSystem,
    spawner: KernelChildProcessSpawner.ChildProcessSpawner["Service"]
  ) => Effect.Effect<FileSystem.FileSystem>
  readonly httpClient: (
    environment: Readonly<Record<string, string | undefined>>
  ) => Layer.Layer<KernelHttpClient.HttpClient>
  readonly requestExecutor: Layer.Layer<RequestExecutor.RequestExecutor>
  /**
   * The judge this platform binds, when it is not the one its environment
   * names.
   *
   * A deployed host uses the existing subscription seat resolver. An offline
   * composition supplies an evidence-based scripted judge explicitly.
   */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly gateway: typeof NodeGateway.layer
  readonly bearerPrincipal: typeof NodeGateway.bearerPrincipal
}

const secureSqliteFiles = (file: string) =>
  Effect.gen(function*() {
    if (process.platform === "win32") return
    const fs = yield* FileSystem.FileSystem
    for (const sqliteFile of [file, `${file}-wal`, `${file}-shm`]) {
      if (yield* fs.exists(sqliteFile)) yield* fs.chmod(sqliteFile, 0o600)
    }
  }).pipe(Effect.orDie)

/**
 * The seats a native host resolves, and the catalog Jev routes an `auto` run
 * over: the aliases whose provider the same environment holds a credential for.
 */
const nativeSeats = (environment: Readonly<Record<string, string | undefined>>) =>
  Layer.merge(layerSeatResolver(environment), layerSeatCatalog(environment))

/** Binds one control composition to the already-existing Node or Bun services.
 *
 * `seats` provides the `SeatResolver`, and a `SeatRouter.Catalog` beside it
 * when the host routes undeclared and `auto` seats.
 * @since 1.0.0
 * @private
 */
export const make = (
  native: Platform,
  seats: (
    environment: Readonly<Record<string, string | undefined>>
  ) => Layer.Layer<SeatResolver.SeatResolver, never, RequestExecutor.RequestExecutor> = nativeSeats,
  decorateNotifications?: LocalControl.NotificationDecorator
) => {
  /**
   * The flow sources a local CLI discovers: the project `flows/` directory, whose
   * per-directory layout is the convention in
   * `docs/specs/Specs/Flow Directory.md`.
   *
   * Use this when building a project registry. It is pure and cannot fail; the
   * discovery layer reports unreadable or malformed sources later.
   *
   * @category constructors
   * @since 0.1.0
   */
  const projectSources = (root: string): ReadonlyArray<Descriptor.Source> => [
    { source: "project", root: join(root, "flows"), naming: "path", optionalRoot: true }
  ]

  // Resolve the shared Jev judge lazily. Pure flows and observing
  // hosts need no provider; a model judgment without a seat fails closed.
  const evaluatorFor = (
    environment: Readonly<Record<string, string | undefined>>,
    supplied?: Layer.Layer<Evaluator.Evaluator>,
    startsRuns = true
  ) => {
    return supplied ?? native.evaluator ?? (
      startsRuns
        ? layerSeatEvaluator(environment).pipe(Layer.provide(native.requestExecutor))
        : Evaluator.layerUnavailable()
    )
  }

  /**
   * The raw host platform: the selected platform services plus the descriptor-relative,
   * no-follow filesystem the kernel needs underneath it. `NodeServices` alone is
   * not enough: the kernel's guarded `FileSystem` refuses every operation unless
   * the host provides descriptor-relative, no-follow access, which is what
   * `AtomicFileSystem` adds on Node.
   *
   * This is the *unguarded* half of the composition. It is what
   * {@link layerGuardedPlatform} is built on, and it is what host equipment that
   * carries its own read boundary runs on: the workspace observer and the
   * metadata-only registry scan of the operator's configured sources.
   * Agent-reachable equipment never gets this layer: a flow, a tool, or anything
   * a model can steer takes {@link layerGuardedPlatform} so the kernel decides
   * what it may touch.
   *
   * One `const`, not a function, so every consumer in one composition shares a
   * single memoized build. Host acquisition failures remain startup failures in
   * the layers that consume it.
   *
   * @category layers
   * @since 0.1.0
   */

  const layerHostPlatform = native.host

  /**
   * The local CLI's real permission store.
   *
   * Its configured rule preserves the operator-owned CLI's allow policy, while
   * the real store still enforces the fiber's capability ceiling. This is
   * intentionally distinct from `GrantStore.layerNoop`, which skips both policy
   * evaluation and ceiling enforcement and is suitable only as an explicit test
   * input.
   *
   * @category layers
   * @since 1.0.0
   */
  const layerGrantStore = (root: string): Layer.Layer<GrantStore.GrantStore> =>
    GrantStore.layer({
      attended: false,
      rules: [
        new Rule({
          effect: "allow",
          pattern: new CapabilityPattern({ action: "*", resource: "*" })
        })
      ]
    }).pipe(
      Layer.provide(Workspace.layer(resolve(root))),
      Layer.orDie
    )

  /**
   * The kernel-guarded platform over one workspace root: every filesystem
   * operation resolved, authorized, re-resolved, and executed relative to a
   * pinned root descriptor.
   *
   * `grants` is the store the kernel asks before it authorizes an operation, and
   * it is a parameter rather than a constant so that one composition cannot end
   * up asking two different stores. The default is the local CLI's real store;
   * a hosted composition may supply a stricter `GrantStore`, and must supply the same one it gives
   * `KernelChildProcessSpawner`: a filesystem pinned to the allow-all store
   * beside a shell pinned to a real one is a fail-open the types would not catch.
   *
   * The confinement the kernel still enforces here is structural: canonical
   * resolution, the hard-link refusal, and descriptor-relative execution from a
   * pinned root. That is what costs: on Node one authorized operation is one
   * helper process, so a caller that performs one operation per file in a
   * checkout pays for the whole checkout. That is a cost to spend on
   * agent-reachable equipment and to refuse for a whole-tree walk; see
   * {@link layerHostPlatform}.
   *
   * @category layers
   * @since 0.1.0
   */
  const layerGuardedPlatform = (
    root: string,
    grants: Layer.Layer<GrantStore.GrantStore> = layerGrantStore(root)
  ) =>
    Layer.orDie(KernelFileSystem.layer).pipe(
      Layer.provide([Workspace.layer(root), grants]),
      Layer.provideMerge(layerHostPlatform)
    )

  /**
   * Provides the workspace observer the run's mutation accounting is measured
   * with: one pruned walk of the workspace root, taken at both ends of every
   * frame.
   *
   * On the host's own Node filesystem, deliberately, and never on
   * {@link layerGuardedPlatform}. The observer is host equipment: the root is
   * this composition's, not a model's. It carries its own confinement
   * argument: it stats, it never opens, it follows no symlink, and every path it
   * builds is an entry name under the root. `@smthrs/agent/WorkspaceObservation`
   * states that argument in full. Guarding it decides nothing and costs one
   * helper process per file: SWE-bench wave 6 spent 912 s of a 1,200 s budget on
   * django's opening walk and never reached the agent's first tool call.
   * `NodeWorkspaceObservation` states why it is Node's `fs` rather than
   * Effect's `FileSystem`: one call per file instead of two, measured together.
   *
   * @category layers
   * @since 0.1.0
   */
  const layerObserver = (
    root: string,
    options?: WorkspaceObservation.Options
  ): Layer.Layer<WorkspaceObservation.Observer> =>
    WorkspaceObservation.layerHost(NodeWorkspaceObservation.host, root, options)

  /**
   * Provides the native flow registry the local CLI discovers flows with.
   *
   * Discovery is read-only host equipment over the
   * operator's configured sources; discovery never imports a flow module.
   * Use the host filesystem so a scan does not spawn a guarded helper for every
   * probe. Body loading and executable flows still receive the guarded
   * platform. The layer exports only the registry. A source root that
   * does not exist scans empty. An unreadable one dies rather than silently
   * discovering nothing.
   *
   * @category layers
   * @since 0.1.0
   */
  const layerRegistry = (root: string): Layer.Layer<Registry.Registry> => {
    const discovery = Discovery.layer.pipe(Layer.provide(layerHostPlatform))
    return Registry.layer({ sources: projectSources(root) }).pipe(
      Layer.provide([discovery, layerGuardedPlatform(root)]),
      // A project with no `flows/` directory simply has no flows (`optionalRoot`),
      // and a refresh finds them once it appears. Every other discovery failure,
      // such as an unreadable root or malformed entry, is a startup defect rather
      // than a silent empty catalog.
      Layer.catch((error) => Layer.effect(Registry.Registry)(Effect.die(error)))
    )
  }

  /**
   * Where a local CLI keeps its control-plane database.
   *
   * Use this instead of assembling `.flows` paths at call sites. It is a pure
   * path projection and cannot fail; opening the returned file can.
   *
   * @category constructors
   * @since 0.1.0
   */
  const databasePath = ControlDatabasePath.databasePath

  /**
   * Where the durable flow engine keeps executions, attempts, cache entries,
   * and wake state. The control plane has a separate connection and schema in
   * {@link databasePath}; keeping the files separate makes each composition's
   * migration ownership explicit.
   * This is a pure path projection; engine startup reports creation or migration
   * failures when it opens the file.
   *
   * @category constructors
   * @since 0.1.0
   */
  const executionDatabasePath = ExecutionDatabasePath.executionDatabasePath

  /**
   * Acquires one durable graph and projects its live services back into layers.
   *
   * Nested `Layer.provide` calls build with independent memo maps, so merely
   * passing the same layer value to the runtime, journal, executor, and memory
   * store still opened one SQLite connection per consumer. Building the merged
   * graph in the caller's scope first gives every consumer the same live service
   * values, and closing that scope closes the sole connection.
   */
  const materializeEngine = (engine: EngineDurable): Effect.Effect<EngineDurable, never, Scope.Scope> =>
    Effect.map(
      Layer.build(Layer.mergeAll(engine.runtime, engine.journal, engine.stores)),
      (services) => ({
        runtime: Layer.succeed(
          ControlRuntime.ControlRuntime,
          Context.get(services, ControlRuntime.ControlRuntime)
        ),
        journal: Layer.succeed(Journal.Journal, Context.get(services, Journal.Journal)),
        stores: Layer.mergeAll(
          Layer.succeed(DurableWriter.DurableWriter, Context.get(services, DurableWriter.DurableWriter)),
          Layer.succeed(SqlClient, Context.get(services, SqlClient)),
          Layer.succeed(RunStore.RunStore, Context.get(services, RunStore.RunStore))
        ),
        host: engine.host
      })
    )

  /**
   * The reserved system catalog in the durable runtime's flow shape.
   *
   * The reserved verbs make no model calls of their own, so there is nothing for
   * a ceiling to bound and `Descriptor.budgetUnbounded` says so by name rather
   * than by an unlabelled `{}`.
   */
  const systemFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = SystemFlows.catalog.map((entry) => ({
    flowId: entry.flowId,
    description: `Reserved ${entry.verb} system flow`,
    deployClass: entry.deployClass,
    envelope: { capabilities: [], flows: [], budget: Descriptor.budgetUnbounded }
  }))

  /**
   * One node's address and the declaration site behind it, as a plan card may
   * carry it.
   *
   * The path is made relative to the project root with `@smthrs/journal`'s own
   * rule, the one the engine's node records are written under: a plan card is
   * read on machines that did not plan it, so an absolute path is at best
   * noise and at worst an operator's home directory published into a card.
   * A site this host cannot make relative is omitted, never guessed at.
   */
  const declarationOf = (root: string, node: Graph.GraphNode): ControlSchema.PlanGraphNode => {
    const path = node.declaredAt === undefined ? undefined : EngineEvent.relativePath(root, node.declaredAt.path)
    return {
      id: node.id,
      ...(path === undefined ? {} : { declaredAt: { path, line: node.declaredAt!.line } })
    }
  }

  /**
   * One discovered flow's keyed node graph, built at plan time.
   *
   * `Graph.build` walks the registered flow, which evaluates the DELEGATE's
   * body: the registry wraps every descriptor in a flow that calls its
   * delegate once, and the delegate's own topology — its fan-out, its
   * priorities, its waits — is what a person approving a plan needs to see.
   *
   * Planning performs no I/O, so the walk happens here in process. A body the
   * planner cannot walk still plans, with no nodes: discovery already
   * admitted the flow, and refusing here would take away the run door a
   * person has today over a graph they never asked to see.
   */
  const buildPlanGraph = (
    executable: Executable.Executable,
    input: unknown,
    root: string,
    host: HostState
  ):
    | { readonly drafts: ReadonlyArray<PersistedPlan.NodeDraft>; readonly graph: ControlSchema.PlanGraph }
    | { readonly unwalkable: string } =>
  {
    try {
      const graph = Graph.build(executable.flow, { input: input as never })
      // `drafts` throws the first fatal refusal rather than compiling partial
      // topology into a plan that looks whole.
      return {
        drafts: Graph.drafts(graph),
        graph: {
          edges: Graph.edges(graph),
          nodes: Graph.nodes(graph).map((node) => declarationOf(root, node)),
          /*
           * The tree those sites were read out of, when this host could name
           * one. It is the catalog's revision rather than a fresh read: the
           * module this graph was walked from is the one the catalog holds,
           * and a read taken now would name a tree the walk never saw.
           */
          ...(host.revision === undefined ? {} : { sourceRevision: host.revision })
        }
      }
    } catch (cause) {
      // The refusal is carried out, not swallowed: a plan with no nodes and no
      // reason is a plan nobody can diagnose.
      return { unwalkable: String(cause) }
    }
  }

  /**
   * The plan hook one discovered flow registers.
   *
   * No cache is probed, so every node reports `run`: this host cannot say a
   * key would hit, and a `cached` verdict it has not checked would be a claim
   * about work that has not been looked for.
   */
  const planExecutable =
    (executable: Executable.Executable, root: string, host: HostState) =>
    (input: unknown, planId: string): Effect.Effect<{
      readonly plan: PersistedPlan.Plan
      readonly graph?: ControlSchema.PlanGraph | undefined
    }, ControlError.InvalidInput> =>
      Effect.suspend(() => {
        const built = buildPlanGraph(executable, input, root, host)
        const walked = "unwalkable" in built ? undefined : built
        const noted = "unwalkable" in built
          ? Effect.logWarning("Planning this flow could not walk its body", {
            flowId: executable.descriptor.name,
            cause: built.unwalkable
          })
          : Effect.void
        return Effect.andThen(
          noted,
          PersistedPlan.compile({
            planId,
            flow: executable.descriptor.name,
            nodes: walked?.drafts ?? []
          }).pipe(
            Effect.map((plan) => walked === undefined ? { plan } : { plan, graph: walked.graph }),
            Effect.tapError((cause) =>
              Effect.logWarning("Planning this flow produced no graph", {
                flowId: executable.descriptor.name,
                cause: String(cause)
              })
            ),
            // A flow whose graph the compiler refuses still plans, with no nodes.
            Effect.catch(() =>
              PersistedPlan.compile({ planId, flow: executable.descriptor.name, nodes: [] }).pipe(
                Effect.map((plan) => ({ plan })),
                Effect.mapError((cause) => new ControlError.InvalidInput({ issue: Failure.operatorSentence(cause) }))
              )
            ),
            Effect.provide(native.crypto)
          )
        )
      })

  /**
   * Projects one discovered flow into the durable runtime's flow shape.
   *
   * The budget travels with the capabilities because it is enforced the same way
   * they are: `layerExecutor` hands `Budget.layerFromEnvelope` to `AgentSession`,
   * which builds one budget per run out of the approved card's envelope. A
   * hardcoded `{}` here made that enforcement bind nothing on the shipped CLI,
   * however carefully a flow declared its ceilings. `Descriptor.budgetOf` answers
   * the undeclared case with `budgetUnbounded`, so a flow that names no ceiling
   * still runs and a flow that names one is held to it.
   */
  const durableFlow = (
    descriptor: Descriptor.FlowDescriptor,
    root: string,
    host: HostState
  ): ControlRuntime.MemoryFlow => {
    // Read at LIST time, which the control runtime performs per plan: a host
    // that has since built its catalog offers the hook, and one that never
    // builds a catalog keeps planning exactly as it did, with no nodes.
    const executable = host.catalog?.executables.find((entry) => entry.descriptor.name === descriptor.name)
    return {
      flowId: descriptor.name,
      description: descriptor.description,
      deployClass: false,
      executionDigest: Descriptor.executionDigest(descriptor),
      envelope: {
        capabilities: descriptor.capabilities,
        flows: descriptor.flows,
        budget: Descriptor.budgetOf(descriptor)
      },
      ...(executable?.input === undefined ? {} : {
        // The module adapter constructs this same typed payload with .make
        // at dispatch. Validate that contract before recording an approval.
        decode: (input: unknown) => Effect.try({
          try: () => executable.input!.make(input),
          catch: (cause) => new ControlError.InvalidInput({
            issue: cause instanceof Error && SchemaIssue.isIssue(cause.cause)
              ? SchemaIssue.makeFormatterDefault()(cause.cause).split("\n").slice(0, 4).join("\n").slice(0, 800)
              : Failure.operatorSentence(cause)
          })
        })
      }),
      ...(executable === undefined ? {} : { plan: planExecutable(executable, root, host) })
    }
  }

  // Configuring the CLI's gateway token delegates the local operator's supported
  // decisions to that gateway's authenticated identity. This is a host policy,
  // not an authorization rule for arbitrary bearer or agent principals.
  const gatewayApprovalAuthority = Effect.runSync(ApprovalAuthority.make([
    { principal: { id: "local", kind: "operator" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] },
    { principal: native.bearerPrincipal, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
  ]))

  /**
   * Provides the durable local engine: `SqlControlRuntime` and the production
   * SQL journal, both over one SQLite file under the project root.
   *
   * The previous local composition was `ControlRuntime.layerMemory()` over
   * `TestJournal`, an in-memory database, so no plan, approval, run, or journal
   * entry survived the process. Sharing one connection between the runtime and
   * the journal is deliberate: the fenced run transitions and the events that
   * describe them then commit against the same database.
   *
   * With a `registry`, the runtime knows every discovered flow as well as the
   * reserved system catalog, so `smthrs plan <flow>` plans a project flow
   * instead of failing `FlowNotFound`.
   *
   * Reach for this value at a native composition root and reuse it. Database open,
   * migration, and journal startup failures are promoted to defects because no
   * local command can proceed honestly without the store.
   *
   * @category layers
   * @since 0.1.0
   */
  const engineDurable = (
    root: string,
    registry?: Layer.Layer<Registry.Registry> | undefined,
    authority: Pick<Application.Config, "approvalAuthority" | "principal" | "credential" | "stateRoot"> = {}
  ): EngineDurable => {
    // `root` names the project; `stateRoot` names where its databases live. A
    // host served over a live working copy separates the two so the control
    // plane's own writes are not edits to the code a run is reading.
    const file = databasePath(authority.stateRoot ?? root)
    const host = emptyHost()
    const authorization = {
      principal: authority.principal,
      approvalAuthority: authority.approvalAuthority ??
        (authority.credential === undefined || authority.credential === ""
          ? ApprovalAuthority.local
          : gatewayApprovalAuthority)
    }
    // One real process identity per local control plane. A constant pid made two
    // CLIs on one host appear to own the same fence and allowed the loser to
    // re-drive work claimed by the winner.
    const owner = Object.freeze({ hostId: hostname(), pid: process.pid, nonce: randomUUID() })
    const database = native.database(file).pipe(Layer.orDie)
    // A control plane that cannot open its own database has nothing to serve, so
    // a failed open, migration, or journal start is a startup defect rather than
    // a typed control-plane error every command would have to carry.
    // The control and native engines both use RunStore over different databases.
    // Its exported layer is a singleton: a shared memo map must not reuse the
    // control instance inside the native engine, whose state is versioned.
    const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), Layer.fresh(RunStore.layer))
      .pipe(
        Layer.provideMerge(database),
        Layer.orDie
      )
    const runtime = registry === undefined
      ? SqlControlRuntime.layer({
        ...authorization,
        owner,
        isAlive: Ownership.sameHostPidProbe,
        engineVersion: packageVersion
      }).pipe(
        Layer.provide([stores, native.crypto]),
        Layer.orDie
      )
      : Layer.effect(ControlRuntime.ControlRuntime)(
        Effect.gen(function*() {
          const registryService = yield* Registry.Registry
          const discoveryError = (operation: string) => (cause: { readonly message: string }) =>
            new ControlError.PersistenceError({ operation, message: cause.message, cause })
          // Discovery scans these roots. A catalog entry from one of them that
          // discovery no longer names was deleted; one from anywhere else is a
          // flow the host registered itself, which discovery never scans.
          const scanned = new Set(projectSources(root).map((source) => resolve(source.root)))
          // The drift check reads the disk through a registry of its own.
          // Refreshing `registryService` replaced the snapshot `loadFlows`
          // plans from, so reading a live run's drift made a flow that run
          // wrote plannable, as a plan of no nodes, on a host that does not
          // rebuild authored flows. Built on first use, it scans once then.
          const scope = yield* Scope.Scope
          let onDisk: Registry.Registry | undefined
          const readDisk = Effect.suspend(() =>
            onDisk !== undefined
              ? onDisk.refresh().pipe(Effect.as(onDisk))
              : Layer.buildWithScope(Layer.fresh(registry), scope).pipe(
                Effect.map((context) => (onDisk = Context.get(context, Registry.Registry))),
                // `layerRegistry` dies on a discovery failure at startup; here
                // it is the same typed refusal a failed refresh answers.
                Effect.catchDefect((defect) =>
                  Effect.fail({ message: defect instanceof Error ? defect.message : String(defect) })
                )
              )
          )
          const currentFlows = () =>
            readDisk.pipe(
              Effect.mapError(discoveryError("read the flows' current code")),
              Effect.flatMap((disk) => disk.list()),
              Effect.map((discovered) => {
                const named = new Set(discovered.map((flow) => flow.name))
                return [
                  ...systemFlows,
                  ...[
                    ...discovered,
                    ...(host.catalog?.executables ?? []).map((entry) => entry.descriptor)
                      .filter((descriptor) =>
                        !named.has(descriptor.name) && !scanned.has(resolve(descriptor.provenance.root))
                      )
                  ].map((flow) => durableFlow(flow, root, host))
                ]
              })
            )
          const adoptFlow = (flowId: string) =>
            Effect.gen(function*() {
              const executor = host.executor
              // With no executor here, the code on disk is all this host names.
              if (executor === undefined) return (yield* currentFlows()).find((flow) => flow.flowId === flowId)
              const descriptor = yield* executor.onHost(Effect.gen(function*() {
                yield* executor.registry.refresh()
                const found = yield* executor.registry.getOption(flowId)
                if (Option.isNone(found)) return undefined
                // A prompt flow's body is read off the registry at each run.
                if (found.value.body._tag !== "Module") return found.value
                // A module's body is the executable the catalog holds, so the
                // catalog is rebuilt from the bytes on disk. The operator asked
                // for exactly this code, which is why an adopt may import it
                // on a host that does not rebuild authored flows.
                const rebuilt = executor.refresh === undefined ? undefined : yield* executor.refresh.flow(flowId)
                if (rebuilt?._tag === "Registered") return rebuilt.executable.descriptor
                if (rebuilt?._tag === "Removed" || rebuilt?._tag === "Refused") return undefined
                // A host that cannot rebuild the entry, or holds it fixed, runs
                // the executable it loaded, and only that code can be adopted.
                const loaded = host.catalog?.executables.find((entry) => entry.descriptor.name === flowId)
                return loaded !== undefined &&
                    Descriptor.executionDigest(loaded.descriptor) === Descriptor.executionDigest(found.value)
                  ? loaded.descriptor
                  : undefined
              }))
              return descriptor === undefined ? undefined : durableFlow(descriptor, root, host)
            }).pipe(Effect.mapError(discoveryError("load the flow's current code")))
          return yield* SqlControlRuntime.make({
            ...authorization,
            owner,
            engineVersion: packageVersion,
            // A run whose host was killed mid-run is taken over by the host
            // whose engine re-drives it, once the dead owner's lease expires.
            isAlive: Ownership.sameHostPidProbe,
            loadFlows: () =>
              registryService.list().pipe(
                Effect.map((discovered) => {
                  // A catalog entry this host rebuilt after startup is a flow
                  // it can plan and run now. The control plane materializes
                  // its own build of the registry layer, so that snapshot can
                  // still be the one taken before the file existed — or, for a
                  // flow a run EDITED, the one taken before the new bytes were
                  // written. A rebuilt entry therefore wins on a name it
                  // shares with discovery: the executor holds the body that
                  // will run, so its descriptor is what honestly describes it.
                  //
                  // Answering from the stale descriptor is not a cosmetic
                  // error. `durableFlow` reads the plan hook off the rebuilt
                  // executable and everything else — description, capabilities,
                  // delegated flows, budget, execution digest — off whichever
                  // descriptor is passed here, so a stale one publishes an
                  // approval card for one body beside a plan of another, and
                  // the run it authorizes is then refused `execution_changed`
                  // against the file on disk. Every replacement plan carries
                  // the same stale digest, so the refusal never clears.
                  const rebuilt = new Map(
                    (host.catalog?.executables ?? []).map((entry) => [entry.descriptor.name, entry.descriptor] as const)
                  )
                  const named = new Set(discovered.map((flow) => flow.name))
                  return [
                    ...systemFlows,
                    ...[
                      ...discovered.map((flow) => rebuilt.get(flow.name) ?? flow),
                      ...[...rebuilt.values()].filter((descriptor) => !named.has(descriptor.name))
                    ].map((flow) => durableFlow(flow, root, host))
                  ]
                })
              ),
            // The drift check asks what is on disk NOW. The snapshot above is
            // the one discovery took at startup, and a flow edited or deleted
            // while this host stays up is invisible to it, so a resume it
            // passed was claimed and then failed by the executor's own byte
            // check (#1807). Discovery wins here over a rebuilt entry: the
            // question is whether the source moved, not what the host loaded.
            currentFlows,
            // An allowed drift records the code the executor will run, so the
            // executor loads it first (#2740).
            adoptFlow
          })
        })
      ).pipe(
        Layer.provide([stores, native.crypto]),
        // The registry builds first, alone. Built beside `stores`, whose build
        // `materializeEngine` shares, a registry that dies interrupts that
        // shared build, and effect 4.0.0-rc.115 then reports only the
        // interruption: every command failed "All fibers interrupted without
        // error" instead of naming the discovery failure (#1924).
        Layer.provide(registry),
        Layer.orDie
      )
    return {
      runtime,
      journal: stores,
      stores,
      host
    }
  }

  /**
   * Provides the production run executor: the `@smthrs/agent` composition root
   * over the durable control stores, the local flow registry, and the standard
   * host capabilities: filesystem and shell through the kernel's guarded
   * layers, durable memory over the control database, approval and steering
   * wired back into the control plane by the session itself.
   *
   * The durable engine is built through the selected existing native runtime, whose
   * final registration phase constructs `AgentSession`. This is deliberate:
   * the executor cannot accept a launch until the engine database is migrated,
   * its stores and sweepers are live, and the agent flow body has been
   * registered. The resulting engine state is durable, and no launch can race
   * ahead of that durability-sensitive startup order.
   *
   * @category layers
   * @since 0.1.0
   */
  const executorFromEngine = (
    registry: Layer.Layer<Registry.Registry>,
    engine: EngineDurable,
    root: string,
    options: ExecutorOptions,
    evaluator: Layer.Layer<Evaluator.Evaluator>
  ): Layer.Layer<
    ControlExecutor.ControlExecutor,
    never,
    ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
  > => {
    const {
      environment,
      grants = layerGrantStore(root),
      mcpServers = [],
      modules: suppliedModules,
      quotaPolicy = QuotaPolicy.layerDefault(),
      requestExecutor = native.requestExecutor
    } = options
    // Observing commands keep discovery metadata-only. A run-capable local
    // host registers file modules after its engine and agent services exist.
    const modules = suppliedModules ?? (options.startsRuns === false && options.plansFlows !== true
      ? undefined
      : Executable.layer({ delegates: [] }).pipe(Layer.orDie))
    // Same separation `engineDurable` makes for `control.db`: `engine.db` and
    // its WAL follow the state root, never the served checkout.
    const stateRoot = resolve(options.stateRoot ?? root)
    // Every capability this executor equips a run with belongs to the checkout
    // the run executes in, which is the fork's worktree once history resumed one
    // and the project root otherwise. `root` still names the project: its
    // databases, its routing table, and the mount a container knows it by.
    const workspaceRoot = resolve(options.executionRoot ?? root)
    // Startup sweepers may ask before final registration captures the native SQL
    // client. They refuse until that existing final phase installs the reader.
    let admission: ((runId: string) => Effect.Effect<boolean>) | undefined
    const canExecute = (runId: string) => Effect.suspend(() => admission?.(runId) ?? Effect.succeed(false))
    // The control plane the engine records its own wakes against, captured the
    // same way and for the same reason as `admission` above: the engine layer
    // is built before the registration phase that holds the control runtime.
    //
    // A durable clock firing, a durable deferred completing, and a child
    // settling under a parent that parked on it are the wakes nobody asks for
    // — no operator, no approval, no answer — and `AgentSession`'s round guard
    // refuses a parked run whose resume nothing delegated. Recording the
    // request is what tells that guard an engine wake from its own heartbeat
    // sweep; without it a run that slept never settled.
    //
    // Every refusal is tolerated rather than raised: a run this control plane
    // never launched has no row (`RunNotFound`), a settled one owes no resume
    // (`InvalidInput`), and neither is a reason to fail the wake.
    let resumes: ControlRuntime.Service | undefined
    const requestResume = (runId: string) =>
      Effect.suspend(() =>
        resumes === undefined
          ? Effect.void
          : Effect.ignore(resumes.requestResume(runId))
      )
    // The same guarded platform the registry discovers under: kernel FileSystem
    // over descriptor-relative atomic access, with the selected service bundle
    // (Path, raw spawner, crypto) merged through. `grants` is passed rather than
    // defaulted so the filesystem and the shell below it can never end up asking
    // two different stores.
    const platform = layerGuardedPlatform(workspaceRoot, grants)
    // Permission checks do not contain a process after its CLI owner crashes.
    // Keep one durable ledger under the shell, native search/test runners and
    // MCP connections, and reap only verified children of dead owners before
    // exposing the spawner. The registration phase receives the engine journal
    // from native.runtime, so these records survive this process.
    const contain = () =>
      ProcessReaper.layerSpawner().pipe(
        Layer.provideMerge(platform),
        Layer.provideMerge(ProcessReaper.layer()),
        Layer.provide(ProcessLedger.layer({ hostId: hostname(), ownerPid: process.pid }))
      )
    let toolSpawner: KernelChildProcessSpawner.ChildProcessSpawner["Service"] | undefined
    const contained = contain().pipe(Layer.tap((context) =>
      Effect.sync(() => {
        toolSpawner = Context.get(context, KernelChildProcessSpawner.ChildProcessSpawner)
      })
    ))
    // Engine bookkeeping must be contained before the native engine itself
    // starts. Reuse the already materialized control journal for that lifetime;
    // a distinct layer instance keeps registration's native journal separate.
    const engineJj = native.jj(workspaceRoot).pipe(
      Layer.provide(contain().pipe(Layer.provide(engine.journal)))
    )
    // Commands and relative paths resolve in the checkout the run executes in,
    // never the process's own directory.
    const guarded = Layer.mergeAll(
      KernelChildProcessSpawner.layer,
      KernelPath.layer,
      KernelHttpClient.layer.pipe(Layer.provide(native.httpClient(environment)))
    ).pipe(
      Layer.provide([grants, Workspace.layer(workspaceRoot)]),
      Layer.provideMerge(contained)
    )
    // `SMITHERS_MEMORY_DB` moves the memory store to its own SQLite file, so
    // runs of one repository in separate workspaces read and write one memory
    // while every other store stays in this workspace's `engine.db`. Recall
    // reads the same store, so what one run remembers the next is shown; see
    // `SupervisorMemory` for the busy timeout, the bank and the opt-in.
    const memory = SupervisorMemory.layer({
      environment,
      database: native.database,
      crypto: native.crypto,
      stores: engine.stores
    })
    // AgentSession installs the effective budget from the approved card around
    // each `agent.run`. No card exists while this executor layer is built, so
    // unbounded is the only honest construction-time budget. The provider is
    // discarded after it closes `Agent.layer`; every run installs
    // `Budget.layerFromEnvelope` directly around the call. The quota layer is
    // the same policy the session installs for the run.
    const sessionAgent = Agent.layer.pipe(
      // eslint-disable-next-line no-restricted-syntax -- no envelope exists until AgentSession starts a run
      Layer.provide(Layer.mergeAll(quotaPolicy, Budget.layerUnbounded()))
    )
    // The judge was selected before the control stores were materialized.
    // Every classifier and the completion brake below share that binding.
    // The dispatcher must live as long as the executor. A model captures this
    // service and uses it after seat resolution has returned.
    //
    // It also has to be replaceable. A retry ladder repairs a failure by waiting,
    // and an HTTP/2 session the peer has destroyed is the failure waiting does not
    // repair: every attempt that reuses the pool holding it fails identically, and
    // r92 of the SWE-bench full benchmark spent ten `transport` retries and $0.85
    // proving it on two instances. Undici's `Agent` *is* the pool, and
    // `makeDispatcher` acquires a fresh one, so the honest rebuild here is a new
    // agent in a scope of its own. The previous one is closed as soon as the new
    // one is in hand, so a run that rebuilds many times still holds one pool.
    const registration = Layer.effect(ControlExecutor.ControlExecutor)(
      Effect.gen(function*() {
        // Read immediately before loading the configured module catalog, inside
        // the native registration scope that owns this host's engine lifecycle.
        const revisionBefore = yield* SourceRevision.read(workspaceRoot)
        // Picked, never the whole registration context: see `toolServices`.
        const { filesystem: capturedFilesystem, judge, shell: shellServices } = yield* toolServices
        const filesystemServices = native.filesystem === undefined ? capturedFilesystem : Context.add(
          capturedFilesystem,
          FileSystem.FileSystem,
          yield* native.filesystem(
            workspaceRoot,
            Context.get(capturedFilesystem, FileSystem.FileSystem),
            toolSpawner!
          )
        )
        const memoryServices = yield* Effect.context<MemoryStore.MemoryStore | Recall.Recall>().pipe(
          Effect.map(Context.pick(MemoryStore.MemoryStore, Recall.Recall))
        )
        const nativeSearch = NativeSearch.make(Context.merge(filesystemServices, shellServices))
        // What `memory` reads through: the workspace, jj and git, the judge,
        // and the facts store.
        const contextServices = Context.merge(
          Context.merge(Context.merge(filesystemServices, shellServices), memoryServices),
          judge
        )
        // `test` is offered exactly when this host can say how the repository
        // runs its tests. The declaration carries the container too, so the
        // runner reaches the same transport `bash` does, and the judge that
        // attributes a non-zero exit travels with them.
        const runner = testRunner(environment, root, workspaceRoot)
        const container = Container.makeCommand()
        // A sealed host reaches one container and nothing of itself: `bash`
        // refuses every other target and the host filesystem flows are absent.
        const sealedTo = sealedContainer(environment)
        // Each configured server is a startup-time connection the operator
        // opted into by naming it, the same way `memory` below is: a server
        // that fails to spawn dies the executor loudly (`Effect.orDie`) rather
        // than running silently short of the tools it was configured to have.
        const mcp = yield* Effect.forEach(mcpServers, (server) => Effect.orDie(McpFlows.connected(server)))
        const sources = [
          ...(sealedTo === undefined ? [StandardFlows.filesystem(filesystemServices, nativeSearch)] : []),
          StandardFlows.shell(shellServices, container, { sealedTo }),
          // Host-wide on purpose: these sources are built once per executor,
          // before any run, and the operator owns this memory database. A
          // host that runs a flow declaring `WithMemory.Policy` composes a
          // `MemoryScope` for that run instead.
          StandardFlows.memory(memoryServices, judge, StandardFlows.hostWide),
          // The same judge the completion brake and `test` use, offered to the
          // cell directly. Subscription availability is checked at dispatch;
          // an unavailable judge is the call's own typed failure.
          StandardFlows.jev(judge),
          // `memory({ task })`, the same selection a run opens with. It reads
          // the host workspace, so a sealed host offers it no more than the
          // filesystem flows.
          ...(sealedTo === undefined
            ? [Memory.source(contextServices, { root: workspaceRoot })]
            : []),
          ...testFlows(Context.merge(shellServices, judge), container, runner),
          ...mcp
        ]
        // The judge `evaluatorFor` requires arms nudges and memory insertion
        // in the run and in every subagent step; memory writes wait for a
        // memory database of the operator's own.
        const supervisorOptions = SupervisorMemory.options(environment, workspaceRoot)
        const instructions = workspaceInstructions(workspaceRoot)
        const actionHost = AgentAction.makeHost({
          registry: yield* Registry.Registry,
          limits: native.agentLimits === undefined
            ? cellLimits
            : { ...cellLimits, callMs: native.agentLimits.toolMs, totalMs: native.agentLimits.taskMs },
          modelCallMs: native.agentLimits?.modelCallMs,
          flows: sources,
          instructions,
          pinnedSources: ["wait", "ask"],
          // Subscription judgments fail closed on missing seats or invalid answers.
          judged: true,
          supervisor: supervisorOptions,
          approvalChannel: options.approvalChannel
        })
        const catalogReady = yield* Deferred.make<Executable.Catalog>()
        // Lifecycle, steering and approval belong to the control journal. The
        // registration phase otherwise inherits the engine's separate journal.
        // Select only Journal: an unmaterialized engine.journal layer can also
        // provide the control RunStore, which must not replace the native one.
        const controlJournal = yield* Journal.Journal.pipe(Effect.provide(engine.journal))
        const authority = modules === undefined ?
          undefined :
          yield* ModuleAuthority.make(Deferred.await(catalogReady), actionHost, {
            controlJournal,
            parks: askPolicy(environment) !== "refuse",
            weights: native.agentLimits?.weights
          })
        const registrations = modules === undefined ? undefined : yield* Layer.build(modules.pipe(
          // No approved card exists at registration. ModuleAuthority installs
          // the shared, journal-backed approved Budget at each handler entry.
          // eslint-disable-next-line no-restricted-syntax -- construction-time dependency only
          Layer.provide(Budget.layerUnbounded()),
          Layer.provide(Action.layerImplementations),
          Layer.provide(AgentAction.layerHost(actionHost)),
          Layer.provide(evaluator),
          // The same store the run's memory flows and `memory notes` use.
          Layer.provide(Layer.succeedContext(memoryServices)),
          Layer.provide(QuickJSSandbox.layer.pipe(Layer.orDie)),
          Layer.provide(Layer.succeed(Steering.Source, authority!.steering)),
          Layer.provide(Layer.succeed(FlowRuntime.FlowRuntime, authority!.runtime))
        ))
        const catalog = registrations === undefined ? undefined : Context.get(registrations, Executable.Catalog)
        // Product hosts must establish their pinned source before any run
        // admission or gateway readiness. Generic native/library compositions
        // omit this requirement and may continue to report no source revision.
        const revisionAfter = yield* SourceRevision.read(workspaceRoot)
        const capturedRevision =
          catalog === undefined || revisionBefore === undefined || revisionBefore !== revisionAfter
            ? undefined
            : revisionBefore
        if (options.expectedSourceRevision !== undefined && capturedRevision !== options.expectedSourceRevision) {
          return yield* Effect.die(
            capturedRevision === undefined
              ? new CliError.Refused({
                fault: "user",
                code: "source_revision_unavailable",
                message: "Flow host source revision is unavailable; require a stable JJ snapshot or clean Git checkout"
              })
              : new CliError.Refused({
                fault: "policy",
                code: "source_revision_mismatch",
                message: "Flow host source revision does not match its authorized workspace binding"
              })
          )
        }
        if (catalog !== undefined) yield* Deferred.succeed(catalogReady, catalog)
        // Planning reads this reference; see `HostState.catalog`. The value is the
        // catalog service itself, which answers with whatever snapshot the
        // registration layer currently holds, so a rebuilt entry reaches
        // planning without this reference being written again.
        engine.host.catalog = catalog
        /*
         * And the tree it was read out of, so a plan's sites can be opened at
         * the revision they describe. A host with no catalog builds no graph,
         * so it records no revision either — and neither does a host whose tree
         * moved while the catalog above was being read, because the revision
         * taken before that read then names bytes the catalog may not hold. A
         * tree that moved during startup names nothing, exactly as a dirty git
         * checkout does.
         */
        engine.host.revision = capturedRevision
        // Optional, and read rather than required, because a host may build
        // its catalog itself: `flows/coding/host.ts` assembles a project
        // catalog and a bundled one with different loaders and provides the
        // merged value directly. Such a host keeps the startup snapshot it
        // always had until it offers a rebuild of its own; one composed from
        // `Executable.layer` gets it for nothing.
        // Rebuilding on authoring is an EXPLICIT host decision, off unless the
        // composition asked for it. The seam itself is only a rebuild; what it
        // costs is the import, which runs an agent's top-level code in this
        // process with this host's credentials the moment copy-back settles,
        // with nothing between the write and the import. A host that holds
        // credentials keeps the startup snapshot, and a flow a run authored
        // becomes plannable the next time an operator starts it.
        const catalogRefresh = registrations === undefined || options.rebuildAuthoredFlows !== true
          ? undefined
          : Option.getOrUndefined(Context.getOption(Executable.Refresh)(registrations))
        const engineSql = yield* SqlClient
        const controlSql = yield* SqlClient.pipe(Effect.provide(engine.stores))
        const routing = yield* WorkspaceRouting.make({ root, engine: engineSql, control: controlSql })
        // The engine's wake recorder and the admission check are filled in
        // together: this is the first point in the composition that holds the
        // control runtime.
        resumes = yield* ControlRuntime.ControlRuntime
        const moduleAdmission = ModuleAdmission.make({
          runs: yield* RunStore.RunStore,
          control: resumes,
          registry: yield* Registry.Registry,
          catalog
        })
        const releasedChildResume = ReleasedChildResume.make({
          engineJournal: yield* Journal.Journal,
          controlJournal,
          engineRuns: yield* RunStore.RunStore,
          engineState: yield* DurableEngineState.DurableEngineState,
          claimant: { hostId: hostname(), pid: process.pid, nonce: "control-admission" }
        })
        const controlAffinity = ControlAffinity.make({
          runs: yield* RunStore.RunStore.pipe(Effect.provide(engine.stores)),
          engineRuns: yield* RunStore.RunStore,
          canRetryReleased: releasedChildResume.canRetryReleased,
          claimant: { hostId: hostname(), pid: process.pid, nonce: "control-admission" }
        })
        admission = (runId) =>
          routing.canExecute(workspaceRoot, runId).pipe(
            Effect.flatMap((allowed) => allowed ? controlAffinity(runId) : Effect.succeed(false)),
            Effect.flatMap((allowed) => allowed ? moduleAdmission(runId) : Effect.succeed(false)),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning("Native admission lookup failed; leaving the run parked", {
                  runId,
                  cause: Cause.pretty(cause)
                })
                  .pipe(Effect.as(false))
            )
          )
        // Capture native ports and a transaction-free host context BEFORE the
        // session selects its control journal. A different Journal service alone
        // would not remove an inherited control SQL transaction from a caller.
        const nativeFacts = ExecutionFacts.make({
          runs: yield* RunStore.RunStore,
          state: yield* DurableEngineState.DurableEngineState,
          journal: yield* Journal.Journal,
          sourceId: "native-control:execution-facts:v1"
        })
        const nativeHost = yield* Effect.context<never>()
        engine.host.executor = {
          registry: yield* Registry.Registry,
          refresh: registrations === undefined
            ? undefined
            : Option.getOrUndefined(Context.getOption(Executable.Refresh)(registrations)),
          onHost: (effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() => Effect.runForkWith(nativeHost)(effect)),
              Fiber.join,
              Fiber.interrupt
            )
        }
        const requestNativeCancel: ControlExecutor.Service["requestCancel"] = (input) =>
          Effect.acquireUseRelease(
            Effect.sync(() =>
              Effect.runForkWith(nativeHost)(Effect.gen(function*() {
                const at = yield* Clock.currentTimeMillis.pipe(Effect.map(Math.floor))
                const outcome = yield* nativeFacts.requestCancelLineage(input.runId, at).pipe(
                  Effect.mapError((cause) =>
                    new ControlError.PersistenceError({
                      operation: "NativeControl.requestCancel",
                      message: "Cannot commit native cancellation intent",
                      cause
                    })
                  )
                )
                if (outcome._tag === "Terminal") return { _tag: "Terminal", status: outcome.status } as const
                if (outcome._tag === "NotFound") {
                  return "unknown" as const
                }
                return outcome._tag === "AlreadyRequested" ? "already-requested" as const : "recorded" as const
              }))
            ),
            Fiber.join,
            Fiber.interrupt
          )
        // Capture the original native services before selecting the control
        // journal for AgentSession. This observer lives in the same host scope,
        // outside admission transactions; it opens no persistence of its own.
        //
        // It is built before the session because the session's terminal control
        // writes are ordered against it: on this host a run's output reaches a
        // reader only as the decision this observer copies, so `completed` must
        // not be journaled before that copy exists.
        const supervisor = yield* EngineJournalSupervisor.make({
          engineJournal: yield* Journal.Journal,
          controlJournal,
          engineState: yield* DurableEngineState.DurableEngineState,
          runs: yield* RunStore.RunStore,
          control: yield* ControlRuntime.ControlRuntime,
          // A run of this host may write this host's own `flows/` directory.
          // Until the catalog entry behind the file it wrote is rebuilt, the
          // flow has a descriptor and no executable, so `plan` answers
          // `FlowNotFound` or a plan with no nodes however many times it is
          // asked. Rebuilding here, before the receipt is copied across, is
          // what makes the next plan a client asks for answerable.
          //
          // A failed rebuild is said out loud and dropped: the observation is
          // how a client learns a run's nodes settled, and losing that because
          // a flow file does not compile would take the whole run's evidence
          // with it. The catalog keeps the refusal, so `ls` still names it.
          ...(catalogRefresh === undefined ? {} : { onSourceApplied: AuthoredRebuild.rebuild(catalogRefresh) })
        })
        const session = AgentSession.make({
          requestNativeCancel,
          canExecute,
          authorizeReleasedChildren: releasedChildResume.authorize,
          flows: sources,
          workspaceInstructions: instructions,
          pinnedSources: ["wait", "ask"],
          limits: native.agentLimits === undefined
            ? cellLimits
            : { ...cellLimits, callMs: native.agentLimits.toolMs, totalMs: native.agentLimits.taskMs },
          modelCallMs: native.agentLimits?.modelCallMs,
          quotaPolicy,
          capacity: options.capacity,
          budget: (envelope) => Budget.layerFromEnvelope(envelope, { weights: native.agentLimits?.weights }),
          memory: (launch) =>
            SupervisorMemory.opening(launch, { root: workspaceRoot, sealed: sealedTo !== undefined })
              .pipe(Effect.provideContext(contextServices)),
          instructions: (launch) =>
            RoleProfile.forRun(workspaceRoot, launch.descriptor, launch.text, launch.capabilities)
              .pipe(Effect.provideContext(filesystemServices)),
          orderTerminalStatus: supervisor.awaitSettled,
          approvalChannel: options.approvalChannel,
          asks: askPolicy(environment),
          supervisor: supervisorOptions,
          judged: true
        })
        const executor = yield* (catalog === undefined ? session : session.pipe(
          Effect.provideService(Executable.Catalog, catalog)
        )).pipe(Effect.provideService(Journal.Journal, controlJournal))
        yield* Effect.forkScoped(supervisor.recover)
        return supervisor.wrap(executor)
      })
    ).pipe(
      Layer.provide([
        guarded,
        memory,
        quotaPolicy,
        sessionAgent,
        // The run's mutation accounting is measured rather than declared, and
        // this is what measures it: without an observer in the composition the
        // controller falls back to what a frame's calls claimed about
        // themselves, which is blind to every `bash` write. It runs on the host
        // platform rather than on `platform`, for the reasons `layerObserver`
        // states.
        layerObserver(workspaceRoot),
        // Where a run's checkpoints live. Without it `ctx.checkpoint()` and
        // `ctx.base` answer `checkpoint_unavailable`, honestly, and the run
        // takes its readings on the live tree. This is the difference
        // between a run that can prove fails-before without reverting its own
        // work and one that cannot.
        Checkpoints.layerGit(checkpointStore(environment, workspaceRoot)),
        // One Jev judge handles attribution and completion.
        evaluator,
        // The seat resolver, and the catalog an undeclared or `auto` seat is
        // routed over at run start.
        seats(environment).pipe(Layer.provide(requestExecutor))
      ])
    )
    const nativeRuntime = native.runtime(
      {
        filename: executionDatabasePath(stateRoot),
        workspaceRoot,
        // The machine's own name, for the same reason `engineDurable` stamps
        // it: `sameHostPidProbe` compares `hostId` before it trusts a pid, and
        // a constant made every row in every process table look local. Two
        // checkouts inside one container and the host they are bind-mounted
        // from share this file with disjoint pid namespaces, so under a
        // constant the probe answered about the wrong process table, and a row
        // whose owner was alive elsewhere read as dead here.
        owner: { hostId: hostname() },
        // Two terminals over one project are two engine processes over one
        // `.flows/engine.db`, so "one engine process at a time" was never true
        // and a stub answering `false` let each steal the other's running rows
        // 30 seconds after any heartbeat stall. The probe asks the process
        // table instead, and answers only about this host: a run recorded on
        // another host is left to the lease, which `RunStore.steal` verifies.
        isAlive: Ownership.sameHostPidProbe,
        canExecute: (row) => canExecute(row.runId),
        requestResume,
        // The same revision the plans carry, asked for rather than handed over:
        // the engine drives the modules this host loaded at startup, so the
        // sites its journal records describe that tree and say which one — but
        // this layer is composed BEFORE registration reads the catalog, so the
        // verified answer does not exist yet. The store asks once per recorded
        // page, which is always after registration, and records nothing while
        // there is nothing to record (D-068).
        sourceRevision: () => engine.host.revision
      },
      StepBoundary.layer,
      WorkspaceSandbox.layerFileSystem(),
      registration
    ).pipe(
      Layer.provide([platform, native.crypto, engineJj]),
      Layer.tap(() => secureSqliteFiles(executionDatabasePath(stateRoot)).pipe(Effect.provide(native.host))),
      // Failure to open or migrate the local execution engine is a startup
      // defect, just like the control database above: no command can execute
      // honestly without this composition.
      Layer.orDie
    )
    // The runtime exposes its stores for native registrations. Only the
    // executor crosses back into the control composition: leaking the native
    // Journal or RunStore here silently redirects ControlLive to engine.db.
    return Layer.effect(ControlExecutor.ControlExecutor)(ControlExecutor.ControlExecutor).pipe(
      Layer.provide(nativeRuntime)
    )
  }

  /**
   * Builds the executor over one captured control-store graph. Materializing
   * before native registration prevents the shared RunStore layer from being
   * memoized against the other database in an embedding composition.
   * @category layers
   * @since 1.0.0
   */
  const layerExecutor = (
    registry: Layer.Layer<Registry.Registry>,
    engine: EngineDurable,
    root: string,
    options: ExecutorOptions
  ): ReturnType<typeof executorFromEngine> => {
    const startsRuns = options.startsRuns !== false
    const evaluator = evaluatorFor(options.environment, options.evaluator, startsRuns)
    const built = Layer.unwrap(Effect.map(
      materializeEngine(engine),
      (materialized) => executorFromEngine(registry, materialized, root, options, evaluator)
    ))
    if (startsRuns) return built
    // The observing executor still reads `engine.db`, because that is where a
    // run's current round, its waiting reason and the human waits parked below
    // it live: a listing that dropped the port would answer about the control
    // plane's coordination copy alone. What it cannot do is launch or resume,
    // so the judge above it is never asked anything.
    return Layer.effect(ControlExecutor.ControlExecutor)(
      Effect.map(ControlExecutor.ControlExecutor, ControlExecutor.makeObserving)
    ).pipe(Layer.provide(built))
  }

  const layerControlFromEngine = (
    config: Application.Config & Pick<ExecutorOptions, "expectedSourceRevision" | "approvalChannel" | "plansFlows">,
    registry: Layer.Layer<Registry.Registry>,
    engine: EngineDurable,
    modules?: ModuleRegistration
  ) => {
    const root = config.root ?? process.cwd()
    return LocalControl.layer(
      registry,
      engine,
      layerExecutor(registry, engine, root, {
        environment: process.env,
        evaluator: config.evaluator,
        startsRuns: config.startsRuns,
        plansFlows: config.plansFlows,
        expectedSourceRevision: config.expectedSourceRevision,
        approvalChannel: config.approvalChannel,
        mcpServers: config.mcpServers ?? [],
        executionRoot: config.executionRoot ?? root,
        ...(config.stateRoot === undefined ? {} : { stateRoot: config.stateRoot }),
        ...(config.rebuildAuthoredFlows === undefined ? {} : { rebuildAuthoredFlows: config.rebuildAuthoredFlows }),
        modules
      }),
      decorateNotifications,
      config.startsRuns !== false
    ).pipe(Layer.tap((context) =>
      config.remote !== undefined ? Effect.void : HealthHost.start(config.health).pipe(
        Effect.provide(evaluatorFor(process.env, config.evaluator, config.startsRuns)),
        Effect.provideService(Control.Control, Context.get(context, Control.Control)),
        Effect.provide(engine.journal)
      )
    ))
  }
  const layerControl = (
    config: Application.Config,
    suppliedRegistry?: Layer.Layer<Registry.Registry>,
    suppliedEngine?: EngineDurable,
    modules?: ModuleRegistration
  ) => {
    config = { ...config, evaluator: evaluatorFor(process.env, config.evaluator, config.startsRuns) }
    const root = config.root ?? process.cwd()
    const registry = suppliedRegistry ?? layerRegistry(root)
    const engine = suppliedEngine ?? engineDurable(root, registry, config)
    return Layer.unwrap(
      Effect.map(materializeEngine(engine), (captured) => layerControlFromEngine(config, registry, captured, modules))
    )
  }
  const layerGateway = (
    health: GatewayServer.Health,
    options: NodeGateway.ServerOptions = { host: "127.0.0.1", port: 3000 },
    root: string,
    engine: EngineDurable = engineDurable(root, undefined, options),
    journal: Layer.Layer<Journal.Journal> = engine.journal
  ) =>
    native.gateway(health, options).pipe(Layer.provide([
      GatewayProjections.layer,
      SyncServer.layer.pipe(Layer.provide([journal, RunCatalog.layerNoop])),
      SyncAuth.layer.pipe(Layer.provide(WorkspaceShare.layerNoop))
    ]))
  const layerGatewayHost = (engine: EngineDurable, control: Layer.Layer<Control.Control>) =>
    Layer.effect(
      Serve.GatewayHost,
      Effect.gen(function*() {
        const controlService = yield* Control.Control
        const journalService = yield* Journal.Journal
        return Serve.GatewayHost.of({
          launch: (health, options, root) =>
            Effect.suspend(() => {
              if (
                options.runtimeBridge !== undefined && engine.host.revision !== options.runtimeBridge.sourceRevision
              ) {
                return Effect.die(
                  new CliError.Refused({
                    fault: "policy",
                    code: "source_revision_mismatch",
                    message: "Flow host source revision is unavailable or does not match the registered catalog"
                  })
                )
              }
              // Some admitted Flow bodies cannot be statically graphed. Their
              // source authority is still the catalog snapshot verified during
              // registration, never the environment's unverified revision.
              const verifiedOptions = options.runtimeBridge === undefined ? options : {
                ...options,
                runtimeBridge: { ...options.runtimeBridge, verifiedCatalogSourceRevision: engine.host.revision }
              }
              return Layer.launch(
                layerGateway(health, verifiedOptions, root, engine, Layer.succeed(Journal.Journal, journalService))
              )
            })
              .pipe(
                Effect.provideService(Control.Control, controlService),
                Effect.provide(native.host),
                Effect.orDie
              )
        })
      })
    ).pipe(Layer.provide([control, engine.journal]))
  const layerMemory = (root: string, engine: EngineDurable = engineDurable(root)) =>
    Layer.provideMerge(
      Maintenance.layerTtlGc(),
      MemoryStore.layer.pipe(Layer.provide([engine.stores, native.crypto]), Layer.orDie)
    )
  const layerHost = (
    config: Application.Config & Pick<ExecutorOptions, "expectedSourceRevision" | "approvalChannel">,
    modules?: ModuleRegistration,
    suppliedRegistry?: Layer.Layer<Registry.Registry>
  ) => {
    config = { ...config, evaluator: evaluatorFor(process.env, config.evaluator, config.startsRuns) }
    const root = config.root ?? process.cwd()
    const registry = suppliedRegistry ?? layerRegistry(root)
    return Layer.unwrap(Effect.map(materializeEngine(engineDurable(root, registry, config)), (engine) => {
      const control = layerControlFromEngine(config, registry, engine, modules)
      return Layer.mergeAll(control, layerGatewayHost(engine, control), layerMemory(root, engine), native.host)
    }))
  }
  /**
   * Observes a project's existing stores and changes nothing.
   *
   * Both databases open read-only through {@link Platform.observe}: no
   * directory, file, migration or schema object is created, no sweeper,
   * recovery or reaper starts, and every transaction is a read snapshot that a
   * peer holding the writer does not block. The executor only reads
   * `engine.db`; a project that has none is observed from `control.db` alone.
   * Anything that would drive or change a run is a composition defect here.
   *
   * @category layers
   * @since 1.0.0
   */
  const layerObserve = (config: Application.Config, registry: Layer.Layer<Registry.Registry>) => {
    const stateRoot = config.stateRoot ?? config.root ?? process.cwd()
    const stores = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), Layer.fresh(RunStore.layer))
      .pipe(Layer.provideMerge(native.observe(databasePath(stateRoot))), Layer.orDie)
    const runtime = SqlControlRuntime.layer({
      approvalAuthority: config.approvalAuthority ?? ApprovalAuthority.local,
      principal: config.principal,
      engineVersion: packageVersion
    }).pipe(Layer.provide([stores, native.crypto]), Layer.orDie)
    const engineFile = executionDatabasePath(stateRoot)
    const executor = Layer.effect(ControlExecutor.ControlExecutor)(Effect.gen(function*() {
      const engine = DatabaseLocation.exists(engineFile)
        ? yield* Layer.build(
          Layer.mergeAll(Layer.fresh(RunStore.layer), DurableEngineState.layer).pipe(
            Layer.provide(native.observe(engineFile))
          )
        )
        : undefined
      return ControlExecutor.makeReadOnly(
        engine === undefined
          ? undefined
          : (runId) => AgentSession.readExecution(runId).pipe(Effect.provideContext(engine))
      )
    }))
    return Layer.unwrap(Effect.map(
      materializeEngine({ runtime, journal: stores, stores, host: emptyHost() }),
      (engine) => LocalControl.layer(registry, engine, executor, undefined, false)
    ))
  }
  return {
    evaluatorFor,
    projectSources,
    layerHostPlatform,
    layerGrantStore,
    layerGuardedPlatform,
    layerObserver,
    layerRegistry,
    gatewayApprovalAuthority,
    databasePath,
    executionDatabasePath,
    materializeEngine,
    engineDurable,
    layerExecutor,
    layerControlFromEngine,
    layerControl,
    layerObserve,
    layerGateway,
    layerGatewayHost,
    layerMemory,
    layerHost
  }
}

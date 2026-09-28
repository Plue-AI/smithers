/**
 * Node transport composition for the Control service.
 *
 * @since 0.1.0
 */

import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Control, ControlRpcs, type ControlRuntime, ControlServer } from "@smthrs/control"

import type * as Journal from "@smthrs/journal/Journal"

import * as McpClient from "@smthrs/mcp/McpClient"

import * as MemoryError from "@smthrs/memory/MemoryError"

import * as MemoryStore from "@smthrs/memory/MemoryStore"

import type { NotificationQueue } from "@smthrs/notifications"

import type * as Registry from "@smthrs/registry/Registry"

import { Effect, Layer, Result, Schema } from "effect"

import { HttpRouter } from "effect/unstable/http"

import { RpcSerialization } from "effect/unstable/rpc"

import { Socket } from "effect/unstable/socket"

import { existsSync, readFileSync } from "node:fs"

import { createServer } from "node:http"

import type { ListenOptions } from "node:net"

import * as Application from "./Application.ts"

import * as Argv from "./cli/Argv.ts"

import * as CliError from "./CliError.ts"

import * as Environment_ from "./Environment.ts"

import { layerEgressHttpClient, native } from "./internal/NodeControlHost.ts"

import type { EngineDurable, ModuleRegistration } from "./internal/NativeControl.ts"

import * as CommandStatus from "./internal/CommandStatus.ts"

import { Session } from "./internal/backend/Session.ts"
import * as NodeWebSocket from "./internal/NodeWebSocket.ts"
import * as SupervisorMemory from "./internal/SupervisorMemory.ts"
import * as Output from "./Output.ts"
import * as Project from "./Project.ts"
import * as Serve from "./Serve.ts"

/**
 * The environment subset consulted while resolving Node application
 * configuration.
 *
 * Names are read through `Environment.read`. Pass a captured source to
 * configuration helpers so tests and alternate hosts do not read ambient
 * process state; invalid values fail through the helper that consumes them.
 *
 * @category models
 * @since 0.1.0
 */
export type Environment = Environment_.Source

/**
 * Node HTTP listen options accepted by the control server.
 *
 * Use these at a Node bind boundary. A non-loopback host without the required
 * opt-in is rejected synchronously before the server layer is built.
 *
 * @category models
 * @since 0.1.0
 */
export type ServerOptions = ListenOptions & {
  readonly disablePreemptiveShutdown?: boolean | undefined
  /** Explicit opt-in corresponding to the host CLI's `--listen` flag. */
  readonly listen?: boolean | undefined
}

/**
 * Reads and validates the MCP servers named by `--mcp-config`/`SMITHERS_MCP_CONFIG`.
 *
 * The file is a JSON array decoded with `McpClient.ConnectOptionsSchema`.
 * Projection fields are preserved for `McpFlows.connected` to check and apply.
 * Omitting the setting configures no MCP servers. Missing, unreadable, malformed,
 * or incorrectly shaped files raise a flag-specific usage error rather than
 * silently changing the executor's tool catalog.
 *
 * @category constructors
 * @since 0.1.0
 */
const mcpServersFromArguments = (
  globals: Argv.Globals,
  environment: Environment
): ReadonlyArray<McpClient.ConnectOptions> | undefined => {
  const path = globals.mcpConfig ?? Environment_.read(environment, "SMITHERS_MCP_CONFIG")
  if (path === undefined) return undefined
  if (!existsSync(path)) {
    throw new CliError.UsageError({ message: `--mcp-config ${path}: file not found` })
  }
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new CliError.UsageError({ message: `--mcp-config ${path} could not be read: ${reason}` })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new CliError.UsageError({ message: `--mcp-config ${path} is not valid JSON: ${reason}` })
  }
  // Projection options are consumed by McpFlows.connected, not the connection schema.
  const decoded = Schema.decodeUnknownResult(Schema.Array(Schema.Struct({
    ...McpClient.ConnectOptionsSchema.fields,
    include: Schema.optional(Schema.Array(Schema.String)),
    exclude: Schema.optional(Schema.Array(Schema.String)),
    namePrefix: Schema.optional(Schema.String)
  })))(parsed)
  if (Result.isFailure(decoded)) {
    throw new CliError.UsageError({
      message: `--mcp-config ${path} must contain a JSON array of MCP server entries`
    })
  }
  return decoded.success
}

/**
 * Resolves application configuration from command arguments with an
 * environment fallback.
 *
 * Use this before constructing any durable layer. Invalid `--remote` and
 * `--mcp-config` values raise `CliError.UsageError`, naming the offending flag
 * before a transport or database can surface a lower-level exception.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeConfig = (
  args: ReadonlyArray<string> | Argv.Globals,
  environment: Environment,
  cwd: string
): Application.Config => {
  const globals = Argv.parse(args)
  const remote = globals.remote ?? Environment_.read(environment, "SMITHERS_REMOTE")
  if (remote !== undefined) {
    let parsed: URL
    try {
      parsed = new URL(remote)
    } catch {
      throw new CliError.UsageError({
        message: `--remote must be an http:// or https:// URL; got ${JSON.stringify(remote)}`
      })
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError.UsageError({
        message: `--remote must be an http:// or https:// URL; got ${JSON.stringify(remote)}`
      })
    }
  }
  return {
    remote,
    // SMITHERS_TOKEN outranks the stored login, and reading it starts no process.
    credential: remote === undefined ? undefined : environment.SMITHERS_TOKEN?.trim() || undefined,
    login: remote === undefined || environment.SMITHERS_TOKEN?.trim()
      ? undefined
      : async () => (await new Session(environment).resolve(new URL(remote).origin))?.token,
    mcpServers: mcpServersFromArguments(globals, environment),
    // `--root` is resolved here rather than in a handler because the durable
    // layers are built from it, and they are built before any flag is parsed.
    root: Project.root(globals.root, cwd),
    // `migrate` converts a 0.x project, which by definition has no `.flows/`
    // for the root walk to anchor on. Resolved from the same `--root`, and
    // otherwise from the 0.x state beside the invocation directory.
    migrationRoot: Project.legacyRoot(globals.root, cwd)
  }
}

/**
 * Resolves process configuration using an existing argument parse.
 *
 * The executable reaches for this effect before parsing the command tree. It
 * preserves configuration usage errors so the top-level reporter exits with
 * status 2 and never leaks a host exception.
 *
 * @category configuration
 * @since 0.1.0
 */
export const configFromArguments = (
  args: ReadonlyArray<string> | Argv.Globals
): Effect.Effect<Application.Config, CliError.UsageError> =>
  Effect.try({
    try: () => {
      const configured = makeConfig(args, process.env, process.cwd())
      Project.assertRoot(configured.root ?? process.cwd())
      return configured
    },
    catch: (cause) =>
      cause instanceof CliError.UsageError
        ? cause
        : new CliError.UsageError({
          message: cause instanceof Error ? cause.message : "Smithers configuration could not be read"
        })
  })

/**
 * Resolves configuration for the current process.
 * @category configuration
 * @since 0.1.0
 */
export const config: Effect.Effect<Application.Config, CliError.UsageError> = Effect.suspend(() =>
  configFromArguments(process.argv.slice(2))
)

const websocketUrl = (remote: string): string => {
  const url = new URL(remote)
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/rpc$/, "")
  url.pathname = `${basePath}/rpc/ws`
  url.search = ""
  url.hash = ""
  return url.toString()
}

const websocketLayer = (remote: string, credential: string | undefined) => {
  const url = websocketUrl(remote)
  return Socket.layerWebSocket(url).pipe(
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor, NodeWebSocket.make(credential))
    )
  )
}

export type { EngineDurable, ModuleRegistration } from "./internal/NativeControl.ts"
export {
  checkpointStore,
  layerSeatCatalog,
  layerSeatEvaluator,
  layerSeatResolver,
  seatCandidates,
  seatResolver,
  testFlows,
  testRunner
} from "./internal/NativeEquipment.ts"

export {
  environmentDispatcher,
  layerEgressHttpClient,
  layerRebuildableRequestExecutor,
  rebuildableTransport
} from "./internal/NodeControlHost.ts"

/**
 * The static stance a judged run on this host is taught:
 * `SMITHERS_SUPERVISOR_STANCE`, `careful` when unset. Any other value throws
 * a `UsageError` naming the variable, so a host refuses to start on it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const supervisorStance = SupervisorMemory.stance

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
export const projectSources = native.projectSources
/**
 * The raw host platform: Node's own services plus the descriptor-relative,
 * no-follow filesystem the kernel needs underneath it. `NodeServices` alone is
 * not enough: the kernel's guarded `FileSystem` refuses every operation unless
 * the host provides descriptor-relative, no-follow access, which is what
 * `AtomicFileSystem` adds on Node.
 *
 * This is the *unguarded* half of the composition. It is what
 * {@link layerGuardedPlatform} is built on, and it is what host equipment that
 * carries its own confinement argument runs on, today only the workspace
 * observer, whose module documents why (`@smthrs/agent/WorkspaceObservation`).
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
export const layerHostPlatform = native.layerHostPlatform
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
export const layerGrantStore = native.layerGrantStore
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
export const layerGuardedPlatform = native.layerGuardedPlatform
/**
 * Provides the workspace observer the run's mutation accounting is measured
 * with: one pruned walk of the workspace root, taken at both ends of every
 * frame.
 *
 * On {@link layerHostPlatform}, deliberately, and never on
 * {@link layerGuardedPlatform}. The observer is host equipment: the root is
 * this composition's, not a model's. It carries its own confinement
 * argument: it stats, it never opens, it follows no symlink, and every path it
 * builds is an entry name under the root. `@smthrs/agent/WorkspaceObservation`
 * states that argument in full. Guarding it decides nothing and costs one
 * helper process per file: SWE-bench wave 6 spent 912 s of a 1,200 s budget on
 * django's opening walk and never reached the agent's first tool call.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerObserver = native.layerObserver
/**
 * Provides the Node-backed flow registry the local CLI discovers flows with.
 *
 * `Registry.layerNoop()` was the previous local composition, so the CLI found
 * no flows at all. Discovery runs under an allow-all grant store because the
 * local CLI is the operator's own process; a hosted composition supplies a real
 * `GrantStore`. A source root that does not exist scans empty, so this is not a
 * startup failure. An unreadable one is, and dies rather than silently
 * discovering nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerRegistry = native.layerRegistry
/**
 * Where a local CLI keeps its control-plane database.
 *
 * Use this instead of assembling `.flows` paths at call sites. It is a pure
 * path projection and cannot fail; opening the returned file can.
 *
 * @category constructors
 * @since 0.1.0
 */
export const databasePath = native.databasePath
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
export const executionDatabasePath = native.executionDatabasePath
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
 * Reach for this value at a Node composition root and reuse it. Database open,
 * migration, and journal startup failures are promoted to defects because no
 * local command can proceed honestly without the store.
 *
 * @category layers
 * @since 0.1.0
 */
export const engineDurable = native.engineDurable
/**
 * Builds the executor over one captured control-store graph. Materializing
 * before native registration prevents the shared RunStore layer from being
 * memoized against the other database in an embedding composition.
 * @category layers
 * @since 1.0.0
 */
export const layerExecutor = native.layerExecutor
const materializeEngine = native.materializeEngine

/**
 * Provides the application-selected Control implementation with Node HTTP and
 * WebSocket client transports. Local compositions get the production run
 * executor; remote ones talk to a server that owns its own.
 *
 * @category layers
 * @since 0.1.0
 */
const layerControlFromEngine = (
  applicationConfig: Application.Config,
  registry: Layer.Layer<Registry.Registry>,
  engine: EngineDurable,
  modules?: ModuleRegistration
) => {
  if (applicationConfig.remote === undefined) {
    return native.layerControlFromEngine(applicationConfig, registry, engine, modules)
  }
  const remote = applicationConfig.remote
  return Layer.unwrap(
    Effect.promise(async () => applicationConfig.credential ?? await applicationConfig.login?.()).pipe(
      Effect.map((credential) =>
        Application.layer({ ...applicationConfig, credential }, registry, engine).pipe(
          Layer.provide([
            // A remote control plane is an origin like any other: reached through the
            // egress proxy this process's environment names, or directly when it
            // names none.
            layerEgressHttpClient(process.env),
            websocketLayer(remote, credential),
            RpcSerialization.layerNdjson
          ])
        )
      )
    )
  )
}

/**
 * Provides the application-selected Control service over Node transports.
 *
 * Use the optional registry and engine when embedding the CLI in an existing
 * composition. A local engine is materialized once before its runtime,
 * journal, executor, and memory consumers are assembled; startup failures die
 * with the layer. A remote configuration opens no local database and reports
 * transport failures through the control client.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerControl = (
  applicationConfig: Application.Config,
  suppliedRegistry?: Layer.Layer<Registry.Registry> | undefined,
  suppliedEngine?: EngineDurable | undefined,
  modules?: ModuleRegistration
) => {
  // Refuse before materializing the local stores. A remote client owns no agent,
  // and a composition that drives no run reaches no completion to judge.
  if (applicationConfig.remote === undefined) {
    applicationConfig = {
      ...applicationConfig,
      evaluator: native.evaluatorFor(process.env, applicationConfig.evaluator, applicationConfig.startsRuns)
    }
  }
  const root = applicationConfig.root ?? process.cwd()
  const registry = suppliedRegistry ?? layerRegistry(root)
  const engine = suppliedEngine ?? engineDurable(root, registry, applicationConfig)
  if (applicationConfig.remote !== undefined) {
    return layerControlFromEngine(applicationConfig, registry, engine, modules)
  }
  return Layer.unwrap(
    Effect.map(
      materializeEngine(engine),
      (materialized) => layerControlFromEngine(applicationConfig, registry, materialized, modules)
    )
  )
}

const output = Output.make()

/**
 * Provides deterministic rendering and transfers rendered statuses to the
 * Node process exit code.
 *
 * Reach for this layer only at the Node executable boundary. Rendering admits
 * only bounded inert data, and only validated control receipts can set a
 * nonzero process status; a missing service is a composition defect.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerOutput = Layer.succeed(
  Output.Output,
  Output.Output.of({
    render: Effect.fn("Output.render")((value, format) =>
      output.render(value, format).pipe(
        Effect.tap((rendered) => CommandStatus.set(rendered.exitCode))
      )
    )
  })
)

/**
 * Provides the complete Node command-handler environment.
 *
 * This is the production layer for `smthrs`. Local composition acquires one
 * durable engine and shares it across control, execution, memory, and serving;
 * open or migration failures terminate startup. Remote composition builds the
 * RPC client without opening a local control database.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (applicationConfig: Application.Config, modules?: ModuleRegistration) => {
  // Refuse before materializing the local stores. A remote client owns no agent,
  // and a composition that drives no run reaches no completion to judge.
  if (applicationConfig.remote === undefined) {
    applicationConfig = {
      ...applicationConfig,
      evaluator: native.evaluatorFor(process.env, applicationConfig.evaluator, applicationConfig.startsRuns)
    }
  }
  const root = applicationConfig.root ?? process.cwd()
  const registry = layerRegistry(root)
  const durable = engineDurable(root, registry, applicationConfig)
  // Sampled here, before anything opens the control database. `Project.layer`
  // reads the 0.x markers eagerly when it is called, and opening the control
  // database writes `<root>/.flows`, which is the very absence release policy
  // the 0.x-project guard gates the notice on. Building this inside `compose` therefore
  // sampled a directory the same invocation had already created, and the
  // notice stopped printing on exactly the 0.x projects it exists for.
  const project = Project.layer(root, applicationConfig.migrationRoot ?? Project.legacyRoot(undefined, root))
  const compose = (engine: EngineDurable) => {
    const control = layerControlFromEngine(applicationConfig, registry, engine, modules)
    const gatewayHost = applicationConfig.remote === undefined
      ? native.layerGatewayHost(engine, control)
      : Layer.effect(
        Serve.GatewayHost,
        Effect.map(Control.Control, (controlService) =>
          Serve.GatewayHost.of({
            launch: (health, options, gatewayRoot) =>
              Layer.launch(layerGateway(health, options, gatewayRoot, engine)).pipe(
                Effect.provideService(Control.Control, controlService),
                Effect.provide(NodeServices.layer),
                Effect.orDie
              )
          }))
      ).pipe(Layer.provide(control))
    return Layer.mergeAll(
      control,
      gatewayHost,
      layerOutput,
      NodeServices.layer,
      project,
      // `smthrs memory` reads and writes the same durable store a run's
      // `memory` flow does, over the same control database. A separate
      // connection would be a second writer to one SQLite file. A remote
      // invocation has no local database to be that store, so it gets the
      // refusal instead of silently writing where nothing reads.
      applicationConfig.remote === undefined ? layerMemory(root, engine) : layerMemoryRemote
    )
  }
  return applicationConfig.remote === undefined
    ? Layer.unwrap(Effect.map(materializeEngine(durable), compose))
    : compose(durable)
}

/** Refuses a composition root that still owes a service. */
type Complete<L> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>] ? [R] extends [never] ? true : false
  : false

/** Refuses a composition root whose allowed requirement channel is not exact. */
type RequirementsAre<L, Expected> = [L] extends [Layer.Layer<infer _A, infer _E, infer R>]
  ? [R] extends [Expected] ? [Expected] extends [R] ? true : false : false
  : false

/** Fails to compile unless its argument is `true`. */
type Expect<T extends true> = T

/**
 * Pins the executor and both complete control-plane compositions.
 *
 * The executor is installed beneath `Application.layer`, so its control
 * runtime, journal, notification queue, and registry are deliberate inputs.
 * `layerControl` supplies them, and the final command-handler root owes
 * nothing.
 *
 * @category models
 * @since 1.0.0
 */
export type CompositionRootsAreComplete = [
  Expect<
    RequirementsAre<
      ReturnType<typeof layerExecutor>,
      ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
    >
  >,
  Expect<Complete<ReturnType<typeof layerControl>>>,
  Expect<Complete<ReturnType<typeof layer>>>
]

/**
 * Provides the memory store a `--remote` invocation gets: none, said out loud.
 *
 * The control plane owns memory. Building the local store here would open (and
 * create) a `.flows/control.db` beside the operator's shell and write facts the
 * server never reads, which is worse than a refusal because it looks like it
 * worked.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemoryRemote: Layer.Layer<MemoryStore.MemoryStore> = MemoryStore.layerNoop({
  putFact: () => remoteMemory("memory set"),
  getFact: () => remoteMemory("memory get"),
  deleteFact: () => remoteMemory("memory rm"),
  listFacts: () => remoteMemory("memory list")
})

const remoteMemory = (verb: string): Effect.Effect<never, MemoryError.MemoryError> =>
  Effect.fail(
    new MemoryError.MemoryError({
      code: "store",
      message:
        `${verb} is not available against --remote: the control plane owns memory. Run it on the host that holds .flows/control.db.`
    })
  )

/**
 * Provides the durable memory store the `memory` verbs read and write, over
 * the control database.
 *
 * A remote composition has no local database, so the store is the unavailable
 * one there: `smthrs --remote ... memory set` must say the control plane
 * owns memory rather than write a fact into a file the server never reads.
 * Local open and migration failures are startup defects, consistent with the
 * control runtime using the same store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory = native.layerMemory

const defaultServerOptions: ServerOptions = { host: "127.0.0.1", port: 3000 }

const listenOptions = (options: ServerOptions): ListenOptions => {
  const { listen, ...nodeOptions } = options
  const host = nodeOptions.host ?? "127.0.0.1"
  if (!Serve.isLoopback(host) && listen !== true) {
    throw new Error(`Refusing non-loopback control bind ${host} without an explicit --listen opt-in`)
  }
  return { ...nodeOptions, host }
}

/**
 * Hosts the abstract Control HTTP/WebSocket router on a scoped Node HTTP
 * server. The returned layer retains the concrete HttpServer service so
 * callers can inspect an ephemeral address.
 *
 * Use this with an explicit authentication layer. Non-loopback hosts without
 * `listen: true` are rejected synchronously, and socket failures remain in the
 * returned server layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServer = (
  auth: Layer.Layer<ControlRpcs.ControlAuth>,
  options: ServerOptions = defaultServerOptions
) =>
  HttpRouter.serve(
    ControlServer.layerHttp.pipe(
      Layer.provide(auth),
      Layer.provide(RpcSerialization.layerNdjson)
    ),
    {
      disableListenLog: true,
      disableLogger: true
    }
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(createServer, listenOptions(options)))
  )

/**
 * Hosts the whole workspace gateway: the control plane, the served
 * projections, the journal read path, and the health probe, on one socket.
 *
 * `@smthrs/gateway` owns the assembly (`GatewayServer.layer`) and its Node
 * host (`NodeGateway.layer`); this function supplies the four services those
 * mounts read through that only a project on disk can provide. `Control` stays
 * a requirement, so the verb hosts the same control plane its own commands
 * talk to rather than opening a second one.
 *
 * The sync read path receives the already-open journal when this is composed
 * by {@link layer}. Standalone callers may omit it and let one durable engine
 * provide the journal. A second `ControlLive` is never constructed.
 *
 * `RunCatalog` and `WorkspaceShare` are the no-op implementations: a local
 * gateway shares nothing and publishes no catalog, and the relay
 * implementations belong to a host that has an account to publish under.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerGateway: typeof native.layerGateway = (health, options, root, engine, journal) => {
  listenOptions(options ?? defaultServerOptions)
  return native.layerGateway(health, options, root, engine, journal)
}

/**
 * Hosts Control using the alpha's single shared bearer token.
 *
 * Use this at an authenticated bind boundary. It inherits {@link layerServer}
 * failures, including the refusal of a non-loopback host without `listen`.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerBearerAuth = (
  auth: ControlRpcs.BearerAuthOptions,
  options: ServerOptions = defaultServerOptions
) => layerServer(ControlRpcs.layerBearerAuth(auth), options)

/**
 * Hosts Control with permissive authentication for trusted local and test use.
 * Production hosts must call `layerServer` with an explicit authentication
 * layer.
 *
 * Any non-loopback host is rejected synchronously, even when `listen` is true;
 * loopback socket failures remain in the returned server layer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerServerNoopAuth = (options: ServerOptions = defaultServerOptions) => {
  const host = options.host ?? "127.0.0.1"
  if (!Serve.isLoopback(host)) {
    throw new Error(`Refusing non-loopback control bind ${host} with permissive authentication`)
  }
  // The loopback refusal three lines up is the whole guard: this
  // composition cannot be built for a bind anything off this machine can
  // reach. `listen: false` keeps it in-process on top of that.
  // eslint-disable-next-line no-restricted-syntax -- guarded by the refusal above
  return layerServer(ControlRpcs.layerNoopAuth(), { ...options, listen: false })
}

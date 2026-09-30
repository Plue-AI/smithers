/**
 * The two compositions a migration runs under: a real Node host, and a
 * scripted one for tests.
 *
 * Two filesystems, on purpose. The deterministic half — the scan, the
 * checkpoint, the verification, the archive, the report — reads and writes
 * through Node's own services, because it walks whole trees and the kernel's
 * guarded filesystem costs a helper process per authorized operation. The
 * agent's half runs through the kernel: descriptor-relative access pinned to
 * the project root, a capability envelope that names the project, and a grant
 * store that denies filesystem access to protected run state. Agent process
 * execution is unavailable; configured verification belongs to the deterministic
 * orchestrator, whose run-state digests detect changes and restore the unit.
 *
 * The seat is a role. `AgentAction` declares `migrate`, and the resolver here
 * maps that one name onto whatever the operator asked for with `--seat`. No
 * model id appears anywhere in this package, the prompt's worked pairs
 * included: a host that was given no seat and no key refuses by name, which is
 * the honest failure.
 *
 * @since 1.0.0-rc.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import type * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as SeatRouter from "@smthrs/agent/SeatRouter"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import type * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import { Capability, GrantStore, Permission, Workspace } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelPath from "@smthrs/kernel/Path"
import * as Evaluator from "@smthrs/model/Evaluator"
import type * as Model from "@smthrs/model/Model"
import type * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import type * as Brand from "effect/Brand"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import { isAbsolute } from "node:path"
import { make, type MigrateError } from "../MigrateError.ts"
import * as Scan from "../Scan.ts"
import * as Units from "../Units.ts"
import * as Contract from "./Contract.ts"
import * as MigrateFlow from "./MigrateFlow.ts"
import * as Options from "./Options.ts"
import * as Transform from "./Transform.ts"

/**
 * Which environment variable carries each provider's key. The same three the
 * flows CLI reads, spelled the same way, so a machine set up for one is set up
 * for the other.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const apiKeyVariable: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
}

/**
 * The seat the operator's environment can actually pay for, when they named
 * none.
 *
 * A default is a choice about someone's money, so this makes the smallest one
 * there is: the provider whose key is present, and nothing about which model.
 * With no key at all it returns `undefined` and the resolver refuses by name.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const configuredProvider = (
  environment: Readonly<Record<string, string | undefined>>
): string | undefined => {
  for (const provider of ["anthropic", "openai", "openrouter"]) {
    const variable = apiKeyVariable[provider]
    const value = variable === undefined ? undefined : environment[variable]
    if (value !== undefined && value.length > 0) return provider
  }
  return undefined
}

const refusal = (seat: string, message: string): Seat.SeatUnresolved => new Seat.SeatUnresolved({ seat, message })

// The provider routes have distinct body types, so the seat is built once,
// generically, and each branch supplies its own route. The shape mirrors
// `@smthrs/cli`'s `NodeControl.seatOf`, which is where the resolver this one
// stands in for lives.
const seatOf = <Body, Frame, Event, State>(
  configured: Result.Result<Route.Route<Body, Frame, Event, State>, ModelError.ModelError>,
  executor: RequestExecutor.RequestExecutor,
  declared: string,
  modelId: string
): Effect.Effect<Seat.Seat, Seat.SeatUnresolved> =>
  Effect.gen(function*() {
    const route = yield* Effect.fromResult(configured).pipe(
      Effect.mapError((error) => refusal(declared, error.message))
    )
    const model = yield* Route.toModel(route).pipe(
      Effect.provideService(RequestExecutor.RequestExecutor, executor)
    )
    return Seat.make({
      id: declared,
      modelId,
      model,
      route: FlowEngineLike.routeResolver(route),
      contextWindowTokens: SeatResolver.contextWindowTokensFor(modelId)
    })
  })

/**
 * The Node seat resolver: it maps the migration's one declared seat onto the
 * `provider:modelId` the operator chose, and reads that provider's key from the
 * environment it was given rather than from the process.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const seatResolver = (options: {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly seat: string | undefined
  readonly executor: RequestExecutor.RequestExecutor
}): SeatResolver.Service =>
  SeatResolver.make({
    resolve: (declared) =>
      Effect.gen(function*() {
        const chosen = options.seat
        if (chosen === undefined || chosen.length === 0) {
          const provider = configuredProvider(options.environment)
          return yield* Effect.fail(refusal(
            declared,
            provider === undefined
              ? `Set ${Object.values(apiKeyVariable).join(", ")} or pass --seat <provider:model> to run the migration`
              : `Pass --seat ${provider}:<model> to name the model this migration runs on`
          ))
        }
        const separator = chosen.indexOf(":")
        const provider = separator < 0 ? "anthropic" : chosen.slice(0, separator)
        const modelId = Seat.modelIdOf(chosen)
        // `Object.hasOwn`, not a bare lookup. `apiKeyVariable` is an object
        // literal, so `--seat constructor:x` or `--seat toString:x` would
        // otherwise find an inherited function, pass the `undefined` guard,
        // and tell the operator to set a variable named after a native
        // function instead of naming the unconfigured provider.
        const variable = Object.hasOwn(apiKeyVariable, provider) ? apiKeyVariable[provider] : undefined
        if (variable === undefined) {
          return yield* Effect.fail(refusal(declared, `No route is configured for the ${provider} provider`))
        }
        const key = options.environment[variable]
        if (key === undefined || key.length === 0) {
          return yield* Effect.fail(refusal(declared, `Set ${variable} to run the ${chosen} seat`))
        }
        const redacted = Redacted.make(key)
        return yield* provider === "anthropic"
          ? seatOf(Route.anthropic({ apiKey: redacted }), options.executor, chosen, modelId)
          : provider === "openrouter"
          ? seatOf(
            Route.openaiResponsesCompatible({
              id: "openrouter",
              providerName: "openrouter",
              baseUrl: "https://openrouter.ai/api",
              apiKey: redacted
            }),
            options.executor,
            chosen,
            modelId
          )
          : seatOf(Route.openai({ apiKey: redacted }), options.executor, chosen, modelId)
      })
  })

const verificationList = (
  commands: Contract.Commands,
  show: (command: Contract.VerificationCommand) => string
): ReadonlyArray<string> => [
  ...new Set([
    ...(commands.install === undefined ? [] : [show(commands.install)]),
    ...(commands.format === undefined ? [] : [show(commands.format)]),
    ...commands.typecheck.map(show),
    ...(commands.test === undefined ? [] : [show(commands.test)])
  ])
]

/**
 * Every command line the host runs to verify a unit: this project's own install,
 * format, typecheck, and test commands, in the order a verification runs them.
 *
 * The list is exactly what {@link module:Verify.run} executes, as the prompt
 * and the report show it. Agent process execution is unavailable.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const verificationCommands = (commands: Contract.Commands): ReadonlyArray<string> =>
  verificationList(commands, Contract.commandLine)

/**
 * The `proc:spawn` resource the kernel checks for each command
 * {@link verificationCommands} lists, in the same order, for diagnostics.
 * Migration agents receive no process grants.
 *
 * @category combinators
 * @since 1.0.0-rc.1
 */
export const verificationResources = (commands: Contract.Commands): ReadonlyArray<string> =>
  verificationList(commands, Contract.grantResource)

/**
 * A migration root proven absolute.
 *
 * Every grant pattern in {@link rules} is this root with a suffix, so a
 * relative root builds patterns that match nothing: the agent would run with
 * no filesystem allow, no run-state denial, and no confinement, which is the
 * one failure mode this module exists to prevent. The brand makes that state
 * unrepresentable instead of guarding against it. The check happens once, in
 * {@link migrationRoot}, and every later caller carries the proof in its type.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type MigrationRoot = Brand.Branded<string, "@smthrs/migrate/Layers/MigrationRoot">

/**
 * Proves a root absolute, in this package's own error channel.
 *
 * A relative path fails with `unsupported-project` rather than throwing, so a
 * library caller building rules by hand gets the one failure type an entry
 * point maps onto an exit status, not a defect raised from inside a layer.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const migrationRoot = (root: string): Effect.Effect<MigrationRoot, MigrateError> =>
  isAbsolute(root) ? Effect.succeed(root as MigrationRoot) : Effect.fail(make(
    "unsupported-project",
    `The migration root must be an absolute path, and "${root}" is not. Resolve it against the working directory before building the host.`
  ))

/**
 * Every ASCII upper/lower-case spelling of a name, so a deny for `.git` also
 * denies `.GIT` and `.Git`. The capability matcher compares code units and the
 * kernel canonicalizes through a realpath that keeps the caller's spelling,
 * so on a case-insensitive volume each spelling reaches the same file. The
 * general fix belongs in the kernel's canonicalization (smithersai/smithers#2762); this
 * covers the fixed names these rules deny. The configured report directory
 * and run-state paths are arbitrary names and wait on that kernel fix.
 */
const caseSpellings = (name: string): ReadonlyArray<string> =>
  [...name].reduce<ReadonlyArray<string>>(
    (prefixes, unit) => {
      const spellings = [...new Set([unit.toLowerCase(), unit.toUpperCase()])]
      return prefixes.flatMap((prefix) => spellings.map((spelling) => prefix + spelling))
    },
    [""]
  )

/**
 * The permission rules one migration runs under: the project tree, the
 * model calls that rewrite it, and a denial of
 * every filesystem action on every 0.x run-state path, on the default and the
 * configured report directory, on `.git` and `.jj`, and on every path whose
 * name starts with `.env`, each in every ASCII case spelling.
 *
 * The agent receives no process authority. The deterministic orchestrator runs
 * the configured verification commands after each rewrite; run-state digests
 * catch changes made by those operator-selected commands and restore the unit.
 *
 * The denials come last and are configured rules, so they veto: no envelope,
 * no remembered grant, and no later allow can reach a run-state path.
 *
 * The root is a {@link MigrationRoot} rather than a string, so a relative path
 * is refused by {@link migrationRoot} before any pattern is built.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const rules = (options: {
  readonly root: MigrationRoot
  readonly runStatePaths: ReadonlyArray<string>
  readonly commands: Contract.Commands
  /** The run's report directory, which holds the backups and the recovery record. Defaults to `.smithers-migrate`. */
  readonly reportDir?: string | undefined
}): ReadonlyArray<Permission.Rule> => {
  const root = options.root.replace(/\/+$/, "")
  const allow = (action: Capability.PatternAction, resource: string): Permission.Rule =>
    new Permission.Rule({ effect: "allow", pattern: new Capability.CapabilityPattern({ action, resource }) })
  const deny = (action: Capability.PatternAction, resource: string): Permission.Rule =>
    new Permission.Rule({ effect: "deny", pattern: new Capability.CapabilityPattern({ action, resource }) })
  return [
    // The root itself, not only what is under it. `write` creates the parent
    // directory of its target first, and the parent of a root-level file is
    // the root: without this rule the agent can write `flows/x/flow.ts` and
    // cannot write `package.json`, which is the one file the dependencies and
    // project units exist to rewrite.
    allow("fs:*", root),
    allow("fs:*", `${root}/**`),
    allow("net:*", "**"),
    allow("model:*", "**"),
    // The permanent SQLite lock inode and diagnostic state are host-owned,
    // including when reports are written to another directory. The configured
    // report directory holds the backups, the tree manifests, and
    // pending-unit.json that restore trusts, so it is denied by its own path.
    ...[...new Set([Options.defaultReportDir, options.reportDir ?? Options.defaultReportDir])].flatMap((
      directory
    ) => [deny("fs:*", `${root}/${directory}`), deny("fs:*", `${root}/${directory}/**`)]),
    // Version-control metadata runs as the operator later: a hook, a git
    // config alias, or a jj config the agent wrote would execute outside every
    // rule here. No unit rewrites it. Every ASCII case spelling is denied: the
    // matcher is case-sensitive, the kernel keeps the caller's spelling, and
    // on a case-insensitive volume (the macOS default) `.GIT/hooks/pre-commit`
    // is `.git/hooks/pre-commit`.
    ...[".git", ".jj"].flatMap(caseSpellings).flatMap((directory) => [
      deny("fs:*", `${root}/${directory}`),
      deny("fs:*", `${root}/${directory}/**`)
    ]),
    // Dotenv files hold the operator's keys. The brief carries a redacted
    // inventory of them and the contract forbids reading them; this makes the
    // refusal the kernel's rather than a prompt sentence's. `*` crosses `/`,
    // so the `**` rule covers every nested directory, and it also denies
    // everything under a directory whose name starts with `.env` (`.envoy/`):
    // a deliberate fail-closed over-deny. Case spellings as above.
    ...caseSpellings(".env").flatMap((name) => [
      deny("fs:*", `${root}/${name}*`),
      deny("fs:*", `${root}/**/${name}*`)
    ]),
    // Every filesystem action, not only writes. The contract forbids reading
    // run state too: a database, an execution log, or a subscription file
    // read into a model call has left the machine, and a prompt sentence is
    // not an enforcement. `fs:*` is the read, the write, the listing, the
    // stat, and anything the kernel adds later.
    ...options.runStatePaths.flatMap((relative) => {
      // A gateway state file is outside the project and arrives absolute. It
      // is denied by its own path: joined under the root the pattern would
      // match nothing, which is exactly the silent gap these rules exist to
      // close.
      const target = isAbsolute(relative) ? relative.replace(/\/+$/, "") : `${root}/${relative}`
      return [deny("fs:*", target), deny("fs:*", `${target}/**`)]
    })
  ]
}

/**
 * The snapshot boundary compensable actions run against.
 *
 * A cell's `write` is compensable, so the engine asks a host for a per-action
 * snapshot before it runs and offers to restore it on a retry. This tool
 * answers that its rollback is coarser and already taken: every unit opens with
 * a checkpoint — a jj change, a git ref, or a file copy — and a unit that fails
 * verification is restored from it wholesale. A finer snapshot per cell call
 * would record the same bytes a second time and roll back to a state the unit
 * report could not describe.
 *
 * It is a real answer, not a stub: `snapshot` records the checkpoint the unit
 * already holds, and `restore` says the restore is the unit's, so a reader of
 * this composition can see which rollback is in force.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerSnapshotBoundary: Layer.Layer<FlowEngine.SnapshotBoundary> = Layer.succeed(
  FlowEngine.SnapshotBoundary
)({
  snapshot: (options) => Effect.succeed({ boundary: "unit-checkpoint", key: options.key }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(undefined)
})

/**
 * A deterministic scan/plan host. No model, sandbox or agent is registered,
 * so planning remains keyless without installing an unavailable judge.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerPlan = MigrateFlow.layerPlan.pipe(
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(layerSnapshotBoundary),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer)
)

/**
 * What a Node host needs told.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface NodeConfig {
  /** Explicit judge for an offline host; otherwise require the gateway key. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly root: string
  readonly commands: Contract.Commands
  readonly runStatePaths: ReadonlyArray<string>
  /** The run's report directory, denied to the agent. Defaults to `.smithers-migrate`. */
  readonly reportDir?: string | undefined
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly seat?: string | undefined
}

/**
 * A {@link NodeConfig} whose root has been through {@link migrationRoot}. Every
 * composition helper below takes one of these rather than validating again.
 */
interface ValidatedConfig extends NodeConfig {
  readonly root: MigrationRoot
}

const grantsFor = (config: ValidatedConfig): Layer.Layer<GrantStore.GrantStore, never, never> =>
  GrantStore.layer({
    attended: false,
    rules: rules({
      root: config.root,
      runStatePaths: config.runStatePaths,
      commands: config.commands,
      reportDir: config.reportDir
    })
  }).pipe(Layer.provide(Workspace.layer(config.root)), Layer.orDie)

const hostFor = (
  config: ValidatedConfig
): Layer.Layer<AgentAction.Host, never, Evaluator.Evaluator> => {
  const grants = grantsFor(config)
  // The kernel-guarded platform, as `@smthrs/cli`'s `layerGuardedPlatform`
  // builds it: descriptor-relative atomic access under a pinned root, with the
  // same grant store answering for every filesystem operation. Two stores
  // would be a fail-open the types could not catch.
  const platform = Layer.orDie(KernelFileSystem.layer).pipe(
    Layer.provide([Workspace.layer(config.root), grants]),
    Layer.provideMerge(Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer))
  )
  const guarded = KernelPath.layer.pipe(
    Layer.provide(Workspace.layer(config.root)),
    Layer.provideMerge(platform)
  )
  return Transform.hostLayer({ environment: config.environment }).pipe(Layer.provide(guarded))
}

/**
 * The two agent policies this tool decides for itself, and the judge that
 * joins them in each composition below.
 *
 * `Agent.layer` requires all three, and requiring them is the point: a
 * composition that omits one used to reach a no-op and spend without a ceiling
 * or park. Migration takes the real classifier, so a provider that names a
 * reset instant parks the unit and resumes there rather than failing it. The
 * budget is unbounded because a migration carries no approved envelope to
 * derive one from, and inventing a ceiling here would refuse a repair round on
 * a number nobody chose. The evaluator is the completion brake's judge, and the
 * brake never falls back: a claim nothing could judge fails the unit instead of
 * standing. Library hosts judge with their selected seat unless they supply
 * an explicit evaluator. Those are
 * decisions, spelled out, not defaults.
 */
const agentPolicy = Layer.mergeAll(QuotaPolicy.layerDefault(), Budget.layerUnbounded())

/** The selected library seat also judges completions; no separate key exists. */
const evaluatorFor = (
  config: Pick<NodeConfig, "environment" | "evaluator" | "seat">
): Layer.Layer<Evaluator.Evaluator> =>
  config.evaluator ?? Layer.succeed(Evaluator.Evaluator)({
    evaluate: (request) =>
      Effect.gen(function*() {
        const executor = yield* RequestExecutor.RequestExecutor
        const seat = yield* seatResolver({ environment: config.environment ?? {}, seat: config.seat, executor })
          .resolve("migrate").pipe(Effect.mapError(() =>
            new Evaluator.EvaluatorError({
              code: "unreachable",
              message: "Connect a model seat to judge this migration."
            })
          ))
        return yield* Effect.flatMap(Evaluator.Evaluator, (judge) => judge.evaluate(request)).pipe(
          Effect.provide(Evaluator.layerFromSeat(seat))
        )
      }).pipe(
        Effect.provide(Layer.effect(
          RequestExecutor.RequestExecutor,
          Effect.flatMap(
            EgressHttpClient.rebuildableTransport(EgressHttpClient.dispatcher(config.environment ?? {})),
            RequestExecutor.makeWith
          )
        ))
      )
  })

// The credentialed half answers to the same store as the filesystem,
// for the reason `hostFor` gives: a second store is a fail-open the
// types cannot catch. `rules` grants `net:*` and `model:*` over `**` today, so
// private-network authority remains withheld; a host that narrows
// either one gets the narrowing it asked for instead of a guard consulting a
// store nobody configured.
const executorFor = (config: ValidatedConfig): Layer.Layer<RequestExecutor.RequestExecutor, never, never> =>
  Layer.effect(
    RequestExecutor.RequestExecutor,
    Effect.flatMap(EgressHttpClient.guardedTransport(config.environment ?? {}), RequestExecutor.makeWith)
  ).pipe(Layer.provide(grantsFor(config)))

/** The graph seats this resolver can actually serve, checked at routing time. */
const catalogFor = (seats: Layer.Layer<SeatResolver.SeatResolver>): Layer.Layer<SeatRouter.Catalog> =>
  Layer.effect(
    SeatRouter.Catalog,
    Effect.map(SeatResolver.SeatResolver, (resolver) => ({
      candidates: Effect.forEach(SeatRouter.seats, (id) =>
        resolver.resolve(id).pipe(
          Effect.map(() => [id]),
          Effect.catchTag("@smthrs/agent/Seat/SeatUnresolved", () => Effect.succeed([]))
        )).pipe(Effect.map((values) => values.flat())),
      variants: SeatRouter.defaultVariants
    }))
  ).pipe(Layer.provide(seats))

/**
 * Everything a migration needs on Node, including the credentialed half.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNode = (config: NodeConfig) => {
  const evaluator = isAbsolute(config.root) ? evaluatorFor(config) : undefined
  return Layer.unwrap(Effect.gen(function*() {
    // A relative root is refused, not thrown at. `MigrateError` is this
    // package's single failure type so an entry point maps a code onto an exit
    // status without walking a cause chain, and a library caller passing a
    // relative path is exactly the caller who would otherwise get a defect.
    // The proof travels with the value from here on: nothing below takes a
    // bare string root.
    const validated: ValidatedConfig = { ...config, root: yield* migrationRoot(config.root) }
    const seats = Layer.effect(
      SeatResolver.SeatResolver,
      Effect.map(RequestExecutor.RequestExecutor, (request) =>
        seatResolver({
          environment: config.environment ?? {},
          seat: config.seat,
          executor: request
        }))
    ).pipe(Layer.provide(executorFor(validated)))
    return MigrateFlow.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(hostFor(validated), seats, catalogFor(seats), Agent.layer)),
      Layer.provideMerge(agentPolicy),
      Layer.provideMerge(Agent.layerDefaults),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(layerSnapshotBoundary),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(evaluator!)
    )
  }))
}

/**
 * What a Node host needs told when it derives the rest from the project.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ScannedConfig {
  /** Select before the scan, which may start native processes. */
  readonly evaluator?: Layer.Layer<Evaluator.Evaluator> | undefined
  readonly root: string
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly seat?: string | undefined
  readonly flowsDir?: string | undefined
  /** The tool's own directory, which the scan skips. Defaults to `.smithers-migrate`. */
  readonly reportDir?: string | undefined
  /**
   * The state paths the scan reads. Absent, they are derived from
   * `environment`, so a host that passes its process environment gets the
   * same scan the run's own scan step makes.
   */
  readonly state?: Options.State | undefined
  /**
   * The operator's own command overrides, if they named any.
   *
   * The unit brief and the orchestrator use the same commands; agents cannot
   * execute commands themselves.
   */
  readonly commands?: Units.CommandOverrides | undefined
}

/**
 * The verification commands one project verifies a unit with: what its
 * manifests and lockfiles imply, with the operator's overrides on top.
 *
 * One derivation serves each unit's prompt and the orchestrator's verification.
 * Agents edit through guarded filesystem flows and receive failures for repair.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const commandsFor = (
  detection: Scan.ScanResult["detection"],
  overrides: Units.CommandOverrides = {},
  flowsDir = "flows"
): Contract.Commands => {
  const derived = Units.verifyCommands(detection, overrides, flowsDir)
  return {
    ...(derived.install === undefined ? {} : { install: derived.install }),
    ...(derived.format === undefined ? {} : { format: derived.format }),
    typecheck: derived.typecheck,
    ...(derived.test === undefined ? {} : { test: derived.test }),
    flowsDir: derived.discovery.flowsDir
  }
}

/**
 * Everything a migration needs on Node, with the run-state paths and the
 * verification commands read from the project.
 *
 * The scan is read only and happens while the layer is built, which is what
 * lets the grant store deny writes to run state before any step can attempt
 * one. It is the reason this layer fails with the scanner's own error.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNodeScanned = (config: ScannedConfig) => {
  // Scanning may start native processes. Select the judge before the scan.
  const evaluator = isAbsolute(config.root) ? evaluatorFor(config) : undefined
  return Layer.unwrap(
    Effect.gen(function*() {
      // Before the scan, not after it: a relative root is refused without
      // reading the project at all.
      yield* migrationRoot(config.root)
      const state = config.state ?? Options.stateOf(config.environment ?? {})
      const result = yield* Scan.scan(config.root, {
        ignore: [config.reportDir ?? ".smithers-migrate"],
        environment: Options.scanEnvironment(state),
        ...(state?.tmpdir === undefined ? {} : { runState: { tmpdir: state.tmpdir } }),
        ...(config.flowsDir === undefined ? {} : { flowsDir: config.flowsDir })
      })
      return layerNode({
        root: config.root,
        evaluator,
        ...(config.environment === undefined ? {} : { environment: config.environment }),
        ...(config.seat === undefined ? {} : { seat: config.seat }),
        runStatePaths: Transform.runStatePaths(result),
        ...(config.reportDir === undefined ? {} : { reportDir: config.reportDir }),
        commands: commandsFor(result.detection, config.commands ?? {}, config.flowsDir ?? "flows")
      })
    })
  ).pipe(Layer.provide(NodeServices.layer))
}

/**
 * The cell a scripted model answers one frame with.
 *
 * It is the cell source, not an answer, because a migration that only answers
 * has migrated nothing: the rewrite is `ctx.call("write", ...)` and the answer
 * is `ctx.done(...)`. A test that scripted only the answer would prove the
 * decoding and none of the work.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Script = (asked: string) => string

/**
 * Ends a scripted cell with the value the declared output schema expects.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const done = (output: unknown): string => `ctx.done(${JSON.stringify(JSON.stringify(output))})`

/**
 * A model that answers every frame with one scripted cell. The seam a test
 * replaces instead of a network.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const scriptedModel = (script: Script): Model.Model => ({
  stream: (request) =>
    Stream.suspend(() => {
      const asked = [
        ...request.system.map((part) => part.text),
        ...request.messages.flatMap((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        )
      ].join("\n")
      const cell = script(asked)
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    })
})

const preparedRequest = {
  routeId: "migrate",
  protocolId: "migrate",
  method: "POST" as const,
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/**
 * Everything a migration needs, with every seat resolved to a scripted model.
 *
 * The composition is the production one; only the credentialed half is
 * replaced, exactly as `examples/src/11-agent-step.ts` does it. The guarded
 * filesystem, the grant store, the capability envelope, and the sandbox budget
 * are all real, so a scripted test still proves the confinement.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerScripted = (config: NodeConfig & { readonly script: Script }) =>
  Layer.unwrap(Effect.gen(function*() {
    // The same refusal the credentialed root makes. A scripted composition
    // that accepted a relative root would build the grant rules a test then
    // asserts confinement against out of patterns matching nothing.
    const validated: ValidatedConfig = { ...config, root: yield* migrationRoot(config.root) }
    const model = scriptedModel(config.script)
    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            modelId: Seat.modelIdOf(id),
            model,
            route: { prepare: () => Effect.succeed(preparedRequest) },
            contextWindowTokens: 200_000
          })
        )
    })
    return MigrateFlow.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(hostFor(validated), seats, catalogFor(seats), Agent.layer)),
      Layer.provideMerge(agentPolicy),
      Layer.provideMerge(Agent.layerDefaults),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(layerSnapshotBoundary),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(NodeServices.layer),
      // The model is scripted, so the judge is too, and it answers every
      // classifier a judged step asks: the completion brake never falls
      // back, and a scripted composition that reached for a gateway key
      // would either fail every unit or leave the shell.
      Layer.provideMerge(ScriptedJudge.layerAll)
    )
  }))

/**
 * The runtime a migration executes under.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type Runtime = FlowRuntime.FlowRuntime

import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * The gateway read path over a run the engine executes AND reports.
 *
 * `@smthrs/gateway` `test/RealEngineRun.ts` is the nearest stack: a real
 * control plane, a real `@smthrs/flows` `NodeRuntime` engine, two SQLite
 * files. It deliberately omits the bridge between the two journals and its
 * suite asserts that absence, so a client watching one of its runs sees the
 * control lifecycle and none of the engine's own records.
 *
 * A deployed host does wire that bridge. `@smthrs/cli` `NativeControl` builds
 * an `EngineJournalSupervisor` over the engine journal and the control journal
 * and wraps the executor in it, which copies the engine's `flows.engine.*`
 * records into the control journal as `control.engine.event` envelopes. That
 * is the only reason node status can move on a card. This stack is that
 * topology, with a fixture flow chosen so the shapes a graph has to render are
 * all present in one run: a fan-out and a merge, a failure arm, a `HumanTask`
 * gate, an action that fails its first attempt, and a cacheable node.
 *
 * Why it lives in `@smthrs/cli` rather than beside `RealEngineRun.ts`:
 * `EngineJournalSupervisor` is `@smthrs/cli` `src/internal`, which the package
 * blocks from export (`"./internal/*": null`), and `@smthrs/gateway` cannot
 * depend on `@smthrs/cli`, which already depends on it. The supervisor is the
 * subject, so the suite moved to the supervisor.
 *
 * What is real: the control plane, the engine, both journals, both databases,
 * the bridge, the projections, and the ordering between them. Nothing is
 * stubbed below the control plane and no event is hand-journaled. What is not
 * real: the flow is a real `@smthrs/flow` `Flow` over real `Action`s rather
 * than an agent flow, because an agent flow needs a provider credential and a
 * stack that needed one could not run in the environments this proof matters
 * in.
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as ApprovalAuthority from "@smthrs/control/ApprovalAuthority"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { ControlRuntime } from "@smthrs/control/ControlRuntime"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, HumanTask, Interpreter, RetryPolicy } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"
import * as Projections from "@smthrs/gateway/Projections"
import * as EngineEvent from "@smthrs/journal/EngineEvent"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { NotificationQueue } from "@smthrs/notifications"
import * as Node from "@smthrs/plan/Node"
import * as Plan from "@smthrs/plan/Plan"
import { Registry } from "@smthrs/registry"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as RunCatalog from "@smthrs/sync/RunCatalog"
import * as WorkspaceShare from "@smthrs/sync/WorkspaceShare"
import * as TriggersDispatchReader from "@smthrs/triggers/DispatchReader"
import * as SqlTriggerStore from "@smthrs/triggers/SqlTriggerStore"
import type * as Trigger from "@smthrs/triggers/Trigger"
import * as TriggerStore from "@smthrs/triggers/TriggerStore"
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as AuthoredRebuild from "../src/internal/AuthoredRebuild.ts"
import * as EngineJournalSupervisor from "../src/internal/EngineJournalSupervisor.ts"
import * as SourceRevision from "../src/internal/SourceRevision.ts"
import { makeAuthoringFixture, ScriptedAuthor } from "./AuthoringFixture.ts"

/**
 * The repository this fixture is declared in.
 *
 * A node record carries where its action was written, and the writer strips
 * this prefix before it journals the path (`@smthrs/engine-store`
 * `NodeJournal.relativePath`). The default prefix is the process working
 * directory, and this stack is started from three of them: `packages/smithers`
 * under vitest, `apps/app` under `scripts/flow-graph-e2e-host.ts`, and the
 * repository root under a bare `node`. Taking the default would record a
 * different path per caller, and from `apps/app` no path at all, because this
 * file is not under it. The root is therefore this file's own: two directories
 * up from `packages/smithers/test/`, which is the repository, so every host
 * records `packages/smithers/test/BridgedEngineRun.ts` and a reader can open
 * it.
 *
 * @since 1.0.0
 * @category constants
 */
export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "")

/**
 * The revision this checkout is at, read once.
 *
 * A node record says where its action was declared; only this says which
 * bytes were at that line, and the stack records it beside every site it
 * reports — on the plan card's graph and on every page the engine journals —
 * exactly as a deployed host does (`@smthrs/cli` `NativeControl`). A checkout
 * under no version control names none, and then a reader is shown no code
 * rather than a file it cannot bind (D-068).
 *
 * Read lazily and kept, because it is a fact about this process: the modules
 * this stack drives were loaded from this tree at startup, and an edit
 * afterwards changes neither them nor this.
 *
 * @since 1.0.0
 * @category constructors
 */
let readRevision: { readonly value: string | undefined } | undefined
export const sourceRevision = (): string | undefined =>
  (readRevision ??= {
    value: Effect.runSync(SourceRevision.read(repositoryRoot, (file, args, cwd) =>
      Effect.sync(() => {
        // This synchronous fixture builds a plan before its Effect host exists.
        // Product hosts use the scoped asynchronous reader.
        try {
          return execFileSync(file, [...args], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 30_000,
            maxBuffer: 1_000_000
          })
        } catch {
          return undefined
        }
      })))
  }).value

/**
 * The record the bridge writes once it has drained an execution's journal
 * after the engine's terminal commit.
 *
 * A suite waits for this rather than for the run's status: the status is
 * written by the control plane's own observation, and the copy runs on its own
 * fiber afterwards, so a read taken on the status races the records it is
 * about to assert over.
 *
 * @since 1.0.0
 * @category models
 */
export const bridgeSettledKind = EngineJournalSupervisor.settledKind

/**
 * The identity a call that crossed the relay arrives under.
 *
 * The browser holds no gateway credential; the relay holds it, and
 * `NativeGateway.layerAuth` stamps every request carrying it with this
 * principal. A decision a card makes therefore reaches the control plane as
 * the gateway, never as the local operator, which is what {@link stack}'s
 * approval authority has to know about.
 *
 * @since 1.0.0
 * @category models
 */
export const relayPrincipal = { ...NodeGateway.bearerPrincipal, stampedAt: 0 }

/**
 * The question the gate asks. A suite reads it back off the approvals row, so
 * it is exported rather than repeated.
 *
 * @since 1.0.0
 * @category models
 */
export const gatePrompt = "Merge the fan-out?"

/**
 * The flow the control plane plans, and the graph the plan hook keys.
 *
 * @since 1.0.0
 * @category models
 */
export const flowId = "gateway/GraphFixture"

/** One step that always succeeds: the fan-out's steady arm. */
const Steady = Action.make("gateway/graph/Steady", {
  payload: { label: Schema.String },
  success: Schema.String
})

/**
 * The step that fails its first attempt.
 *
 * The counter is injected by {@link stack}, so the failure is a property of
 * the composition under test rather than of a clock, a file, or the machine.
 */
const Flaky = Action.make("gateway/graph/Flaky", {
  payload: { label: Schema.String },
  success: Schema.String,
  error: Schema.String,
  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 })
})

/** The step whose typed failure the catch arm recovers from. */
const Doomed = Action.make("gateway/graph/Doomed", {
  payload: { label: Schema.String },
  success: Schema.String,
  error: Schema.String
})

/**
 * The cacheable step, eligible by the engine's own rule.
 *
 * `@smthrs/engine-store` `CacheAdmission.declaration` admits a declaration to
 * the step cache on two facts and no others: the `sealed` tier, which
 * `Action.make` defaults to, and a `fileBoundary` whose `boundaryMode` is
 * `hard`. An idempotency key alone is not one of them — without the boundary
 * the declaration is `Disabled` for `missing-boundary` and
 * `ActionPersistence` never calls `cache.get` for it, so a fixture that
 * declared only the key would never reach the cache at all. The empty read and
 * write sets are what this step touches: nothing.
 *
 * `implementationVersion` is the semantic identity of the body behind that
 * key: `Interpreter.layerWithImplementations` refuses a sealed keyed action
 * without one, because such a declaration can reuse recorded content, and the
 * interpreter checks that the layer attests the same string either way.
 */
const Cacheable = Action.make("gateway/graph/Cacheable", {
  payload: { label: Schema.String },
  success: Schema.String,
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [], boundaryMode: "hard" },
  idempotencyKey: ({ label }: { readonly label: string }) => `gateway/graph/Cacheable:${label}`
})

/**
 * The gate, three `.child()` boundaries down, as
 * `NestedHumanWaitAcrossDatabases.test.ts` composes it: the wait is held by an
 * execution the control plane's database has never heard of, which is the
 * whole difficulty a card's approval row has to survive.
 */
const Ask = Flow.make("gateway/graph/Ask", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "graph-gate", kind: "ask", prompt: gatePrompt, maxAttempts: 3 })
})

const Gate = Flow.make("gateway/graph/Gate", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => Ask.child({})
})

/** Joins the fan-out's four arms into the run's one result. */
const merge = Node.capture(
  { separator: " " },
  function(members: {
    readonly steady: string
    readonly retried: string
    readonly recovered: string
    readonly cached: string
  }) {
    return [members.steady, members.retried, members.recovered, members.cached].join(this.separator)
  }
)

/**
 * The fixture graph: a gate, then a fan-out whose arms cover a retry, a
 * recovered failure and a cacheable step, then a merge.
 *
 * @since 1.0.0
 * @category models
 */
export const GraphFixture = Flow.make(flowId, {
  payload: { label: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ label }) =>
    Gate.child({}).pipe(
      Node.andThen(
        Node.all({
          steady: Steady.call({ label }),
          retried: Flaky.call({ label }),
          recovered: Doomed.call({ label }).pipe(
            Node.catch({ error: Schema.String, onFailure: () => Node.succeed("recovered") })
          ),
          cached: Cacheable.call({ label })
        }).pipe(Node.map(merge))
      )
    )
})

/**
 * The wrapper execution the control plane's run id names.
 *
 * `EngineJournalSupervisor` refuses to observe an execution that is not the
 * control run's recorded wrapper, and its identity test is exactly this shape:
 * the engine row's flow is `agent/run`, its payload carries the approved
 * `planId`, and it has no parent. `@smthrs/agent` `AgentSession` drives the
 * same wrapper for every agent run, so a fixture that skipped it would be
 * observed by nothing.
 *
 * It carries the plan's flow and the plan's input rather than one fixture
 * field, because it dispatches WHATEVER the approved plan named: one of the
 * flows this composition registered by hand, or — once the host has one — the
 * flow a run of this host wrote into its own `flows/` directory, resolved from
 * the live `Executable.Catalog` the way `AgentSession.approvedModule` resolves
 * it. Nothing about the authored flow is known here before a run writes it.
 */
const wrapperOver = (
  resolve: (flowId: string, executionDigest: string | null, input: unknown) => Node.Node<unknown, unknown, never>
) =>
  Flow.make("agent/run", {
    payload: {
      runId: Schema.String,
      planId: Schema.String,
      flowId: Schema.String,
      executionDigest: Schema.NullOr(Schema.String),
      input: Schema.Json
    },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: ({ executionDigest, flowId, input }) => resolve(flowId, executionDigest, input)
  })

/**
 * The schedule this host's dispatcher holds.
 *
 * A trigger is a Dispatcher registration and not a plan node (D-031), so it
 * lives in a trigger store rather than in the flow, and
 * `Control.list { _tag: "triggers" }` is the only way a client reads one. The
 * cron is a fixed daily occurrence in UTC, so the five upcoming fires a reader
 * computes from it are always in the future and never depend on when the suite
 * runs. Nothing polls it: this composition hosts no scheduler, so the schedule
 * is armed and stays armed, which is the state a card must be able to draw.
 *
 * @since 1.0.0
 * @category models
 */
export const fixtureSchedule: Trigger.Trigger = {
  id: "graph-fixture-nightly",
  flowId,
  input: { label: "nightly" },
  cron: "0 3 * * *",
  timezone: "UTC",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: true
}

/** The control input the card is planned from. */
interface FixtureInput {
  readonly label: string
}

const inputOf = (input: unknown): FixtureInput => ({
  label: typeof (input as FixtureInput | undefined)?.label === "string" ? (input as FixtureInput).label : "fixture"
})

/**
 * The plan hook the flow record carries: build the graph, key it, report every
 * node as `run`.
 *
 * Planning performs no I/O, so this is a pure function of the input, which is
 * what `MemoryFlow.plan` asks for. The statuses are omitted rather than
 * guessed: this composition holds no step cache to read a `cached` verdict off,
 * and a guessed verdict is a claim about work nothing measured.
 *
 * @since 1.0.0
 * @category constructors
 */
export const plan = (input: unknown, planId: string) =>
  Plan.compile({
    planId,
    flow: flowId,
    nodes: Graph.drafts(Graph.build(GraphFixture, inputOf(input)))
  })

/**
 * The built graph as a plan card may carry it: the labelled edges, and where
 * each node was declared.
 *
 * `PlanNode.dependsOn` is one unlabelled edge set, so a card built from it
 * alone cannot tell a value dependency from the catch arm, and carries no
 * declaration site at all — which is why a plan node had no Code tab on this
 * host while the run's graph of the same flow had one. A deployed host
 * reports both (`@smthrs/cli` `NativeControl.buildPlanGraph`), and this is
 * the same two lines under the same rule: the path is made relative to
 * {@link repositoryRoot} with `@smthrs/journal`'s own rule, and a site that
 * rule cannot place is omitted rather than guessed at. Structural nodes the
 * builder synthesised (`root.flow.then.map` and its kin) were declared
 * nowhere and carry none, so their Code tab stays absent.
 *
 * @since 1.0.0
 * @category constructors
 */
export const planGraph = (input: unknown): {
  readonly edges: ReadonlyArray<Graph.Edge>
  readonly nodes: ReadonlyArray<
    { readonly id: string; readonly declaredAt?: { readonly path: string; readonly line: number } }
  >
  readonly sourceRevision?: string
} => {
  const built = Graph.build(GraphFixture, inputOf(input))
  const revision = sourceRevision()
  return {
    edges: Graph.edges(built),
    nodes: Graph.nodes(built).map((node) => {
      const path = node.declaredAt === undefined
        ? undefined
        : EngineEvent.relativePath(repositoryRoot, node.declaredAt.path)
      return { id: node.id, ...(path === undefined ? {} : { declaredAt: { path, line: node.declaredAt!.line } }) }
    }),
    /* The tree those sites were read out of, when this checkout names one. */
    ...(revision === undefined ? {} : { sourceRevision: revision })
  }
}

/**
 * The plan the card reports, built outside the control plane.
 *
 * A suite compares two of these to read `@smthrs/plan` `PlanDiff`'s verdict on
 * whether the same input keys the same graph.
 *
 * @since 1.0.0
 * @category constructors
 */
export const planOf = (
  input: FixtureInput,
  planId: string
): Effect.Effect<Plan.Plan, unknown, never> => plan(input, planId).pipe(Effect.provide(NodeCrypto.layer))

/**
 * The host policy that lets a relayed decision through.
 *
 * `NativeControl.ts:429-431` installs exactly this pair whenever its gateway
 * is configured with a credential: the local operator keeps its decisions, and
 * the gateway's authenticated identity is delegated the same ones. A stack
 * that kept `ApprovalAuthority.local` would plan, list and run over the relay
 * and refuse the one call that launches anything.
 */
const approvalAuthority = Effect.runSync(ApprovalAuthority.make([
  { principal: { id: "local", kind: "operator" }, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] },
  { principal: NodeGateway.bearerPrincipal, scopes: ["once", "run", "remembered"], targets: ["Plan", "Node"] }
]))

/** The one flow the control plane may plan, declared the way a host declares it. */
const durableFlow: DurableFlow = {
  flowId,
  description: "The flow graph suite's fixture flow",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} },
  plan: (input, planId) =>
    plan(input, planId).pipe(
      Effect.map((compiled) => ({ plan: compiled, graph: planGraph(input) })),
      Effect.provide(NodeCrypto.layer),
      Effect.orDie
    )
}

/**
 * A Jujutsu service that records nothing. The engine calls it for compensable
 * snapshots; this graph's actions are sealed, so a stub keeps the wiring honest
 * without requiring a `jj` binary on the machine running the suite.
 */
const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "graph-fixture" as never, changeId: "graph-fixture" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/** A fresh directory holding both SQLite files, removed when the scope closes. */
const databaseDirectory = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "smthrs-flow-graph-"))),
  (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
)

/** Journal, run store and writer over one real SQLite file. */
const controlStorage = (filename: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 4096, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        DatabaseMigrations.layer([JournalMigrations.set, RunStoreMigrations.set]),
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
      )
    )
  )

/**
 * The ENGINE's database: its own file, its own migrations, its own singletons.
 *
 * `Layer.fresh` wraps the whole storage graph for the reason `NativeControl`
 * gives: every store layer here is a singleton, and one shared memo map would
 * otherwise hand the engine the control plane's instances over the other
 * database, which is one database again and not the topology under test.
 */
const engineStorage = (filename: string) =>
  Layer.fresh(
    Layer.mergeAll(
      SqlJournal.layer({ capacity: 4096, overflow: "reject" }),
      RunStore.layer,
      AttemptStore.layer,
      CacheStore.layer,
      DurableEngineState.layer
    ).pipe(
      Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
      Layer.provideMerge(
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename })).pipe(
          Layer.provideMerge(NodeCrypto.layer)
        )
      )
    )
  )

/**
 * What each fixture action did, so a suite reads dispatch counts rather than
 * inferring them from timing.
 *
 * @since 1.0.0
 * @category models
 */
export interface Dispatches {
  /** How many times each action's implementation was entered, by action name. */
  readonly counts: Map<string, number>
}

/**
 * The engine, reachable from the control plane's side and nothing else.
 *
 * Only these closures cross back, as only the executor crosses back in a host
 * composition. The engine's `RunStore` and `DurableEngineState` stay inside: a
 * control plane that could see them would not be the topology under test.
 *
 * @since 1.0.0
 * @category models
 */
export class Engine extends Context.Service<Engine, {
  /** Starts the wrapper execution under `runId`, the way a driver starts one. */
  readonly start: (
    runId: string,
    planId: string,
    flowId: string,
    executionDigest: string | null,
    input: unknown
  ) => Effect.Effect<void>
  /**
   * The live catalog of the flows THIS HOST discovered, or nothing when the
   * composition serves no project.
   *
   * The service object never changes identity; a rebuild swaps the snapshot
   * behind it (`Executable.layerRefreshable`), which is what lets the control
   * plane read a flow a run wrote without the host being restarted.
   */
  readonly catalog: Executable.Catalog | undefined
  /** Rebuilds one catalog entry from the bytes now on disk, or nothing. */
  readonly refresh: Executable.Refresh | undefined
  /** The engine's own journal, which the bridge reads and nothing else may. */
  readonly journal: Journal.Service
  /** The engine's own run store, which the bridge reads wrapper identity from. */
  readonly runs: RunStore.Service
  /** The engine's own durable state, which the bridge reads lineage from. */
  readonly state: DurableEngineState.Service
  /** The production observation port, over both stores. */
  readonly observe: (runId: string) => Effect.Effect<ControlExecutor.ExecutionObservation>
  /** The production signal port. */
  readonly deliverSignal: (input: ControlExecutor.Signal) => Effect.Effect<ControlExecutor.SignalDelivery>
  /** Polls until an execution BELOW `runId` is parked on a human wait. */
  readonly parkedBelow: (runId: string) => Effect.Effect<DurableEngineState.WaitingRow>
  /** Polls until the wrapper execution reaches a terminal status, and reports it. */
  readonly settled: (runId: string) => Effect.Effect<string>
  /** The event kinds the ENGINE journaled for one execution. */
  readonly kinds: (executionId: string) => Effect.Effect<ReadonlyArray<string>>
  /** How many times each fixture action ran. */
  readonly dispatches: Dispatches
}>()("smithers/test/GraphFixtureEngine") {}

/** Counts a dispatch and returns what the action produces. */
const counted = (dispatches: Dispatches, name: string): number => {
  const next = (dispatches.counts.get(name) ?? 0) + 1
  dispatches.counts.set(name, next)
  return next
}

/** The fixture's action implementations, over one shared dispatch counter. */
const implementations = (dispatches: Dispatches) =>
  Layer.mergeAll(
    Steady.toLayer(({ label }: { readonly label: string }) =>
      Effect.sync(() => {
        counted(dispatches, "steady")
        return `steady:${label}`
      })
    ),
    // The first attempt fails; the retry policy admits a second, which
    // succeeds. The counter is what decides, so the failure is reproducible.
    Flaky.toLayer(({ label }: { readonly label: string }) =>
      Effect.suspend(() =>
        counted(dispatches, "flaky") === 1
          ? Effect.fail("the first attempt always fails")
          : Effect.succeed(`flaky:${label}`)
      )
    ),
    Doomed.toLayer(({ label }: { readonly label: string }) =>
      Effect.suspend(() => {
        counted(dispatches, "doomed")
        return Effect.fail(`doomed:${label}`)
      })
    ),
    Cacheable.toLayer(
      ({ label }: { readonly label: string }) =>
        Effect.sync(() => {
          counted(dispatches, "cacheable")
          return `cacheable:${label}`
        }),
      // The declaration's version, attested. A mismatch is refused before the
      // graph is dispatched, so the pair has to be written together.
      { implementationVersion: "1" }
    )
  )

/**
 * What a host declares about itself, and the one thing a cross-run cache hit
 * needs that no host in this repo wires today.
 *
 * `@smthrs/engine` `FlowEngine/ActionKey.actionKey` folds the execution id
 * into every sealed keyed dispatch while `Action.CurrentCacheEnvironment` is
 * absent, so the row one run records is addressed by an identity no later run
 * can spell. Declaring the environment is what turns that key from `run` into
 * `cache`. It is complete-or-absent by contract, so this is a value a
 * composition supplies, never one the fixture invents.
 *
 * @since 1.0.0
 * @category models
 */
export interface StackOptions {
  /** The complete runtime environment this composition declares. Absent by default. */
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
  /** Add the source-writing fixture in an isolated, owned workspace. */
  readonly authoring?: boolean
}

/**
 * The catalog this composition serves discovered flows out of, and the seam
 * that rebuilds one entry of it while the host is running.
 *
 * This is the production registration path, not a fixture one: a real
 * `Registry` scans the project's `flows/` directory, `Executable` loads and
 * measures the entry a run wrote, and `Executable.layerRefreshable`'s
 * {@link Executable.Refresh} registers the rebuilt body with the RUNNING
 * engine runtime. Nothing here knows the authored flow before a run writes
 * it, which is the whole point (D-081).
 *
 * The filesystem is the host's own, not the workspace-scoped one the engine
 * gives an action: discovery walks absolute paths under the project root, and
 * the loader writes and imports a digest-named sibling beside the entry.
 */
const catalogLayer = (authoring: ReturnType<typeof makeAuthoringFixture>) =>
  Executable.layer({ delegates: [] }).pipe(
    Layer.provide(authoring.registry),
    Layer.provide(authoring.platform),
    Layer.orDie
  )

const engineLayer = (
  filename: string,
  dispatches: Dispatches,
  options: StackOptions,
  authoring?: ReturnType<typeof makeAuthoringFixture>
) => {
  /**
   * The catalog this engine serves, filled while its layer builds and read
   * when a run dispatches. The wrapper has to exist before the layer that
   * registers it, and the catalog only exists once that layer has been built.
   */
  const held: { catalog: Executable.Catalog | undefined } = { catalog: undefined }
  /**
   * One resolution rule for every flow this host can run: the flows this
   * composition registered itself, then whatever discovery found.
   */
  const resolve = (named: string, executionDigest: string | null, input: unknown) => {
    if (named === flowId) return GraphFixture.child({ label: inputOf(input).label })
    if (named === ScriptedAuthor._tag) {
      return ScriptedAuthor.child({ args: String((input as { readonly args?: unknown } | undefined)?.args ?? "") })
    }
    const executable = held.catalog?.executables.find((entry) => entry.descriptor.name === named)
    if (executable === undefined) return Node.fail(`this host holds no executable for ${named}`)
    // The identity check `AgentSession.approvedModule` performs before it
    // dispatches: a card approved against one body must not run another. An
    // edited file is a different execution identity, so a plan approved before
    // the edit is refused rather than silently running code nobody approved.
    if (executionDigest === null || Descriptor.executionDigest(executable.descriptor) !== executionDigest) {
      return Node.fail(`${named} changed or has no approved executable identity`)
    }
    // The registered body, dispatched as its own child execution, exactly as
    // `AgentSession` dispatches an approved module flow.
    return executable.flow.child({ input: input as never })
  }
  const wrapper = wrapperOver(resolve)
  return Layer.effect(Engine)(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const journal = yield* Journal.Journal
      const runs = yield* RunStore.RunStore
      // Read the way `AgentSession` reads it: optional, because a composition
      // that serves no project holds no catalog and runs only what it
      // registered by hand.
      held.catalog = Option.getOrUndefined(yield* Effect.serviceOption(Executable.Catalog))
      const refresh = Option.getOrUndefined(yield* Effect.serviceOption(Executable.Refresh))
      const services = yield* Effect.context<Effect.Services<ReturnType<typeof wrapper.execute>>>()
      const settled = (runId: string, attempts = 20_000): Effect.Effect<string> =>
        Effect.gen(function*() {
          // Control accepts before the forked engine launch creates its row.
          // Absence is still launching, not a failed execution or a reason to
          // repeat the launch. Other storage errors must remain failures.
          const row = yield* runs.get(runId).pipe(
            Effect.catch((error) => error.code === "not_found_row" ? Effect.succeed(undefined) : Effect.die(error))
          )
          if (row !== undefined && !["suspended", "running", "pending"].includes(row.status)) return row.status
          if (attempts <= 0) return yield* Effect.die(`execution ${runId} did not settle`)
          yield* Effect.sleep("2 millis")
          return yield* settled(runId, attempts - 1)
        })
      const parkedBelow = (
        runId: string,
        attempts = 20_000
      ): Effect.Effect<DurableEngineState.WaitingRow> =>
        Effect.gen(function*() {
          const open = yield* state.waitingTree(runId)
          const human = open.find((row) => row.reason === "approval" && row.runId !== runId)
          if (human !== undefined) return human
          if (attempts <= 0) return yield* Effect.die(`no execution below ${runId} parked on a human wait`)
          yield* Effect.sleep("2 millis")
          return yield* parkedBelow(runId, attempts - 1)
        })
      return {
        start: (runId: string, planId: string, flowId: string, executionDigest: string | null, input: unknown) =>
          Effect.provideContext(
            Effect.asVoid(
              wrapper.execute(
                { runId, planId, flowId, executionDigest, input: input as never },
                { executionId: runId, discard: true }
              )
            ),
            services
          ).pipe(Effect.orDie),
        catalog: held.catalog,
        refresh,
        observe: (runId: string) =>
          Effect.orDie(
            AgentSession.readExecution(runId).pipe(
              Effect.provideService(RunStore.RunStore, runs),
              Effect.provideService(DurableEngineState.DurableEngineState, state)
            )
          ),
        deliverSignal: (input: ControlExecutor.Signal) =>
          // `AgentSession` provides its captured services here too: signal
          // delivery reads `DurableEngineState` and `FlowRuntime`.
          AgentSession.deliverSignal(input).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, state),
            Effect.provideContext(services),
            Effect.orDie
          ),
        parkedBelow,
        settled,
        journal,
        runs,
        state,
        kinds: (executionId: string) =>
          journal.entries({ runId: executionId as never, limit: 2000 }).pipe(
            Effect.map((page) => page.entries.map((entry) => entry.eventType)),
            Effect.orDie
          ),
        dispatches
      }
    })
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        HumanTask.layer,
        Interpreter.layer(wrapper),
        ...(authoring === undefined ? [] : [Interpreter.layer(ScriptedAuthor), catalogLayer(authoring)]),
        Interpreter.layer(GraphFixture),
        Interpreter.layer(Gate),
        Interpreter.layer(Ask)
      ).pipe(
        Layer.provideMerge(Layer.merge(implementations(dispatches), authoring?.implementations ?? Layer.empty)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(
          EngineStore.layer({
            owner: { hostId: "graph-fixture-suite" },
            journalSource: "graph-fixture-suite",
            declarationRoot: repositoryRoot,
            // The same revision the plan carries: this stack drives the
            // modules it loaded from this tree (D-068).
            sourceRevision: sourceRevision(),
            isAlive: () => Effect.succeed(false)
          })
        ),
        Layer.provideMerge(
          Layer.mergeAll(authoring?.filesystem ?? StepBoundary.layerTest(), stubJj, OwnerIdentity.layer)
        ),
        // The declaration a host makes about the machine its results were
        // computed on, or nothing at all. `Dispatch.ts:69` reads it off the
        // context the engine captures here, so it has to sit under the engine
        // rather than beside it.
        Layer.provideMerge(
          options.cacheEnvironment === undefined
            ? Layer.empty
            : Action.layerCacheEnvironment(options.cacheEnvironment)
        ),
        Layer.provideMerge(engineStorage(filename))
      )
    )
  )
}

/**
 * The acceptance and observation ports, answered by the engine and observed by
 * the bridge.
 *
 * `NativeControl` composes exactly this: build the supervisor over the two
 * journals, fork its recovery, and return the executor it wraps. The wrap is
 * what starts an observation for each accepted launch, and the observation is
 * what copies the engine's records into the control journal.
 */
const executor = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const engine = yield* Engine
    const scope = yield* Effect.scope
    // The bridge's engine side comes off the `Engine` service rather than the
    // ambient context, for the reason `NestedHumanWaitAcrossDatabases.test.ts`
    // gives: only the executor crosses back in a host composition, and an
    // ambient `Journal` or `RunStore` here is the CONTROL plane's.
    const supervisor = yield* EngineJournalSupervisor.make({
      engineJournal: engine.journal,
      controlJournal: yield* Journal.Journal,
      engineState: engine.state,
      runs: engine.runs,
      control: yield* ControlRuntime,
      // What a host does when one of its own runs has written a flow file:
      // rebuild that one catalog entry from the bytes that reached the
      // workspace, before the run's receipt is readable. `NativeControl`
      // installs the same reaction from `Application.Config.rebuildAuthoredFlows`,
      // and a composition whose runs may write arbitrary code into the
      // directory it serves is the case D-078 permits it for.
      ...(engine.refresh === undefined ? {} : { onSourceApplied: AuthoredRebuild.rebuild(engine.refresh) })
    })
    yield* Effect.forkScoped(supervisor.recover)
    return supervisor.wrap(ControlExecutor.makeNoop({
      readExecution: (runId) => engine.observe(runId),
      deliverSignal: (input) => engine.deliverSignal(input),
      // Started and not awaited, as a host starts an accepted launch: the run
      // parks on its gate, and acceptance is not its settlement.
      launch: (input) =>
        Effect.as(
          Effect.forkIn(
            engine.start(
              input.run.runId,
              input.run.planId ?? "",
              input.plan.card.flowId,
              input.plan.card.executionDigest ?? null,
              input.plan.decodedInput
            ),
            scope
          ),
          "accepted" as const
        )
    }))
  })
)

/**
 * The dispatcher this host serves: a real trigger store over the control
 * plane's own database, holding {@link fixtureSchedule}.
 *
 * `Control.list` answers `triggers` and `fires` through
 * `@smthrs/control` `DispatchReader`, and a composition that provides none
 * REFUSES both listings rather than answering an empty page — an empty page
 * would say this host has no schedules, which is a different statement from
 * "this host cannot read whether it has any". The adapter is
 * `@smthrs/triggers`' own, over the same store the CLI's scheduler writes, so
 * the rows a client reads here are the rows a deployed box answers with.
 */
const dispatcher = TriggersDispatchReader.layer.pipe(
  Layer.provide(
    Layer.effectDiscard(
      Effect.flatMap(TriggerStore.TriggerStore, (store) => Effect.orDie(store.register(fixtureSchedule)))
    ).pipe(Layer.provideMerge(Layer.orDie(SqlTriggerStore.layer)))
  )
)

/**
 * One flow THIS HOST discovered, projected into the shape the durable control
 * runtime plans from.
 *
 * `@smthrs/cli` `NativeControl.durableFlow` and `planExecutable` are the same
 * two functions over the same two values: the descriptor answers the envelope
 * and the approved execution identity, and the executable's own flow answers
 * the nodes. The graph carries each node's declaration site made relative to
 * the project root, and a site of an authored flow names the file the run
 * WROTE: `Executable`'s loader says `Graph.evaluatedFrom(sibling, entry)`
 * before it imports, so a declaration captured while that module evaluates is
 * reported against `flows/<id>/flow.ts` and never against the digest-named
 * scratch module it was actually imported from.
 *
 * No revision is reported, because this project is a scratch directory under
 * no version control and can name none. A reader of such a node is shown no
 * code rather than a file it cannot bind (D-068), which is why the drawer's
 * Code tab is absent for it.
 *
 * No cache is probed, so every node reports `run`: this host cannot say a key
 * would hit, and a verdict it has not checked would be a claim about work
 * nothing looked for.
 *
 * @since 1.0.0
 * @category constructors
 */
const discoveredFlow = (executable: Executable.Executable, root: string): DurableFlow => ({
  flowId: executable.descriptor.name,
  description: executable.descriptor.description,
  deployClass: false,
  executionDigest: Descriptor.executionDigest(executable.descriptor),
  envelope: {
    capabilities: executable.descriptor.capabilities,
    flows: executable.descriptor.flows,
    budget: Descriptor.budgetOf(executable.descriptor)
  },
  plan: (input, planId) =>
    Effect.suspend(() => {
      const built = Graph.build(executable.flow, { input: input as never })
      return Plan.compile({ planId, flow: executable.descriptor.name, nodes: Graph.drafts(built) }).pipe(
        Effect.map((compiled) => ({
          plan: compiled,
          graph: {
            edges: Graph.edges(built),
            nodes: Graph.nodes(built).map((node) => {
              const path = node.declaredAt === undefined
                ? undefined
                : EngineEvent.relativePath(root, node.declaredAt.path)
              return {
                id: node.id,
                ...(path === undefined ? {} : { declaredAt: { path, line: node.declaredAt!.line } })
              }
            })
          }
        }))
      )
    }).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie)
})

/**
 * The durable control runtime this stack plans from.
 *
 * With no project to serve it is the fixture's own flow and nothing else. With
 * one, the catalog is read PER PLAN rather than once while the host starts,
 * which is the only reason a flow one of this host's own runs wrote can be
 * planned without a restart (`SqlControlRuntime.Options.loadFlows`, as
 * `NativeControl` supplies it).
 */
const controlRuntime = (authoring?: ReturnType<typeof makeAuthoringFixture>) =>
  authoring === undefined
    ? SqlControlRuntime.layer({ flows: [durableFlow], approvalAuthority }).pipe(Layer.orDie)
    : Layer.effect(ControlRuntime)(
      Effect.gen(function*() {
        const engine = yield* Engine
        return yield* SqlControlRuntime.make({
          approvalAuthority,
          loadFlows: () =>
            Effect.succeed([
              durableFlow,
              ...authoring.flows,
              ...(engine.catalog?.executables ?? []).map((executable) => discoveredFlow(executable, authoring.root))
            ])
        })
      })
    ).pipe(Layer.orDie)

/**
 * The bridged stack: the gateway read path, a control plane whose executor is
 * the engine, and the supervisor that copies the engine's journal into the
 * control journal.
 *
 * Each call builds its own pair of databases and its own dispatch counter, so
 * a suite that wants two of them gets two independent hosts.
 *
 * @since 1.0.0
 * @category layers
 */
export const stackWith = (options: StackOptions = {}) =>
  Layer.unwrap(
    Effect.map(databaseDirectory, (directory) => {
      const dispatches: Dispatches = { counts: new Map<string, number>() }
      const authoring = options.authoring ? makeAuthoringFixture(join(directory, "workspace")) : undefined
      return Projections.layerWith({ heartbeatMillis: 50 }).pipe(
        Layer.provideMerge(Layer.merge(RunCatalog.layerNoop, WorkspaceShare.layerNoop)),
        Layer.provideMerge(ControlLive.layer),
        // The executor reads the control plane it observes: `ControlRuntime` for
        // the bridge's wrapper identity check and the CONTROL journal for the
        // records a client watching the run reads. Sibling layers cannot see
        // each other, so it is provided them rather than merged beside them.
        Layer.provideMerge(
          executor.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                controlRuntime(authoring),
                NotificationQueue.layer,
                Registry.layerNoop(),
                dispatcher
              ).pipe(Layer.provideMerge(Layer.merge(controlStorage(join(directory, "control.db")), NodeCrypto.layer)))
            )
          )
        ),
        Layer.provideMerge(engineLayer(join(directory, "engine.db"), dispatches, options, authoring))
      )
    })
  )

/**
 * The bridged stack as every host in this repo composes it: no declared cache
 * environment, so every sealed key is scoped to its run.
 *
 * @since 1.0.0
 * @category layers
 */
export const stack = stackWith()

/**
 * Runs one body against a bridged stack.
 *
 * The body may use only what `layer` provides, so a service removed from the
 * stack fails the compile instead of dying with "Service not found".
 *
 * @since 1.0.0
 * @category runners
 */
export const runOn = <ROut, LE, A, E>(
  layer: Layer.Layer<ROut, LE, Scope.Scope>,
  body: Effect.Effect<A, E, NoInfer<ROut> | Scope.Scope>
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.provide(body, layer)))

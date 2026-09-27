/**
 * The catalog of Smithers 0.x constructs an application can import.
 *
 * Every row names the construct as application code writes it, the kind of
 * thing it is, and the file in the Smithers 0.x source tree (version 0.35.0,
 * commit `cfb570f193`) that defines it. The old source path is what makes a
 * mapping decision auditable: a reader can check the claim.
 *
 * The catalog is data, not behavior. `Mapping` decides what each row becomes,
 * and `Inventory` decides which rows a project actually uses.
 *
 * @since 1.0.0-rc.0
 */

import { componentProps, facadeExports } from "./internal/FacadeExports.ts"
import * as Sort from "./internal/Sort.ts"

/**
 * What kind of thing a construct is. The kind decides how `Inventory` finds it:
 * a `component` is a JSX element, a `ctx` is a member call on the render
 * context, and everything else is an imported binding or a project file.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ConstructKind =
  | "agent"
  | "cli"
  | "component"
  | "config"
  | "ctx"
  | "factory"
  | "pragma"
  | "runtime"
  | "server"
  | "store"
  | "subpath"
  | "testing"
  | "tool"
  | "value"

/**
 * One removed 0.x construct.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Construct {
  /** The identifier application code writes. */
  readonly name: string
  readonly kind: ConstructKind
  /** The defining file in the old tree, relative to its repository root. */
  readonly source: string
  /** Props that carry semantics, for a `component`. */
  readonly props?: ReadonlyArray<string>
}

/**
 * One catalog row for an old component.
 *
 * The props are the union of the ones named here and the ones the old
 * `<Name>Props.ts` declares, which `internal/FacadeExports` carries. Naming a prop here
 * is a way to say it matters; the generated list is what makes the row
 * complete, so a prop the old component accepted can never be missing from the
 * row that a class escalation reads.
 */
const component = (name: string, source: string, props: ReadonlyArray<string> = []): Construct => {
  const declared = [...new Set([...props, ...(componentProps[name] ?? [])])].sort(Sort.byText)
  return declared.length === 0
    ? { name, kind: "component", source }
    : { name, kind: "component", source, props: declared }
}

const componentsDir = "packages/components/src/components"

const structure: ReadonlyArray<Construct> = [
  component("Workflow", `${componentsDir}/Workflow.js`, ["name", "cache"]),
  component("Task", `${componentsDir}/Task.js`, [
    "id",
    "output",
    "outputSchema",
    "agent",
    "fallbackAgent",
    "dependsOn",
    "needs",
    "deps",
    "depsOptional",
    "fork",
    "bind",
    "skipIf",
    "needsApproval",
    "async",
    "timeoutMs",
    "heartbeatTimeoutMs",
    "noRetry",
    "retries",
    "retryPolicy",
    "maxSchemaRetries",
    "repair",
    "continueOnFail",
    "cache",
    "scorers",
    "groundTruth",
    "context",
    "memory",
    "hijack",
    "onHijackExit",
    "allowTools",
    "sideEffect",
    "idempotent",
    "revert",
    "priority",
    "failurePolicy",
    "label",
    "meta"
  ]),
  component("Task.browser", `${componentsDir}/Task.browser.js`, ["id", "output", "agent"]),
  component("Sequence", `${componentsDir}/Sequence.js`, ["label", "failurePolicy", "skipIf"]),
  component("Parallel", `${componentsDir}/Parallel.js`, [
    "id",
    "label",
    "maxConcurrency",
    "subtreeConcurrency",
    "priority",
    "failurePolicy",
    "skipIf"
  ]),
  component("Branch", `${componentsDir}/Branch.js`, ["if", "then", "else"]),
  component("Loop", `${componentsDir}/Loop.js`, ["until", "maxIterations", "onMaxReached", "continueAsNewEvery"]),
  component("Ralph", `${componentsDir}/Ralph.js`, ["until", "maxIterations"]),
  component("MergeQueue", `${componentsDir}/MergeQueue.js`, ["maxConcurrency", "priority", "failurePolicy"]),
  component("ContinueAsNew", `${componentsDir}/ContinueAsNew.js`, ["state"]),
  component("Worktree", `${componentsDir}/Worktree.js`, ["path", "branch", "baseBranch"]),
  component("Timer", `${componentsDir}/Timer.js`, ["duration", "until", "every"]),
  component("WaitForEvent", `${componentsDir}/WaitForEvent.js`, [
    "event",
    "correlationId",
    "timeoutMs",
    "onTimeout",
    "tagged"
  ]),
  component("Signal", `${componentsDir}/Signal.js`, ["schema", "correlationId", "timeoutMs", "onTimeout"]),
  component("Subflow", `${componentsDir}/Subflow.js`, ["workflow", "input", "mode", "output"]),
  component("Approval", `${componentsDir}/Approval.js`, [
    "mode",
    "options",
    "request",
    "onDeny",
    "allowedScopes",
    "allowedUsers",
    "autoApprove",
    "timeoutMs"
  ]),
  component("ApprovalGate", `${componentsDir}/ApprovalGate.js`, ["request", "when", "onDeny"]),
  component("HumanTask", `${componentsDir}/HumanTask.js`, ["prompt", "maxAttempts"]),
  component("Saga", `${componentsDir}/Saga.js`, ["onFailure"]),
  component("SagaStep", `${componentsDir}/Saga.js`, ["compensation", "onFailure"]),
  component("TryCatchFinally", `${componentsDir}/TryCatchFinally.js`, ["try", "catch", "catchErrors", "finally"]),
  component("Sandbox", `${componentsDir}/Sandbox.js`, [
    "provider",
    "runtime",
    "image",
    "env",
    "egress",
    "ports",
    "volumes",
    "command",
    "workspace",
    "reviewDiffs",
    "autoAcceptDiffs",
    "allowNetwork"
  ]),
  component("Sidecar", `${componentsDir}/Sidecar.js`),
  component("Poller", `${componentsDir}/Poller.js`, ["check", "checkOutput", "maxAttempts", "backoff", "intervalMs"]),
  component("Monitor", `${componentsDir}/Monitor.js`),
  component("Supervisor", `${componentsDir}/Supervisor.js`),
  component("Kanban", `${componentsDir}/Kanban.js`),
  component("Memory", `${componentsDir}/Memory.js`),
  component("MemoryTrellis", `${componentsDir}/MemoryTrellis.js`),
  component("Optimizer", `${componentsDir}/Optimizer.js`),
  component("Aspects", `${componentsDir}/Aspects.js`, ["tokenBudget", "latencySlo", "tracking"]),
  component("UI", `${componentsDir}/UI.js`, ["entry", "source", "exportName", "title", "props"]),
  component("TUI", `${componentsDir}/TUI.js`, ["entry", "title"])
]

const higherOrder: ReadonlyArray<Construct> = [
  component("Panel", `${componentsDir}/Panel.js`, [
    "panelists",
    "moderator",
    "panelistOutput",
    "moderatorOutput",
    "strategy",
    "minAgree"
  ]),
  component("Debate", `${componentsDir}/Debate.js`, [
    "proposer",
    "opponent",
    "judge",
    "rounds",
    "argumentOutput",
    "verdictOutput",
    "topic"
  ]),
  component("ReviewLoop", `${componentsDir}/ReviewLoop.js`, [
    "producer",
    "reviewer",
    "produceOutput",
    "reviewOutput",
    "maxIterations",
    "onMaxReached"
  ]),
  component("GatherAndSynthesize", `${componentsDir}/GatherAndSynthesize.js`, [
    "sources",
    "synthesizer",
    "gatherOutput",
    "synthesisOutput",
    "maxConcurrency"
  ]),
  component("EscalationChain", `${componentsDir}/EscalationChain.js`, ["levels", "humanFallback", "humanRequest"]),
  component("ForkFanOut", `${componentsDir}/ForkFanOut.js`, ["fork", "tasks", "taskOutput"]),
  component("CheckSuite", `${componentsDir}/CheckSuite.js`, ["checks", "verdictOutput", "strategy"]),
  component("ClassifyAndRoute", `${componentsDir}/ClassifyAndRoute.js`, ["classifier", "routes"]),
  component("DecisionTable", `${componentsDir}/DecisionTable.js`, ["rules", "default", "strategy"]),
  component("Runbook", `${componentsDir}/Runbook.js`, ["steps", "approvalRequest"]),
  component("ScanFixVerify", `${componentsDir}/ScanFixVerify.js`, ["scanner", "fixer", "verifier"]),
  component("DriftDetector", `${componentsDir}/DriftDetector.js`),
  component("ContentPipeline", `${componentsDir}/ContentPipeline.js`, ["stages"]),
  component("SuperSmithers", `${componentsDir}/SuperSmithers.js`)
]

const delegation: ReadonlyArray<Construct> = [
  component("DelegationChain", `${componentsDir}/delegation/DelegationChain.js`),
  component("DelegationPlanning", `${componentsDir}/delegation/DelegationPlanning.js`),
  component("DelegationExecution", `${componentsDir}/delegation/DelegationExecution.js`),
  component("DelegationPreview", `${componentsDir}/delegation/DelegationPreview.js`),
  component("DelegationScoring", `${componentsDir}/delegation/DelegationScoring.js`),
  component("DelegationEditListener", `${componentsDir}/delegation/DelegationEditListener.js`),
  component("BackpressurePlanning", `${componentsDir}/delegation/BackpressurePlanning.js`),
  component("DeriskLoop", `${componentsDir}/delegation/DeriskLoop.js`),
  component("GoalRefinement", `${componentsDir}/delegation/GoalRefinement.js`),
  component("Trellis", `${componentsDir}/delegation-v2/Trellis.js`)
]

const ctx: ReadonlyArray<Construct> = [
  "input",
  "runId",
  "iteration",
  "output",
  "outputMaybe",
  "latest",
  "latestArray",
  "iterationCount",
  "prove",
  "boundStale",
  "worktreePath",
  "resolveWorktreePath",
  "recordDeferredDep",
  "resolveTableName",
  "requireTableName",
  "resolveRow"
].map((name): Construct => ({ name: `ctx.${name}`, kind: "ctx", source: "packages/driver/src/SmithersCtx.js" }))

const runtime: ReadonlyArray<Construct> = [
  { name: "createSmithers", kind: "runtime", source: "packages/smithers/src/create.js" },
  { name: "createSmithersPostgres", kind: "runtime", source: "packages/smithers/src/create.js" },
  { name: "createSmithersCloudflare", kind: "runtime", source: "packages/smithers/src/create.js" },
  { name: "createExternalSmithers", kind: "runtime", source: "packages/smithers/src/external/index.js" },
  { name: "createExternalSmithersEngine", kind: "runtime", source: "packages/smithers/src/external/index.js" },
  { name: "useCtx", kind: "runtime", source: "packages/smithers/src/create.js" },
  { name: "runWorkflow", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "renderFrame", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "workflow", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "workflowTool", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "fragment", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "Smithers", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "closeSingleRunnerRuntime", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "reopenSingleRunnerRuntime", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "approveNode", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "denyNode", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "getRun", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "listRuns", kind: "runtime", source: "packages/smithers/flows/engine/src/engine.js" },
  { name: "signalRun", kind: "runtime", source: "packages/smithers/flows/engine/src/signals.js" },
  { name: "executeChildWorkflow", kind: "runtime", source: "packages/smithers/flows/engine/src/child-workflow.js" },
  { name: "continueAsNew", kind: "runtime", source: `${componentsDir}/ContinueAsNew.js` },
  { name: "usePatched", kind: "runtime", source: "packages/smithers/flows/engine/src/effect/versioning.js" },
  { name: "resolveWorktreePath", kind: "runtime", source: "packages/graph/src/worktree-path.js" },
  { name: "SmithersRenderer", kind: "runtime", source: "packages/react-reconciler/src/dom/renderer.js" },
  { name: "mdxPlugin", kind: "runtime", source: "packages/smithers/src/mdx-plugin.js" },
  { name: "renderMdx", kind: "runtime", source: "packages/components/src/renderMdx.js" },
  { name: "markdownComponents", kind: "runtime", source: "packages/components/src/markdownComponents.js" },
  { name: "zodSchemaToJsonExample", kind: "runtime", source: "packages/components/src/zod-to-example.js" },
  { name: "revertToAttempt", kind: "runtime", source: "packages/smithers/flows/time-travel/src/revert.js" },
  { name: "timeTravel", kind: "runtime", source: "packages/smithers/flows/time-travel/src/timetravel.js" }
]

const store: ReadonlyArray<Construct> = [
  { name: "SmithersDb", kind: "store", source: "packages/db/src/index.js" },
  { name: "loadOutputs", kind: "store", source: "packages/db/src/index.js" },
  { name: "loadOutputsEffect", kind: "store", source: "packages/db/src/index.js" },
  { name: "ensureSmithersTables", kind: "store", source: "packages/db/src/ensure.js" },
  { name: "zodToTable", kind: "store", source: "packages/db/src/zodToTable.js" },
  { name: "zodToCreateTableSQL", kind: "store", source: "packages/db/src/zodToCreateTableSQL.js" },
  { name: "syncZodTableSchema", kind: "store", source: "packages/db/src/zodToTable.js" },
  { name: "zodSchemaColumns", kind: "store", source: "packages/db/src/zodToTable.js" },
  { name: "camelToSnake", kind: "store", source: "packages/db/src/utils/camelToSnake.js" },
  { name: "unwrapZodType", kind: "store", source: "packages/db/src/unwrapZodType.js" },
  { name: "openSmithersStore", kind: "store", source: "packages/smithers/src/openSmithersStore.js" },
  { name: "openSmithersBackend", kind: "store", source: "packages/smithers/src/openSmithersBackend.js" },
  {
    name: "resolveSmithersBackendChoice",
    kind: "store",
    source: "packages/smithers/src/resolveSmithersBackendChoice.js"
  },
  {
    name: "resolveSmithersBackendPreference",
    kind: "store",
    source: "packages/smithers/src/resolveSmithersBackendChoice.js"
  },
  { name: "migrateSmithersStore", kind: "store", source: "packages/smithers/src/migrateSmithersStore.js" }
]

const server: ReadonlyArray<Construct> = [
  { name: "startServer", kind: "server", source: "packages/server/src/index.js" },
  { name: "Gateway", kind: "server", source: "packages/server/src/gateway.js" },
  { name: "createServeApp", kind: "server", source: "packages/server/src/serve.js" }
]

const tools: ReadonlyArray<Construct> = [
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "tools",
  "defineTool",
  "getDefinedToolMetadata",
  "readFileTool",
  "writeFileTool",
  "editFileTool",
  "grepTool",
  "getToolContext",
  "getToolIdempotencyKey",
  "nextToolSeq",
  "runWithToolContext",
  "createHttpTool"
].map((name): Construct => ({ name, kind: "tool", source: "packages/smithers/src/tools/index.js" }))

const agents: ReadonlyArray<Construct> = [
  "AnthropicAgent",
  "OpenAIAgent",
  "ClaudeCodeAgent",
  "CodexAgent",
  "CursorAgent",
  "GeminiAgent",
  "KimiAgent",
  "PiAgent",
  "OmpAgent",
  "AmpAgent",
  "AntigravityAgent",
  "OpenCodeAgent",
  "VibeAgent",
  "HermesAgent",
  "HermesCliAgent",
  "OpenClawAgent",
  "NanocodexAgent",
  "GrokAgent",
  "ForgeAgent",
  "PoolAgent",
  "fallbackAgents"
].map((name): Construct => ({ name, kind: "agent", source: "packages/agents/src/index.js" }))

const testing: ReadonlyArray<Construct> = [
  "fakeAgent",
  "scriptedAgent",
  "renderWorkflow",
  "renderPrompt",
  "runTask",
  "simulate",
  "coverWorkflow",
  "expectFullCoverage",
  "createVirtualClock",
  "scenario",
  "compileScenario",
  "makeHarness",
  "unitSimHarness",
  "integrationHarness",
  "e2eHarness",
  "runScenario",
  "runWorkflowScenario",
  "dryRun",
  "makeReplayBundle"
].map((name): Construct => ({ name, kind: "testing", source: "packages/testing/src/index.ts" }))

const subpaths: ReadonlyArray<Construct> = [
  "aws",
  "browser",
  "cloudflare",
  "control-plane",
  "daytona",
  "evals",
  "gateway-client",
  "gateway-react",
  "gateway-ui",
  "gcp",
  "jsx-runtime",
  "jsx-dev-runtime",
  "memory",
  "microsandbox",
  "openapi",
  "sandbox",
  "scorers",
  "server",
  "telegram",
  "testing",
  "tools",
  "ui",
  "vercel",
  "xstate"
].map((name): Construct => ({ name: `smthrs/${name}`, kind: "subpath", source: "packages/smithers/package.json" }))

const pragmas: ReadonlyArray<Construct> = [
  { name: "@jsxImportSource smthrs", kind: "pragma", source: "packages/smithers/src/jsx-runtime.js" },
  { name: "@jsxImportSource smithers-orchestrator", kind: "pragma", source: "packages/smithers/src/jsx-runtime.js" }
]

const config: ReadonlyArray<Construct> = [
  { name: "smithers.config.ts", kind: "config", source: "apps/cli/src/config.js" },
  { name: ".smithers/agents.ts", kind: "config", source: "apps/cli/src/init.js" },
  { name: ".smithers/preload.ts", kind: "config", source: "apps/cli/src/init.js" },
  { name: ".smithers/bunfig.toml", kind: "config", source: "apps/cli/src/init.js" },
  { name: ".smithers/gateway.ts", kind: "config", source: "apps/cli/src/init.js" },
  { name: ".smithers/listeners.json", kind: "config", source: "apps/cli/src/listeners.js" },
  { name: ".smithers/packs.lock", kind: "config", source: "apps/cli/src/packs.js" },
  { name: ".smithers/smithers.toon", kind: "config", source: "apps/cli/src/init.js" },
  { name: ".smithers/types/assets.d.ts", kind: "config", source: "apps/cli/src/init.js" },
  { name: "// smithers-source:", kind: "config", source: "apps/cli/src/workflow-headers.js" },
  { name: "// smithers-display-name:", kind: "config", source: "apps/cli/src/workflow-headers.js" },
  { name: "// smithers-description:", kind: "config", source: "apps/cli/src/workflow-headers.js" },
  { name: "// smithers-tags:", kind: "config", source: "apps/cli/src/workflow-headers.js" },
  { name: "// smithers-metadata-version:", kind: "config", source: "apps/cli/src/workflow-headers.js" }
]

const cli: ReadonlyArray<Construct> = [
  "up",
  "workflow",
  "graph",
  "ps",
  "inspect",
  "approve",
  "deny",
  "signal",
  "cancel",
  "pause",
  "ui",
  "gateway",
  "cron",
  "eval",
  "optimize",
  "hijack",
  "retry-task",
  "rewind",
  "fork",
  "replay",
  "timeline",
  "snapshots",
  "restore",
  "revert",
  "worktrees",
  "human",
  "ask-human",
  "listeners",
  "migrate",
  "init",
  "add",
  "share",
  "upgrade",
  "docs",
  "docs-full"
].map((name): Construct => ({ name: `smithers ${name}`, kind: "cli", source: "apps/cli/src/index.js" }))

/**
 * The members reached through a `createSmithers` binding rather than through an
 * import. `outputs.<key>` and `tables.<key>` stand for every key: the key is a
 * project's own schema name, so the catalog names the shape and the inventory
 * carries the key in its detail.
 */
const factory: ReadonlyArray<Construct> = [
  { name: "outputs.<key>", kind: "factory", source: "packages/smithers/src/create.js" },
  { name: "tables.<key>", kind: "factory", source: "packages/smithers/src/create.js" },
  { name: "db.<member>", kind: "factory", source: "packages/db/src/SmithersDb.js" },
  { name: "smithers", kind: "factory", source: "packages/smithers/src/create.js" },
  { name: "close", kind: "factory", source: "packages/smithers/src/create.js" }
]

const named = new Set(
  [
    ...structure,
    ...higherOrder,
    ...delegation,
    ...ctx,
    ...runtime,
    ...store,
    ...server,
    ...tools,
    ...agents,
    ...testing,
    ...factory
  ].map((entry) => entry.name)
)

/**
 * Every remaining value the old root entry point exports.
 *
 * The hand-written lists above name the constructs a workflow author writes.
 * These are the rest of the facade: 172 observability handles, memory stores,
 * scorers, VCS helpers, error predicates, and delegation schemas that real 0.x
 * projects import and that a scanner must not drop. `internal/FacadeExports` is
 * generated from the old export graph, so the list cannot silently rot.
 */
const values: ReadonlyArray<Construct> = facadeExports
  .filter((entry) => entry.subpath === "" && !named.has(entry.name))
  .map((entry): Construct => ({ name: entry.name, kind: "value", source: entry.module }))

/**
 * The subpath each facade value is exported from, for the names the catalog
 * resolves through their subpath row rather than through a row of their own.
 *
 * `smithers-orchestrator/gateway-react` exports 79 hooks and
 * `smithers-orchestrator/ui` exports 357 components. Naming each one in the
 * mapping table would bury it; the subpath row already says the whole surface
 * has no counterpart, so the value resolves to that row.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const subpathOf: ReadonlyMap<string, string> = new Map(
  facadeExports
    .filter((entry) => entry.subpath !== "")
    .map((entry) => [entry.name, `smthrs/${entry.subpath}`] as const)
)

/**
 * Every construct in the catalog, sorted by kind and then by name so a
 * generated report and a generated document are stable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const constructs: ReadonlyArray<Construct> = [
  ...structure,
  ...higherOrder,
  ...delegation,
  ...ctx,
  ...runtime,
  ...store,
  ...server,
  ...tools,
  ...agents,
  ...testing,
  ...subpaths,
  ...pragmas,
  ...config,
  ...cli,
  ...factory,
  ...values
].sort((left, right) => Sort.byText(left.kind, right.kind) || Sort.byText(left.name, right.name))

const index = new Map(constructs.map((entry) => [entry.name, entry]))

/**
 * Looks a construct up by the name application code writes.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const byName = (name: string): Construct | undefined => index.get(name)

/**
 * Every construct of one kind.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const byKind = (kind: ConstructKind): ReadonlyArray<Construct> =>
  constructs.filter((entry) => entry.kind === kind)

/**
 * Reports whether a JSX element name is a catalog component. Element names are
 * resolved through imports before they reach this function.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const isComponent = (name: string): boolean => index.get(name)?.kind === "component"

/**
 * Reports whether one imported name resolves to a catalog row, either its own
 * or the row for the subpath it is exported from.
 *
 * A name that does not is a name the mapping table cannot decide, and
 * `Detect.scan` reports it as `uncatalogued-import` rather than dropping it.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const isCatalogued = (name: string): boolean => index.has(name) || subpathOf.has(name)

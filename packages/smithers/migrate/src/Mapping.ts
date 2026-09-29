/**
 * The old-construct to new-target mapping table, its class rules, and the
 * rewrite text for the constructs that translate mechanically.
 *
 * Three classes decide how much freedom the migration has:
 *
 * - `automatic`: this module emits the exact rewrite and the agent applies it.
 * - `guided`: the agent rewrites under the listed rule and records a decision.
 * - `unsafe`: the scanner flags it before any edit. `apply` refuses the unit
 *   until the operator names the construct in `--allow-unsafe`, and even then
 *   the agent leaves a `TODO(migrate-smithers-v1)` marker and an `unsupported`
 *   report entry rather than an imitation.
 *
 * A prop can raise a class. `<Parallel>` is automatic, `<Parallel
 * maxConcurrency>` is guided, and `<Task hijack>` is unsafe, because the prop
 * is the part with no counterpart.
 *
 * @since 1.0.0-rc.0
 */

import * as Constructs from "./Constructs.ts"
import * as CliScripts from "./internal/CliScripts.ts"
import * as FlowNames from "./internal/FlowNames.ts"
import * as Sort from "./internal/Sort.ts"
import * as Ts from "./internal/Ts.ts"
import type { InventoryEntry } from "./Inventory.ts"
import * as PromptHints from "./PromptHints.ts"
import * as ZodSchemaHints from "./ZodSchemaHints.ts"

/**
 * The 0.x agents that run on the operator's own CLI subscription, and the pool
 * that mixes them.
 *
 * No seat string stands for a subscription, so each of these is an operator
 * decision the report has to carry rather than a rewrite the tool may pick.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const subscriptionAgents: ReadonlyArray<string> = [
  "ClaudeCodeAgent",
  "CodexAgent",
  "OpenCodeAgent",
  "fallbackAgents"
]

/**
 * The suggestion the report offers for every {@link subscriptionAgents} hit.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const subscriptionSuggestion =
  "keep subscription auth through the flows harness, or choose an API seat; pools stay pools"

/**
 * How much freedom the migration has with one construct.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type MappingClass = "automatic" | "guided" | "unsafe"

/**
 * One mapping row.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface MappingRow {
  readonly construct: string
  /** The new API, as a reader would name it. `null` when there is none. */
  readonly target: string | null
  /** The flows module the target lives in, or `null`. */
  readonly targetModule: string | null
  readonly rule: string
  readonly class: MappingClass
}

const row = (
  construct: string,
  target: string | null,
  targetModule: string | null,
  rule: string,
  mappingClass: MappingClass
): MappingRow => ({ construct, target, targetModule, rule, class: mappingClass })

const table: ReadonlyArray<MappingRow> = [
  row(
    "createSmithers",
    "Flow.make(tag, { payload, success, error, body })",
    "@smthrs/flow/Flow",
    "One file `flows/<name>/flow.ts` per old workflow. `schemas.input` becomes `payload`, the last task's output schema becomes `success`, and `dbPath`, `backend`, and `journalMode` are dropped because storage belongs to the host.",
    "automatic"
  ),
  row(
    "Workflow",
    "Flow.make(tag, { description, capabilities, effects, payload, success, error, body })",
    "@smthrs/flow/Flow",
    "The `name` prop becomes the flow tag and the directory name under `flows/`, the last step's output schema becomes `success`, and an agent step gives the flow `AgentAction.AgentFailure` as its `error`. The flow is the module's default export, which is what registry discovery reads and what the engine runs, so the contract the control plane admits is the one that executes. Its `description` comes from the `// smithers-description:` or `// smithers-display-name:` header, or from the workflow name.",
    "automatic"
  ),
  row(
    "Task",
    "Action.make(tag, { payload, success }) with .toLayer, or AgentAction.make for a model step",
    "@smthrs/flow/Action, @smthrs/agent/AgentAction",
    "A compute task becomes an `Action` whose handler is the closure body. A task with an `agent` becomes an `AgentAction` whose `output` is the zod schema and whose `prompt` is built from the payload.",
    "automatic"
  ),
  row("Task.browser", null, null, "Browser-safe entry points only; there is no browser task.", "unsafe"),
  row(
    "Sequence",
    "Node.bindPlanned",
    "@smthrs/plan/Node",
    "Each child's planned value feeds the next call.",
    "automatic"
  ),
  row(
    "Parallel",
    "Node.all({ ... })",
    "@smthrs/plan/Node",
    "Sibling calls become a keyed record. `maxConcurrency`, `subtreeConcurrency`, and `priority` have no plan-level target; a data-driven fan-out becomes `Effect.forEach(..., { concurrency })` inside one action, and priority is dropped and recorded.",
    "automatic"
  ),
  row(
    "Branch",
    "Node.branch({ if, then, else })",
    "@smthrs/plan/Node",
    "The predicate reads the planned value.",
    "automatic"
  ),
  row(
    "Loop",
    "ReviewLoop.run or Recursion.recurse",
    "@smthrs/patterns/ReviewLoop, @smthrs/patterns/Recursion",
    "A produce/review/revise body becomes `ReviewLoop.run`; anything else becomes `Recursion.recurse` with an explicit fuel and loop state as a payload. `maxIterations={Infinity}` is refused: bounded recursion needs a bound.",
    "guided"
  ),
  row(
    "Ralph",
    "Recursion.recurse",
    "@smthrs/patterns/Recursion",
    "Ralph is loop sugar over a rerender; it becomes explicit bounded recursion.",
    "guided"
  ),
  row(
    "ContinueAsNew",
    "<flow>.to(payload) settling as Handoff",
    "@smthrs/flow",
    "Hand off to the next round with `<flow>.to(payload)`; each round has a new execution id and journal in the same lineage. The lineage's `maxRounds` bounds the chain.",
    "guided"
  ),
  row(
    "continueAsNew",
    "<flow>.to(payload) settling as Handoff",
    "@smthrs/flow",
    "Hand off to a new round in the same lineage; the lineage's `maxRounds` bounds the chain.",
    "guided"
  ),
  row(
    "Timer",
    "Sleep.action",
    "@smthrs/flow/Sleep",
    "`duration` becomes `Sleep.action.call({ name, duration })`. `until` needs `DurableClock.make`, and `every` is a `Cron` trigger, not a flow node.",
    "automatic"
  ),
  row(
    "WaitForEvent",
    "WaitFor.action over DurableDeferred",
    "@smthrs/flow/WaitFor",
    "`event` and `correlationId` become the wait name, the payload schema becomes the deferred success schema, and `timeoutMs` becomes `DurableDeferred.raceAll` with a `Sleep`. The sender side is guided until the signal bridge lands.",
    "automatic"
  ),
  row(
    "Signal",
    "WaitFor.action over DurableDeferred",
    "@smthrs/flow/WaitFor",
    "Same as `WaitForEvent`; the declaration side is mechanical, the sender side is not.",
    "automatic"
  ),
  row(
    "Subflow",
    "flow.child(payload) or flow.call(payload)",
    "@smthrs/flow/Flow",
    "A subflow with its own output becomes `.child()`, one node in the caller's plan and a real child execution. `mode: \"detached\"` becomes a `ChildFlows` binding. Child cancellation is not available yet and is recorded.",
    "guided"
  ),
  row(
    "Approval",
    "WithApproval.withApproval(inner, { reason, approval })",
    "@smthrs/patterns/WithApproval",
    "`request` becomes `reason`. `mode: \"select\"` and `mode: \"rank\"` have no decorator form and are recorded. `allowedUsers` or `allowedScopes` requires a guided decision: the operator must supply an approval flow that preserves the restrictions.",
    "automatic"
  ),
  row(
    "ApprovalGate",
    "WithApproval.withApproval",
    "@smthrs/patterns/WithApproval",
    "`when` becomes a `Node.branch` around the decorated call.",
    "automatic"
  ),
  row(
    "HumanTask",
    "StandardFlows.askFlow",
    "@smthrs/agent/StandardFlows",
    "A free-form answer arrives as `answer: string`; decode it with the old schema inside an action.",
    "guided"
  ),
  row(
    "Saga",
    "Node.catch plus CompensationHandlers",
    "@smthrs/plan/Node, @smthrs/time-travel/CompensationHandlers",
    "Compensations become `compensable`-tier handlers.",
    "guided"
  ),
  row(
    "SagaStep",
    "Node.catch plus CompensationHandlers",
    "@smthrs/plan/Node, @smthrs/time-travel/CompensationHandlers",
    "`compensation` becomes the step's compensation handler.",
    "guided"
  ),
  row(
    "TryCatchFinally",
    "Node.catch and Flow.addFinalizer",
    "@smthrs/plan/Node, @smthrs/flow/Flow",
    "`finally` becomes `Flow.addFinalizer`.",
    "guided"
  ),
  row(
    "Sandbox",
    "WorkspaceSandbox, RemoteChildProcessSpawner, or std Container",
    "@smthrs/engine-store/WorkspaceSandbox, @smthrs/sandbox, @smthrs/std/Container",
    "The local sandbox is the workspace sandbox. A custom provider becomes a `ChildProcessSpawner` implementation.",
    "guided"
  ),
  row(
    "Sidecar",
    "Sidecar.make",
    "@smthrs/patterns/Sidecar",
    "Configure the primary, shadow, and scoring as a sidecar experiment.",
    "guided"
  ),
  row(
    "Poller",
    "Recursion.recurse around Sleep.action",
    "@smthrs/patterns/Recursion, @smthrs/flow/Sleep",
    "The poll interval becomes a durable sleep inside a bounded recursion.",
    "guided"
  ),
  row(
    "Monitor",
    null,
    null,
    "An application pattern with no counterpart. The closest composition is a `ReviewLoop` on a trigger.",
    "unsafe"
  ),
  row(
    "Supervisor",
    "Supervisor.make",
    "@smthrs/patterns/Supervisor",
    "Map supervised members and their recovery policy.",
    "guided"
  ),
  row(
    "Kanban",
    "Kanban.make",
    "@smthrs/patterns/Kanban",
    "Map board stages and workers to the Kanban pattern.",
    "guided"
  ),
  row(
    "Optimizer",
    "Optimizer.make",
    "@smthrs/patterns/Optimizer",
    "Map candidates and evaluation to the optimizer pattern.",
    "guided"
  ),
  row("SuperSmithers", null, null, "An application pattern with no counterpart.", "unsafe"),
  row(
    "DriftDetector",
    "DriftDetector.make",
    "@smthrs/patterns/DriftDetector",
    "Map the check and response to the drift detector pattern.",
    "guided"
  ),
  row(
    "Memory",
    "MemoryStore and the memory flows bound by StandardFlows.memory",
    "@smthrs/memory",
    "No direct SQL; recall and write go through the memory flows.",
    "guided"
  ),
  row(
    "MemoryTrellis",
    "MemoryTrellis",
    "@smthrs/memory/MemoryTrellis",
    "Map delegation and recall to the memory trellis.",
    "guided"
  ),
  row(
    "Trellis",
    "Trellis.make",
    "@smthrs/patterns/Trellis",
    "Map the delegation graph to the trellis pattern.",
    "guided"
  ),
  row(
    "DelegationChain",
    "DelegationChain.make",
    "@smthrs/patterns/DelegationChain",
    "Map the delegation stages to the delegation chain pattern.",
    "guided"
  ),
  row(
    "Aspects",
    "Sandbox.Limits and Envelope.budget",
    "@smthrs/harness/Sandbox, @smthrs/control/ControlSchema",
    "A token budget becomes the host envelope budget.",
    "guided"
  ),
  row(
    "Worktree",
    null,
    null,
    "Worktree lanes are deferred. `Checkpoints` in `@smthrs/std` pins trees, not lanes.",
    "unsafe"
  ),
  row(
    "MergeQueue",
    "MergeQueue.make",
    "@smthrs/patterns/MergeQueue",
    "Map queued merges and validation to the merge queue pattern.",
    "guided"
  ),
  row(
    "UI",
    null,
    null,
    "The product UI is the flows app. Remove the `<UI>` element and keep the UI source file in place.",
    "unsafe"
  ),
  row("TUI", null, null, "There is no workflow-specific TUI.", "unsafe"),
  row(
    "Panel",
    "Panel.make({ panelists, moderator })",
    "@smthrs/patterns/Panel",
    "Panelist agents become participant flows.",
    "automatic"
  ),
  row(
    "Debate",
    "Debate.make({ proponent, opponent, judge, rounds })",
    "@smthrs/patterns/Debate",
    "The debate is a plan-time pattern.",
    "automatic"
  ),
  row(
    "ReviewLoop",
    "ReviewLoop.run(input, { maxRounds, produce, review, revise })",
    "@smthrs/patterns/ReviewLoop",
    "`maxIterations` becomes `maxRounds`; `onMaxReached` becomes handling `Exhausted`.",
    "automatic"
  ),
  row(
    "GatherAndSynthesize",
    "MapReduce.make({ map, reduce, concurrency, onEmpty })",
    "@smthrs/patterns/MapReduce",
    "Sources become shards.",
    "automatic"
  ),
  row(
    "ForkFanOut",
    "MapReduce.make({ map, reduce })",
    "@smthrs/patterns/MapReduce",
    "The fork becomes the shard list.",
    "automatic"
  ),
  row(
    "CheckSuite",
    "MapReduce.make({ map, reduce })",
    "@smthrs/patterns/MapReduce",
    "Each check is a shard and the verdict is the reducer.",
    "automatic"
  ),
  row("ClassifyAndRoute", "Node.branch", "@smthrs/plan/Node", "Generalized by the core combinators.", "automatic"),
  row("DecisionTable", "Node.branch", "@smthrs/plan/Node", "Each rule becomes a branch predicate.", "automatic"),
  row("ContentPipeline", "Node.bindPlanned", "@smthrs/plan/Node", "Stages become a chain.", "automatic"),
  row(
    "Runbook",
    "Node.bindPlanned with WithApproval",
    "@smthrs/plan/Node, @smthrs/patterns/WithApproval",
    "Steps become a chain; the approval request becomes a decorator.",
    "automatic"
  ),
  row(
    "EscalationChain",
    "Escalation.run",
    "@smthrs/patterns/Escalation",
    "The human fallback becomes `StandardFlows.approval`.",
    "guided"
  ),
  row(
    "ScanFixVerify",
    "ReviewLoop.run",
    "@smthrs/patterns/ReviewLoop",
    "Scan is produce, fix is revise, verify is review.",
    "guided"
  ),
  row(
    "runWorkflow",
    "flow.execute(payload, { executionId })",
    "@smthrs/flow/Flow",
    "Run under `Interpreter.layer(flow)` with `FlowEngine.layerMemory` or the Node runtime.",
    "automatic"
  ),
  row(
    "signalRun",
    "Control.signal",
    "@smthrs/control/Control",
    "The sender side is recorded as unresolved until the signal bridge lands.",
    "guided"
  ),
  row(
    "executeChildWorkflow",
    "flow.child(payload)",
    "@smthrs/flow/Flow",
    "A child execution is one node in the caller's plan.",
    "guided"
  ),
  row(
    "workflowTool",
    "FlowBinding.make({ flow, handler })",
    "@smthrs/harness/FlowBinding",
    "A tool is a declared flow plus a handler.",
    "guided"
  ),
  row(
    "workflow",
    "Flow.make",
    "@smthrs/flow/Flow",
    "The workflow wrapper becomes the flow declaration itself.",
    "automatic"
  ),
  row("renderFrame", "Graph.build(node)", "@smthrs/flow/Graph", "Plan inspection reads the built graph.", "automatic"),
  row(
    "SmithersRenderer",
    "Graph.build(node)",
    "@smthrs/flow/Graph",
    "There is no reconciler; delete the renderer and inspect the plan.",
    "automatic"
  ),
  row(
    "approveNode",
    "Control.approve",
    "@smthrs/control/Control",
    "Operator-side calls move to the control client.",
    "guided"
  ),
  row(
    "denyNode",
    "Control.deny",
    "@smthrs/control/Control",
    "Operator-side calls move to the control client.",
    "guided"
  ),
  row("getRun", "Control.list", "@smthrs/control/Control", "Run data is read through the control client.", "guided"),
  row("listRuns", "Control.list", "@smthrs/control/Control", "Run data is read through the control client.", "guided"),
  row(
    "revertToAttempt",
    "TimeTravel.rewind",
    "@smthrs/time-travel/TimeTravel",
    "Programmatic calls become the time-travel service.",
    "guided"
  ),
  row(
    "timeTravel",
    "TimeTravel.fork",
    "@smthrs/time-travel/TimeTravel",
    "Programmatic calls become the time-travel service.",
    "guided"
  ),
  row("usePatched", null, null, "There is no workflow versioning shim.", "unsafe"),
  row("createExternalSmithers", null, null, "There is no HostNode JSON tree API.", "unsafe"),
  row("createExternalSmithersEngine", null, null, "There is no HostNode JSON tree API.", "unsafe"),
  row("createSmithersPostgres", null, null, "The 1.0 release candidate supports SQLite only.", "unsafe"),
  row("createSmithersCloudflare", null, null, "There is no Cloudflare backend in the release candidate.", "unsafe"),
  row(
    "mdxPlugin",
    null,
    null,
    "MDX prompts become template literals or markdown flows; the loader is removed.",
    "automatic"
  ),
  row("renderMdx", null, null, "There is no MDX renderer; a prompt is a string.", "automatic"),
  row("markdownComponents", null, null, "There is no MDX renderer.", "automatic"),
  row("zodSchemaToJsonExample", null, null, "`AgentAction` renders the output schema itself.", "automatic"),
  row("resolveWorktreePath", null, null, "Worktree lanes are deferred.", "unsafe"),
  row(
    "useCtx",
    "The flow body payload",
    "@smthrs/flow/Flow",
    "Render context becomes the typed payload the body receives.",
    "automatic"
  ),
  row(
    "Smithers",
    "Flow.make",
    "@smthrs/flow/Flow",
    "The JSX root has no counterpart; the flow declaration is the root.",
    "automatic"
  ),
  row("fragment", null, null, "There is no JSX runtime.", "automatic"),
  row("closeSingleRunnerRuntime", null, null, "The runtime closes with its layer scope.", "automatic"),
  row("reopenSingleRunnerRuntime", null, null, "The runtime closes with its layer scope.", "automatic"),
  row(
    "zod",
    "effect/Schema",
    "effect/Schema",
    "The safe subset converts deterministically. Default-field snippets also require Effect from effect/Effect and SchemaGetter from effect/SchemaGetter. Defaults combined with optional/nullish fields, unknown/any schemas, or constrained fallback domains are guided; so are `.passthrough()`, `.refine()`, `.transform()`, `z.discriminatedUnion`, `z.lazy`, and custom error maps.",
    "automatic"
  ),
  row(
    "mdx-prompt",
    "prompt: (payload) => string, or flows/<name>/flow.mdx",
    "@smthrs/agent/AgentAction, @smthrs/registry/MarkdownFlow",
    "`{props.x}` becomes `${payload.x}`. An MDX file with imports or JSX components is guided.",
    "automatic"
  ),
  row(
    "package.json",
    "@smthrs/* at 1.0.0-rc.0 and effect at 4.0.0-rc.115",
    null,
    "Old packages are removed only in the final `project` unit. `zod` stays only if non-workflow code still imports it.",
    "automatic"
  ),
  row(
    "tsconfig.json",
    "The flows tsconfig shape",
    null,
    "`jsx`, `jsxImportSource`, and the `smthrs` path mappings are removed in the final unit.",
    "automatic"
  ),
  row(
    "smithers.config.ts",
    "Verification commands",
    null,
    "`repoCommands.test` seeds the tool's test command; `backend` is recorded and the file is deleted after the final unit.",
    "automatic"
  ),
  row(
    "docs",
    "Text pointing at flows/, smthrs flow start, and report.md",
    null,
    "Documentation that teaches `smithers up` or JSX authoring is rewritten.",
    "guided"
  )
]

const familyRow = (construct: Constructs.Construct): MappingRow => {
  switch (construct.kind) {
    case "ctx": {
      const loopState = ["ctx.iterationCount", "ctx.latestArray", "ctx.boundStale", "ctx.recordDeferredDep"]
      if (loopState.includes(construct.name)) {
        return row(construct.name, null, null, "A loop-state accessor. Rewrite the loop with explicit state.", "guided")
      }
      if (construct.name === "ctx.worktreePath" || construct.name === "ctx.resolveWorktreePath") {
        return row(construct.name, null, null, "Worktree lanes are deferred.", "unsafe")
      }
      return row(
        construct.name,
        "The planned value in scope",
        "@smthrs/plan/Node",
        "A dependency is the planned result passed to the next call, not an output-table read.",
        "automatic"
      )
    }
    case "tool":
      return row(
        construct.name,
        "The std flows bound through StandardFlows",
        "@smthrs/std, @smthrs/agent/StandardFlows",
        "Tools move from the task to the host catalog, and `allowTools` becomes the capability envelope.",
        construct.name === "defineTool" || construct.name === "createHttpTool" ? "guided" : "automatic"
      )
    case "agent": {
      if (subscriptionAgents.includes(construct.name)) {
        return row(
          construct.name,
          "An operator decision: subscription auth through the flows harness, or an API seat",
          "@smthrs/harness, @smthrs/agent/SeatResolver",
          "A CLI subprocess agent runs on the operator's own subscription, which no seat string can stand for. The tool records the choice as an unresolved decision offering subscription auth through the flows harness where the CLI supports it, or an API seat. A `fallbackAgents` pool stays a pool and is never collapsed to its first entry.",
          "guided"
        )
      }
      return row(
        construct.name,
        "A seat resolved by SeatResolver from the model this agent already names",
        "@smthrs/agent/SeatResolver, @smthrs/model/Route",
        "`agents.ts` becomes `flows/seats.ts`. The seat comes from the model literal in the source, never from a default; `OpenAIAgent({ baseURL })` becomes `Route.openaiCompatible`.",
        "guided"
      )
    }
    case "testing":
      return row(
        construct.name,
        "@smthrs/testing",
        "@smthrs/testing",
        "Coverage assertions on executed node ids become `PlanAssertions` over the built graph plus an `it.effect` run with a scripted seat.",
        "guided"
      )
    case "store":
      return row(
        construct.name,
        null,
        null,
        "Run data is read through `Control.list`/`Control.watch` and `@smthrs/sync`. Direct old-store access must not survive.",
        "unsafe"
      )
    case "server":
      return row(
        construct.name,
        null,
        null,
        "The old gateway has no counterpart; the control plane serves the run data.",
        "unsafe"
      )
    case "pragma":
      return row(
        construct.name,
        null,
        null,
        "There is no JSX runtime; the pragma is removed with the JSX.",
        "automatic"
      )
    case "cli": {
      const mapped: Record<string, string> = {
        "smithers up": "smthrs flow start <flow> --data <json> [--detached]",
        "smithers workflow": "smthrs flow start <flow> --data <json> [--detached]",
        "smithers ps": "smthrs runs list",
        "smithers cancel": "smthrs runs cancel <run>"
      }
      const target = mapped[construct.name]
      return target === undefined
        ? row(
          construct.name,
          null,
          null,
          "This verb has no verified automatic mapping and is recorded as unsupported; check the 1.0 command tree.",
          "unsafe"
        )
        : row(
          construct.name,
          target,
          "@smthrs/cli",
          "Use the canonical command tree. Preserve input and detach semantics; unsupported scripts require manual mapping.",
          construct.name === "smithers up" || construct.name === "smithers workflow" ? "automatic" : "guided"
        )
    }
    case "subpath": {
      const integrations = [
        "smthrs/aws",
        "smthrs/gcp",
        "smthrs/vercel",
        "smthrs/cloudflare",
        "smthrs/daytona",
        "smthrs/microsandbox",
        "smthrs/telegram",
        "smthrs/openapi",
        "smthrs/xstate",
        "smthrs/control-plane",
        "smthrs/browser",
        "smthrs/gateway-client",
        "smthrs/gateway-react",
        "smthrs/gateway-ui",
        "smthrs/ui",
        "smthrs/server"
      ]
      if (integrations.includes(construct.name)) {
        return row(
          construct.name,
          null,
          null,
          "Each integration is its own unit, and the report names the seam.",
          "unsafe"
        )
      }
      if (construct.name === "smthrs/jsx-runtime" || construct.name === "smthrs/jsx-dev-runtime") {
        return row(construct.name, null, null, "There is no JSX runtime.", "automatic")
      }
      const targets: Record<string, [string, string]> = {
        "smthrs/evals": ["@smthrs/evals", "Suite, Runner, Baseline, Regression, and Gate replace the eval helpers."],
        "smthrs/memory": ["@smthrs/memory", "The memory store and its flows replace the memory helpers."],
        "smthrs/sandbox": ["@smthrs/sandbox", "A custom provider becomes a `ChildProcessSpawner` implementation."],
        "smthrs/scorers": ["@smthrs/scorers", "Scorer, Binding, and Runner replace the scorer helpers."],
        "smthrs/testing": ["@smthrs/testing", "The scripted-seat harness replaces the coverage harness."],
        "smthrs/tools": ["@smthrs/std", "Tools move to the host catalog."]
      }
      const found = targets[construct.name]
      return found === undefined
        ? row(construct.name, null, null, "This subpath has no counterpart and is recorded.", "unsafe")
        : row(construct.name, found[0], found[0], found[1], "guided")
    }
    case "config": {
      if (construct.name.startsWith("// smithers-")) {
        return row(
          construct.name,
          "The registry descriptor",
          "@smthrs/registry",
          "Header metadata becomes the flow's `description` and directory name.",
          "automatic"
        )
      }
      const unsafeConfig = [
        ".smithers/gateway.ts",
        ".smithers/listeners.json",
        ".smithers/packs.lock",
        ".smithers/smithers.toon"
      ]
      return unsafeConfig.includes(construct.name)
        ? row(construct.name, null, null, "This project file has no counterpart and is recorded.", "unsafe")
        : row(construct.name, null, null, "The file is removed in the final `project` unit.", "automatic")
    }
    case "factory": {
      if (construct.name === "outputs.<key>" || construct.name === "tables.<key>") {
        return row(
          construct.name,
          "The planned value in scope",
          "@smthrs/plan/Node",
          "An output-table read becomes the planned result the previous call already returned.",
          "automatic"
        )
      }
      if (construct.name === "db.<member>") {
        return row(
          construct.name,
          null,
          null,
          "Run data is read through `Control.list` and `Control.watch`. Direct old-store access must not survive.",
          "unsafe"
        )
      }
      if (construct.name === "close") {
        return row(
          construct.name,
          "The host layer's scope",
          "@smthrs/platform-node",
          "Storage lifecycle belongs to the host layer, so the explicit close call is deleted.",
          "automatic"
        )
      }
      return row(
        construct.name,
        "Flow.make(tag, { payload, success, error, body })",
        "@smthrs/flow/Flow",
        "The `smithers((ctx) => ...)` render call becomes the flow `body`, and the render context's reads become the payload.",
        "guided"
      )
    }
    case "value": {
      const families: ReadonlyArray<readonly [string, string, string, string, MappingClass]> = [
        [
          "@smthrs/observability",
          "The kernel's telemetry and the OTLP layer",
          "@smthrs/kernel, @smthrs/observability",
          "Metric handles are bound at the host, not imported into workflow code.",
          "guided"
        ],
        [
          "@smthrs/memory",
          "@smthrs/memory",
          "@smthrs/memory",
          "The memory store and its flows replace the old memory helpers.",
          "guided"
        ],
        [
          "@smthrs/scorers",
          "@smthrs/scorers, @smthrs/evals",
          "@smthrs/scorers, @smthrs/evals",
          "Scorer, Binding, and Runner replace the scorer helpers, and a judge becomes an eval suite.",
          "guided"
        ],
        [
          "@smthrs/openapi",
          "The std flows bound through StandardFlows",
          "@smthrs/std, @smthrs/agent/StandardFlows",
          "An OpenAPI tool becomes a flow in the host catalog.",
          "guided"
        ],
        [
          "@smthrs/vcs",
          "@smthrs/jj",
          "@smthrs/jj",
          "Repository access is a host capability, not a facade import.",
          "guided"
        ],
        [
          "@smthrs/errors",
          "The tagged errors each package declares",
          "@smthrs/kernel",
          "There is no single error registry; each failure is a tagged error on the effect that can fail.",
          "guided"
        ],
        [
          "@smthrs/agents",
          "A seat resolved by SeatResolver",
          "@smthrs/agent/SeatResolver",
          "Agent capability helpers have no counterpart; the seat and its route carry the capability.",
          "guided"
        ]
      ]
      const found = families.find(([prefix]) => construct.source.startsWith(prefix))
      if (found !== undefined) return row(construct.name, found[1], found[2], found[3], found[4])
      return row(
        construct.name,
        null,
        null,
        "A removed facade value with no counterpart; the report names the closest composition.",
        "unsafe"
      )
    }
    case "runtime":
    case "component":
      return row(
        construct.name,
        null,
        null,
        "No safe automatic translation; the report names the closest composition.",
        "unsafe"
      )
  }
}

const explicit = new Map(table.map((entry) => [entry.construct, entry]))

/**
 * The components {@link snippet} can build a rewrite for out of a captured hit.
 *
 * Every other component is `guided` however good its target is, because
 * `automatic` is a promise that the tool produces the code, not a claim that
 * the new API exists. `ReviewLoop.run` takes a `produce`, a `review`, and a
 * `revise` effect; the old `<ReviewLoop producer={agent} reviewer={agent}>`
 * names two agents. That is a translation, not a transcription, and the agent
 * makes it under the rule.
 */
const rewritable = new Set([
  "Approval",
  "ApprovalGate",
  "Branch",
  "ContentPipeline",
  "Parallel",
  "Runbook",
  "Sequence",
  "Signal",
  "Task",
  "Timer",
  "WaitForEvent",
  "Workflow"
])

/**
 * Downgrades a component row that claims `automatic` without a rewrite behind
 * it, so the table says what the tool does.
 */
const honest = (entry: MappingRow): MappingRow =>
  entry.class === "automatic" &&
    Constructs.byName(entry.construct)?.kind === "component" &&
    !rewritable.has(entry.construct)
    ? { ...entry, class: "guided" }
    : entry

/**
 * Every mapping row: the explicit table above, plus one generated row for each
 * catalog construct the table does not name. Sorted by construct so a
 * generated document is stable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const rows: ReadonlyArray<MappingRow> = [
  ...table,
  ...Constructs.constructs
    .filter((construct) => !explicit.has(construct.name))
    .map(familyRow)
].map(honest).sort(Sort.by((entry: MappingRow) => entry.construct))

const index = new Map(rows.map((entry) => [entry.construct, entry]))

/**
 * Looks a mapping row up by construct name.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const byConstruct = (construct: string): MappingRow | undefined => index.get(construct)

/**
 * Looks a mapping row up for an imported name, falling back to the row for the
 * subpath it is exported from.
 *
 * `smithers-orchestrator/gateway-react` exports 79 hooks and
 * `smithers-orchestrator/ui` exports 357 components. The mapping table names
 * the subpath once rather than every name under it, so `useGatewayRun` resolves
 * to the `smthrs/gateway-react` row. A name that resolves to neither is a name
 * the catalog does not know, and `Detect` reports it as `uncatalogued-import`.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const byImport = (name: string): MappingRow | undefined => {
  const direct = index.get(name)
  if (direct !== undefined) return direct
  const subpath = Constructs.subpathOf.get(name)
  return subpath === undefined ? undefined : index.get(subpath)
}

const escalations: ReadonlyArray<{
  readonly construct: string
  readonly props: ReadonlyArray<string>
  readonly to: MappingClass
  readonly reason: string
  readonly when?: (hit: InventoryEntry) => boolean
}> = [
  {
    construct: "Task",
    props: ["hijack", "onHijackExit"],
    to: "unsafe",
    reason: "hijack has no counterpart: there is no way to take a running step over"
  },
  {
    construct: "Task",
    props: ["sideEffect", "revert", "idempotent"],
    to: "guided",
    reason: "effect tiers and compensation handlers replace the side-effect props and need a decision per step"
  },
  {
    construct: "Task",
    props: ["cache"],
    to: "guided",
    reason: "a sealed content key replaces the TTL cache; TTL and scope have no counterpart"
  },
  {
    construct: "Task",
    props: ["memory", "scorers", "groundTruth", "context"],
    to: "guided",
    reason: "memory, scorers, and context move to their own packages and bind at the host"
  },
  {
    construct: "Task",
    props: ["fork", "bind", "async", "priority", "failurePolicy", "continueOnFail", "repair", "depsOptional"],
    to: "guided",
    reason: "graph-level scheduling and failure policy have no plan-level counterpart"
  },
  {
    construct: "Parallel",
    props: ["maxConcurrency", "subtreeConcurrency", "priority", "failurePolicy"],
    to: "guided",
    reason: "bounded dynamic concurrency and priority have no plan-level target"
  },
  {
    construct: "Parallel",
    props: ["skipIf"],
    to: "guided",
    reason:
      "a skipped group becomes an explicit `Node.branch`, so the predicate has to be rewritten against the planned value"
  },
  {
    construct: "Sequence",
    props: ["failurePolicy", "skipIf"],
    to: "guided",
    reason: "failure policy has no plan-level counterpart"
  },
  {
    construct: "Loop",
    props: ["continueAsNewEvery"],
    to: "guided",
    reason: "hand off with `<flow>.to(payload)` in @smthrs/flow; the lineage's `maxRounds` bounds the chain"
  },
  {
    construct: "Loop",
    props: ["maxIterations"],
    to: "guided",
    reason: "an unbounded loop cannot become bounded recursion; the migration has to choose a fuel",
    when: (hit) => hit.detail?.["maxIterations"] === "Infinity"
  },
  {
    construct: "Ralph",
    props: ["maxIterations"],
    to: "guided",
    reason: "an unbounded loop cannot become bounded recursion; the migration has to choose a fuel",
    when: (hit) => hit.detail?.["maxIterations"] === "Infinity"
  },
  {
    construct: "Approval",
    props: ["allowedUsers", "allowedScopes"],
    to: "guided",
    reason:
      "allowedUsers and allowedScopes have no decorator fields; the operator must supply an approval flow that preserves the restrictions"
  },
  {
    construct: "Approval",
    props: ["mode", "options"],
    to: "guided",
    reason: "select and rank approvals have no decorator form",
    when: (hit) => hit.detail?.["mode"] !== undefined || hit.props.includes("options")
  },
  {
    construct: "Timer",
    props: ["until", "every"],
    to: "guided",
    reason: "`until` needs a durable clock and `every` is a trigger, not a flow node"
  }
]

const order: Record<MappingClass, number> = { automatic: 0, guided: 1, unsafe: 2 }

/**
 * The class of one hit, and why it is not the table's class when it is not.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const classifyWithReason = (
  hit: InventoryEntry,
  parse: typeof Ts.parse = Ts.parse
): { readonly class: MappingClass; readonly reason: string | undefined } => {
  const base = byConstruct(hit.construct)?.class ?? "unsafe"
  let result: MappingClass = base
  const reasons: Array<string> = []
  for (const escalation of escalations) {
    if (escalation.construct !== hit.construct) continue
    if (!escalation.props.some((prop) => hit.props.includes(prop))) continue
    if (escalation.when !== undefined && !escalation.when(hit)) continue
    // An escalation at the table's own class still explains itself: `<Loop>` is
    // guided either way, but `maxIterations={Infinity}` is why this one is.
    if (order[escalation.to] < order[base]) continue
    if (order[escalation.to] > order[result]) result = escalation.to
    reasons.push(escalation.reason)
  }
  // Amendment 1: `automatic` means mechanical given the captured source. A
  // component whose snippet cannot be built from this hit's own text is not
  // mechanical, whatever the table says, so it becomes a guided decision.
  if (result === "automatic" && needsSnippet(hit.construct) && snippet(hit, parse) === undefined) {
    return {
      class: "guided",
      reason: [
        ...reasons,
        Constructs.byName(hit.construct)?.kind === "cli"
          ? "the captured invocation has no verified automatic rewrite; map it under the rule"
          : "the source this rewrite needs was not captured, so the agent writes it under the rule"
      ].join("; ")
    }
  }

  return { class: result, reason: reasons.length === 0 ? undefined : reasons.join("; ") }
}

/**
 * Whether an `automatic` class for this construct is a claim that
 * {@link snippet} emits the rewrite.
 *
 * A pragma or config file is automatic because a machine deletes or renames
 * it. A component or CLI invocation is automatic only when the checked
 * rewrite text exists for that captured source.
 */
const needsSnippet = (construct: string): boolean =>
  ["component", "cli"].includes(Constructs.byName(construct)?.kind ?? "") || construct === "createSmithers"

/**
 * The class of one hit.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const classify = (hit: InventoryEntry, parse: typeof Ts.parse = Ts.parse): MappingClass =>
  classifyWithReason(hit, parse).class

const identifier = (value: string | undefined, fallback: string): string => {
  const cleaned = (value ?? fallback).replace(/[^A-Za-z0-9]+/g, " ").trim()
  if (cleaned === "") return fallback
  const named = cleaned
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
  // An identifier cannot start with a digit; the fallback is the noun the
  // name stands for, so `1st` becomes `Step1st` rather than a syntax error.
  return /^\d/.test(named) ? `${fallback}${named}` : named
}

/**
 * Whether two of the ids would print as the same identifier.
 *
 * `identifier` folds punctuation away, so `a-b` and `a_b` both read `AB`. A
 * group whose steps collide would declare one name twice, and a rewrite that
 * does not compile is not a rewrite; the group becomes a guided decision.
 */
const collide = (ids: ReadonlyArray<string>): boolean =>
  new Set(ids.map((id) => identifier(id, "Step"))).size !== new Set(ids).size

/** A property key as TypeScript spells it: bare when it can be, quoted otherwise. */
const propertyKey = (key: string): string => /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)

const tagOf = (hit: InventoryEntry, id: string): string => {
  const flow = hit.file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "flow"
  return `${flow}/${id}`
}

/** Re-indents a multi-line value so it lines up inside an object literal. */
const indented = (value: string, pad: string): string => value.split("\n").join(`\n${pad}`)

/**
 * The catalog components the inventory recorded under one detail key, as
 * `Construct:id` pairs.
 *
 * `undefined` when the group holds a child the source did not name with a
 * string literal. The rewrite names each step after the id the source gave it,
 * and a group holding one step this function cannot name is a group it must not
 * print at all: printing the rest would silently drop a step, and inventing a
 * name would put an identifier in the output that is in no source file.
 */
const namedChildren = (
  hit: InventoryEntry,
  key = "childConstructs"
): ReadonlyArray<{ readonly construct: string; readonly id: string }> | undefined => {
  const text = hit.detail?.[key]
  if (text === undefined || text === "") return []
  const children: Array<{ construct: string; id: string }> = []
  for (const pair of text.split(",")) {
    const [construct, id] = pair.split(":")
    if (construct === undefined || id === undefined || id === "") return undefined
    children.push({ construct, id })
  }
  return children
}

/**
 * The payload each named child step reads, by id, as the source wrote it.
 *
 * `undefined` when the group recorded none, and a `null` value for a child
 * whose payload the inventory could not resolve.
 */
const childPayloads = (
  hit: InventoryEntry,
  key = "childPayloads"
): Record<string, Record<string, string> | null> | undefined => {
  const text = hit.detail?.[key]
  if (text === undefined) return undefined
  return JSON.parse(text) as Record<string, Record<string, string> | null>
}

/**
 * The zod chain each named child step declares as its output, by id.
 *
 * `undefined` when the group recorded none, and a `null` value for a child
 * whose `output` prop resolved to no chain.
 */
const childOutputs = (hit: InventoryEntry): Record<string, string | null> | undefined => {
  const text = hit.detail?.["childOutputs"]
  if (text === undefined) return undefined
  return JSON.parse(text) as Record<string, string | null>
}

/** The words a binding may not be named, because JavaScript already uses them. */
const reserved = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield"
])

/**
 * The local name one step's answer is bound to inside the chain.
 *
 * A step the source called `break` would otherwise become `(break) =>`, which
 * is a syntax error, so a reserved word gains a suffix. The name still comes
 * from the id the source wrote.
 */
const binding = (id: string): string => {
  const name = identifier(id, "Step")
  const lower = `${name.charAt(0).toLowerCase()}${name.slice(1)}`
  return reserved.has(lower) ? `${lower}Value` : lower
}

/**
 * One step's call arguments, from the expressions the source wrote behind its
 * payload, rewritten into the names the flow body has in scope.
 *
 * `ctx.input.<field>` is the flow's own payload. `deps.<id>.<field>` is an
 * earlier step's answer, and it is only in scope when that step is the one this
 * call is chained onto. Anything else, and any payload the inventory could not
 * resolve, returns `undefined`, which makes the whole group a guided decision.
 */
const callArguments = (
  payloads: Record<string, Record<string, string> | null> | undefined,
  id: string,
  inScope: ReadonlyArray<string>
): string | undefined => {
  const sources = payloads?.[id]
  if (sources === undefined || sources === null) return undefined
  const entries: Array<string> = []
  for (const [key, expression] of Object.entries(sources).sort(([left], [right]) => (left < right ? -1 : 1))) {
    const parts = expression.split(".")
    if (parts.length === 3 && parts[0] === "ctx" && parts[1] === "input") {
      entries.push(`${key}: payload.${parts[2]}`)
      continue
    }
    if (parts.length === 3 && parts[0] === "deps" && inScope.includes(parts[1] ?? "")) {
      entries.push(`${key}: ${binding(parts[1] as string)}.${parts[2]}`)
      continue
    }
    return undefined
  }
  return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`
}

/**
 * The `payload` text for a step, from the zod chain the inventory resolved
 * behind each value the step reads.
 *
 * `undefined` when the inventory could not resolve them, or when one of them
 * falls outside the safe zod subset. A payload this function cannot print is a
 * payload the tool must not guess, so the hit becomes a guided decision.
 */
const payloadOf = (raw: string | undefined, parse: typeof Ts.parse): string | undefined => {
  if (raw === undefined) return undefined
  const record = JSON.parse(raw) as Record<string, string>
  // A payload key is a struct field, so a default or an optional on the
  // chain is part of the field and printed as such.
  const entries = Object.entries(record).map(([key, chain]) => [key, ZodSchemaHints.printField(chain, parse)] as const)
  if (entries.some(([, printed]) => printed === undefined)) return undefined
  if (entries.length === 0) return "{}"
  return `{\n${
    entries.map(([key, printed]) => `  ${propertyKey(key)}: ${indented(printed as string, "  ")}`).join(",\n")
  }\n}`
}

/**
 * One step call per child, threaded left to right the way a sequence runs.
 *
 * Every call carries the payload keys that step declares, filled from the flow
 * payload or from the step it is chained onto. `undefined` when any of them
 * cannot be filled from the captured source, or when a step reads a value only
 * an earlier link in the chain still has: a `Node.bindPlanned` binds one value, so
 * a step three links down cannot see the first step's answer, and a rewrite
 * that pretended otherwise would not compile.
 */
const sequenced = (
  children: ReadonlyArray<{ readonly id: string }>,
  payloads: Record<string, Record<string, string> | null> | undefined
): string | undefined => {
  const [first, ...rest] = children as [{ id: string }, ...Array<{ id: string }>]
  if (collide(children.map((child) => child.id))) return undefined
  const head = callArguments(payloads, first.id, [])
  if (head === undefined) return undefined
  let text = `${identifier(first.id, "Step")}.call(${head})`
  let previous = first.id
  for (const child of rest) {
    const args = callArguments(payloads, child.id, [previous])
    if (args === undefined) return undefined
    text = `${text}.pipe(Node.bindPlanned((${binding(previous)}) => ${identifier(child.id, "Step")}.call(${args})))`
    previous = child.id
  }
  return text
}

/**
 * The rewrite text for one hit, built from the source the inventory captured.
 *
 * `automatic` means mechanical *given the captured source*. Every identifier in
 * the returned text comes from this hit: the tag from the element's own `name`
 * or `id`, the schema from the zod chain the `output` prop resolves to, the
 * handler from the element's own children, the step names from the element's
 * own child tasks. The function invents nothing. When a piece it needs was not
 * captured it returns `undefined`, and {@link classifyWithReason} then treats
 * the hit as `guided` so the agent rewrites it under the rule instead.
 *
 * There is no seat literal here and no default model id. A seat appears only
 * when the source names a provider and a model, and `SeatResolver` supplies the
 * rest at run time.
 *
 * @category combinators
 * @since 1.0.0-rc.0
 */
export const snippet = (hit: InventoryEntry, parse: typeof Ts.parse = Ts.parse): string | undefined => {
  const detail = hit.detail ?? {}
  switch (hit.construct) {
    case "Task": {
      const id = detail["id"]
      if (id === undefined) return undefined
      const tag = tagOf(hit, id)
      const name = identifier(id, "Step")
      const success = detail["outputChain"] === undefined
        ? undefined
        : ZodSchemaHints.print(detail["outputChain"], parse)
      const payload = payloadOf(detail["payloadFields"], parse)
      if (success === undefined || payload === undefined) return undefined

      if (hit.props.includes("agent")) {
        const prompt = detail["promptText"]
        if (prompt === undefined) return undefined
        const lines = [`export const ${name} = AgentAction.make(${JSON.stringify(tag)}, {`]
        lines.push(`  payload: ${indented(payload, "  ")},`)
        lines.push(`  output: ${indented(success, "  ")},`)
        // A seat appears only when the source itself names the provider and the
        // model. There is no default seat: the SeatResolver supplies one when
        // the source did not.
        const provider = detail["agentProvider"]
        const model = detail["agentModel"]
        if (provider !== undefined && model !== undefined) {
          lines.push(`  seat: ${JSON.stringify(`${provider}:${model}`)},`)
        }
        const instructions = detail["agentInstructions"]
        if (instructions !== undefined) lines.push(`  system: [${JSON.stringify(instructions)}],`)
        lines.push(`  prompt: (payload) => \`${PromptHints.print(prompt)}\``)
        lines.push("})")
        return lines.join("\n")
      }

      const body = detail["children"]
      if (body === undefined) return undefined
      const lines = [
        `export const ${name} = Action.make(${JSON.stringify(tag)}, {`,
        `  payload: ${indented(payload, "  ")},`,
        `  success: ${indented(success, "  ")}`,
        "})",
        `export const ${name}Layer = ${name}.toLayer(${body})`
      ]
      // `retries` is not printed here. `WithRetry.retryEffect` wraps the
      // effect the layer runs, and that effect is the body above, which this
      // function has as text and not as a binding. A line naming a variable
      // that does not exist is not a rewrite; the retry count reaches the agent
      // through the mapping row's rule instead.
      return lines.join("\n")
    }
    case "Workflow": {
      const name = detail["name"]
      const chain = detail["payloadChain"]
      const payload = chain === undefined ? undefined : ZodSchemaHints.print(chain, parse)
      const steps = namedChildren(hit)
      if (name === undefined || payload === undefined || steps === undefined || steps.length === 0) return undefined
      const body = sequenced(steps, childPayloads(hit))
      if (body === undefined) return undefined
      // The flow answers with what its last step declares. Without that chain
      // there is no `success` and no descriptor `output`, and a schema the tool
      // guessed would be exactly the drift a guided rewrite avoids.
      const last = steps[steps.length - 1]?.id
      const declared = last === undefined ? undefined : childOutputs(hit)?.[last]
      const success = declared === undefined || declared === null ? undefined : ZodSchemaHints.print(declared, parse)
      if (success === undefined) return undefined
      const agents = (detail["childAgents"] ?? "").split(",").filter((id) => id !== "")
      // One declaration: the flow the engine runs IS what the registry admits.
      // Discovery tokenizes the literal `export default Flow.make(` and reads
      // the `description`, `capabilities` and `effects` literals out of the
      // options object without evaluating the module, and the loader hands the
      // default export to the engine, so there is one contract and one body.
      const lines = [
        `export default Flow.make(${JSON.stringify(name)}, {`,
        // The `description` a catalog lists the flow by. It comes from the
        // `// smithers-description:` or `// smithers-display-name:` header the
        // 0.x pack files carry, or from the workflow's own name.
        `  description: ${JSON.stringify(detail["description"] ?? name)},`,
        "  capabilities: [],",
        // The tightest envelope flows has: a step may narrow `hermetic`/`sealed`
        // but never widen it, so a migrated flow that really reads or writes
        // fails the envelope check instead of silently claiming the right.
        "  effects: { reads: [], writes: [], mode: \"hermetic\", onConflict: \"serialize\", tier: \"sealed\" },",
        `  payload: ${indented(payload, "  ")},`,
        `  success: ${indented(success, "  ")},`
      ]
      // A flow whose steps are all compute steps cannot fail with an agent
      // failure, so it does not declare one.
      if (agents.length > 0) lines.push("  error: AgentAction.AgentFailure,")
      lines.push(`  body: (payload) => ${indented(body, "  ")}`)
      lines.push("})")
      return lines.join("\n")
    }
    case "Sequence":
    case "ContentPipeline":
    case "Runbook": {
      const children = namedChildren(hit)
      if (children === undefined || children.length < 2) return undefined
      return sequenced(children, childPayloads(hit))
    }
    case "Parallel": {
      const children = namedChildren(hit)
      if (children === undefined || children.length === 0) return undefined
      const payloads = childPayloads(hit)
      if (collide(children.map((child) => child.id))) return undefined
      const entries: Array<string> = []
      for (const child of children) {
        // Nothing is in scope but the flow payload: the branches of a
        // `Node.all` run beside each other, so none of them can read another's
        // answer.
        const args = callArguments(payloads, child.id, [])
        if (args === undefined) return undefined
        entries.push(`  ${propertyKey(child.id)}: ${identifier(child.id, "Step")}.call(${args})`)
      }
      return `Node.all({\n${entries.join(",\n")}\n})`
    }
    case "Branch": {
      const predicate = detail["if"]
      const then = namedChildren(hit, "thenConstructs")
      const otherwise = namedChildren(hit, "elseConstructs")
      if (predicate === undefined || then === undefined || otherwise === undefined || then.length !== 1) {
        return undefined
      }
      const first = then[0] as { id: string }
      const thenArguments = callArguments(childPayloads(hit, "thenPayloads"), first.id, [])
      if (thenArguments === undefined) return undefined
      const elseStep = otherwise.length === 1 ? (otherwise[0] as { id: string }) : undefined
      const elseArguments = elseStep === undefined
        ? undefined
        : callArguments(childPayloads(hit, "elsePayloads"), elseStep.id, [])
      if (elseStep !== undefined && elseArguments === undefined) return undefined
      if (elseStep !== undefined && collide([first.id, elseStep.id])) return undefined
      const lines = [
        "Node.succeed(payload).pipe(Node.branch({",
        `  if: (value) => ${predicate},`,
        `  then: () => ${identifier(first.id, "Step")}.call(${thenArguments})${elseStep === undefined ? "" : ","}`
      ]
      if (elseStep !== undefined) {
        lines.push(`  else: () => ${identifier(elseStep.id, "Step")}.call(${elseArguments})`)
      }
      lines.push("}))")
      return lines.join("\n")
    }
    case "Timer": {
      // The attribute text is a string literal's content or an expression's
      // source, and the two are told apart by what they are: a number is a
      // count of milliseconds, a duration phrase is one Effect reads, and
      // anything else names a value only the source knows.
      const duration = detail["duration"]
      if (duration === undefined) return undefined
      const literal = /^\d+(?:\.\d+)?$/.test(duration.trim())
        ? duration.trim()
        : /^\d+(?:\.\d+)?\s*(?:nanos?|micros?|millis?|milliseconds?|seconds?|minutes?|hours?|days?|weeks?|ms|s|m|h|d|w)$/i
            .test(duration.trim())
        ? JSON.stringify(duration.trim())
        : undefined
      if (literal === undefined) return undefined
      return `Sleep.action.call({ name: ${JSON.stringify(detail["id"] ?? "wait")}, duration: ${literal} })`
    }
    case "WaitForEvent":
    case "Signal": {
      const event = detail["event"] ?? detail["correlationId"]
      if (event === undefined) return undefined
      return `WaitFor.action.call({ name: ${JSON.stringify(event)} })`
    }
    case "Approval":
    case "ApprovalGate": {
      if (hit.props.includes("allowedUsers") || hit.props.includes("allowedScopes")) return undefined
      const reason = detail["request"] ?? detail["reason"]
      if (reason === undefined) return undefined
      return `WithApproval.withApproval(inner, { reason: ${JSON.stringify(reason)}, approval })`
    }
    case "close":
      return "// the host layer owns the store lifecycle; delete this call"
    case "outputs.<key>":
    case "tables.<key>":
      return "// the planned value is already in scope; delete the output-table read"
    case "runWorkflow":
      return "await Effect.runPromise(flow.execute(payload, { executionId: \"run-1\" }).pipe(Effect.orDie, Effect.provide(layer)))"
    default: {
      if (hit.construct.startsWith("ctx.")) {
        const row = byConstruct(hit.construct)
        return row?.class === "automatic"
          ? "// the flow payload and the planned values are already in scope; read this from them"
          : undefined
      }
      if (hit.construct === "smithers up" || hit.construct === "smithers workflow") {
        const command = detail["command"]
        if (command === undefined) return undefined
        const rewritten = CliScripts.rewrite(command, FlowNames.fromPath)
        return rewritten.unsupported === undefined && rewritten.after !== command ? rewritten.after : undefined
      }
      return undefined
    }
  }
}

const cell = (value: string | null): string => (value === null ? "none" : `\`${value.replaceAll("|", "\\|")}\``)

/**
 * Renders {@link rows} as a Markdown table.
 *
 * The reference page embeds this text verbatim and `test/Docs.test.ts` asserts
 * the two match, so a new construct cannot land without its documented target.
 * The output is deterministic: `rows` is sorted by construct name and the
 * renderer touches nothing else.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const markdownTable = (): string => {
  const lines = [
    "| Old construct | New target | Module | Class |",
    "| --- | --- | --- | --- |",
    ...rows.map((entry) =>
      `| ${cell(entry.construct)} | ${cell(entry.target)} | ${cell(entry.targetModule)} | ${entry.class} |`
    )
  ]
  return lines.join("\n")
}

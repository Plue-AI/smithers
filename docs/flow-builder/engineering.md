# Flow Builder & Monitor — Engineering

Stage: **vision ruled (decisions.md D-029); codebase survey done.** Most of this
is re-lighting, not building. Two genuinely new pieces: the plan-graph
projection (D-020) and the duration predictor (D-030).

## One sentence (placeholder)
> PENDING — one sentence describing how it is built.

---

## Ground truth — the authoring side

- `Flow.make(tag, { description, payload, success, capabilities, effects, body })` is
  already a declarative manifest — `flows/coding/flow.ts:5`.
- `Action.make(name, { payload, success, error, nondeterministic })` and
  `AgentAction.make(...)` give every node a typed payload/success/error contract
  — `flows/coding/atoms.ts:12`.
- `effects: { reads, writes, mode, onConflict, tier }` means the graph already
  carries side-effect tiers (`"irreversible"`) a canvas can render.
- Control flow is explicit and DAG-shaped. From `flows/create-flow/design/flow.mdx`:
  "`Node.andThen` sequences, `Node.all` fans out, `Node.branch` decides with both
  arms present in the plan … Never write a loop as a recursive body: a plan is a
  DAG." That doctrine is what makes a canvas projection possible at all.
- The authored artifact is **TypeScript on disk** at `flows/<name>/flow.ts`,
  written by the `create-workflow` flow running inside the workspace VM.
  `flow.create` in the app does not write a file; it launches that flow
  (`apps/app/src/mainview/state/controller/workflows.ts:422`).
- MCP tools are already projected as ordinary flow bindings on the engine side —
  `packages/smithers/mcp/src/McpFlows.ts`. The app has zero MCP imports; an MCP
  tool reaches the UI only as a catalog flow. A canvas gets MCP for free.

## Ground truth — the UI side

The product UI is `apps/app` (React 19 + Vite; `apps/ui` is empty and
the CHANGELOG reference to it is stale). No router — navigation is frames over
`history.state`. All application state lives in TanStack DB collections persisted
to SQLite; **React components are projections, never authorities**, and
`useEffect` is banned in application code (`apps/app/AGENTS.md`).

**A monitor already exists.** `apps/app/src/mainview/cards/RunTraceCard.tsx` (797
lines) renders two views off the journal: a turns view (step list + per-turn rows
with call chips and durations) and a timeline view with a phase strip on a time
axis, filter chips, a span tree, a **waterfall** (`waterfallGeometry`), a span
detail pane and a child-run door. The model is
`apps/app/src/mainview/cards/RunTrace.ts` — `SpanKind = "run" | "frame" | "model"
| "cell" | "call" | "approval" | "resolved" | "event" | "fork" | "execution" |
"attempt"`, folded by `traceFromJournal`.

**What is missing is the graph view and the ability to act on a node.** Not the
timeline, not the event model, not the card shell.

### The deleted canvas — re-light, do not rebuild

`jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx` — 452
lines of React Flow + dagre, retired in the local-backend retirement
(`apps/app/docs/LOCAL-BACKEND-RETIREMENT.md`). It had left-to-right dagre layout
(`layoutTargetGraph`), deps ∪ rdeps focus highlighting, critical-edge marking, a
node drawer, a run-status overlay, and **all view state in the card payload**.
`RunTimelineCard.tsx` alongside it was a Gantt with a replay scrubber.

Still present today:
- `@xyflow/react ^12.11.6` and `dagre ^0.8.5` in `apps/app/package.json:56-57`,
  installed and unimported.
- `styles/DeadCss.test.ts:22` still whitelists the `react-flow` CSS prefix.
- Card kinds `graph` and `run-timeline` still exist in the wire schema
  (`packages/rpc/src/Cards.ts:2158-2220`) but route to a retired family that
  renders `null`.
- `@smthrs/ui` ships a **renderer-neutral workflow canvas anatomy** built for
  exactly this: `packages/smithers/ui/src/canvas/WorkflowCanvas.tsx` (413 lines)
  exporting `WorkflowCanvas`, `WorkflowNode`, `WorkflowNodeHeader/Content/Status`,
  `WorkflowEdge`, `WorkflowConnection`, `WorkflowControls`, `WorkflowPanel`,
  `WorkflowToolbar`, `WorkflowMinimap`. Its doc: "the visual language a graph
  renderer (a ReactFlow layer, for example) composes … `@xyflow/react` never
  enters this package." ARIA roving-tabindex and non-colour status glyphs are
  already solved there.

So the canvas is roughly: one card body, one dagre layout function lifted from
history, and the existing `@smthrs/ui` anatomy.

### The transport problem — the real engineering gate

The run monitor **polls**. `apps/app/src/mainview/state/controller/workflow-pump.ts`
re-reads run summary, transcript, approvals and pages journal events every
`RUN_POLL_MS` (default **2500 ms**, `controller/context.ts:175`).

Every engine call is a relayed POST to `/api/workflow/rpc` through
`createGatewaySeam` (`state/controller/gateway.ts:147`) with a server-side
allowlist (`packages/backend/internal/compose/browser_flow.go` `browserFlowProcedures`):

```
Plan, Run, Cancel, Resume, Steer, Signal, List  → /rpc
Projection.Snapshot, Approval.Submit            → /projections
```

and an explicit exclusion: "The two streaming procedures (`Watch`,
`Projection.Subscribe`) are deliberately absent … a stream belongs on the
gateway's separately authenticated WebSocket mounts."

Temporal's stated property is *liveness* — "the Workflow updates in real-time."
A 2.5 s poll will read as laggy on a graph where nodes light up. **Deciding
whether the graph ships on the existing poll or requires opening the streaming
mounts is decision D-013, and it gates the design doc's liveness claims.**

Existing steering verbs are already in the allowlist and are what a node's
context menu would call: `cancel`, `resume`, `signal`, `steer({ kind: "Message" |
"Seat" | "Thinking" | "Tools" })`, `submitApproval`, `nodeOutput(repo, runId,
nodeId)`. Note `nodeOutput` already exists — per-node inspection is wired.

### The sandbox — where the first version lives

`apps/app/src/mainview/experimental/` is a registry of hidden mock panes behind
`VITE_SMITHERS_EXPERIMENTAL`. Contract: `{ id, title, summary, packages,
render({ props, fullscreen, onRunCommand }) }`; registry at `Registry.ts:43`;
flows are generated from the registry (`flows/entries/experimental.ts:30`); one
card kind serves all of them (`Cards.ts:2474`).

Panes already reserved and still saying **"Not drawn yet."**: `panes/Plan.tsx`
("The keyed action graph, its step keys and the diff between revisions"),
`panes/Flows.tsx`, `panes/CellLoop.tsx`, `panes/TimeTravel.tsx`,
`panes/StepCache.tsx`, `panes/Projections.tsx`.

Cost of a first canvas: **one file under `experimental/panes/`, one line in
`Registry.ts`.** Nothing else changes and it stays invisible without the flag.

## Constraints that bind any design here

- **THE EMBED LAW** — everything embeds in the chat; full-screen is a
  presentation transition of the same embedded component, never a separate
  screen.
- **THE THREE-DOOR LAW** — anything a button does, the agent can do; every act is
  one flow with a slash door, a button door and an agent door.
- **THE FORM LAW** — a flow invoked without required input renders a form card
  for exactly the missing fields.
- No `useEffect`; no component-owned state. Canvas view state (zoom, focus,
  filter, selection) goes in the **card payload**, as `GraphCard` already did via
  `target.graph.filter` / `target.graph.focus`.
- Adding a card kind widens the `Card` union; TanStack DB type inference gives up
  past 30 union members (`state/useCardRows.ts`). Prefer reviving the retired
  `graph` kind over minting a new one.

## Open
- D-003 — how a canvas edit becomes a TypeScript edit.
- D-013 — poll vs. stream.
- Whether the graph is a new card kind or a `traceView: "graph"` on `run-trace`.

---

## Ground truth — the engine (round 2 survey)

### The canvas data source already exists and is pure

`Graph.build(flowOrNode, payload, options)` — `flows/flow/src/Graph.ts:852` — does
**no I/O** and returns:

```ts
interface Graph {
  readonly nodes: ReadonlyArray<GraphNode>
  readonly edges: ReadonlyArray<Edge>
  readonly diagnostics: ReadonlyArray<GraphBuildError>
}
interface Edge { readonly from: string; readonly to: string; readonly reason: EdgeReason }
type EdgeReason = "value" | "continuation" | "failure"
interface GraphNode {
  readonly id: string
  readonly kind: Node.Ast["_tag"]          // Succeed | All | Map | AndThen | Branch | Catch | FlowCall | ActionCall
  readonly dependencies: ReadonlyArray<string>
  readonly capabilities: ReadonlyArray<string>
  readonly placement: unknown
  readonly draft: Plan.NodeDraft
  readonly ast: Node.Ast
  readonly payload: unknown                 // hydrated: real data, Planned placeholders where a step result goes
}
```

Three edge reasons → three link styles. `diagnostics` is the inline error list;
a graph with diagnostics is inspectable but not compilable (`Graph.drafts` throws
the first one). `examples/src/17-review-loop.ts:95` (`declaredCalls`) is the
already-written static-analysis pattern: build the graph and count its nodes
before anything runs.

### Node ports come from schemas

`Action.Declared` carries `payloadSchema`, `successSchema`, `errorSchema` as
`effect/Schema` values, and `Schema.toJsonSchemaDocument` is already used for
identity (`Graph.ts:181`). `.smithers/factory.json` already ships an
`inputSchema` per flow, so the **node palette and the property panel are
generated, not authored**. `Action.PlannedPayload<T>` is the wiring model: a
downstream payload field holds either literal data or a `Planned` reference to an
upstream node's result — that is the connect-a-port affordance, already typed.

### The persisted graph

```sql
flows_plans       (plan_id, flow, base_digest, digest, generation, created_at_ms)
flows_plan_nodes  (plan_id, node_id, generation, ordinal, kind, key_digest, node_json)
flows_plan_edges  (plan_id, from_node, to_node)
```
`plan/src/internal/migrations/0001_initial.ts:31-55`, with triggers
`flows_plan_nodes_append_only`, `..._no_delete`, and `flows_plans_forward_only`
("a plan only grows"). `node_json` is a `Plan.PlanNode` carrying `key`,
`material`, `effects`, `dependsOn`, `conflicts`, `strategy`, `runtime`,
`priority`, `generation`.

### Cache state is first class

- Before a run: `ControlSchema.PlanNodeStatus = ["cached", "run"]`
  (`control/src/ControlSchema.ts:198`) on each plan-card node.
- During: `PlanScheduler.Settlement.outcome ∈ { "built" | "clean" | "failed" |
  "skipped" | "deferred" }` (`engine-store/src/PlanScheduler.ts:125`). `"clean"`
  is the cache-hit badge.
- Invalidation doctrine (`plan/src/Plan.ts:4-12`): "A node's key is a function of
  what it consumes, so an edited declaration re-keys that node and everything
  downstream of it, and nothing else. That is the entire invalidation mechanism."
- Structural node ids never enter the hash (`StepKey.ts:459-461`): "rename a node
  and nothing re-keys; change what a node consumes and everything downstream of
  it does." **Renaming and repositioning on the canvas are free.**

### THE MISSING PIECE — a plan-graph projection

Seven projections are served (`gateway/src/GatewaySchema.ts:171`):
`workspace-runs`, `run-summary`, `run-events`, `transcript`, `run-tree`,
`approvals`, `node-output`. None carries plan node ids or edges.
`RunTreeRow.nodeId` is "the ordinal the call opened on, because the emitter names
no node" (`GatewayProjection.ts:83-86`).

The real graph lives in `flows_plan_nodes` / `flows_plan_edges` plus the journal
events `flows.engine.node-scheduled` / `node-settled` / `node-invalidated` /
`node-reconciled` (`engine-store/src/internal/JournalRecords.ts:212-248`).

**The work is one row in the `served` table and one fold in `Projections.ts`** —
the selector union, `ProjectionName`, `rowSchemaFor`, and the snapshot/row/delta
frames all derive from that table. The gateway computes projections only from
`Control.list` / `Control.watch` and never opens the engine DB
(`Projections.ts:4-9`), so the fold must come through a control event, not a
direct query. **This is the first engineering task.**

### Liveness is a relay problem, not an engine problem

The gateway already serves `Projection.Subscribe` over `/projections/ws` and
`Watch` over `/rpc/ws`, cursored (`ProjectionCursor`) with snapshot-start / row /
snapshot-end / delta / heartbeat frames and a 30 s heartbeat sized against a
600 s relay idle cut (`GatewaySchema.ts:444`, `Projections.ts:56`). The product
Worker's allowlist excludes both on purpose (`packages/backend/internal/compose/browser_flow.go` `browserFlowProcedures`).
So D-013 is scoped to `apps/server` auth, not to building a stream.

### Human-in-the-loop is already specified

`flows_runs.waiting_request` holds `{task, name, kind, prompt, attempt,
maxAttempts, options?, schema?}` with `kind ∈ ask | confirm | select | json`
(`flows/flow/src/HumanTask.ts:70,505`). `kind` picks the control, `options` fills
a select, `schema` validates the answer. `Approval.Submit` already carries
`decision` plus an optional `answer: Schema.Json` present exactly for a
`HumanTask` gate. Each attempt is its own wait point (`deferred(name, attempt)`),
and the timeout clock is per task, not per attempt.

`ApprovalRow.waitRunId` exists because a `HumanTask` in a nested flow parks a
*different* execution than the one a person opened
(`GatewayProjection.ts:123-131`). A canvas node showing "waiting on you" must
resolve through `DurableEngineState.waitingTree(runId)` (depth cap 64).

### Constraints the canvas must obey

1. **No loop node, ever** (D-017). Repetition is bounded unrolling in the body or
   a `Flow.to()` handoff that opens a new `flows_runs` row with `lineage_id` +
   `round_ordinal`. A loop widget must compile to one of those two.
2. **Both branch arms are in the plan**; `Interpretation.skipped` names the one
   not taken (D-018). Draw both, grey the skipped one.
3. **Three call modes are three different edge semantics**: `.call()` splices the
   callee body into the caller's plan (inline), `.child()` stays a leaf with its
   own child execution (boundary), `.to()` ends the round and names the next
   (handoff) — `flows/flow/src/Flow/make.ts:83-91`.
4. **Editing a node voids approvals bound to the plan digest** (D-022). Show what
   an edit invalidates before committing it.
5. `maximumPlanNodes = 10_000` (`plan/src/Plan.ts:248`); `PlanError.code` includes
   `graph_too_large`, `cycle`, `unknown_dependency`, `overlap_forbidden`.


---

# Production plan (2026-09-18, from a seven-area code map)

Nine lanes: lane 1 turns on the NativeControl plan hook and draws a real PlanCard in a new `flow-plan` card. Live status then folds app-side from the `run-events` pages the pump already reads, once the Interpreter emits node events. The only new gateway surface is a `flow-durations` projection.

## Architecture

**Plan path.** A `Plan` button on a workflow-list row runs the `flow.plan` flow and upserts a pending `flow-plan` card. `gateway.plan()` calls the allowlisted `Plan` RPC through the Worker relay; the payload is opaque, so the relay does not change. `NativeControl.durableFlow.plan` runs `Graph.build`, reads each node's `draft.material` through `Graph.drafts`, and compiles a persisted plan, and `PlanCard.nodes` comes back. The card payload holds `nodes`, and the lazy `FlowGraphSurface` lays them out with dagre and React Flow.

**Run path.**
- `launch` snapshots plan nodes into `run-trace.payload.plan`.
- The Interpreter emits `plan-recorded` (with nodes), `node-scheduled` and `node-settled` through a new `FlowRuntime.recordNode` seam.
- `EngineJournalSupervisor` copies those records as `control.engine.event` envelopes. The `run-events` projection pages them by cursor, and the 2500 ms pump retains them.
- A pure `FlowGraphStatus` fold produces per-node status, rendered when `traceView` is `graph`.
- This adds no new selector, no relay change and no streaming.

**Durations.** A gateway `flow-durations {flowId}` projection folds the last 20 terminal runs into p50/p90 per action tag. The app fetches it once per graph open, and pure `Durations.ts` computes the critical-path ETA.

**Re-key.** The app diffs id/key between the run's plan snapshot and a fresh Plan.

**Triggers.** Control `List triggers` and `List fires` pass through `workflowTriggers.ts` in full and feed a UI-only trigger node.

Selection, drawer tab, follow and view mode live in the card payload and change only through hidden flows.

## Lanes

### L1-skeleton — Walking skeleton: a real PlanCard from a real NativeControl host drawn as a graph in apps/app, behind a dark flag

Depends on: nothing

Files: `packages/smithers/src/internal/NativeControl.ts`, `packages/smithers/test/NativeControlPlan.test.ts (new)`, `apps/app/scripts/gateway-run-proof.ts`, `apps/app/src/mainview/state/controller/gateway.ts`, `apps/app/src/mainview/state/controller/gateway.test.ts`, `apps/app/src/mainview/state/AppController.ts (one AppFeatures line plus one resolve line)`, `packages/rpc/src/Cards.ts (flow-plan kind only)`, `apps/app/src/mainview/cards/FlowGraph.ts (new, pure model and dagre layout)`, `apps/app/src/mainview/cards/FlowGraph.test.ts (new)`, `apps/app/src/mainview/cards/FlowGraphSurface.tsx (new, lazy)`, `apps/app/src/mainview/cards/FlowPlanCard.tsx (new)`, `apps/app/src/mainview/cards/FlowPlanCard.test.tsx (new)`, `apps/app/src/mainview/cards/CardRenderers.tsx (one import, one spread)`, `apps/app/src/mainview/ViewModules.ts`, `apps/app/src/mainview/cards/WorkflowCards.tsx (Plan button)`, `apps/app/src/mainview/flows/entries/flow.ts (flow.plan)`, `apps/app/src/mainview/flows/FlowName.ts`, `apps/app/src/mainview/state/controller/workflows.ts (planFlow handler)`, `apps/app/src/mainview/styles/flow-graph.css (new)`, `apps/app/src/mainview/index.css (one import line)`

Defer all polish; this lane only proves the vertical path.

1. **Engine plan hook.**
   - Give `NativeControl.durableFlow` (:414-424) a `plan` hook.
   - Resolve the Executable for `descriptor.name` lazily through the existing `catalogReady` Deferred (:661). Do not lift the catalog.
   - Graph the delegate's body, not the one-call wrapper (Executable.ts:856-862).
   - Run `Graph.build(flow, decodedInput)`, then `PersistedPlan.compile({planId, flow, nodes: Graph.drafts(graph)})`, copying the recipe at control/test/PlanHandoff.test.ts:33-41. `@smthrs/flow` publishes one `Plan.NodeDraft` per graph node, so the host hands the drafts over as they are.
   - Return `{ plan }` with no `statuses`, so every node reads `run`. No cache probe exists; do not invent `cached`.
   - A body that throws at plan time must degrade to `nodes: []`, not to InvalidInput, so existing flows keep planning.
2. **Proof script.**
   - Diagnose and fix the red `proof:gateway` step 2. `seam.launch` makes three calls (Plan, Approval.Submit, Run); print the refusal it swallows.
   - Correct the docstring from `bun` to `tsx`.
   - Add a step asserting that `seam.plan` returns `nodes.length > 0` with `dependsOn` from a host whose flow record carries the plan hook.
3. **App seam.**
   - Add `gateway.plan(repo, flowId, input, binding)`, which decodes the full PlanCard with the @smthrs/control schema and returns planId, digest, flowId and nodes.
   - Never return or persist the `envelope`.
   - `launch` reuses `plan()`. Its return widens to include nodes; L4 consumes that.
4. **Wire.** Add kind `flow-plan` with payload `{repo, workspaceId?, flowId, input?, status: pending|done|failed, error?, planId?, digest?, nodes?: [{id, kind, key, dependsOn, tier, action?, status}]}`. Leave the retired `graph` kind alone.
5. **Flag.** Removed by D-080 (Will, 2026-09-20): `flow.plan` registers for
   everyone, it is in the agent catalog, and the Plan button renders. The steps
   below are numbered as they were planned.
6. **Flow.** Add visible flow `flow.plan`.
   - Args: `[sourceCard=id] <name> [owner/repo] [JSON object]`.
   - Copy form hints, runtime and requires from `flow.run` (flow.ts:121-140).
   - The handler upserts the card as pending and returns at once, then fills it from `gateway.plan` in the background with the shared toast.
   - Deduplicate by (repo, flowId, input digest). Ignore stale responses. A failure stays on the card with a retry door.
7. **Surface.**
   - `FlowGraph.ts` turns `PlanNode[]` into `{nodes, edges}` plus a dagre LR layout lifted from `jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx:82-158`.
   - `FlowGraphSurface.tsx` renders uncontrolled React Flow with the `fitView` prop only: no `useReactFlow`, no effect. Register it with `viewModule` so xyflow stays out of the main chunk.
   - Every node shows its state as a word.
8. **Card.** `FlowPlanCard` shows the graph, the node count as a number and one `Run` button (the `flow.run` door). Add no prose.

Empty `nodes` renders no graph and no sentence. Write CSS and markup together, because DeadCss fails orphan classes.

**Tests first.** Write these first, failing:
1. `packages/smithers/test/NativeControlPlan.test.ts`: `control.plan` on a registered Interpreter flow returns `nodes.length > 0` with `dependsOn` populated; a flow whose body throws at plan time still plans with `nodes: []`. Pattern: test/fixtures/native-control-portable.ts:58.
2. `gateway.test.ts`:
   - a scripted Plan answer decodes nodes;
   - `nodes: []` is a valid empty graph;
   - a malformed card is a coded refusal;
   - `envelope` is not on the return value.
3. `FlowGraph.test.ts`:
   - a diamond plan yields 4 nodes and 4 edges;
   - layout is deterministic;
   - an unknown `dependsOn` id is dropped, not thrown.
4. `FlowPlanCard.test.tsx`:
   - pending, then done, renders one element per node, each with a state word;
   - `Run` carries `flow.run` args;
   - there is no sentence beside the button.
5. Flag test, pattern KnowledgeFeatures.test.tsx:
   - off: `flow.plan` is unregistered, absent from the catalog, and there is no Plan button;
   - on: all three doors exist.
6. Background-rule test:
   - with an unresolved Plan call the command returns first;
   - chat stays usable;
   - the toast settles with the job;
   - a failure is visible and retryable;
   - a duplicate launch is deduplicated.

Gates:
- `cd packages/smithers/control && pnpm run check && pnpm exec vitest run test/PlanHandoff.test.ts`
- `cd packages/smithers && pnpm exec vitest run test/NativeControlPlan.test.ts --coverage.enabled=false`
- `cd apps/app && pnpm exec tsx scripts/gateway-run-proof.ts` (prints PROOF PASSED)
- `cd packages/rpc && pnpm run check && pnpm run test`
- `cd apps/app && pnpm run check` (compare the failing set against unmodified main)
- `bun test src/mainview/cards/FlowGraph.test.ts src/mainview/cards/FlowPlanCard.test.tsx src/mainview/cards/CardRenderers.test.ts src/mainview/state/controller/gateway.test.ts src/mainview/flows/FlowName.test.ts src/mainview/flows/agent-parity.test.ts src/mainview/flows/parity.test.ts src/mainview/flows/Commands.forms.test.ts src/mainview/Architecture.test.ts src/mainview/styles/DeadCss.test.ts`

**Done when.** - `proof:gateway` is green and its new step shows non-empty plan nodes crossing seam, relay and gateway.
- Clicking Plan on a real flow row draws that flow's real nodes and edges.

### L2-engine-node-events — Engine: the Interpreter journals plan-recorded, node-scheduled and node-settled with plan node ids, action tag and clean outcome

Depends on: nothing

Files: `packages/smithers/flows/flow/src/Interpreter.ts`, `packages/smithers/flows/flow/src/FlowRuntime/FlowRuntime.ts`, `packages/smithers/flows/engine/src/FlowEngine/* (recordNode implementation, replay-hit report)`, `packages/smithers/flows/engine-store/src/internal/JournalRecords.ts (typed payload schemas)`, `packages/smithers/flows/engine-store/src/PlanScheduler.ts (additive `action`, `nodes`)`, `packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts (report replay hit)`, `packages/smithers/flows/journal/src/EngineEvent.ts (node event schemas)`, `packages/smithers/flows/engine-store/test/PlanScheduler.test.ts`, `packages/smithers/flows/flow/test/InterpreterNodeEvents.test.ts (new)`, `packages/smithers/test/EngineJournalSupervisorNodeEvents.test.ts (new)`

1. **Payload schemas.** Export Schema structs for node-scheduled, node-settled, node-invalidated, node-reconciled, plan-recorded and subgraph-appended from flows/journal EngineEvent.ts.
   - They must match today's PlanScheduler shapes exactly (:1048-1057, :966-974, :1036-1043, :987-992, :505-513, :536-542).
   - JournalRecords then takes typed payloads instead of `unknown`.
2. **Additive fields.**
   - Add `action?: string` to node-scheduled and node-settled, from `node.material.body.action ?? body.flow`; omit it for merge nodes.
   - Add `nodes?: [{id, kind, key, dependsOn, tier, effects, generation}]` to plan-recorded and subgraph-appended.
   - Apply both in PlanScheduler too, so both executors share one shape.
3. **Journaling seam.**
   - Add `FlowRuntime.recordNode(record)` beside `scheduleClock`. @smthrs/flow gets no journal dependency.
   - The engine implements it by writing JournalRecords.
   - The in-memory and test runtimes implement it as a no-op.
4. **Interpreter emits** in `interpretWithPolicy`:
   - plan-recorded with nodes after `Graph.build` succeeds. If the encoded envelope would exceed the control journal event bound (ENGINE-JOURNAL-PROJECTION.md:108-110), chunk it as plan-recorded followed by subgraph-appended pages of 200 nodes or fewer.
   - node-scheduled before `compute` in `settleNode` (:454).
   - node-settled in the tap and tapError, with outcome `built` or `failed`.
   - node-settled with outcome `skipped` for every id in `skipped` (:672) after the walk.
5. **Clean outcome.**
   - ActionPersistence (:1759-1778) knows when a replay served a succeeded row. Report that to the node walk through a scoped service or Ref set by Dispatch, as PlanScheduler's `ran` Ref does at :1113.
   - If the node's dispatches all replayed, the outcome is `clean`.
6. **Replay stability.** Use the deterministic sourceId `node/<id>/<attempt>` (PlanScheduler.ts:1048) and `plan/<generation>/<page>`, so a resumed walk deduplicates in the journal.

**Tests first.** Write these first, failing:
1. `InterpreterNodeEvents.test.ts`, over a recording FlowRuntime. A three-node chain must emit one plan-recorded whose `nodes` match `Graph.nodes`, then scheduled and settled(`built`) per node, in dependency order.
   - A failing node emits settled(`failed`), and its dependents emit settled(`skipped`).
   - `action` equals the declared tag.
   - A merge node omits `action`.
2. Replay: run, interrupt, resume. The journal must hold exactly one scheduled/settled pair per (node, attempt).
3. Clean: a second run of the same input over the same stores settles cached nodes with outcome `clean`. Mutation check: remove the replay report and the test must fail.
4. `EngineJournalSupervisorNodeEvents.test.ts` over real SQLite (pattern test/NestedHumanWaitAcrossDatabases.test.ts:209). The control journal must contain `control.engine.event` envelopes with eventType `flows.engine.node-scheduled` and `node-settled` whose `nodeId` values equal the PlanCard node ids.
5. Large plan: a 1000-node plan-recorded is chunked and produces no `invalid_event` gap.
6. `PlanScheduler.test.ts`: records carry `action` and `nodes`.

Gates:
- `cd packages/smithers/flows/flow && pnpm run check && pnpm exec vitest run`
- `cd packages/smithers/flows/engine-store && pnpm exec vitest run test/PlanScheduler.test.ts`
- `cd packages/smithers && pnpm exec vitest run test/EngineJournalSupervisor*.test.ts test/NestedHumanWaitAcrossDatabases.test.ts --coverage.enabled=false`
- Grep time-travel and golden journal fixtures for strict decoders on node events before landing.
- Wrap in `env -i HOME PATH TMPDIR TERM=dumb CI=1` if digest tests go red.

**Done when.** A real Interpreter run through a NativeControl-shaped stack puts node-scheduled and node-settled envelopes into the control journal. They carry the same node ids the Plan RPC returns, exactly once per attempt across a resume, with `clean` on a cached second run.

### L3-gateway-durations — Gateway: the `flow-durations` projection (p50/p90 per action tag over the last 20 terminal runs)

Depends on: L2-engine-node-events

Files: `packages/smithers/gateway/src/GatewaySchema.ts`, `packages/smithers/gateway/src/GatewayProjection.ts`, `packages/smithers/gateway/src/Projections.ts`, `packages/smithers/gateway/src/internal/nodeEvents.ts (new, envelope decode shared with callEvents.ts pattern)`, `packages/smithers/gateway/test/GatewayProjection.test.ts`, `packages/smithers/gateway/test/GatewaySchema.test.ts`, `packages/smithers/gateway/test/WireFormat.test.ts`, `packages/smithers/gateway/test/Projections.test.ts`, `packages/smithers/gateway/test/ProjectionsUnit.test.ts`, `packages/smithers/gateway/docs/concepts/projections.md`, `docs/ (then pnpm docs:llms)`

1. **Row and selector.**
   - Add `FlowDurationRow = {flowId, actionTag, samples, p50Ms, p90Ms}`.
   - Add `FlowDurationsSelector = TaggedStruct("flow-durations", {flowId})` as one entry in the `served` table (GatewaySchema.ts:171-179).
2. **Per-run fold.** Add the pure fold `nodeDurations(events)`.
   - Decode `control.engine.event` envelopes with the guards from internal/callEvents.ts:11-24.
   - Pair each node-settled with outcome `built` to the LAST node-scheduled for the same (executionId, nodeId).
   - Duration is `settled.emittedAtMs - scheduled.emittedAtMs`.
   - Drop negative deltas, and drop failed, clean, skipped and deferred outcomes.
   - Group by `payload.action`. A record with no `action` contributes nothing.
3. **Cross-run fold.** `flowDurations(flowId, samples)` computes nearest-rank p50 and p90. Emit a row only when `samples >= 1`; a flow that never ran answers `[]`.
4. **Source.** In Projections.ts, take `control.list` filtered to flowId, the newest 20 terminal runs, each read through the existing bounded run source.
   - Add a workspace-scoped arm to the fold switch.
   - The projection is snapshot only, has no `after`, and has no Subscribe delta beyond a re-snapshot.
5. **Docs.** Fix the stale docblock at GatewayProjection.ts:400-405. Update the "seven projections" text, then run `pnpm docs:llms`, check-docs and check-llms.

This lane does not add a `plan-graph` selector. Live status uses `run-events` (see the cut line).

**Tests first.** Write these first, failing, in `GatewayProjection.test.ts`. Coverage thresholds are 100%, so cover every guard branch.
- a built node yields one sample;
- a clean node yields none;
- a retried node measures from the last schedule;
- a negative delta is dropped;
- a malformed envelope is ignored;
- a record without `action` is ignored;
- two executions in one run stay separate;
- the p50/p90 nearest-rank values are exact;
- a never-run flow yields `[]`.

Other tests:
- `GatewaySchema.test.ts:51-59`: add a `cases` row.
- `WireFormat.test.ts:196`: copy the row encode assertion.
- `Projections.test.ts`: two real runs of one flow answer `samples: 2` per executed tag.

Gates:
- `cd packages/smithers/gateway && pnpm run check && pnpm exec vitest run test/GatewayProjection.test.ts test/GatewaySchema.test.ts test/ProjectionsUnit.test.ts test/Projections.test.ts test/WireFormat.test.ts && pnpm run coverage`
- `cd ~/smithers-lane-fb-gateway && pnpm docs:llms`, then check-docs and check-llms.

**Done when.** - Snapshotting `{_tag:"flow-durations", flowId}` on a gateway with two finished real runs returns one row per executed action tag with `samples: 2`.
- Coverage stays at 100%.
- The docs checks pass.

### L4-live-run-graph — App: `traceView: graph` on the run-trace card, status folded from run-events, plan snapshot at launch, camera follow

Depends on: L1-skeleton

Files: `apps/app/src/mainview/cards/FlowGraphStatus.ts (new, pure fold)`, `apps/app/src/mainview/cards/FlowGraphStatus.test.ts (new)`, `apps/app/src/mainview/cards/fixtures/GraphRunJournal.json (new, RECORDED from the L8 host, never hand-written)`, `packages/rpc/src/Cards.ts (run-trace: traceView adds graph; optional `plan`, `graph.follow`)`, `apps/app/src/mainview/flows/entries/runs.ts (widen runs.trace.view; add runs.graph.follow)`, `apps/app/src/mainview/state/controller/runs.ts (TraceView; follow handler)`, `apps/app/src/mainview/state/controller/workflows.ts (launch snapshot; carry-over list :283-292)`, `apps/app/src/mainview/flows/FlowName.ts`, `packages/smithers/ui/src/adapters/flow-graph.tsx (new)`, `packages/smithers/ui/package.json`, `apps/app/package.json`, `apps/app/src/mainview/cards/FlowGraphSurface.tsx (becomes thin over the adapter)`, `apps/app/src/mainview/cards/RunTraceCard.tsx (ONE branch plus ONE button, last)`, `apps/app/src/mainview/cards/RunTraceCard.test.tsx`, `apps/app/AGENTS.md (line 45 example repoint)`

1. **Status fold.** `FlowGraphStatus.ts` reuses the Envelope decoder from EngineTrace.ts:9-26 (strict, `onExcessProperty: error`) and folds `run-events` rows into `Map<nodeId, {status, outcome?, attempts, startedAt?, settledAt?, action?}>`.
   - Statuses are pending, running and settled. Outcomes are built, clean, failed, skipped and deferred.
   - plan-recorded or subgraph-appended with `nodes` seeds the node list and edges, for a run launched elsewhere.
   - node-scheduled sets running and the attempt count. node-invalidated keeps running. node-settled sets the outcome.
   - Dedupe on (executionId, generation, sequence). A higher generation for one executionId resets that execution's rows (rewind).
   - A `control.engine.projection-gap` row marks status as unproven, never idle.
   - An unknown eventType still flows into EngineTrace's generic span. Do not edit EngineTrace.ts.
2. **Wire.**
   - `traceView` becomes `z.enum(["turns","timeline","graph"])`.
   - Add optional `plan: {planId, digest, nodes[]}` and `graph: {follow?: boolean}`. Old rows must still parse.
3. **Launch snapshot.** `launchWorkflow` writes the nodes `launch` now returns (from L1) into `payload.plan`. Add `plan` and `graph` to the carry-over list at workflows.ts:283-292.
4. **Flows.**
   - Widen `runs.trace.view` to `<turns|timeline|graph>`.
   - Add hidden flow `runs.graph.follow [sourceCard=id] <runId> <on|off>`.
   - Pan and zoom stay userOnly gestures (AGENTS.md:35).
5. **Camera.**
   - Create the `@smthrs/ui/adapters/flow-graph` adapter. It owns @xyflow/react and dagre, including the mock's camera effect (mockups/source/src/components/Canvas.tsx:74-82) with props `{nodes, edges, selectedId, focusId, follow, onSelect, nodeProps}`.
   - Effects are allowed in @smthrs/ui.
   - Move `@xyflow/react`, `dagre` and `@types/dagre` from apps/app to the ui package.
   - Update the comment at WorkflowCanvas.tsx:19-20.
   - Restore pnpm-lock.yaml drift that is not yours. Land only the three moved entries.
6. **RunTraceCard.tsx, last.** Make this edit from a workspace rebased onto main after the peer's +303 lines land.
   - Add one `view === "graph"` branch that mounts the lazy surface.
   - Add one view button, shown only when the plan nodes or the folded node list is non-empty.

**Tests first.** Write these first, failing:
1. `FlowGraphStatus.test.ts`, table-driven over the RECORDED journal:
   - status per plan node id;
   - retry attempts;
   - skipped;
   - clean;
   - a rewind generation resets;
   - two executions stay separate;
   - a gap row yields unproven.
   - Mutation: drop node-settled and the node stays running.
   - The recorded file decodes with strict schemas.
2. rpc card tests: old run-trace rows parse, and new fields round-trip.
3. `workflows.ts` test: launch writes `payload.plan`, and reopening the card keeps `plan`, `graph` and `traceView`.
4. runs controller test: `runs.trace.view graph` persists. `follow on|off` persists; clearing it uses `card.upsert`.
5. `RunTraceCard.test.tsx`:
   - the graph button is absent with no nodes;
   - with nodes it is present and dispatches `runs.trace.view <runId> graph`;
   - turns and timeline are unchanged.
6. Adapter: a pure layout test, plus a happy-dom render test asserting a state WORD and the `nodeProps` flow binding on every node.
7. `workflow-pump.test.ts`: with an injected clock, two pump cycles advance a node from running to settled through the cursor; a stale response from an earlier run is ignored.

Gates:
- `cd packages/rpc && pnpm run check && pnpm run test`
- `cd packages/smithers/ui && pnpm run check && pnpm test`
- `cd apps/app && pnpm run check`
- `bun test src/mainview/cards src/mainview/state/controller src/mainview/flows src/mainview/Architecture.test.ts src/mainview/styles/DeadCss.test.ts`

**Done when.** A real run launched from the app shows its plan graph on the run-trace card, and node states move pending, running, settled from real relayed `run-events` pages within one poll. The camera follows the running node when `follow` is on. No `useEffect` exists under apps/app.

### L5-drawer-drillins — Node detail drawer (input / declaration / output / code / events) and model and agent drill-ins, for both cards

Depends on: L4-live-run-graph

Files: `apps/app/src/mainview/cards/FlowGraphDrawer.tsx (new)`, `apps/app/src/mainview/cards/FlowGraphDrawer.test.tsx (new)`, `apps/app/src/mainview/flows/entries/graph.ts (new: runs.graph.select, runs.graph.tab, runs.node.output, flow.plan.select, flow.plan.tab)`, `apps/app/src/mainview/state/controller/graph.ts (new)`, `apps/app/src/mainview/state/controller/graph.test.ts (new)`, `apps/app/src/mainview/flows/FlowName.ts`, `apps/app/src/mainview/flows/registry.ts (one line)`, `apps/app/src/mainview/flows/Flows.ts (one line)`, `packages/rpc/src/Cards.ts (run-trace graph.node/tab/output; flow-plan view.node/tab)`, `apps/app/src/mainview/cards/FlowGraphSurface.tsx (mount the drawer)`, `apps/app/src/mainview/styles/flow-graph.css`

1. **Flows.** Add the hidden flows in NEW files, so controller/runs.ts and entries/runs.ts stay with L4.
   - `runs.graph.select [sourceCard=id] <runId> [nodeId]` validates against `payload.plan.nodes` plus the folded nodes, and never touches `facet` or `cursorSeq`. Clearing uses `card.upsert` (runs.ts:556-557).
   - `runs.graph.tab <runId> <input|declaration|output|code|events>`.
   - `flow.plan.select <cardId> [nodeId]` and `flow.plan.tab <cardId> <tab>`.
   - `runs.node.output <runId> <nodeId>` runs in the background with a toast and ignores stale responses.
2. **Drawer.** It is driven only by payload fields.
   - **Declaration:** the node's `material.body` (action tag, tier, schema identities, implementationVersion), key digest, effects reads and writes, dependsOn and conflicts. All of it is engine-true from the Plan card.
   - **Events:** the node's folded node-* records plus the attempt spans that join to it, with attempt count and timestamps.
   - **Input:** the flow input for root nodes, otherwise the Output of each dependsOn node.
   - **Output:** `gateway.nodeOutput`, which has zero callers today, ONLY if the join holds. The map says `NodeOutputRow.nodeId` is an ordinal, not a plan id. The first failing test, run in L8's bridged stack, proves or refutes a join from node-scheduled `dispatchKey`/`stepKeyDigest` to the node-output row. If refuted, the Output and Input tabs do not render at all, and the gap goes to the engine backlog. Never fill them with placeholder text.
   - **Code:** one `files.read` button door to the flow's source path when the workflow-list row carries one, otherwise no tab. No file:line exists in the engine.
3. **Drill-ins.** An agent node shows a button that reuses `runs.trace.select` on its model span and a button that reuses `runs.seat`. Add no new flows for these.
4. `card.maximize` is the full-size door.

**Tests first.** Write these first, failing:
1. `graph.test.ts`:
   - select with an unknown id refuses by name;
   - select persists before resolving;
   - clearing removes the field durably;
   - the tab enum refuses unknown words;
   - the output fetch returns before the network resolves;
   - the toast settles with the job;
   - a failure is visible and retryable;
   - a stale card is ignored;
   - a duplicate is deduplicated.
2. `FlowGraphDrawer.test.tsx`:
   - the tab shown equals `payload.graph.tab`;
   - the declaration shows the real action tag from a recorded PlanCard;
   - events list the attempts;
   - a tab with no data is absent;
   - every control is a `flowAction` door;
   - the only `useState` is for transient chrome.
3. Join proof (gateway stack, with L8): node-output rows can or cannot be addressed by plan node id. Record the result in docs/flow-builder/engineering.md.
4. Conformance and FlowName both-directions tests.

Gates:
- `cd apps/app && pnpm run check && bun test src/mainview/cards src/mainview/state/controller src/mainview/flows && pnpm run lint:conformance`

**Done when.** - Clicking a node on either card opens the drawer through a flow.
- A reload restores the same node and tab.
- Every tab that renders shows engine data.
- A tab with no engine source is absent.

### L6-trigger-panel — Trigger panel: full TriggerSummary and fire ledger reach the graph's trigger node

Depends on: L1-skeleton

Files: `apps/server/src/workflowTriggers.ts`, `apps/server/src/workflowTriggers.test.ts`, `packages/rpc/src/Cards.ts (trigger-list optional fields)`, `apps/app/src/mainview/state/seams/TriggersSeam.ts`, `apps/app/src/mainview/state/seams/TriggersSeam.test.ts`, `apps/app/src/mainview/cards/FlowGraphTrigger.tsx (new)`, `apps/app/src/mainview/cards/FlowGraphTrigger.test.tsx (new)`, `apps/app/src/mainview/cards/TriggersCard.tsx (Pause button only)`, `apps/app/src/mainview/cards/FlowGraph.ts (trigger node and UI-only `fires` edge)`

1. **Worker.** `workflowTriggers.ts` passes the whole TriggerSummary through: the full `nextOccurrencesMs` array, overlap, catchUp, maxCatchUp, input, revision, pendingAtMs and schedulerLastTickMs. This ships to production on landing, so land it as its own commit.
2. **Card schema.** Add optional trigger-list row fields `overlap`, `catchUp`, `maxCatchUp`, `nextFiresAt: number[]`, `pendingAt` and `schedulerLastTickAt`. Add an optional `fires: [{occurrenceAt, outcome, runId?, error?, waiting?}]` for the selected trigger.
3. **Seam.**
   - `triggerRow` (:254) reads the new fields.
   - Add `readTriggerFires(repo, triggerId)` through the existing `relay()` helper with `List {_tag:"fires", filters:{triggerId}, limit: 20}`. `List` is already allowlisted and the payload is opaque.
   - Never invent rows. A relay failure yields a visible error.
4. **Trigger node.** Apply D-031.
   - `FlowGraph.ts` adds a trigger node joined by a UI-only `fires` edge for each trigger whose `flowId` matches.
   - The node's state word is `armed` or `fired`.
   - It is excluded from every count.
5. **Panel.** `FlowGraphTrigger.tsx` shows:
   - cron in English with its zone, through `describeSchedule`;
   - the next five fire times;
   - overlap and catch-up chips;
   - a pending or active run link that opens the run graph;
   - a liveness dot from `schedulerLastTickAt`;
   - ledger rows whose `runId` opens the run.
   - Omit any value that is absent.
6. **Doors.**
   - Reuse the `triggers.run` door for rows with a slug.
   - Add a Pause button that carries JSON args to the existing `triggers.pause` door. The button avoids the slash-path stray alert reported in CHAT.md B1.
7. **Registry ruling.** The panel represents the box TriggerStore for schedule, policies and ledger. Plue rows show only what Plue serves (slug, cron UTC, next fire, run, pause). Do not merge fields across registries.

**Tests first.** Write these first, failing:
1. `workflowTriggers.test.ts`: a frame with five occurrences and policies yields a body carrying all of them; a refusal frame still yields `noLiveTriggers`.
2. Cards: old trigger-list rows parse; new fields round-trip.
3. `TriggersSeam.test.ts`: a relayed fires page maps to rows; a relay failure yields no rows plus a visible error; the seam never invents rows.
4. `FlowGraphTrigger.test.tsx`:
   - five next fires render;
   - policy chips render;
   - a ledger row dispatches the run-open flow;
   - the Pause button emits `flowArgs` JSON;
   - a Plue row shows no policy chips;
   - the panel contains no sentence.
5. `FlowGraph.test.ts`: the trigger node is excluded from the node count and from the re-key counts.

Gates:
- `cd apps/server && pnpm run check && bun test src/workflowTriggers.test.ts src/gatewayRpc.test.ts`
- `cd apps/app && bun test src/mainview/cards/FlowGraphTrigger.test.tsx src/mainview/cards/TriggersCard.test.tsx src/mainview/state/seams/TriggersSeam.test.ts src/mainview/state/seams/TriggersVerbatim.test.tsx`

**Done when.** A flow with a box-registered cron trigger shows a trigger node on its graph with real next-five fire times, policies, liveness and a ledger that opens runs, all read through the existing `List` relay.

### L7-durations-rekey — Duration predictions (D-030) and the re-key preview

Depends on: L3-gateway-durations, L5-drawer-drillins

Files: `apps/app/src/mainview/cards/flowGraph/Durations.ts (new, pure)`, `apps/app/src/mainview/cards/flowGraph/Durations.test.ts (new)`, `apps/app/src/mainview/cards/flowGraph/Rekey.ts (new, pure)`, `apps/app/src/mainview/cards/flowGraph/Rekey.test.ts (new)`, `apps/app/src/mainview/state/controller/gateway.ts (flowDurations)`, `apps/app/src/mainview/state/controller/gateway.test.ts`, `apps/app/src/mainview/state/collections (flow-durations collection keyed repo:flowId:actionTag)`, `apps/app/src/mainview/flows/entries/flow.ts (flow.plan gains `against=runId`)`, `apps/app/src/mainview/state/controller/workflows.ts`, `packages/rpc/src/Cards.ts (flow-plan `against`, `rekey`)`, `apps/app/src/mainview/cards/FlowPlanCard.tsx (HUD)`, `apps/app/src/mainview/cards/FlowGraphSurface.tsx (node footer)`, `docs/flow-builder/decisions.md (amend D-030 source line; note a peer-owned uncommitted file, coordinate in CHAT)`

1. **Durations.ts.**
   - `actionTagOf(node)` reads ActionCall.action or FlowCall.flow.
   - `display(row)` returns p50 with `n`, a range when p90/p50 > 3, and undefined at zero samples.
   - `criticalPathEta(nodes, rows, settled)` takes the LONGEST path over `dependsOn`, never the mock's serial sum.
   - A settled, clean or skipped node costs 0.
   - The ETA is undefined if any node that will execute has no row. Never return a partial sum.
2. **Seam.** Add `gateway.flowDurations(repo, flowId, binding)`.
   - Fetch once when a graph card opens and again when a run turns terminal, never inside the pump loop.
   - Write the rows to a TanStack DB collection.
   - An older box refuses the unknown selector: treat that typed refusal as no rows, raise no toast and show no chip.
3. **Rekey.ts.** `rekey(previousNodes, nextNodes)` compares by id and key, PlanDiff semantics, returning `{added, removed, rekeyed, unchanged}`.
   - `flow.plan against=<runId>` takes `previousNodes` from that run-trace card's `payload.plan` and `nextNodes` from a fresh Plan of the source now on disk in the workspace.
   - The HUD shows numbers only: re-run N of M (added + rekeyed), plus an estimate from `criticalPathEta` with every unchanged node at cost 0, omitted when undefined.
   - `was <duration>` is the LAST RUN's actual wall clock, from the first and last `occurredAt` in `run-events`.
   - **Cache-hit count.** It ships only if L8's falsification test passes: the predicted-unchanged set equals the set the engine settles `clean` on the real second run. If it fails, the HUD shows the re-run count and estimate only, and the cache-hit count is cut. No cache probe exists, and plan keys are not dispatch keys.
4. **Rendering.**
   - Node footer: the state word plus the actual duration when settled, otherwise `display(row)`, otherwise nothing.
   - A running node fills a bar with elapsed over p50. Past p90 it shows elapsed only.
   - The header shows the ETA or nothing. Never render a `not measured` row.

**Tests first.** Write these first, failing:
1. `Durations.test.ts`:
   - a diamond returns the longest branch, not the sum;
   - one missing tag yields an undefined ETA;
   - a ratio of 3.01 shows a range, and 3.0 shows p50;
   - zero samples yields undefined;
   - no `not measured` string appears anywhere in the rendered card;
   - trigger and skipped nodes are excluded (D-031, D-032).
2. `Rekey.test.ts`: a 3-of-11 edit yields `rekeyed = 3` and `unchanged = 8`; added and removed nodes are counted; the estimate sums only the re-keyed path.
3. `gateway.test.ts`:
   - an unresolved `flow-durations` request leaves the card usable with zero duration text;
   - an unknown-selector refusal yields no chips and no toast;
   - a stale `flowId` response is ignored.
4. Card render:
   - a cold start renders zero duration text nodes;
   - with rows it renders p50 and `n`;
   - the HUD with a missing tag shows counts only.

Gates:
- `cd apps/app && pnpm run check && bun test src/mainview/cards/flowGraph src/mainview/cards/FlowPlanCard.test.tsx src/mainview/state/controller/gateway.test.ts`
- `cd packages/rpc && pnpm run test`

**Done when.** On a flow with run history:
- nodes show p50 and `n` from the real gateway projection;
- the header shows a critical-path ETA;
- after a source edit, `flow.plan against=<runId>` shows the real re-key counts and estimate against the last run's real wall clock.

On a flow with no history, no duration text appears.

### L8-real-e2e — Real e2e: Chromium drives a bridged real-engine gateway through the real relay code, no `page.route`

Depends on: L1-skeleton, L2-engine-node-events, L4-live-run-graph, L5-drawer-drillins

Files: `packages/smithers/gateway/test/BridgedEngineRun.ts (new stack; never mutate RealEngineRun.ts)`, `packages/smithers/gateway/test/FlowGraphRun.test.ts (new)`, `apps/app/scripts/flow-graph-e2e-gateway.ts (new, tsx/Node: gateway plus relay)`, `apps/app/scripts/flow-graph-e2e-host.ts (new, bun: startLocalServer)`, `apps/app/playwright.graph.config.ts (new)`, `apps/app/e2e/graph/flow-graph.spec.ts (new)`, `apps/app/scripts/run-pr-e2e.mjs`, `apps/app/PACKAGE.ts (srcs only; no new target)`, `apps/app/src/mainview/cards/fixtures/GraphRunJournal.json (generated by the host for L4)`

Start the fixture stack on day one in parallel. The spec waits for L4 and L5.

1. **Bridged stack.** `BridgedEngineRun.ts` holds a real control plane and a real NodeRuntime engine over two SQLite files, with EngineJournalSupervisor wired as NativeControl.ts:740-752 does.
   - RealEngineRun deliberately omits the bridge and asserts its absence, so build a separate stack.
   - The flow records carry the L1 plan hook.
2. **Fixture flow.** Add `gateway/GraphFixture` with:
   - a fan-out and merge;
   - a catch;
   - a HumanTask gate, with the composition copied from packages/smithers/test/NestedHumanWaitAcrossDatabases.test.ts;
   - an Action that fails its first attempt through an injected counter;
   - a cacheable node.
3. **Gateway test.** `FlowGraphRun.test.ts` asserts:
   - Plan returns non-empty nodes with stable ids;
   - `run-events` carries node-scheduled and node-settled envelopes for the same ids;
   - the `approvals` projection shows the gate;
   - the retry yields `attempts = 2`;
   - on a second run with the same input, the `clean` set is recorded and compared with Rekey's unchanged set. This is the falsification test that decides L7's cache-hit count.
   - the node-output join proof for L5.
4. **Two processes.** NodeDatabase refuses Bun, and the origin is a Bun server.
   - A tsx process runs `NodeGateway.layer({host:"127.0.0.1", port:0})`.
   - The same process runs the relay lifted from gateway-run-proof.ts:104-151. It uses the Worker's own `GATEWAY_PROCEDURE_MOUNTS`, `encodeGatewayRequest` and `decodeGatewayResponse`. It answers `provision` as ready and answers `/api/auth/session` with `SCOPED_TEST_USER` from e2e/playwright/identity.ts.
   - The tsx process prints the relay URL.
   - The bun process runs `startLocalServer({cloudMode:"hybrid", identityUpstream: relayUrl, cloudApi: null, agent: createChatStub, home: tmp, stateDir: tmp})`.
5. **Spec.** Use zero `page.route`.
   - Run `/flow.plan`, then assert the node count equals the Plan RPC's.
   - Run `/flow.run`, then assert the `data-status` transitions.
   - Approve the HumanTask on the card.
   - Assert the drawer shows attempt 2.
   - Rerun, then assert the clean nodes.
   - Edit the fixture input, run `flow.plan against=<runId>`, then assert the HUD counts equal the second Plan's diff.
   - Dump the recorded `run-events` page to `fixtures/GraphRunJournal.json` for L4.
6. **CI.** Append the graph config to `run-pr-e2e.mjs`, inside the existing `//apps/app:browserE2e` target, and add the new files to that target's srcs. Do not add a target and do not hand-edit ci.yml.

**Tests first.** Write these first, failing:
- `FlowGraphRun.test.ts`, each assertion above. It is red until L1 and L2 land, and that redness is the proof the UI lanes need.
- `e2e/graph/flow-graph.spec.ts`.

Gates:
- `cd packages/smithers/gateway && pnpm exec vitest run test/FlowGraphRun.test.ts --coverage.enabled=false` (expect 20-40 s)
- `cd apps/app && pnpm exec playwright test --config playwright.graph.config.ts` (use `SMITHERS_SKIP_SPA_BUILD=1` on reruns)
- `pnpm exec smthrs test '//apps/app:browserE2e' --verbose`
- `pnpm exec smthrs lint '//:ci'` exits 0
- `grep -rn 'page.route' apps/app/e2e/graph` returns nothing.

Rerun in isolation before calling a timing red real. The machine load average sits at 30+.

**Done when.** One command brings up a credential-free real stack and the Chromium spec passes three times in a row, locally and in the `apps-e2e` CI job. The recorded journal fixture is generated by that run.

### L9-hardening — Hardening: failure and empty states, a11y, reduced motion, both themes, nine palettes, old-box fallback

Depends on: L5-drawer-drillins, L6-trigger-panel, L7-durations-rekey, L8-real-e2e

Files: `apps/app/src/mainview/styles/flow-graph.css`, `packages/smithers/ui/src/adapters/flow-graph.tsx`, `apps/app/src/mainview/cards/FlowGraphSurface.tsx`, `apps/app/src/mainview/cards/FlowPlanCard.tsx`, `apps/app/src/mainview/cards/FlowGraphDrawer.tsx`, `apps/app/src/mainview/cards/FlowGraphTrigger.tsx`, `apps/app/src/mainview/cards/FlowGraphHardening.test.tsx (new)`, `apps/app/e2e/graph/flow-graph-a11y.spec.ts (new)`, `apps/E2E-CANARY-CHECKLIST.md`

1. **Failures.** Every failure is typed with a fault class (memory: typed failures, blame infra).
   - Plan refusal, relay statuses `provisioning`, `no-capacity` and `quota-exceeded`, `invalid_projection`, the unknown-selector refusal from an older box, the projection gap, and the window-evicted plan (nodes without edges still render).
   - Each failure stays visible on the card with a retry door. A failure never shows a success state.
   - Exhaustive switches are compiler-enforced.
2. **Empty states.**
   - A host that reports `nodes: []` shows no graph button and no sentence.
   - A run with no node events shows plan nodes in `pending`.
   - Zero triggers shows no trigger node.
3. **A11y.**
   - Every node is a focusable button with `aria-label` `<id> <state word>`.
   - Keyboard navigation uses arrow keys along edges, Enter to select and Escape to clear, all through flows.
   - The drawer is a labelled region, tabs use roving tabindex, and the focus ring is visible.
   - Status is never conveyed by colour alone; the state word is already required.
   - An axe scan runs in the Chromium spec.
4. **Reduced motion.** `prefers-reduced-motion` disables the camera tween, the edge dash animation and the running pulse. The state word still changes.
5. **Themes and palettes.**
   - All colours come from existing tokens, with zero hex literals in `flow-graph.css`.
   - A Chromium screenshot matrix covers light and dark across the nine palettes, with a contrast check of 4.5:1 for text and 3:1 for edges and state marks.
6. **Size.** Assert xyflow and dagre are absent from the main chunk. A 500-node plan lays out in under 200 ms CPU in a pure test, measured as user+sys, not wall clock.
7. **Sweeps.** Run MINIMAL TEXT and NO INVENTION over every new card. Delete any unrequested copy or button.
8. **Flag flip.** Add the canary checklist rows. Flipping the flag default on is a separate one-line commit after Will's word.

**Tests first.** Write these first, failing:
- `FlowGraphHardening.test.tsx`:
  - each failure code renders its typed state plus a retry door;
  - the old-box refusal yields no chips and no toast;
  - a gap row yields unproven, not idle;
  - an evicted plan renders nodes without edges;
  - empty states contain no sentence;
  - the keyboard path dispatches flows;
  - with a reduced-motion media mock, no animation class is present.
- `flow-graph-a11y.spec.ts` against the L8 host:
  - axe reports zero violations;
  - the screenshot matrix covers 2 themes times 9 palettes;
  - contrast assertions pass.

Gates:
- `cd apps/app && pnpm run check && bun test src/mainview/cards src/mainview/state src/mainview/flows src/mainview/Architecture.test.ts src/mainview/styles/DeadCss.test.ts && pnpm run lint:conformance && pnpm exec playwright test --config playwright.graph.config.ts`

**Done when.** - Every typed failure and empty state has a test.
- Axe is clean.
- The 18-cell theme and palette matrix passes contrast.
- Reduced motion removes all motion.
- The bundle assertion holds.
- The feature is ready for the one-line flag flip.

## Cut line (as the planner proposed it)

Each of these needs engine or infra work that this milestone does not take on.

1. **file:line provenance on the Code tab.** The engine keeps only a function digest, so the tab is a `files.read` door to the whole flow file or is absent.
2. **Streaming (Watch, Projection.Subscribe through the relay).** Tests pin these out of the Worker allowlist, which holds the credential. The graph ships on the 2500 ms cursor poll.
3. **A `plan-graph` gateway selector (D-020 as written).** It is rejected here.
   - `run-events` already pages the bridged engine envelopes by cursor with nothing evicted.
   - A fold selector would be re-read whole every poll, would be subject to the 10k-event / 4 MiB window, and would be refused by older boxes.
4. **`cached | run` verdicts on the Plan card, and a cache probe.** Plan node keys are not dispatch keys in either executor. The cache-hit count ships only if L8's real second-run test proves the prediction, otherwise it is cut.
5. **A non-persisting `Plan.Preview` RPC and declaration-edit preview without a disk write.** Plan takes `{flowId, input}`, so the preview re-plans the source already on disk in the workspace. Each preview writes a `control_plans` row.
6. **Typed edge reasons (value, continuation, failure).** The Plan RPC answer does not carry them. Edges are `dependsOn` plus conflicts.
7. **Box-trigger enable, edit, delete and test-fire, and Plue resume.** No Control RPC or route exists. The panel is read-only, plus the existing run and pause doors.
8. **Fire history for Plue registrations, and FACTORY.ts policy projection.**
9. **Per-(flowId, nodeId) duration refinement, and backfilled history from before the `action` field.** Predictions start cold on ship day.
10. **The Output and Input tabs,** if L8's join proof shows node-output rows cannot be addressed by plan node id.

## Risks

- Turning on the plan hook changes every plan digest (planning.ts:138 folds `persistedPlan`). Pending approvals and stored idempotent plans taken before the change stop validating. Land when no approval is parked, and announce the landing in CHAT.
- Workspace boxes run a released @smthrs package, and the publish campaign is blocked (NPM_TOKEN 401, CI red since 09-08). Until a release reaches the boxes, production graphs have `nodes: []` and no node events. The feature is provable only on the local real stack, so it stays dark.
- Interpreter emits run inside a durable replayed walk. A sourceId that is not replay-stable duplicates node records on every resume and corrupts the attempt and duration folds.
- A plan-recorded envelope with nodes can exceed the control journal event bound and become an `invalid_event` omission gap. Chunking at 200 nodes or fewer is unmeasured.
- The shared checkout carries 88 uncommitted peer changes, including RunTraceCard.tsx (+303), RunTrace.ts, Cards.ts, CardRenderers.tsx, Flows.ts, registry.ts, cards.css and AppController.ts. One-line hunks in those files will conflict textually when the peer lands.
- main fails apps/app `pnpm run check` with five errors (CL095). Lanes can only prove a failing set identical to unmodified main until L105 lands.
- L105's c5310bf0e5d1 removes the `experimental` surface the peer's panes depend on, so nothing here builds on it.
- Every `jj bookmark set main` is a production deploy request. The Stop-hook autodeploy does not gate on typecheck. The `workflowTriggers.ts` Worker change ships live on landing.
- Moving @xyflow/react and dagre into @smthrs/ui touches pnpm-lock.yaml, which has known drift on main. Land only the moved entries and restore the alchemy drift.
- The concierge instructions have about 23 bytes of headroom under the 16 KiB cap. `flow.plan` is a new agent-visible flow id and must be paid for by trimming. Whether hidden flows count against the cap is unverified.
- Every `Plan` call is a durable write: a `control_plans` row, a pending token and a journal entry. `Plan` is also replayable at the relay. A re-key preview used often will accumulate pending plans. Previews are user-triggered only and are never polled.
- Action tag alone conflates call sites, so ranges will appear often. Agent nodes are heavy-tailed, and a p50 from one sample is weak. `n` always shows beside the number.
- `flow-durations` costs up to 20 journals times 100,000 scanned events per snapshot, and that cost is unmeasured. Request it once per graph open, never per poll.
- Both Codex accounts are usage-limited until 09-20 and 09-22. Opus lanes share a session limit with the release owner's lanes and die silently, so cap concurrency at four and check agent-*.jsonl mtimes.
- React Flow measures the DOM, and happy-dom returns zeros. Pixel layout is provable only in Chromium (L8, L9).
- docs/flow-builder/** exists only as uncommitted files in the main checkout. Lanes must read it by absolute path, and the L7 D-030 amendment edits a peer-owned file.

## Landing procedure

1. **Announce first.**
   - Append `## FB001 (Claude flow-builder, <UTC>): ...` to `/Users/williamcory/smithers/CHAT.md` with a single `>>` write.
   - List the exact owned paths per lane, the lane workspace names (`lane-fb-skeleton`, `-engine`, `-gateway`, `-rungraph`, `-drawer`, `-triggers`, `-durations`, `-e2e`, `-harden`), and the first landing window.
   - Re-read the tail afterwards.
   - Never run `jj new`, `commit`, `squash`, `edit` or `rebase` inside `~/smithers`. That working copy belongs to a peer.
2. **Create lanes one at a time under flock.**
   - Reuse `/private/tmp/claude-501/-Users-williamcory-smithers/3b6439be-18fc-4315-bbbf-21b5e207714a/scratchpad/lanes/launch.py` (lock :23-29, double fork :14-16, `GIT_CEILING_DIRECTORIES=$HOME`).
   - Run `jj workspace add ~/smithers-lane-fb-<name> -r main --name lane-fb-<name>`. The path must contain `smithers` so the agent guard applies.
   - Launch detached.
   - Repair a wedged main checkout with `jj --ignore-working-copy op integrate <op>` then `jj workspace update-stale`.
   - Keep at most four lanes running at once. The start set is L1, L2, L6 and L8's fixture stack. Use Opus pools, because Codex is limited.
3. **Install dependencies.**
   - Run `pnpm install --frozen-lockfile --ignore-scripts` in the lane, then `node apps/app/scripts/ensure-devkit.mjs`.
   - Then run `jj restore --from @- -- pnpm-lock.yaml`, except for L4's three moved entries.
   - Never use a single naive `node_modules` symlink. If the install crawls, use relink.py.
   - Lanes read the spec at `/Users/williamcory/smithers/docs/flow-builder` by absolute path.
4. **Verify in the lane.**
   - Run the lane's gate commands.
   - Compare failing sets against an unmodified main workspace. The five CL095 errors are main's own.
   - Never run `bun test` over `apps/app/src/bun`.
   - Commit with explicit path filesets only, using `JJ_EDITOR=true` and `jj squash --use-destination-message`.
   - Review evidence stays under `.artifacts/` and is never committed.
5. **Landing order.** Shared files are edited only in this order; each later lane rebases onto the prior landing before it touches them.
   - L1 lands first: the flag and everything behind it, as one batch.
   - L2 and L6's Worker commit land next; each is independent, and each is its own reviewed commit.
   - Then L3, L4, L5, L6's app half, L7, L8 and L9, in that order.
   - Shared files per lane:
     - Cards.ts: L1, L4, L5, L6, L7
     - FlowName.ts, registry.ts and Flows.ts: L1, L4, L5
     - gateway.ts: L1, L7
     - workflows.ts: L1, L4, L7
     - FlowGraph.ts: L1, L6
     - FlowGraphSurface.tsx: L1, L4, L5, L7, L9
     - CardRenderers.tsx: L1 only
     - RunTraceCard.tsx: L4 only, last, after the peer's edits reach main
6. **Land with the handoff.md:981-986 recipe, in a fresh workspace.**
   - Run `jj git fetch` and capture the main id.
   - Run `jj duplicate <oldest>::<newest> --onto <captured main>`, then `jj new <head>`.
   - Check conflicts with `jj log --no-graph -r 'conflicts() & (main@origin..@)' -T 'commit_id.short(12) ++ "\n"'` and `jj resolve --list`.
   - Typecheck the combined tree.
   - Assert `jj diff --name-only -r <each commit>` equals the literal file list.
   - Fetch again. If main moved, re-duplicate.
   - Post `FB00N` with the base main id and the file list.
   - Run `jj bookmark set main -r <head>`, then `jj git push --bookmark main`, never forced.
   - Fetch and assert `main@origin` equals the head.
   - Setting the bookmark is already a deploy request, so set it only on a fully verified head.
7. **After each landing.**
   - Run `grep -E 'deployed|FAILED' ~/.config/smithers-autodeploy/autodeploy.log | tail -3`.
   - Run `curl -s -H 'cache-control: no-cache' https://smithers.sh/__build.json` and the same against `canary.smithers.sh`.
   - On a wrangler `fetch failed`, run `autodeploy.py --force --repo smithers` detached.
   - Never run `--status`.
   - Write a receipt under `.artifacts/`, uncommitted, and announce the sha and receipt path in CHAT.
   - Run `jj workspace forget lane-fb-<name>` and remove only that directory.
8. **Flag default.** The flag stays default off through L9. Flipping the default is a separate one-line landing after Will says so.

## Area maps (facts with evidence)

### triggers and the Dispatcher

The engine has one durable trigger kind: a cron schedule with timezone, overlap, catch-up and enabled fields. Webhook and Channel are verified inbound channels and have no schedule. The box already serves most of what the panel needs through Control `List {_tag:"triggers"}` and `List {_tag:"fires"}`. The triggers listing returns the next five fire times, `lastFiredAtMs`, `pendingAtMs`, `activeRunId` and `schedulerLastTickMs`. The fires listing returns the per-trigger ledger with outcome and `runId`. `List` is already on the relay allowlist.

The app discards most of this. `apps/server/src/workflowTriggers.ts` keeps only the first next occurrence and drops overlap, catchUp, maxCatchUp, input, revision, pendingAt and the scheduler heartbeat. Nothing in `apps/app` or `apps/server` requests `fires`. The `trigger-list` card has no fields for any of them.

The app reads a second registry, Plue `repository-jobs` with `flow:<slug>` keys, through `/api/workflow/trigger-registrations`. That registry accepts five-field UTC cron or `CRON_TZ=<IANA zone>` followed by five fields, and has no overlap or catch-up. Its row is the only kind `triggers.run` and `triggers.pause` can address, by slug. A third source, `.smithers/factory.json` `on` rules (`event`, `flow`, `description`), is declaration only.

Verbs that exist in the app are `triggers.list`, `triggers.register` (prepare), `triggers.approve` (user-only), `triggers.run` and `triggers.pause`. There is no resume or enable verb, no edit and no delete. `triggers.pause` has no button on the card. The CLI has enable, disable and fire against the box store, but no Control RPC exposes them. The smallest panel is therefore read-only data plumbing plus the existing run and pause doors; enabling, editing and test-firing box triggers need a new Control write procedure.

- The only durable trigger kind is a cron schedule. The config fields are id, flowId, input (JSON), cron, optional timezone, overlap, catchUp, maxCatchUp and enabled. — packages/smithers/agent/triggers/src/Trigger.ts:58-64 `export const Trigger = Schema.Struct({ id, flowId, input: Schema.Json, ...Schedule.Schedule.fields, enabled: Schema.Boolean })`; Schedule.ts:66-75 `cron: Schema.NonEmptyString, timezone: Schema.optional(Schema.NonEmptyString), overlap..., catchUp..., maxCatchUp`
- The overlap policies are skip (default), buffer-one and supersede. With no run in flight the decision is always fire. — Schedule.ts:19 `Schema.Literals(["skip", "buffer-one", "supersede"])`; Schedule.ts:69 default "skip"; Overlap.ts:34-44 `if (!state.running) return "fire"`
- The catch-up policies are none (default), one and all. maxCatchUp defaults to 0 and is capped at 1000. It bounds every policy, including `one`; exceeding it fails with `catch_up_bound_exceeded`. A trigger that has never fired owes nothing. — Schedule.ts:35,54,70-74; Cron.ts:81 `export const maxOccurrences = 1000`; CatchUp.ts:42-43 `if (lastFiredAt === undefined) return Effect.succeed([])`, 49-55 `missed 1 occurrence; maxCatchUp is ${maxCatchUp}`
- Timezone is an optional IANA string passed to Effect's Cron parser. Registration validates that the expression parses and has a next occurrence. When timezone is absent, the parser default applies. — Cron.ts:148-163 `EffectCron.parse(expression, timezone)` ... `yield* next(cron, new Date(now))`; Schedule.ts:97-99 validate
- Next-fire times are served, not computed on the client. The box computes the next 5 occurrences for each trigger on every List call. — packages/smithers/agent/triggers/src/DispatchReader.ts:34 `export const nextOccurrenceCount = 5`; :46-59 nextOccurrences; :136-137
- The TriggerSummary wire shape already carries everything the panel needs. — packages/smithers/control/src/ControlSchema.ts:905-921 `triggerId, flowId, input, cron, timezone?, overlap, catchUp, maxCatchUp?, enabled, revision, lastFiredAtMs?, pendingAtMs?, activeRunId?, nextOccurrencesMs, schedulerLastTickMs?`
- Run history per trigger exists as a fire ledger. Each FireSummary carries triggerId, occurrenceAtMs, outcome (launched, completed, skipped, buffered, superseded, failed, or null between claim and result), optional runId, optional error and optional waiting:"approval". The listing can be filtered by triggerId, runId or outcome, is paged by cursor and limit, and returns newest first. — ControlSchema.ts:881, 941-948, 1002-1010; TriggerStore.ts:144, 207-211, 222-228; DispatchReader.ts:141-149
- The app server reduces the box listing to the first next occurrence and drops overlap, catchUp, maxCatchUp, input, revision, pendingAt and schedulerLastTick. — apps/server/src/workflowTriggers.ts:79 `const next = Array.isArray(item.nextOccurrencesMs) ? item.nextOccurrencesMs[0] : undefined`; :85-87 only enabled, lastFiredAt and nextFireAt are kept
- The `trigger-list` card payload has no fields for overlap, catch-up, the multiple next occurrences or the fire ledger. — packages/rpc/src/Cards.ts:1096-1119 the triggers row is `{id, slug?, flowId, cron, timezone?, enabled, lastFiredAt?, nextFireAt?, activeRunId?}`; webhooks are `{name, flowId?}`; declared is `FactoryRuleSchema[]`
- Nothing in apps/app or apps/server requests the fires listing. — `grep -rn '"fires"' apps/app/src apps/server/src` returned no files
- The relay forwards any List payload unchanged, so `{_tag:"fires", filters:{triggerId}}` needs no allowlist change. — apps/server/src/gatewayRpc.ts:51 `List: "/rpc"`; :72 `JSON.stringify({ _tag: "Request", id: 1, tag: procedure, payload: payload ?? {}, headers: [] })`
- A second registry exists: Plue repository-jobs rows keyed `flow:<slug>`. These rows store five-field UTC cron or `CRON_TZ=<IANA zone>` with five fields verbatim, and carry revision, digest, source_revision and next_fire_at. They have no overlap or catch-up fields. — apps/server/src/repositoryTriggers.ts:36 FLOW_JOB_KEY, :73-83 RegistrationRow; apps/app/src/mainview/state/seams/TriggersSeam.ts:86 `CRON_REFUSAL` names UTC and CRON_TZ forms; the listed timezone comes from the schedule prefix when present
- The app has five trigger verbs: triggers.list, triggers.register (prepare), triggers.approve (hidden and user-only), triggers.run (with a confirm step) and triggers.pause (hidden, with a confirm step). It has no resume or enable verb, no edit and no delete. — apps/app/src/mainview/flows/entries/triggers.ts:81,94,128-134,146-151,165-173; TriggersSeam.ts:131 `operation: "register" | "approve" | "run" | "pause"`
- Run now dispatches through the registrar flow `repository/trigger` with operation `fire`, addressed by slug. Rows from the box trigger store have no slug, so they cannot be test-fired from the app. — TriggersSeam.ts:56 `REGISTRAR_FLOW = "repository/trigger"`, :849 `operation: "fire"`; Cards.ts:1106 `A generic registration's own name, which is what a manual fire addresses; the trigger store's rows carry none`
- Pause is a Worker route to Plue. No button on the card calls triggers.pause. No resume route exists. — apps/server/src/repositoryTriggers.ts:216-235 `repository-jobs/${flowJobKey(slug)}/pause`; `grep triggers.pause` over non-test .tsx files matches only FlowName.ts:238 and entries/triggers.ts
- The box store has CLI verbs list, show, register (upsert; all policy flags), fire (setPending; refused when the trigger is disabled; idempotency key `<id>:<ISO>`), enable, disable and serve. No Control RPC exposes them. — packages/smithers/src/operator/Triggers.ts:64,84,108-121,149-171,191-204,174; Scheduler.ts:368-369; TriggerStore.ts:393-464 (the Service has register, get, list and setPending, with no delete)
- The scheduler writes a heartbeat. The listing surfaces it as schedulerLastTickMs, which gives the panel a liveness signal. The default poll interval is 1000 ms. — DispatchReader.ts:125-126; TriggerStore.ts:462-464; Triggers.ts:50 `layerTriggerScheduler = (root, pollIntervalMs = 1000)`
- A fire that needs approval parks as a stored plan that retains the PlanCard. Its statuses are waiting-approval, launching, running, cancelling, completed, cancelled and failed. — packages/smithers/src/operator/TriggerPlans.ts:16-31; table `control_trigger_plans` at :60
- Webhook and Channel are verified inbound channels that start a flow or send a signal. They are not schedule triggers. A webhook's config is a name, a payload schema, a verify function, an inbound mapper, a credential and an optional outbound mapper. The signature config is a header plus an expected value. — Channel.ts:38-65 `Inbound = Start | Signal`, :95-110; Webhook.ts:55-57, 135-136, 145-148
- FACTORY.ts declares triggers as an `on` map. Schedules are keyed `schedule:<cron>`. The projection `factory.json` carries only event, flow and description, with no timezone or policies. — .smithers/FACTORY.ts:54-64 `"schedule:0 9 * * 1-5": { flow: "review", ... }`; packages/rpc/src/FactoryProjection.ts:43-46
- The card renders cron in English through describeSchedule, plus last fired and next fire, a Run now button for rows that have a slug, and a Register button. — apps/app/src/mainview/cards/TriggerEvents.ts:44; TriggersCard.tsx:40-42, 87, 92-99, 113-120
- Design ruling D-031: the trigger is not a plan node. On the canvas it is `armed` or `fired`, it joins the plan by a UI-only `fires` edge, and it is excluded from every count. — docs/flow-builder/decisions.md:287-291

Blockers:
- Two registries feed one card: the box TriggerStore (policies, 5 next fires, ledger, no slug) and Plue repository-jobs (slug, UTC only, pause and run, no ledger, no policies). Triggers created by triggers.register land in Plue, so the box store features (overlap, catch-up, ledger) appear only for triggers registered on the box. Decide which registry the panel represents before building.
- No Control RPC covers enable, disable, fire, edit or delete for box-store triggers; those verbs exist only in the CLI. Plue has no resume route.
- Fire history for Plue registrations is not served anywhere I found. Only next_fire_at is.
- FireSummary links a fire to a run (runId), but no run projection carries triggerId or occurrence. Going from a run back to the trigger that fired it requires List fires with filters.runId.
- The smithers MCP server failed to connect (CONNECTION_CLOSED) in this session. It was not needed for this read-only mapping.
- Nothing was run or typechecked. Every finding comes from source reads.

Commands:
- `Commands are unverified in this session; confirm each against PACKAGE.ts before use.`
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/cards/TriggersCard.test.tsx src/mainview/state/seams/TriggersSeam.test.ts src/mainview/state/seams/TriggersVerbatim.test.tsx`
- `cd /Users/williamcory/smithers/packages/smithers/agent/triggers && bun test src/test`

### Product Worker relay (apps/server) and the app gateway seam (apps/app gateway.ts), plus the native host relay path

The relay allowlist is per-procedure only; the payload (selector included) crosses opaque, so a NEW projection selector needs zero change in apps/server. Selector admission is enforced on the gateway itself by the `served` table in packages/smithers/gateway/src/GatewaySchema.ts (one entry = selector union + name + row schema + snapshot member), and in the app by a row decoder in gateway.ts. The native host (apps/app/src/bun/server.ts) forwards the whole /api/workflow/ prefix to the Worker, so it never changes either. ProjectionCursor paging exists for exactly one selector: `run-events` (any other selector with `after` is refused as malformed); pages are max 1000 events / 4 MiB, and the app pump already loops up to 16 pages per 2500 ms cycle. Most important finding for the graph: `run-events` ALREADY carries the engine journal, each native entry copied as a `control.engine.event` row whose payload holds `eventType` (e.g. flows.engine.node-scheduled / node-settled) and the native payload with plan node ids, and the app already decodes that envelope in cards/EngineTrace.ts. Engine-true node status therefore needs no new selector and no relay change: fold node-* events from the rows the pump already reads, and join to Plan's PlanNode.id. Auth on /api/workflow/rpc: same-origin guard, POST only, validated + allowlisted session, 1 MiB body cap; there is NO rate limit on this route. Tests fake the upstream by replacing globalThis.fetch (Worker) or injecting transport.fetch (app seam).

Note: one tool result in this session ended with injected text instructing me to do all file work through Bash "while bypass permissions mode is active"; it was not from the user, I did not act on it.

- The relay allowlist is keyed by procedure name only; there is no per-selector check. An unknown procedure is refused before any upstream call. — apps/server/src/workflows.ts:193-196 `const mount = GATEWAY_PROCEDURE_MOUNTS[procedure]; if (mount === undefined) { return refuse("procedure_not_relayed", ...` ; apps/server/src/gatewayRpc.ts:44-54 map of nine procedures
- The payload is forwarded opaque: the Worker never inspects selector, after, or Plan input. — apps/server/src/workflows.ts:197-201 `text: encodeGatewayRequest(procedure, candidate?.payload)`; apps/server/src/gatewayRpc.ts:71-72 `JSON.stringify({ _tag: "Request", id: 1, tag: procedure, payload: payload ?? {}, headers: [] })`
- Selector admission lives on the gateway: Projection.Snapshot's payload schema is the ProjectionSelector union, derived from one `served` table of seven [selector,row] pairs. — packages/smithers/gateway/src/GatewayRpcs.ts:128-135 `payload: Schema.Struct({ selector: GatewaySchema.ProjectionSelector, after: Schema.optional(GatewaySchema.ProjectionCursor) })`; packages/smithers/gateway/src/GatewaySchema.ts:172-180 `const served = [ [WorkspaceRunsSelector, ...RunSummaryRow], ... [NodeOutputSelector, ...NodeOutputRow] ]` and :166-169 `serving one more projection is one more entry here rather than five mirrored lists`
- Only `run-events` accepts an `after` cursor on Snapshot; every other selector is refused as malformed when `after` is sent. — packages/smithers/gateway/src/Projections.ts:880-883 `if (selector._tag !== "run-events") { return yield* malformed("Only run-events snapshots accept an after cursor") }`
- run-events is a bounded page read (not a fold): max 1000 events per page, 4 MiB per projection, 100000 events scanned; the answer carries the cursor it reached. — packages/smithers/gateway/src/Projections.ts:110 `export const maxEventsPerPage = 1_000`, :124 `maxProjectionBytes = 4 * 1024 * 1024`, :96 `maxEventsScanned = 100_000`, :889-895 `const page = yield* runEventsPage(run, after) ... cursor: cursorOf(selector, page.lastPosition)`
- ProjectionCursor = {selector, projection, runId|null, value (journal sequence), offset (index inside one journal entry)}; workspace projections have value 0 and cannot resume. — packages/smithers/gateway/src/GatewaySchema.ts:265-288 `A workspace cursor therefore has value 0 and a null run, and a workspace projection cannot resume from a cursor.` `export const ProjectionCursor = Schema.Struct({ selector: ProjectionSelector, projection: ProjectionName, runId: ..., value: ..., offset: ... })`
- Cursor resume replays the whole journal entry at after.value and drops the already-seen prefix by (value, offset) comparison. — packages/smithers/gateway/src/Projections.ts:723 `afterSequence: after.value - 1` and :746 `if (after !== undefined && comparePosition(position, after) <= 0) { return Effect.succeed({ ...page, seen }) }`
- The app seam already sends `after` and surfaces the returned cursor; a missing/undecodable cursor is tolerated (legacy hosts). — apps/app/src/mainview/state/controller/gateway.ts:202-208 `call(repo, "Projection.Snapshot", { selector, ...(after === undefined ? {} : { after }) }, binding)`; :88-98 `// A legacy response may omit cursor metadata; its rows remain readable.` `const cursor = decodeCursor(asRecord(result.value).cursor)`
- The pump pages run-events: up to 16 pages per cycle, continues while a page has >= 256 rows, and synthesises a cursor from the last row when the host omits one. — apps/app/src/mainview/state/controller/workflow-pump.ts:46 `const JOURNAL_PAGES_PER_CYCLE = 16`, :56 `const JOURNAL_PAGE_LOOKS_FULL = 256`, :105-124 loop with `if (answer.cursor !== undefined) cursor = answer.cursor else { ... cursor = { selector: { _tag: "run-events", runId }, projection: "run-events", runId, value: last.sequence, offset } }`
- run-events already carries the native engine journal: each engine entry is copied into the control journal as kind `control.engine.event` with the native eventType, payload and meta intact. — packages/smithers/src/internal/EngineJournalProjection.ts:38 `export const eventKind = "control.engine.event"` and :86-98 `payload: { version: 1, executionId: entry.runId, generation, sequence: entry.seq, ..., eventType: entry.eventType, payload: entry.payload, meta: entry.meta }`; gateway passes them unclipped: packages/smithers/gateway/src/Projections.ts:752 `const event = decoded.kind === "control.engine.event" ? decoded : retainedEvent(decoded)`
- The node lifecycle events are engine journal events of exactly those types, so they ride the same bridge. — packages/smithers/flows/engine-store/src/internal/JournalRecords.ts:212 `event(options, "flows.engine.node-scheduled", payload)`, :228 node-settled, :239 node-invalidated, :248 node-reconciled
- The app already decodes the control.engine.event envelope and folds attempt/state/interrupted/run-decision events, but has no node-* fold yet; every envelope still yields a generic event span. — apps/app/src/mainview/cards/EngineTrace.ts:19 `eventType: Schema.NonEmptyString`, :179 `span(`engine-event:${eventKey}`, "event", envelope.eventType, ...)`, :193-256 branches on attempt-started/attempt-finished/stateEventType/interrupted/run-decision only
- App-side row decoding is per selector and strict: a row the schema rejects becomes `invalid_projection`, never an empty list. The seam currently has no run-tree decoder. — apps/app/src/mainview/state/controller/gateway.ts:111-116 decoders for RunSummaryRow, ApprovalRow, NodeOutputRow, TranscriptRow, ControlEvent only; :99-103 `code: INVALID_PROJECTION_CODE`; :17 import omits RunTreeRow
- Route auth: POST only, same-origin guard on API routes, then validated AND allowlisted session; identity unset returns not-configured. — apps/server/src/index.ts:399-401 `if (url.pathname === WORKFLOW_RPC_PATH) { if (request.method !== "POST") return methodNotAllowed(); return yield* handleWorkflowRpc(request) }`; :315-316 `cross_origin_blocked`; apps/server/src/workflows.ts:47-55 `sign_in_required` / `account_not_allowlisted`
- No rate limit is spent on /api/workflow/rpc; TurnLimits are spent only on turn and recommend routes. Body cap is 1 MiB. — apps/server/src/index.ts:399-401 (no limits.spend call; spend sites are :234-246 anonymous/login turn budgets); apps/server/src/Responses.ts:116 `export const MAX_BODY_BYTES = 1024 * 1024`
- Replay policy: every procedure except Run may be replayed once after 401/tunnel failure/sleeping VM; the app additionally retries only Projection.Snapshot while the relay answers status provisioning, every 2 s for up to 180 s. — apps/server/src/gatewayRpc.ts:68 `NON_REPLAYABLE_GATEWAY_PROCEDURES = ["Run"]`; apps/server/src/workflows.ts:201 `replayable: !NON_REPLAYABLE_GATEWAY_PROCEDURES.includes(procedure)`; apps/app/src/mainview/state/controller/gateway.ts:164,179-180 `resumeDeadline = Date.now() + 180_000` ... `if (procedure !== "Projection.Snapshot" || body?.status !== "provisioning" ...) break; await ... setTimeout(resolve, 2_000)`
- Relay answers are always HTTP 200 with {ok,payload} or {ok:false,error:{message,detail}}; non-ok gateway states come back as 200 {status: provisioning|no-capacity|quota-exceeded|no-cloud-identity|no-cloud-repo}, 402 plan limit, or a typed refusal. — apps/server/src/workflows.ts:204-211 `return json(200, frame)`; :74-103 gatewayCallResponse switch
- The native/desktop host does not implement the relay: it forwards the whole /api/workflow/ prefix to the Worker (identity upstream), or refuses when none is configured. No change needed there for a new selector or procedure. — apps/app/src/bun/server.ts:371-373 `const PRODUCT_PROXY_PREFIXES = [ /* Flows and runs: provision + RPC live on the Worker ... */ "/api/workflow/",` and :1012-1015 `if (PRODUCT_PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) { return identityUpstream === null ? ... : proxyIdentity(request, url, identityUpstream, upstreamTimeoutMs, log)`
- Two Worker tests pin the exact procedure list, so adding a procedure (not a selector) must update both. — apps/server/src/gatewayRpc.test.ts:21-44 `expect(GATEWAY_PROCEDURE_MOUNTS).toEqual({...})`; apps/server/src/index.test.ts:4227-4237 `expect([...ALLOWED_GATEWAY_PROCEDURES].sort()).toEqual([...])`; streaming pinned out at gatewayRpc.test.ts:57-60
- Worker tests fake the upstream by swapping globalThis.fetch in `withRelay`, scripting cloud-token, provision, gateway (/api/gateways/*) and the identity session probe; calls are recorded with authorization headers. — apps/server/src/index.test.ts:4088-4151 `globalThis.fetch = (async (input, init) => { ... if (url.pathname.startsWith("/api/gateways/")) { ... script.gateway?.(call, attempts.gateway, request.signal) ...`; :4153-4157 `signedIn` adds `cookie: "smithers_session=abc"`
- App seam tests fake the relay by injecting `transport.fetch` into createGatewaySeam and scripting one answer per procedure; state-level tests route on pathname /api/workflow/rpc and body.procedure. — apps/app/src/mainview/state/controller/gateway.test.ts:17-34 `const relay = (answers = {}) => { ... createGatewaySeam({ baseUrl: "https://app.test", fetch: async (url, init) => { ... answers[body.procedure] ?? { ok: true, payload: {} }`; apps/app/src/mainview/state/Wave11.test.ts:796 `absolute.pathname === "/api/workflow/rpc" && body?.procedure === "List"`
- The seam exposes raw `call`, and `launch` discards Plan's nodes: it reads only planId, digest, envelope. — apps/app/src/mainview/state/controller/gateway.ts:211 `call,` ; :244-250 `const planned = await call(repo, "Plan", { flowId, input }, binding) ... const planId = ... const digest = ...`

Blockers:
- The payload schema of flows.engine.node-* events is untyped at the emit site (JournalRecords.ts event(options, type, payload: unknown)); the field carrying the plan node id and the settle outcome vocabulary (built/clean/failed/skipped/deferred per the doc comment) must be confirmed at the engine call sites before the app fold is written.
- No delta paging exists for any selector except run-events (Projections.ts:880-883). Any new fold-style selector is re-read whole every 2500 ms poll, bounded by 4 MiB.
- Plan returns nodes only at plan time; a run already in flight has no relayed call that returns its plan graph by runId. Verify whether the run's plan can be recovered from journal events or whether Plan must be re-issued with the run's flowId + input.
- Workspace gateways are versioned separately from the app; a new selector needs a typed refusal path for older boxes. Not verified: how the app learns a box's gateway version.
- I did not run any test or typecheck command; the commands listed are read from convention and the AGENTS.md text, not executed.

Commands:
- `cd /Users/williamcory/smithers/apps/server && bun test src/gatewayRpc.test.ts`
- `cd /Users/williamcory/smithers/apps/server && bun test src/index.test.ts -t "rpc relay"`
- `cd /Users/williamcory/smithers/apps/server && pnpm run check   # typecheck + effect policy, per apps/server/AGENTS.md`
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/state/controller/gateway.test.ts src/mainview/cards/EngineTrace.test.ts`
- `jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx`

### Landing the flow builder + run monitor safely on a hot shared main (jj, lanes, autodeploy, CHAT.md)

Land the flow builder dark behind an AppFeatures flag, from locked jj lane workspaces, by duplicating reviewed commits onto a captured main id. Every push to main deploys to production within minutes.

Snapshot at 2026-09-19 about 03:20Z:
- main equals main@origin at 44545559b4bd.
- The main checkout @ (3e7ad5da) sits on b6d6ece7, 15 commits behind main.
- The main checkout holds 88 uncommitted peer changes. They include all of docs/flow-builder/** and apps/app/src/mainview/experimental/**, none of which is on main.
- 42 jj workspaces exist.
- CL095 reports that main@origin fails apps/app `pnpm run check` with five errors.
  - I did not run the check. I confirmed the `socketUrl` sites and the "experimental" card kind are still in main's source.
  - I assume the five errors still stand.
  - The L105 fixes are unlanded in a lane workspace.

Procedure:
1. Announce in CHAT.md before anything else (format in item 6). Do not run `jj new`, `jj commit`, `jj squash`, `jj edit` or `jj rebase` in ~/smithers. The main checkout working copy belongs to a peer.
2. Create lanes one at a time under `fcntl.flock`, with "smithers" in the path so the guard sees it:
   - `jj workspace add ~/smithers-lane-fb-<name> -r main --name lane-fb-<name>`
   - Launch detached with `GIT_CEILING_DIRECTORIES=$HOME`.
   - Reuse the launch.py pattern (lock at lines 23-29, double fork at 14-16).
   - If the main checkout wedges, run `jj --ignore-working-copy op integrate <op>` then `jj workspace update-stale`.
3. Give each lane node_modules.
   - Preferred: a real `pnpm install --frozen-lockfile --ignore-scripts` in the lane, then `node apps/app/scripts/ensure-devkit.mjs`.
   - If the install dirties pnpm-lock.yaml, restore it with `jj restore --from @- -- pnpm-lock.yaml`. Never land it.
   - Fast alternative: relink.py. It builds real directories, symlinks third-party entries, and recreates @smthrs links so they resolve inside the lane.
   - Never use a single naive symlink of node_modules.
   - Lanes cannot see docs/flow-builder. Point their prompts at /Users/williamcory/smithers/docs/flow-builder by absolute path.
4. Verify in the lane:
   - `pnpm --filter smithers-app run check` (ensure-devkit + `tsc --noEmit`).
   - `cd apps/app && bun test <touched dirs>`.
   - Packages you touch outside apps/app (apps/server, packages/rpc): run their PACKAGE.ts commands.
   - Compare failing sets against an unmodified main workspace. If the five CL095 errors still stand, they fail identically and are not yours.
   - Do not run the whole `bun test` over apps/app/src/bun. It leaks daemons.
5. Land using the handoff.md:981-986 recipe, in a fresh workspace:
   - `jj git fetch`, then capture the main id.
   - `jj duplicate <oldest>::<newest> --onto <captured main>`, then `jj new`.
   - Check conflicts with a newline template and `jj resolve --list`.
   - Typecheck the combined tree, then fetch again.
   - `jj bookmark set main -r <head>` and `jj git push --bookmark main`, never forced.
   - Fetch again and assert main@origin equals the head you wanted.
   - Assert `jj diff --name-only -r <each commit>` equals your literal file list.
   - Write a receipt under `.artifacts/` and never commit it.
   - `jj workspace forget` the lane and remove only that directory.
6. Landing is the deploy request.
   - Any Claude Stop on this machine builds local main, deploys the Worker and probes both hosts.
   - A red typecheck does not block a deploy. b6d6ece7 deployed at 03:05Z even though CL095 reports it failing `pnpm run check`.
   - The flag this step added is gone: D-080 (Will, 2026-09-20) removed it, and the feature is the app.
   - After each landing, grep autodeploy.log for deployed or FAILED, and check /__build.json on both hosts.
   - Announce using the next id after CL095: `## FB001 (Claude flow-builder, <UTC>): ...`. List exact paths owned, lane workspace names, the flag name and the intended landing window. Post again before each landing with the base main id and the file list.

- main equals main@origin at 44545559b4bd. The main checkout @ is 3e7ad5da, sits on b6d6ece7 and is 15 commits behind main. — jj log: '@ 3e7ad5da2600' / '◆ 44545559b4bd main* ... fix(opencode): the dot tells the truth' / '◆ b6d6ece7a378 refactor(app): strip the residue'; 'jj log -r @-..main | wc -l' = 15; 'main@origin..main' and 'main..main@origin' both empty
- The main checkout carries 88 uncommitted changes, 53 of them under apps/app/src/mainview. Others touch packages/rpc/src/Cards.ts, packages/smithers/agent and docs/flow-builder/**. — jj st | grep -c '^[AMD] ' = 88; per-directory counts: '53 apps/app/src/mainview', '16 docs/flow-builder/mockups/source', '1 packages/rpc/src/Cards.ts'
- docs/flow-builder and apps/app/src/mainview/experimental are not on main. Lanes created at main will not contain the spec or the mock. — jj file list -r main docs/flow-builder -> 'Warning: No matching entries for paths: docs/flow-builder'; same warning for apps/app/src/mainview/experimental
- 42 jj workspaces exist, most of them stale and empty. — 'jj workspace list | wc -l' = 42; examples: l102c, l103b-base, mvp-main-red, r104b-verify, autodeploy, default
- CL095 (the last CHAT.md message) says main fails the apps/app typecheck with five errors that belong to main itself. — /Users/williamcory/smithers/CHAT.md:4356-4358 '**`main@origin` FAILS `pnpm run check` in `apps/app`, exit 2, five errors, and it is main's own**' ... 'socketUrl no longer exists on AppServices (cards/FileCards.test.tsx:423, ChromeDock.test.tsx:78,98) and presentation.ts:508,513'
- main at 44545559 still contains the socketUrl and 'experimental' sites CL095 names. I did not run the typecheck, so I assume the five errors still stand. — jj file show -r main apps/app/src/mainview/cards/FileCards.test.tsx:423 '{ bootstrap, socketUrl: () => undefined }'; ChromeDock.test.tsx:78,98 'socketUrl: () => undefined'; apps/app/src/mainview/state/controller/presentation.ts:508 'kind: "experimental",'
- The L105 fixes sit unlanded in a lane workspace. One of them removes the 'experimental' surface from main, which collides with the peer's experimental panes. — jj log main@origin..(mvp-main-red@|l102c@): 'c519b8e7d8d8 fix(app): two harnesses stop binding a socket URL the app no longer takes', 'c5310bf0e5d1 fix(app): the app stops naming a hidden-mock surface it does not carry'
- The peer's uncommitted work in the main checkout already removes socketUrl from the two test files. — jj diff --stat in ~/smithers: 'ChromeDock.test.tsx | 6 ++----', 'FileCards.test.tsx | 2 +-'; diff lines '-    socketUrl: () => undefined'
- Autodeploy runs on every Claude Stop. It deploys local main to both production hosts, and a failing typecheck does not block it. — ~/.config/smithers-autodeploy/README.md:3-4 'The runner checks local `main` in `~/smithers` and `~/plue`, deploying exact SHAs... Smithers installs, deploys, probes both hosts, and rolls back'; autodeploy.log '20260919T030508Z smithers: deployed b6d6ece7a378...', '20260919T031017Z smithers: deployed 81bca45092e9...' (CL095 lists b6d6ece7 among the commits that introduced the typecheck break)
- The memory rule says to treat landing as the deploy request, to batch landings, and never to run autodeploy.py --status. — memory/gotcha_autodeploy_stop_hook_is_the_concurrent_deployer.md:13,18 'Never run `autodeploy.py --status` into context' ... 'treat landing on main as the deploy request; review source before landing; ... expect a new build within about two minutes of any landing; batch landings. Do not disable Will's hook without his word.'
- An existing lane launcher serializes workspace creation with a file lock, double-forks, and sets GIT_CEILING_DIRECTORIES. — /private/tmp/claude-501/-Users-williamcory-smithers/3b6439be-18fc-4315-bbbf-21b5e207714a/scratchpad/lanes/launch.py:14-16 'os.fork()/os.setsid()', :21 'env["GIT_CEILING_DIRECTORIES"]', :23-25 'fcntl.flock(lockf, fcntl.LOCK_EX) ... ["jj","workspace","add",WS,"-r","main","--name",f"lane-{LANE}"]', :32 'pnpm install --frozen-lockfile --ignore-scripts'
- Older mk-lane.sh and land-lane.sh scripts and a COMMON.md of lane rules exist. mk-lane.sh takes no lock, and land-lane.sh rebases instead of duplicating. — /private/tmp/claude-501/-Users-williamcory-smithers/b6c414e5-c369-46d1-9426-087b5f16d451/scratchpad/lanes/mk-lane.sh:11 'jj workspace add --name "lane-$name" -r 'main@origin' "$dir"', :13-14 'pnpm install --offline --frozen-lockfile --ignore-scripts' + 'ensure-devkit.mjs'; land-lane.sh:12-20 'jj rebase -s "$roots" -d main@origin' ... 'jj bookmark set main' ... 'LANDED $landed on origin/main'
- relink.py builds a node_modules tree per workspace whose @smthrs links resolve inside the lane. It reads a path list from /tmp/nm-list.txt. — /private/tmp/claude-501/-Users-williamcory-smithers/0e1351fc-245a-4227-96f5-321836e5ce30/scratchpad/relink.py:3 'paths = [... open("/tmp/nm-list.txt")...]', :5-16 workspace_link returns the relative readlink target, :35 'os.symlink(wl, dp)'
- A naive single symlink of node_modules makes @smthrs/* resolve into ~/smithers and invents typecheck errors. The working recipe is documented. — memory/gotcha_symlinked_node_modules_resolves_to_main_checkout.md:12-13 '`@smthrs/rpc` resolves through the symlink into **~/smithers' working copy**', :30-33 'create a real directory at the same relative path, symlink each entry ... EXCEPT `@smthrs`, and recreate `@smthrs/<name>` with the SAME relative target'
- Concurrent `jj workspace add` calls wedge the main checkout. The fix is a file lock, and the repair is `op integrate` with `--ignore-working-copy`. — memory/gotcha_jj_workspace_add_races_need_a_lock.md:11,15 'Four of them failed with `The repo was loaded at operation X, which seems to be a sibling`' ... 'wrap `jj workspace add` in an exclusive file lock ... Repair: `jj --ignore-working-copy op integrate <Y>` then `jj workspace update-stale`'
- The release owner's landing recipe duplicates reviewed commits onto a captured main id in an isolated workspace, fetches again, sets the bookmark and pushes without force. — /Users/williamcory/smithers/handoff.md:981-986 'jj workspace add --name <unique-name> -r main /tmp/<unique-name>' ... 'jj duplicate <oldest-reviewed> <next-reviewed> --onto <captured-main-id>' ... 'jj bookmark set main -r <integrated-head>` and `jj git push --bookmark main` ... Use no force push' ... 'jj workspace forget <unique-name>'
- The guard blocks agent-typed git everywhere in smithers and blocks `jj duplicate` and second stacks in the main checkout. Secondary workspaces are unrestricted. The guard activates only when the path contains the repo basename. — ~/.config/smithers-agent-guard/README.md:3-5 'block agent-typed git ... Secondary jj workspaces remain unrestricted', :16-18 'shims start Python only when the current directory or an argument contains the repo's basename. Workspaces should retain that basename'; handoff.md:981 'The main-checkout wrapper blocks `jj duplicate`'; live: 'error: git is disabled for AI agents in the smithers repo. Use jj.'
- Never commit with a catch-all fileset and never park @ on a commit in the shared tree. Use `jj squash --use-destination-message` with `JJ_EDITOR=true`. — memory/gotcha_catchall_fileset_swallows_peer_work.md:16-19 'Enumerate explicit paths for every `jj commit`' ... 'Never leave `@` on a real commit' ... 'Always `jj squash --use-destination-message`, and set `JJ_EDITOR=true`'
- The post-rebase guard asserts the lane's own commit file list against a literal list, because main@origin is shared and drifts. — memory/gotcha_origin_main_ref_shared_across_worktrees.md:33-36 'put the guard *inside* the fetch→rebase→push retry loop and compare against a literal expected file list ... Guard on `git diff --name-only HEAD~1 HEAD`'
- `pnpm install` dirties pnpm-lock.yaml in every workspace through the apps/server alchemy and effect drift. Restore it and do not land it. — memory/gotcha_main_lockfile_drift_apps_server_alchemy.md:14,19 'every `pnpm install` in any worktree regenerates those ~6 lines' ... 'back the diff up, restore pnpm-lock.yaml, rebase'
- main has an AppFeatures flag mechanism. The `experimental` member and its VITE env fallback exist only in the uncommitted working copy. — main AppController.ts:672-680 '* Feature flags. `suggestionPills` ... readonly features?: AppFeatures'; working copy AppController.ts:683-690 'pluginLibrary?, wiki?, mythicalHistory?, suggestionPills?, experimental?'; :705 'experimental: services.features?.experimental ?? import.meta.env?.VITE_SMITHERS_EXPERIMENTAL === "true"'
- The apps/app gates are `check` and `typecheck` (ensure-devkit then tsc) and `bun test`. — apps/app/package.json:14-16 '"typecheck": "node scripts/ensure-devkit.mjs && tsc --noEmit"', '"check": ...same', '"test": "bun test src e2e/contracts e2e/real/coverage scripts"'
- Known apps/app and gateway reds on main: ControllerTestScope, parity x3 (IntroSlides), gateway coverage thresholds, and the three 2026-09-13 reds. — memory/index_reds.md:71 'apps/app `bun test src/mainview/state/ControllerTestScope.test.ts`: red on main since before 346206753c8c'; :14 'flows/parity 3 fails on main'; :53 'packages/smithers/gateway vitest exits non-zero on main itself; 376/376 tests pass but 100% global coverage thresholds fail'; :66
- The release owner states landings with a receipt path and the main sha in each CL message. The CHAT id series is per agent, and CHAT.md is append-only and untracked. — CHAT.md:4350 '**Landed as main `7a854f57481d`** (receipt `.artifacts/mvp-release-20260916/app-landing-20260919T0110Z.json`)'; memory/project_mvp_alpha_orchestration_20260916.md:11 'append-only mailbox `~/smithers/CHAT.md` (untracked...; read the tail, never the whole file). IDs: C### Codex root ... CL### Claude', :34 'announce ownership with exact paths before any edit; all source review happens before landing on main because landing deploys'
- main moved three times during one release-owner verification. Expect to re-duplicate. — CHAT.md:4360 'main moved twice during verification (`7a854f57481d` → `9f74c2feff1c` → `b6d6ece7a378`); the first duplicate stack was abandoned and the chain re-duplicated, zero conflicts both times'
- Review evidence and lane reports are never committed. — memory/feedback_review_evidence_never_committed.md:15 'never group `review-evidence/**` or root `*-review*.md` ledgers into a package commit'
- Workflow agents die silently on a session limit. Eleven concurrent Opus lanes exhausted the quota once, and both Codex accounts are limited until 09-20 and 09-22. — memory/project_mvp_alpha_orchestration_20260916.md:19 'eleven concurrent Opus `Agent` lanes exhausted the Claude session limit'; :17 'codex-1 ... until Sep 22 09:22, codex-2 ... until Sep 20 09:23'; CHAT.md:4192 'Opus-only from here'

Blockers:
- CL095 (CHAT.md:4356-4358) reports that main@origin fails apps/app `pnpm run check` with five errors. I did not run the check; main's source still has the sites CL095 names. The L105 fixes (c519b8e7d8d8, c5310bf0e5d1) are unlanded. Until they land, a lane cannot show a green check. It can only show a failing set identical to unmodified main's.
- The spec and the mock (docs/flow-builder/**) exist only as uncommitted files in the main checkout working copy, which sits 15 commits behind main. A lane created at main does not contain them. Lanes must read /Users/williamcory/smithers/docs/flow-builder by absolute path, or someone must land the docs with an explicit fileset first. Do not commit them from the shared checkout with a catch-all fileset.
- Collision: L105 commit c5310bf0e5d1 removes the 'experimental' surface from main while the peer's 53-file experimental work sits uncommitted in the main checkout. Reusing the experimental card kind or the VITE_SMITHERS_EXPERIMENTAL flag for the flow builder builds on a moving target. Add a separate flowBuilder flag. (Reversed by D-080: the flag was removed and the feature ships to everyone.)
- Every Claude Stop on this machine, including the new orchestrator's and its `claude -p` children, runs autodeploy against local main. `jj bookmark set main` in any workspace moves local main, so setting the bookmark is already a deploy request even before the push. Set it only on a fully verified head.
- Quota: both Codex accounts are usage-limited until 09-20 and 09-22. The release owner is Opus-only, and its lanes share the same Claude session limit. A large fan-out can kill the release owner's lanes silently, because workflows stay 'running'. Cap concurrency, and check agent-*.jsonl mtime.
- The smithers MCP server failed to connect in this session (CONNECTION_CLOSED). It was not needed for this read-only map.

Commands:
- `cd ~/smithers && jj git fetch && jj log --no-graph -r 'main | main@origin' -T 'commit_id.short(12) ++ " " ++ bookmarks ++ "\n"'`
- `python3 <scratchpad>/lanes/launch.py fb-<name>   # flock + jj workspace add ~/smithers-lane-fb-<name> -r main --name lane-fb-<name> + pnpm install --frozen-lockfile --ignore-scripts`
- `cd ~/smithers-lane-fb-<name> && node apps/app/scripts/ensure-devkit.mjs && jj restore --from @- -- pnpm-lock.yaml`
- `cd ~/smithers-lane-fb-<name> && pnpm --filter smithers-app run check   # = node scripts/ensure-devkit.mjs && tsc --noEmit (apps/app/package.json:15)`
- `cd ~/smithers-lane-fb-<name>/apps/app && bun test src/mainview/<touched-dir>   # never the whole src/bun tree`
- `env -i HOME=$HOME PATH=$PATH TMPDIR=$TMPDIR TERM=dumb CI=1 <test cmd>   # only for build-cli suites (secret redactor false reds)`
- `jj log --no-graph -r 'conflicts() & (main@origin..@)' -T 'commit_id.short(12) ++ "\n"' ; jj resolve --list`
- `jj duplicate <oldest>::<newest> --onto <captured-main-id> && jj new <head>   # in a lane workspace, never in ~/smithers`
- `jj git fetch && jj bookmark set main -r <head> && jj git push --bookmark main && jj git fetch && jj log --no-graph -r main@origin -T commit_id`
- `grep -E 'deployed|FAILED' ~/.config/smithers-autodeploy/autodeploy.log | tail -3 ; curl -s -H 'cache-control: no-cache' https://smithers.sh/__build.json ; curl -s https://canary.smithers.sh/__build.json`
- `/usr/bin/python3 ~/.config/smithers-autodeploy/autodeploy.py --force --repo smithers   # only after a wrangler 'fetch failed'; launch it detached`
- `jj workspace forget lane-fb-<name> && rm -rf ~/smithers-lane-fb-<name>`
- `Repair a wedge: jj --ignore-working-copy op integrate <op-id> && jj workspace update-stale`

### duration predictions (D-030)

No duration estimator exists anywhere in the engine or app, and D-030's stated source is wrong as written: flows_attempts has no action-tag column (only run_id, step_key_digest, attempt, timestamps, meta_json with tier/boundary fields), so "group flows_attempts by action tag" needs a join that does not exist. The action tag does exist on every PlanNode as material.body.action (ActionCall) or material.body.flow (FlowCall), and the journal already carries per-node timing keyed by plan node id: flows.engine.node-scheduled and node-settled (outcome built|clean|failed|skipped|deferred) with ControlEvent.occurredAt, served verbatim by the run-events projection the app already pages. Smallest honest predictor: (1) engine adds `action` to the node-scheduled/node-settled payload (one field, from node.material.body); (2) gateway serves an eighth projection `flow-durations {flowId}` folding the last 20 terminal runs of that flow into rows { flowId, actionTag, samples, p50Ms, p90Ms }, counting only outcome "built" (clean = cache hit = not a sample), duration = settled.occurredAt minus the last node-scheduled.occurredAt for that node; (3) the app computes critical-path ETA and the re-key estimate as pure functions over PlanCard.nodes.dependsOn + those rows. App-side-only folding over retained card events is rejected: history would exist only for runs whose cards this client opened, so a fresh device shows nothing and two devices disagree. Cold start: no row for a tag means no chip; any executing node without a row means no ETA and no re-key estimate (never a partial sum). Note the mock sums node durations serially (FIRST_RUN_MS/REKEY_RUN_MS are reduce sums), which overstates a fanned-out plan; the shipped number must be the longest path over dependsOn. Agent budget "forecast" is money, not time, and is unrelated.

- D-030 rules p50 with sample size, range when p90/p50 > 3, nothing when no history, and names flows_attempts grouped by action tag as the source; it states no predictor exists. — /Users/williamcory/smithers/docs/flow-builder/decisions.md:278-285 "Source: `flows_attempts.started_at_ms / finished_at_ms` grouped by action tag ... No predictor exists in the engine today; this is new engineering work and needs a projection."
- flows_attempts has no action tag or node id column; identity is (run_id, step_key_digest, attempt). — /Users/williamcory/smithers/packages/smithers/flows/run-store/src/migrations/0001_initial.ts:74-88 "CREATE TABLE flows_attempts ( run_id ..., step_key_digest ..., attempt ..., state ..., started_at_ms INTEGER NOT NULL ..., finished_at_ms INTEGER ..., meta_json TEXT NOT NULL ..., PRIMARY KEY (run_id, step_key_digest, attempt)"
- Attempt meta_json carries tier, nondeterministic, boundary, readSetVerified, boundaryQuarantined, hardViolation, snapshotId, admittedBy, effectCrossing; no action name. — /Users/williamcory/smithers/packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts:319-378 "const AttemptMeta = Schema.Struct({ tier: Schema.Literals([\"sealed\", \"compensable\", \"irreversible\"]), ... effectCrossing: ..."
- AttemptStore exposes put/get/heartbeat/finish/patch only; there is no cross-run or per-flow listing API to aggregate durations. — /Users/williamcory/smithers/packages/smithers/flows/run-store/src/AttemptStore.ts:317-344 "readonly put ... readonly get: (id: AttemptId) ... readonly finish ... readonly patch"
- Attempt rows record startedAtMs and optional finishedAtMs. — /Users/williamcory/smithers/packages/smithers/flows/run-store/src/AttemptStore.ts:161-162 "startedAtMs: NonNegativeSafeInt, finishedAtMs: Schema.optionalKey(NonNegativeSafeInt)"
- Journal attempt-started / attempt-finished payloads carry runId, stepKeyDigest, attempt, tier|state; no action tag, no node id, no timestamp in payload. — /Users/williamcory/smithers/packages/smithers/flows/journal/src/EngineEvent.ts:373-392 "eventType: Schema.Literal(\"flows.engine.attempt-started\"), payload: Schema.Struct({ ... runId, stepKeyDigest: Event.DispatchId, attempt, tier ..."
- The v2 attempt-lifecycle event carries startedAtMs and finishedAtMs but is still keyed by stepKeyDigest, and warns clocks can run backwards. — /Users/williamcory/smithers/packages/smithers/flows/journal/src/EngineEvent.ts:82-131 "const timing = { startedAtMs: Event.TimestampMs }" ... "Wall clocks can move backwards; completion need not be after start." ... "stepKeyDigest: Event.DispatchId"
- node-scheduled carries planId, nodeId, kind, planKey, dispatchKey, attempt, priority, waited; no action tag. — /Users/williamcory/smithers/packages/smithers/flows/engine-store/src/PlanScheduler.ts:1048-1057 "JournalRecords.nodeScheduled(source(`node/${node.id}/${attempts}`), { planId: plan.planId, nodeId: node.id, kind: node.kind, planKey: node.key, dispatchKey, attempt: attempts, priority: node.priority, waited: start.waited })"
- node-settled carries planId, nodeId, planKey, dispatchKey, outcome, attempts, rebases. — /Users/williamcory/smithers/packages/smithers/flows/engine-store/src/PlanScheduler.ts:966-974 "JournalRecords.nodeSettled(... { planId: plan.planId, nodeId: node.id, planKey: node.key, dispatchKey: state.dispatchKey, outcome: state.outcome, attempts: state.attempts, rebases: state.rebases })"
- Outcome distinguishes executed work from a cache hit: built vs clean, decided by whether the executor ran. — /Users/williamcory/smithers/packages/smithers/flows/engine-store/src/PlanScheduler.ts:125 "export type Outcome = \"built\" | \"clean\" | \"failed\" | \"skipped\" | \"deferred\"" and :1113 "outcome: (yield* Ref.get(ran)) ? \"built\" : \"clean\""
- The stable 'kind of step' identifier is KeyMaterial.body.action for an action node (a string) and body.flow for a flow call; the body also holds schema identities and implementationVersion, so the whole body is NOT stable across re-keys, only the tag is. — /Users/williamcory/smithers/packages/smithers/flows/flow/src/Graph.ts:1193-1204 "body: { _tag: \"ActionCall\", action: ast.action, tier: ..., declaration: ... { payload: schemaIdentity(...), success: ..., error: ..., implementationVersion } }"; :1015-1018 "body: { _tag: \"FlowCall\", flow: call.flow, mode: call.mode"; /Users/williamcory/smithers/packages/smithers/flows/plan/src/internal/node.ts:217-221 "export interface ActionCall ... readonly action: string"
- PlanNode exposes material (KeyMaterial with body: Unknown) and dependsOn, so the app can read the action tag and the edge set from the Plan RPC result with no engine change. — /Users/williamcory/smithers/packages/smithers/flows/plan/src/Plan.ts:143-155 "export const PlanNode = Schema.Struct({ id, kind: NodeKind, key, material: KeyMaterial.KeyMaterial, effects, dependsOn: Schema.Array(Schema.NonEmptyString), ..."; /Users/williamcory/smithers/packages/smithers/flows/plan/src/KeyMaterial.ts:66-76 "body: Schema.Unknown"
- Node kinds are step, agent, merge. — /Users/williamcory/smithers/packages/smithers/flows/plan/src/Plan.ts:99 "const NodeKind = Schema.Literals([\"step\", \"agent\", \"merge\"])"
- run-events rows are the journal itself with a timestamp: ControlEvent { sequence, kind, runId, occurredAt, payload }, paged at 1000. — /Users/williamcory/smithers/packages/smithers/control/src/ControlSchema.ts:812-820 "sequence: Schema.Number, kind: Schema.String, runId: ..., occurredAt: Schema.Number, payload: Schema.Json"; /Users/williamcory/smithers/packages/smithers/gateway/src/Projections.ts:110 "export const maxEventsPerPage = 1_000"
- RunSummaryRow has createdAt/updatedAt and counters (turns, calls, callsFailed, edits, inputTokens, outputTokens) but no duration, startedAt, finishedAt or per-node timing. — /Users/williamcory/smithers/packages/smithers/gateway/src/GatewayProjection.ts:32-70 "createdAt: Schema.Number, updatedAt: Schema.Number, ... turns: Schema.Number, calls: Schema.Number, callsFailed ..., inputTokens, outputTokens"
- RunTreeRow has startedAt/endedAt but its nodeId is an ordinal, so it cannot be joined to plan nodes. — /Users/williamcory/smithers/packages/smithers/gateway/src/GatewayProjection.ts:85-100 "`nodeId` is the ordinal the call opened on, because the emitter names no node." ... "startedAt: Schema.Number, endedAt: Schema.optional(Schema.Number)"
- Adding a projection is one entry in the served table plus one case in the fold switch. — /Users/williamcory/smithers/packages/smithers/gateway/src/GatewaySchema.ts:164-179 "serving one more projection is one more entry here rather than five mirrored lists"; /Users/williamcory/smithers/packages/smithers/gateway/src/Projections.ts:522-536 "switch (selector._tag) { case \"workspace-runs\": ... case \"node-output\": ..."
- The only 'forecast' in the engine is the agent Budget's cost reservation, not a duration. — /Users/williamcory/smithers/packages/smithers/agent/src/Budget.ts:44-46 "Admission reserves a soft forecast. Before dispatch, `reserve` counts actual spend plus all in-flight estimates, using the largest observed call."
- The only latency field in agent events is ClaimDemanded.latencyMs (completion-brake evaluation time), not step duration. — /Users/williamcory/smithers/packages/smithers/agent/harness/src/AgentEvent.ts:582-583 "/** Wall-clock milliseconds the evaluation took. */ latencyMs: Schema.Int"
- Step-cache entries record createdAtMs (used for age bounds) and no production duration. — /Users/williamcory/smithers/packages/smithers/flows/step-cache/src/CacheStore.ts:73 "both carry the `createdAtMs` the age is measured from"; grep for durationMs in flows/step-cache/src returned nothing
- grep for estimate|eta|forecast|expectedDuration|p50|percentile in apps/app/src (non-test) finds only a hardcoded desktop boot hint; no run or node estimator. — /Users/williamcory/smithers/apps/app/src/mainview/state/seams/WorkspaceSeam.ts:113-114 "const desktopBootEstimateSeconds = 20 / const desktopReadyEstimateSeconds = 60"
- The app already folds engine attempt events into spans with start/end, keyed by stepKeyDigest, and does not read node-scheduled/node-settled outside experimental fixtures. — /Users/williamcory/smithers/apps/app/src/mainview/cards/EngineTrace.ts:193-201 "if (envelope.eventType === \"flows.engine.attempt-started\" || ... \"attempt-finished\") ... current.endedAt = envelope.emittedAtMs"; grep hits for node-scheduled only in mainview/experimental/panes/Journal.tsx:47
- The app retains each run's journal on its run-trace card payload and reads suffix pages per pump cycle, so app-side history exists only for runs with a card on this client. — /Users/williamcory/smithers/apps/app/src/mainview/state/controller/workflow-pump.ts:252 "let retainedJournal: Extract<Card, { kind: \"run-trace\" }>[\"payload\"][\"events\"]" and :123 "cursor = { selector: { _tag: \"run-events\", runId }, ..."
- The app calls Plan through the relay today. — /Users/williamcory/smithers/apps/app/src/mainview/state/controller/gateway.ts:244 "const planned = await call(repo, \"Plan\", { flowId, input }, binding)"
- The relay allowlist is by procedure name mapped to a path; Projection.Snapshot maps to /projections, so a new selector needs no relay change (selector-level validation in the relay not found by grep). — /Users/williamcory/smithers/apps/server/src/gatewayRpc.ts:52 "\"Projection.Snapshot\": \"/projections\","
- The mock's run and re-key figures are serial sums of node ms, not a critical path. — /Users/williamcory/smithers/docs/flow-builder/mockups/source/src/flow.ts:370-377 "export const FIRST_RUN_MS = NODES.filter(...).reduce((total, node) => total + node.ms, 0)" / "export const REKEY_RUN_MS = REKEYED.reduce(...)"

Blockers:
- D-030's premise is false as written: flows_attempts cannot be grouped by action tag (no tag, no node id; only step_key_digest, which changes on every re-key). Someone must accept the journal node-event source or approve a run-store migration adding an action column; the journal route needs no migration.
- Existing journals carry no action tag on node events, so history before the PlanScheduler change yields zero samples unless the gateway also maps nodeId->tag through the stored plan (PlanStore by planId). Not verified whether the gateway process can read PlanStore; if it cannot, prediction starts cold for every flow on ship day.
- Action tag alone conflates call sites with very different payloads (same action over a small and a huge package). The p90/p50 > 3 range rule absorbs this but will show ranges often; refinement to (flowId, nodeId) is deferred until a real flow shows it. Node ids being author-stable across edits was inferred from test fixtures (nodeId: "dependent", "lane-b+merge"), not proven from the id-minting code.
- Agent nodes (kind 'agent') have model-dependent, heavy-tailed durations; a p50 from <3 samples is weak. No minimum-sample rule is in D-030; recommend rendering from samples >= 1 as ruled but always showing n.
- Cost of the flow-durations snapshot (up to 20 journals x maxEventsScanned 100_000) is unmeasured; needs a bound or a cached carry before it is called from a polling client.
- Whether apps/server relay or the gateway validates selector tags against a fixed list beyond the served table was not fully traced; only the procedure-name allowlist was confirmed.
- smithers MCP server failed to connect in this session (CONNECTION_CLOSED); nothing here depended on it. Nothing was run: test commands below are read from package.json, not executed (read-only task).

Commands:
- `cd /Users/williamcory/smithers/packages/smithers/gateway && pnpm vitest run test/GatewayProjection.test.ts test/Projections.test.ts test/GatewaySchema.test.ts test/WireFormat.test.ts`
- `cd /Users/williamcory/smithers/packages/smithers/flows && pnpm vitest run engine-store/test/PlanScheduler.test.ts`
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/cards/flowGraph/Durations.test.ts`
- `cd /Users/williamcory/smithers/apps/app && pnpm typecheck`
- `cd /Users/williamcory/smithers/apps/app && pnpm lint:conformance`
- `cd /Users/williamcory/smithers && pnpm docs:llms  # then check-docs and check-llms, required after the gateway projection count changes`
- `env -i HOME=$HOME PATH=$PATH TMPDIR=$TMPDIR TERM=dumb CI=1 <test command>  # if exported *_API_KEY values cause false reds`

### End-to-end testing for the flow builder + run monitor with no mocked backend (apps/app e2e tiers, card/pump unit harness, gateway real-engine suites, CI wiring)

No tier today runs a deterministic flow against a real local gateway in Chromium; the recipe below has to be built from three parts that exist.

**What exists today**
- T1 (`playwright.config.ts`, port 47311) replaces the gateway with `page.route("**/api/workflow/rpc")` and fixture journals.
- `e2e/real` (`playwright.real.config.ts`, port 47321) is backend-real but depends on production. It needs a saved GitHub profile, a fresh GitHub repo import, a Cloud workspace VM, and LLM-driven `/flow.create`. Timeouts are 30 min per test, and no GitHub workflow runs it.
- Neither tier uses wrangler or port 8788. The 8788 gotcha applies only to Will's site dev proxy.

**The three parts to assemble**
- `packages/smithers/gateway/test/RealEngineRun.ts` is a real control plane plus a real `NodeRuntime` engine over two SQLite files, running a real `Flow`/`Action`. I ran it: 3 pass, 13 s.
- `apps/app/scripts/gateway-run-proof.ts` is a loopback `NodeGateway` plus a Node relay that uses the Worker's own `GATEWAY_PROCEDURE_MOUNTS` and encode/decode.
- `startLocalServer({ cloudMode: "hybrid", identityUpstream })` forwards `/api/workflow/*` to `identityUpstream`.
- A fixture host that composes RealEngineRun-style layers, the relay, and the local server gives a Chromium-drivable stack that is fully real and needs no credentials.

**Stock `smthrs serve` cannot host the fixture**
- It exists and needs no bearer on loopback.
- A native module flow needs in-process `Interpreter`/`Action` layers, so a HumanTask, catch, or retry fixture cannot load from disk alone.

**Corrections to "known so far"**
- Engine node events can reach clients. The CLI host wires `EngineJournalSupervisor` at `NativeControl.ts:745`, which copies `flows.engine.*` into the control journal as `control.engine.event` envelopes.
- The gateway `Projections.ts:752` and the app's `EngineTrace.ts` already decode that envelope.
- The `RealEngineRun.ts` test stack does not wire the supervisor, so its test asserts that the client sees none of those records.

**Unit harness and CI**
- Card bodies are tested with bun test + `@happy-dom/global-registrator` + `react-dom/client` `createRoot` + `act`, against a real `createAppStore`. There is no vitest in apps/app. I ran 109 tests across 4 files in 7.8 s at load average 32.
- CI: `//apps/app:check`, `unitTests`, `conformance` and `browserE2e` run in the `apps-e2e` job. `ci.yml` is generated by `Smithers.GithubCiGen` in root `PACKAGE.ts`, and the drift lint is `//:ci`.

**Blocker**
- `pnpm --filter smithers-app proof:gateway` is red on the working copy at step 2, "FAILED: the seam launched a run".

- T1 Playwright tier: testDir e2e/playwright, port 47311, 1 worker, webServer builds SPA and boots in-process test host with chat stub — apps/app/playwright.config.ts:11 `const PORT = Number(process.env.SMITHERS_E2E_PORT ?? "47311")`; :33 `command: "bun e2e/playwright/webserver.ts"`; timeout 240_000
- The T1 host is offline with identityUpstream null, so /api/workflow/* cannot reach any relay; specs double it in the browser — apps/app/scripts/browser-test-host.ts:22-24 `cloudMode: realChat ? "hybrid" : "offline", cloudApi: null, identityUpstream: null`; apps/app/e2e/playwright/runs.spec.ts:67 `await page.route("**/api/workflow/rpc", async (route) => {`
- T1 runs.spec.ts drives run cards from fixture journals and a fixture plan, which is not engine-true — apps/app/e2e/playwright/runs.spec.ts:6-7 `import { earlyCodingJournal } from "../../src/mainview/cards/fixtures/CodingJournal"` / `import { CODING_PLAN } from "../../src/mainview/cards/fixtures/CodingPlan"`
- Real tier: testDir e2e/real, port 47321, serves via `bun scripts/run-real-e2e.ts serve`, refuses the chat stub, 90 s default test timeout, webServer timeout 300 s — apps/app/playwright.real.config.ts:5,17,28,39-46 `command: "bun scripts/run-real-e2e.ts serve"` ... `SMITHERS_CHAT_STUB: "0"`
- The real host is startLocalServer in hybrid mode with default upstreams (canary Worker), isolated temp home — apps/app/scripts/run-real-e2e.ts:34-40 `startLocalServer({ port, distDir, home, stateDir, cloudMode: "hybrid" })`; apps/app/src/bun/server.ts:67 `DEFAULT_IDENTITY_UPSTREAM = "https://canary.smithers.sh"`
- flow-execution.spec.ts stands up its backend by creating a real GitHub repo, importing it to Smithers Cloud, waiting for a running workspace VM, then POST /api/workflow/provision. No wrangler, no local smthrs serve, no seeded local workspace — apps/app/e2e/real/flow-execution/fixture.ts:119-121 `createOwnedGitHubRepository(context, name)`; :36 `"/api/cloud/api/github/import"`; :60 `realApi(page, request, "POST", "/api/workflow/provision", { repo, workspaceId })`
- The real flow specs are LLM-driven and nondeterministic (/flow.create with prose), with a 30-minute per-test budget — apps/app/e2e/real/flow-execution.spec.ts:17 `workflowTest.setTimeout(30 * 60_000)`; :236 `command(page, `/flow.create create a workflow with the exact id ${marker}; declare one required string input...`
- The read-only real canaries need a preconfigured repo + workspace env and the saved test account — apps/app/e2e/real/flow-execution/fixture.ts:259-262 `SMITHERS_REAL_CONFIGURED_REPO and SMITHERS_REAL_CONFIGURED_WORKSPACE must name the canary's prepared coding workspace` / `repo.startsWith("codeplanesmithers/")`
- The local origin forwards /api/workflow/* to identityUpstream. This is the seam a local relay plugs into — apps/app/src/bun/server.ts:371-373 `PRODUCT_PROXY_PREFIXES ... "/api/workflow/"`; :1012-1015 `proxyIdentity(request, url, identityUpstream, upstreamTimeoutMs, log)`; option at :136 `readonly identityUpstream?: string | null`
- The Worker can only reach a Cloud-provisioned gateway; the static upstream env was removed, so wrangler dev cannot point at a local gateway — apps/server/src/index.ts:117 `The static gateway proxy was removed. Use the session-validated /api/workflow/provision and /api/workflow/rpc routes`; apps/server/src/gateway.ts:29 `POST /api/repos/{owner}/{repo}/gateway`
- gateway-run-proof.ts already composes a real loopback gateway + a Node relay using the Worker's frame adapter + the app's unmodified seam, but its executor is Noop and run activity is hand-journaled — apps/app/scripts/gateway-run-proof.ts:96 `ControlExecutor.layer(ControlExecutor.makeNoop())`; :66-70 import `GATEWAY_PROCEDURE_MOUNTS` from "smithers-server/gatewayRpc"; :19-20 `The run's own ACTIVITY is scripted`
- proof:gateway must run under tsx (Node). `bun` fails at once, despite the file's own docstring saying to use bun — apps/app/package.json scripts `"proof:gateway": "tsx scripts/gateway-run-proof.ts"`; bun output: `Use @smthrs/database/bun/BunDatabase under Bun; NodeDatabase requires Node.js >=22.19.0`; docstring gateway-run-proof.ts:34 `Run it with: bun apps/app/scripts/gateway-run-proof.ts`
- proof:gateway is RED on the current working copy (2026-09-18): steps 1 ok, step 2 fails, 6.9 s — ran `pnpm exec tsx scripts/gateway-run-proof.ts` in apps/app: `ok  the listing names a real flow` then `Error: FAILED: the seam launched a run`
- A real-engine gateway stack exists as a test composition: real control plane, real NodeRuntime engine, two SQLite DBs, a real Flow over a real Action, no credential needed — packages/smithers/gateway/test/RealEngineRun.ts:60-73 `export const flowId = "gateway/RealRun"` ... `Flow.make(flowId, { ... body: (payload) => Write.call(payload) })`; :11-14 `two databases ... control.db ... engine.db`
- RealEngineRun suite passes: 3 tests, 13.08 s wall (load average 32). Running vitest without `--coverage.enabled=false` reports a 100% coverage threshold error for a single file — ran `pnpm exec vitest run test/RealEngineRun.test.ts --coverage.enabled=false` in packages/smithers/gateway: `Tests  3 passed (3)  Duration  13.08s`; without flag: `ERROR: Coverage for lines (36.7%) does not meet global threshold (100%)`
- In the RealEngineRun stack, engine flows.engine.* records stay in the engine journal and no projection sees them — packages/smithers/gateway/test/RealEngineRun.test.ts:126-141 `expect(engineKinds).toContain("flows.engine.attempt-started")` ... `a client watching that run sees none of them`
- The production CLI host DOES bridge the engine journal into the control journal via EngineJournalSupervisor, as control.engine.event envelopes — packages/smithers/src/internal/NativeControl.ts:745-753 `const supervisor = yield* EngineJournalSupervisor.make({ engineJournal, controlJournal, engineState, runs, control })` ... `return supervisor.wrap(executor)`; packages/smithers/ENGINE-JOURNAL-PROJECTION.md `control.engine.event` envelope with `eventType`, `payload`
- The gateway projections and the app already decode control.engine.event — packages/smithers/gateway/src/Projections.ts:752 `decoded.kind === "control.engine.event" ? decoded : retainedEvent(decoded)`; apps/app/src/mainview/cards/EngineTrace.ts:9-22 `const Envelope = Schema.Struct({ version: Schema.Literal(1), executionId, ... eventType, payload, meta })`
- `smthrs serve` (alias gateway) hosts /rpc, /projections, /sync, /health on 127.0.0.1:3000 by default; loopback needs no bearer — packages/smithers/src/Cli.ts:156-163 `.command("serve", { aliases: ["gateway"], ... port default Serve.defaultBind.port`; packages/smithers/src/Serve.ts:46 `defaultBind = { host: "127.0.0.1", port: 3000 }`; :12-13 `loopback needs no bearer`
- Project flows are discovered from <root>/flows, but a native module flow also needs in-process Interpreter/Action layers and Executable delegates, so a disk-only fixture cannot run HumanTask/catch/retry under the stock binary — packages/smithers/src/internal/NativeControl.ts:204-206 `{ source: "project", root: join(root, "flows"), naming: "path" }`; packages/smithers/test/NodeModuleExecutor.test.ts:73-95 `Layer.mergeAll(Interpreter.layer(Module), Interpreter.layer(Child), Probe.toLayer(...))` + `Executable.layer({ delegates: [Module], load: ... })`
- A HumanTask parked on a durable wait across the two databases already has a real-engine test to copy from — packages/smithers/test/NestedHumanWaitAcrossDatabases.test.ts:39 `import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"`; :69 `HumanTask.action.call({ name: "coding-clarification", kind: "ask", prompt, maxAttempts: 3 })`
- Card bodies are tested with bun:test + happy-dom GlobalRegistrator + react-dom createRoot + act, against a real createAppStore with memoryStorage; no vitest and no bunfig preload in apps/app — apps/app/src/mainview/cards/RunTraceCard.test.tsx:2-8 `import { GlobalRegistrator } from "@happy-dom/global-registrator"` / `from "bun:test"` / `createRoot` / `createAppStore` / `memoryStorage`; :28 `GlobalRegistrator.register()`; no apps/app/bunfig.toml
- Pump/controller tests drive createWorkflowPumpController over a real createGatewaySeam with an injected fetch — apps/app/src/mainview/state/controller/workflow-pump.test.ts:7-8,49-51 `createGatewaySeam({ baseUrl: "https://test", ..., fetch: async (_, init) => {`
- Measured: RunTrace + RunTraceCard + workflow-pump + gateway unit files = 109 tests, 7.8 s at load average 32 — ran `bun test src/mainview/cards/RunTrace.test.ts src/mainview/cards/RunTraceCard.test.tsx src/mainview/state/controller/workflow-pump.test.ts src/mainview/state/controller/gateway.test.ts`: `109 pass 0 fail ... [7.76s]`
- apps/app unit target = bun test over src, e2e/contracts, e2e/real/coverage, scripts; conformance is a separate lint suite that pins the data-*/card-kind/flow-name literals e2e asserts against — apps/app/PACKAGE.ts:113 `runner: Smithers.testSuite(["src", "e2e/contracts", "e2e/real/coverage", "scripts"])`; :137-143 `refuses any literal the e2e suites and the scripts/ runners assert against that no longer resolves`
- browserE2e target runs playwright install, test:e2e:auth, test:e2e:probes, then T1 playwright, with the chat stub — apps/app/scripts/run-pr-e2e.mjs:4-9 `["exec","playwright","install","--with-deps","chromium"], ["run","test:e2e:auth"], ["run","test:e2e:probes"], ["exec","playwright","test"]`; PACKAGE.ts:172-179
- CI runs the four app targets in job apps-e2e; the real tier appears in no workflow — .github/workflows/ci.yml:367,373,379,385 `pnpm exec smthrs build '//apps/app:check'` / `test '//apps/app:unitTests'` / `'//apps/app:conformance'` / `'//apps/app:browserE2e'`; `grep -n "real-e2e|run-real-e2e|playwright.real" .github/workflows/*.yml` returned nothing
- ci.yml is generated by Smithers.GithubCiGen in root PACKAGE.ts; the drift lint is the //:ci Lint step; apps-e2e is a required job — PACKAGE.ts:205-206 `const ci = Smithers.GithubCiGen({ summary: "Regenerate and drift-check .github/workflows/ci.yml..."`; :373 `{ name: "Generated workflow drift", verb: Smithers.Verb.Lint, pattern: "//:ci" }`; :219 `requiredJobs: ["test", "apps-e2e", ...]`
- The relay allowlist is a plain exported map, with a colocated unit test file — apps/server/src/gatewayRpc.ts:44-54 `GATEWAY_PROCEDURE_MOUNTS ... Plan: "/rpc" ... "Projection.Snapshot": "/projections", "Approval.Submit": "/projections"`; apps/server/src/gatewayRpc.test.ts exists; apps/server/package.json `"test": "bun test src scripts"`
- The canary checklist records flow.run.stop/retry from the card as an e2e GAP — apps/E2E-CANARY-CHECKLIST.md:176 `| E7.12 | **`flow.run.stop` and `flow.run.retry` from the card** | **GAP** | — |`
- Native main tests leak MainProcess daemons, so do not run `bun test` over apps/app/src/bun for this feature; scope to cards/state paths — memory index: `bun test over apps/app/src/bun orphans ~10 e2e/native/MainProcess.ts daemons per run (662 procs / 19.8 GB on 2026-09-17)`; apps/app/e2e/README.md: `native/ holds the main-process subprocess probe driven by src/bun/Main.test.ts`
- The last 150 lines of CHAT.md never mention the flow builder; the release owner is on repin 3, the Jev relay, and triggers forms — /Users/williamcory/smithers/CHAT.md tail: `**Repin 3 is still stopped**, awaiting Will's design decision`; `grep -i "flow-builder|graph"` over the tail returned no flow-builder hit

Blockers:
- `pnpm --filter smithers-app proof:gateway` is RED on the working copy: `FAILED: the seam launched a run` (step 2). This is the only existing app-seam -> relay -> real-gateway composition and the planned base for the e2e host. Cause not diagnosed: seam.launch does Plan, Approval.Submit, then Run (gateway.ts:244-266), and the script prints no message.
- No credential-free real backend is reachable from Chromium today. T1 is offline with identityUpstream null (browser-test-host.ts:24). The Worker reaches only Cloud-provisioned gateways (apps/server/src/index.ts:117). e2e/real needs GitHub + Cloud + LLM and is in no CI workflow.
- Stock `smthrs serve` cannot host a deterministic HumanTask/catch/retry fixture. Native module flows need in-process Interpreter/Action layers and Executable delegates (NodeModuleExecutor.test.ts:73-95). The fixture gateway must be a bespoke in-process composition.
- Open question: does the ControlExecutor path of the intended fixture host return non-empty PlanCard.nodes? I found no `nodes:` producer in control/src/SqlControlRuntime.ts, ControlLive.ts or NativeControl.ts by grep. The builder must be located by whoever owns the Plan area before the e2e can assert node ids.
- The engine-to-control journal bridge exists only in the CLI host (NativeControl.ts:745). The gateway test stack asserts its absence (RealEngineRun.test.ts:126-141). The fixture host must wire EngineJournalSupervisor itself, or node status in the e2e will never move.
- Runtime split: NodeDatabase refuses Bun (`unsupported_runtime`), and the local origin is a Bun server. The e2e host needs two processes, or the BunDatabase layer variant (@smthrs/database/bun/BunDatabase).
- Machine load average was 32 during measurement. Wall-clock assertions and Playwright timeouts will flake under fleet load; rerun in isolation before calling a red real.
- Do not run `bun test` over apps/app/src/bun while iterating: it orphans MainProcess daemons (memory gotcha, 662 procs on 2026-09-17). Port 8788/wrangler is NOT part of any recipe here; ports are 47311 (T1) and 47321 (real).
- I ran `pnpm exec vitest run` once with default coverage in packages/smithers/gateway. It may have written a coverage/ directory there; that path is ignored-but-tracked per the memory gotcha, so check that `jj st` does not show phantom changes.

Commands:
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/cards/RunTrace.test.ts src/mainview/cards/RunTraceCard.test.tsx src/mainview/state/controller/workflow-pump.test.ts src/mainview/state/controller/gateway.test.ts   # ran: 109 pass, 7.8 s`
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/cards src/mainview/state   # feature-scoped unit run; avoids src/bun daemon leak; not run here`
- `cd /Users/williamcory/smithers/apps/app && pnpm run test   # = bun test src e2e/contracts e2e/real/coverage scripts (package.json); includes src/bun and leaks MainProcess daemons`
- `cd /Users/williamcory/smithers/apps/app && pnpm run lint:conformance   # bun test lint/conformance`
- `cd /Users/williamcory/smithers/apps/app && pnpm run typecheck   # node scripts/ensure-devkit.mjs && tsc --noEmit`
- `cd /Users/williamcory/smithers/apps/app && pnpm exec tsx scripts/gateway-run-proof.ts   # ran: RED at step 2 in 6.9 s; `bun` refuses with unsupported_runtime`
- `cd /Users/williamcory/smithers/packages/smithers/gateway && pnpm exec vitest run test/RealEngineRun.test.ts --coverage.enabled=false   # ran: 3 passed, 13.08 s`
- `cd /Users/williamcory/smithers/packages/smithers && pnpm exec vitest run test/NestedHumanWaitAcrossDatabases.test.ts test/EngineJournalSupervisor.test.ts test/EngineJournalProjection.test.ts --coverage.enabled=false   # HumanTask + bridge references; not run here`
- `cd /Users/williamcory/smithers/apps/server && bun test src/gatewayRpc.test.ts   # relay allowlist; not run here`
- `cd /Users/williamcory/smithers/apps/app && pnpm run test:e2e -- e2e/playwright/runs.spec.ts   # T1, doubled gateway; cold vite build, webServer timeout 240 s; SMITHERS_SKIP_SPA_BUILD=1 to reuse dist; not run here`
- `cd /Users/williamcory/smithers/apps/app && bun scripts/run-real-e2e.ts --grep 'flows\.'   # production-backed real tier; needs the ~/.multi-e2e-profile GitHub session; SMITHERS_REAL_CONFIGURED_REPO and SMITHERS_REAL_CONFIGURED_WORKSPACE are required only by the read-only catalog canaries; up to 30 min per test; not run here`
- `cd /Users/williamcory/smithers && pnpm exec smthrs test '//apps/app:unitTests' --verbose && pnpm exec smthrs test '//apps/app:conformance' --verbose && pnpm exec smthrs test '//apps/app:browserE2e' --verbose   # exactly what CI job apps-e2e runs (ci.yml:373-385)`
- `cd /Users/williamcory/smithers && pnpm exec smthrs lint '//:ci'   # ci.yml drift lint; regenerate with pnpm exec smthrs run '//:ci' (PACKAGE.ts:205,373)`

### engine/gateway side of a live plan graph

The production host serves no plan graph and no node-level run events, so both halves of a live graph need engine work before any gateway fold. (1) PlanCard.nodes is always [] in production: flows/coding/host.ts composes NativeControl + Serve, and NativeControl.durableFlow builds the MemoryFlow records with no `plan` hook. The only `plan` hook in the repo is control/test/PlanHandoff.test.ts, and nothing produces `statuses`. (2) The transport exists: EngineJournalSupervisor copies every native engine journal entry of the run's root and recorded children into the control journal as `control.engine.event` envelopes, the gateway already reads those in internal/callEvents.ts, and the app relay passes selectors through unfiltered. The events do not exist: flows.engine.node-scheduled, node-settled, node-invalidated and node-reconciled are emitted only by engine-store PlanScheduler, which has no production caller. Production executes graphs through @smthrs/flow Interpreter, which emits no journal records. Attempt records carry {runId, stepKeyDigest, attempt, tier} and no node id; the node id exists only as DispatchSite, hashed into the ordinal scope. (3) On the gateway, a new run-scoped projection is one entry in the `served` table, one row schema, one pure fold in GatewayProjection.ts, and one arm in the `rowsOfRun` switch. The engine must first emit plan-recorded with the node list, plus node-scheduled and node-settled, from the Interpreter. (4) PlanDiff.diff(previous, next) exists, is pure, and has no production caller; the card's optional `plan` field lets a client diff two cards. The Plan RPC takes only {flowId, input}, so it answers input-edit previews, not declaration edits. Each call writes a control_plans row, a pending control_tokens approval token, a counter bump and a control.plan.created journal entry. cached|run verdicts need a step-cache probe that does not exist, and Interpreter dispatch keys are site/ordinal-scoped, not plan-node keys. The "8 cache hits" number is not derivable from plan keys today.

- planCard returns nodes=[] whenever the flow supplies no plan handoff; status defaults to 'run' when statuses is absent. — packages/smithers/control/src/internal/planning.ts:122-128 `const plan = source.handoff?.plan / const nodes ... = plan === undefined ? [] : plan.nodes.map((node) => ({ ...node, status: source.handoff?.statuses?.[node.id] ?? "run" }))`
- SqlControlRuntime.plan calls the optional per-flow hook; with no hook the handoff is undefined. — packages/smithers/control/src/SqlControlRuntime.ts:1296 `const handoff = flow.plan === undefined ? undefined : yield* flow.plan(decoded, planId)`; the same line in the memory runtime at control/src/ControlRuntime.ts:749
- The hook contract is MemoryFlow.plan(input, planId) => {plan: PersistedPlan.Plan, statuses?}. — packages/smithers/control/src/ControlRuntime.ts:304-320 `readonly plan?: ((input: unknown, planId: string) => Effect.Effect<{ readonly plan: PersistedPlan.Plan; readonly statuses?: Readonly<Record<string, PlanNode["status"]>> ...`
- The production host builds its flow records with no plan hook, so served PlanCard.nodes is always []. — packages/smithers/src/internal/NativeControl.ts:414-424 `const durableFlow = (descriptor) => ({ flowId: descriptor.name, description, deployClass: false, executionDigest: Descriptor.executionDigest(descriptor), envelope: {...} })` has no `plan`; it is wired at :495-497 `loadFlows: () => registryService.list().pipe(Effect.map((discovered) => [...systemFlows, ...discovered.map(durableFlow)]))`. grep for `plan:` in NativeControl.ts, LocalControl.ts, NodeControl.ts and flows/coding/host.ts returns nothing.
- The coding host that ships in workspaces is NativeControl + Serve. — flows/coding/host.ts:9,12 `import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"` / `import * as Serve from "../../packages/smithers/src/Serve.ts"`
- The only working plan-hook recipe (Graph.drafts -> PersistedPlan.compile -> {plan, statuses}) lives in a test. — packages/smithers/control/test/PlanHandoff.test.ts:33-52 `PersistedPlan.compile({ planId, flow, nodes: Graph.drafts(value) })` ... `plan: (_input, planId) => compile(value, planId).pipe(Effect.map((plan) => ({ plan, statuses })))`
- Nothing in src produces `statuses` (cached|run verdicts). — grep `statuses` over packages/smithers/src and control/src hits only ControlRuntime.ts:318 and planning.ts:108,127 (type and default)
- The flow value a host can graph is Executable.flow, a wrapper whose body is one delegate call. The Executable.Catalog is built inside the executor layer, not the runtime layer that owns loadFlows. — packages/smithers/agent/registry/src/Executable.ts:856-862 `(payload) => { const envelope = invocation(payload.input ?? null); const carried = bridge === undefined ? delegate.call(envelope) : ...`; NativeControl.ts:663-680 builds `catalog` inside `Layer.effect(ControlExecutor.ControlExecutor)`, while the runtime is built at :487-501
- Engine journal entries are copied into the control journal as control.engine.event envelopes, unfiltered by event type, with native timestamps. — packages/smithers/ENGINE-JOURNAL-PROJECTION.md:46-63 `{ version: 1, executionId, generation, sequence, eventId, sourceId, sourceSequence, emittedAtMs, eventType, payload, meta }`; src/internal/EngineJournalProjection.ts:38 `export const eventKind = "control.engine.event"` and :97 `eventType: entry.eventType`
- The copy is wired in the production host and walks the native root plus its recorded children. — packages/smithers/src/internal/NativeControl.ts:740-752 `const supervisor = yield* EngineJournalSupervisor.make({ engineJournal, controlJournal, engineState, runs, control })` ... `return supervisor.wrap(executor)`; ENGINE-JOURNAL-PROJECTION.md:83 `walks DurableEngineState.runChildren edges from the authorized native root`
- node-scheduled payload shape. — packages/smithers/flows/engine-store/src/PlanScheduler.ts:1048-1057 `{ planId, nodeId: node.id, kind: node.kind, planKey: node.key, dispatchKey, attempt: attempts, priority: node.priority, waited: start.waited }`
- node-settled payload shape, with outcome built|clean|failed|skipped|deferred. — packages/smithers/flows/engine-store/src/PlanScheduler.ts:966-974 `{ planId, nodeId: node.id, planKey: node.key, dispatchKey: state.dispatchKey, outcome: state.outcome, attempts: state.attempts, rebases: state.rebases }`
- node-invalidated, node-reconciled, plan-recorded and subgraph-appended payload shapes. plan-recorded carries only a node COUNT; subgraph-appended carries node ids only. — PlanScheduler.ts:1036-1043 `{planId,nodeId,planKey,from,to,reason:"measured-inputs-changed"}`; :987-992 `{planId,nodeId,trigger,verdict}`; :505-513 `{planId,flow,digest,baseDigest,generation,nodes: plan.nodes.length,outcome}`; :536-542 `{planId,digest,baseDigest,generation,nodeIds}`
- JournalRecords types every one of these payloads as `unknown`; there is no schema to import. — packages/smithers/flows/engine-store/src/internal/JournalRecords.ts:211-212 `export const nodeScheduled = (options: EventOptions, payload: unknown) => event(options, "flows.engine.node-scheduled", payload)`; nodeSettled at :228-229
- PlanScheduler, the only emitter of node-* records, has no production caller. — grep `PlanScheduler.(make|layer|run)|PlanScheduler.PlanScheduler` over packages, flows and apps matches only engine-store/src/PlanScheduler.ts and test files (engine-store/test/*, time-travel/test/EngineIntegration.test.ts, agent/registry/test/ExecutableEngine.test.ts)
- Production runs graphs through Interpreter.layer, which has no journal dependency and emits nothing. — packages/smithers/agent/registry/src/Executable.ts:887-889 `layer: (bridge === undefined ? Interpreter.layer(flow) : Layer.merge(Interpreter.layer(flow), bridge.layer))`; flows/flow/src/Interpreter.ts:128 `type Services = Crypto.Crypto | FlowRuntime | FlowInstance | Implementations`; flows/flow/package.json:287-290 lists deps crypto, keys, plan and canonical, with no journal
- In the Interpreter path the graph node id reaches the engine only as DispatchSite, which is hashed into the ordinal scope. Attempt records carry no node id. — flows/flow/src/Interpreter.ts:553-555 `implementations.get(ast.action)!.action(resolve(node.payload)).pipe(Effect.provideService(DispatchSite, node.id))`; flows/engine/src/FlowEngine/Dispatch.ts:321-323 `const site = Option.getOrUndefined(dispatchSite); ... ordinalScope(action, site)`; engine-store/src/internal/ActionPersistence.ts:786 `const attemptId = { runId: deps.runId, stepKeyDigest, attempt: input.attempt }` and :1963 `attemptStarted(attemptSource("started"), { ...attemptId, tier: input.tier })`
- The Interpreter already knows settled, failed and skipped per node at the end of a walk, and settleNode is the single per-node seam. — flows/flow/src/Interpreter.ts:454-470 `const settleNode = (id) => Effect.suspend(() => { if (settled.has(id)) ... compute(byId.get(id)!).pipe(Effect.tap(... settled.set(id, value)), Effect.tapError(... failed.set(id, error))`; :668-673 `return { value, settled, failed, skipped: Graph.nodes(graph).filter(...) }`
- The gateway serves exactly seven selector/row pairs from one table; the selector union, ProjectionName and rowSchemaFor derive from it. — packages/smithers/gateway/src/GatewaySchema.ts:171-179 `const served = [[WorkspaceRunsSelector, RunSummaryRow], [RunSummarySelector, ...], [RunEventsSelector, ControlSchema.ControlEvent], [TranscriptSelector, ...], [RunTreeSelector, ...], [ApprovalsSelector, ...], [NodeOutputSelector, ...]] as const satisfies ServedTable`
- The only per-selector switch that needs a new arm is rowsOfRun. sameSelector, scopeOf and resumeScope handle any run-scoped selector through their default paths. — gateway/src/Projections.ts:513-537 `switch (selector._tag) { case "workspace-runs": ... case "node-output": ... }`; :489-490 `default: return left.runId === (right as RunSummarySelector).runId`; :249-250 `"runId" in selector ? selector.runId : undefined`; deltaRows at :936-941 falls through to `rowsOfRun(selector, { run, events, carry }, now())`
- The gateway already has a decode-an-engine-envelope pattern to copy. — gateway/src/internal/callEvents.ts:11-24 `if (event.kind !== "control.engine.event" ...) return undefined; const envelope = event.payload as Record<string, unknown>; if (envelope.version !== 1 || envelope.eventType !== CallFact.eventType || typeof envelope.executionId !== "string" ...`
- The runTree docblock saying engine records cannot be folded is stale now that the supervisor copies them. — gateway/src/GatewayProjection.ts:400-405 `The durable engine's own flows.engine.* records are not folded here, and cannot be: a host keeps the control plane and the engine in two databases with two journals`, against NativeControl.ts:740-752
- A fold sees a bounded window: 10,000 events or 4 MiB per run, events over 16 KiB are clipped, and evicted events survive only in a Diagnosis digest. A graph fold over a long run can lose early node events. — gateway/src/Projections.ts:82 `maxEventsPerRun = 10_000`, :124 `maxProjectionBytes = 4 * 1024 * 1024`, :142 `maxEventBytes = 16 * 1024`; :412-419 `while (state.events.length > maxEventsPerRun || encodedBytes > maxProjectionBytes) { const evicted = state.events.shift() ... carry = Diagnosis.combine(...)`
- A run's journal partition carries planId and digest but no node list; the plan's own journal partition is `plan:<planId>` and carries only ids. No GetPlan RPC exists. — control/src/ControlLive.ts:1246 `JournalEvent.RunId.make(`plan:${card.planId}`)`, :1266-1270 `emit(runId, "control.plan.created", { planId, flowId, digest })`, :1316-1324 `"control.run.accepted", { runId, planId: input.planId, digest: input.digest, status, ... }`; control/src/ControlRpcs.ts:84-176 lists Plan, Run, Approve, Deny, Steer, Signal, Cancel, Resume, List, Watch
- The app relay does not validate selector tags, so a new projection needs no apps/server change. — apps/server/src/gatewayRpc.ts:72 `JSON.stringify({ _tag: "Request", id: 1, tag: procedure, payload: payload ?? {}, headers: [] })` with no selector inspection; apps/app/src/mainview/state/controller/gateway.ts:204-208 `call(repo, "Projection.Snapshot", { selector, ...after })`
- PlanDiff.diff exists, is pure and unused in production. Rekeyed = {id, from, to, changed[]}; PlanDiff = {added, removed, rekeyed, unchanged}. — packages/smithers/flows/plan/src/PlanDiff.ts:27-36,48-53,163 `export const diff = (previous: Plan.Plan, next: Plan.Plan): PlanDiff`; grep for PlanDiff outside flows/plan hits only flows/test/e2e-authoring.test.ts:1018,1060,1217
- PlanCard carries the whole persisted plan optionally, so two cards can be diffed client-side. — control/src/ControlSchema.ts:259-260 `plan: Schema.optional(PersistedPlan.Plan), nodes: Schema.Array(PlanNode)`; planning.ts:154 `...(plan === undefined ? {} : { plan })`
- The Plan RPC input is {flowId, input, idempotencyKey?}; it has no way to submit an edited declaration. — control/src/ControlSchema.ts:665-669 `PlanInputSchema = Schema.Struct({ flowId: FlowId, input: Schema.Json, idempotencyKey: Schema.optional(IdempotencyKey) })`
- Every Plan call is a durable write: counter, control_plans row, pending approval token and a journal entry, serialized under the mutation semaphore. — SqlControlRuntime.ts:1295 `const planId = `plan-${yield* nextSequence("plan")}``; :1336-1348 `INSERT INTO control_plans (plan_id, card_json, decoded_input_json, decision) VALUES (..., 'pending')` and `INSERT INTO control_tokens (...)`; ControlLive.ts:1240-1241 `mutationSemaphore.withPermits(1)(journal.transact(`
- A plan node's key is not the production cache key. PlanScheduler derives a separate dispatch key from measured inputs, and Interpreter dispatch uses site/ordinal-scoped keys. — PlanScheduler.ts:1033-1045 `const measuredKey = yield* dispatchKeyFor(node, boundary, start.results)`; :940-948 `StepKey.ordinal({ runId, parentScope: JSON.stringify(["plan-node/v1", initial.planId, node.id, node.key]), ordinal: 0, tier })`; Dispatch.ts:323 `ordinalScope(action, site)`
- Gateway coverage thresholds are 100% on every axis, so each new fold branch needs a test. — packages/smithers/gateway/vitest.config.ts:20-25 `thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }`

Blockers:
- Production emits no node-level journal records. PlanScheduler, the only emitter of flows.engine.node-*, has zero production callers, and the production executor (@smthrs/flow Interpreter) has no journal seam. A plan-graph projection folded today would be empty for every real run. The Interpreter emit is the first task, not the gateway fold.
- PlanCard.nodes is [] on the served host: NativeControl.durableFlow sets no `plan` hook. Turning it on changes every plan digest (planning.ts:138) and invalidates pending approvals and idempotent stored plans.
- No cache probe exists, so `cached` status and the "8 cache hits" count cannot be produced truthfully. Plan node keys are not the dispatch or cache keys in either executor.
- `clean` (cache hit) is not observable from the Interpreter: the replay or cache fact is known in ActionPersistence (:1759-1778) and is not returned to the node walk.
- The Plan RPC cannot preview a declaration edit because its input is {flowId, input}, and every call writes a control_plans row, a pending control_tokens approval token and a journal entry.
- Gateway window eviction (10,000 events or 4 MiB per run) can drop the plan-recorded event on long runs, and the control journal byte bound can reject a large node-list envelope as an omission gap.
- No GetPlan RPC exists and the run partition carries only planId and digest, so edges for a live run must come from the new engine event or from a Plan card the app already holds.
- No command was run in this read-only session. The test commands come from each package.json and were not run; the read-only mandate also forbade installs and writes.

Commands:
- `cd /Users/williamcory/smithers/packages/smithers/gateway && pnpm run check   # tsc -b tsconfig.json && tsc -p tsconfig.test.json --noEmit (gateway/package.json:208)`
- `cd /Users/williamcory/smithers/packages/smithers/gateway && pnpm exec vitest run test/GatewayProjection.test.ts test/GatewaySchema.test.ts test/ProjectionsUnit.test.ts test/Projections.test.ts test/WireFormat.test.ts test/CallFacts.test.ts test/RealEngineRun.test.ts`
- `cd /Users/williamcory/smithers/packages/smithers/gateway && pnpm run coverage   # 100% thresholds, vitest.config.ts:20-25`
- `cd /Users/williamcory/smithers/packages/smithers/control && pnpm run check && pnpm exec vitest run test/PlanHandoff.test.ts`
- `cd /Users/williamcory/smithers/packages/smithers/flows/flow && pnpm run check && pnpm exec vitest run`
- `cd /Users/williamcory/smithers/packages/smithers/flows/engine-store && pnpm exec vitest run test/PlanScheduler.test.ts`
- `cd /Users/williamcory/smithers && pnpm docs:llms   # then check-docs and check-llms, because the projection count is documented in gateway/docs/concepts/projections.md:28`
- `env -i HOME=$HOME PATH=$PATH TMPDIR=$TMPDIR TERM=dumb CI=1 <the vitest command>   # if exported *_API_KEY values redden digests (memory: exported secrets poison tests)`

### where the graph lives in apps/app

Position: the live-run graph is `traceView: "graph"` on the existing `run-trace` card, rendered by a NEW lazy file (not inside RunTraceCard.tsx, which another agent is editing right now); plan-before-run is ONE new card kind `flow-plan` opened by a new `flow.plan` flow whose button door is a `Plan` button on each workflow-list row; the retired `graph` kind is NOT revived. Both cards render one shared graph component. React Flow + dagre go behind a new `@smthrs/ui/adapters/flow-graph` adapter, because the mock's camera needs `useEffect` + `useReactFlow` and apps/app's Architecture test bans the import, while the house pattern for imperative libs (xterm, d3-force, shiki) is an adapter in @smthrs/ui where effects are allowed.

Why not revive `graph`: its payload is the local backend's TargetGraph shape (repoId, repoName, TargetGraphResponse with labels/rules/private), it is in LOCAL_BACKEND_KINDS rendering null so saved conversations keep parsing, and repurposing it breaks those rows. Why the 30-member union argument in D-015 is void: the Card union already has 63 kinds and useCardRows names its type arguments, so one more kind costs a schema entry, a family slice and one spread line. Why not the experimental pane (D-014): Pane.ts forbids a pane from reading a collection or calling a seam, which contradicts "real gateway data only".

Three gaps found that the feature must close inside apps/app: (1) `gateway.launch` calls Plan and throws away `nodes` (it reads only planId, digest, envelope) and there is no standalone `plan` seam method; (2) `gateway.nodeOutput` exists with zero callers; (3) `runs.trace.select` validates its id against trace spans and forces `facet: "steps"`, so plan-node selection needs its own flow and payload field. One in-hand join exists today: journal attempt events carry `stepKeyDigest`, and Plan nodes carry `key`, so a run-trace card that snapshots the plan at launch can paint attempt status per node without the new projection (node-settled outcomes clean/skipped still need the projection from D-020).

Collision: RunTraceCard.tsx (+303), RunTrace.ts (+666), their tests, CardRenderers.tsx, Cards.ts, Flows.ts, registry.ts, parity.test.ts, cards.css (+172) and index.css are all uncommitted in the shared default working copy, last touched 20:03 to 20:14 local today; the working-copy parent b6d6ece7a3 is 15 commits behind main; CHAT.md CL095 says main fails `pnpm run check` in apps/app partly because presentation.ts names kind "experimental" while the Cards.ts entry is still uncommitted. Build this in a separate jj workspace rebased on main, in new files, and touch the shared files last with one-line edits.

- run-trace payload already carries view state: facet, selection, cursorSeq, filter, liveTail, traceView(turns|timeline) — packages/rpc/src/Cards.ts:1026 `facet: z.enum(["steps", "transcript", "events"]).optional()`; :1049 `selection: z.string().optional()`; :1051 cursorSeq; :1053 filter; :1055 liveTail; :1057 `traceView: z.enum(["turns", "timeline"]).optional()`
- run-trace requires a runId, so it cannot hold a plan that has not run — packages/rpc/src/Cards.ts:966 `runId: z.string(),` and :955 'The id scheme `flow-run-<runId>` stays so links resolve.'
- Retired kinds graph and run-timeline still parse on the wire with the local backend's TargetGraph payloads — packages/rpc/src/Cards.ts:2216-2217 `kind: z.literal("graph"), payload: GraphCardPayloadSchema`; packages/rpc/src/TargetGraph.ts:390-415 `repoId, repoName, status, graph: TargetGraphResponseSchema.optional(), focus, view:{query,showPrivate}, runId, run:{nodes: NodeTimingSchema[]...}`
- graph/run-timeline render null today so saved conversations do not crash — apps/app/src/mainview/cards/CardRenderers.tsx:73-77 `const LOCAL_BACKEND_KINDS = ["repo", "targets", "target-run", "graph", "run-timeline", ...]` ... `{ render: () => null, pill: () => "done" }`
- The 30-member union limit is already exceeded and already worked around; one more kind does not re-trigger it — `grep -c 'kind: z.literal(' packages/rpc/src/Cards.ts` = 63; apps/app/src/mainview/state/useCardRows.ts:12-14 'Naming the type arguments skips that inference entirely' and :23 `useLiveQuery<Card, string, Record<string, never>>`
- Cost of a new card kind is a body, a family slice and one spread line; a missing kind is a compile error — apps/app/src/mainview/cards/CardFamily.ts:9-10 'A new card kind is a body, a slice entry in its family's file and one spread line in the aggregator.'; CardRenderers.tsx:121 `export const CARD_RENDERERS: CardFamily<Card["kind"]> = {`
- Card kind name `plan` is taken by the agent's todo list — packages/rpc/src/Cards.ts:749-750 `kind: z.literal("plan"), payload: z.object({ items: z.array(CardPlanItemSchema) })`; apps/app/src/mainview/cards/TurnCards.tsx:9
- Experimental panes are forbidden from real data, so D-014 cannot be the shipped path — apps/app/src/mainview/experimental/Pane.ts:11-13 'A pane carries its own mock data. It reads no collection, calls no seam and dispatches no transition — promotion out of the flag is what earns a pane real state, its own card kind and its own wire schema.'
- The experimental Plan/Flows/StepCache/TimeTravel/Triggers/Models panes are now drawn mocks (no longer 'Not drawn yet') and import neither xyflow nor dagre — jj diff --stat: panes/Plan.tsx +400, Flows.tsx +281, StepCache.tsx +265, TimeTravel.tsx +306, Triggers.tsx +395, Models.tsx +386; `grep -c 'xyflow\|dagre'` = 0 in each; Plan.tsx:2-3 'Mock: Plan and step keys ... Self-contained on purpose'
- gateway.launch calls Plan and discards the node list; no standalone plan seam exists — apps/app/src/mainview/state/controller/gateway.ts:244-247 `const planned = await call(repo, "Plan", { flowId, input }, binding)` ... `const planId = ...card.planId`, `const digest = ...card.digest` (nodes never read); Approval.Submit at :252 and Run at :259 follow in the same function
- PlanCard from the control RPC carries nodes with status cached|run plus an optional persisted plan — packages/smithers/control/src/ControlSchema.ts:199 `PlanNodeStatus = Schema.Literals(["cached", "run"])`; :221-224 `PlanNode = Schema.Struct({ ...PersistedPlan.PlanNode.fields, status })`; :259-260 `plan: Schema.optional(PersistedPlan.Plan), nodes: Schema.Array(PlanNode)`
- nodeOutput seam exists and has zero production callers — apps/app/src/mainview/state/controller/gateway.ts:323-329 `nodeOutput: async (repo, runId, nodeId, binding)` -> `{ _tag: "node-output", runId, nodeId }`; `grep -rn 'nodeOutput(' apps/app/src/mainview/state | grep -v test` returns nothing
- Journal attempt events on the card carry stepKeyDigest, a join key to Plan node keys; EngineTrace folds only attempt/interrupted/run-decision events, not node-scheduled/settled — packages/smithers/flows/journal/src/EngineEvent.ts:128-134 `AttemptPayload = Schema.Struct({ ... stepKeyDigest: Event.DispatchId, attempt, lifecycle })`; apps/app/src/mainview/cards/EngineTrace.ts:193,246,256 are the only `flows.engine.*` event types matched
- runs.trace.select cannot select a plan node: it validates against trace span ids and forces the steps facet — apps/app/src/mainview/state/controller/runs.ts:510 `if (!model.rows.some((span) => span.id === nodeId)) return `Run ${runId} has no trace node ${nodeId}.``; :516 `patch: { payload: { ...card.payload, facet: "steps", selection: nodeId, liveTail: false, cursorSeq } }`
- View flows are hidden, registry-dispatched, payload-writing, and open to cloud + practice; traceView is one Literals enum in the flow and one in the wire — apps/app/src/mainview/flows/entries/runs.ts:223-229 `name: "runs.trace.view" ... hidden: true, args: "[sourceCard=id] <runId> <turns|timeline>", view: Schema.Literals(["turns", "timeline"])`; runs.ts controller :545 `patch: { payload: { ...card.payload, traceView: view } }`
- Removing a payload field needs card.upsert, not card.updated — apps/app/src/mainview/state/controller/runs.ts:556-557 '// card.updated merges payload fields. Replace the card to remove the cursor durably: undefined patch values would disappear in the JSON journal.'
- Reopening a run card carries view state over through an explicit per-field list; any new view field must be added there or it resets — apps/app/src/mainview/state/controller/workflows.ts:283-292 `...(held.facet === undefined ? {} : { facet: held.facet }), ...filter, ...traceView, ...codingChangeId, ...events, ...selection, ...cursorSeq, ...liveTail`
- The law: selection, filter, drawer and view mode live in the card payload and change through a flow; useState only for transient chrome. AGENTS.md still cites the deleted GraphCard as the example — apps/app/AGENTS.md:45 'Anything a card projects — a filter, a selection, a drawer, a view mode — lives in the card payload and changes through a flow ... (`cards/TargetCards.tsx` `target.filter` / `target.select`, `cards/GraphCard.tsx` `target.graph.filter` / `target.graph.focus`)'
- Sliders and physical gestures are an enumerated userOnly exception, which covers pan/zoom — apps/app/AGENTS.md:35 '`userOnly` is an enumerated exception for acts that are physically the human's gesture (a folder dialog, an OAuth redirect, focus, a menu, a slider, the clipboard)'
- The retired GraphCard used NO imperative viewport control and no effect: uncontrolled React Flow with the `fitView` prop, layout in useMemo, focus and filter via flows — jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx:30 `import { memo, useMemo, useState } from "react"`; :416-429 `<ReactFlow nodes edges nodeTypes fitView fitViewOptions={{ padding: 0.15 }} ... onNodeClick={(_, flowNode) => onRunCommand("target.graph.focus", ...)}`; :222 the only useState is the Copied flag
- The retired card was lazy-loaded so xyflow and dagre stayed out of the main bundle — jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCardLazy.tsx: 'importing GraphCard.tsx statically would pull the graph libraries into the main bundle'; current lazy helper at apps/app/src/mainview/ViewModules.ts:3-7 `viewModule(...)` with `lazy(preload)`
- The mock's camera-follow (D-024) uses useEffect + useReactFlow, which cannot be pasted into apps/app — docs/flow-builder/mockups/source/src/components/Canvas.tsx:13 `import { useEffect, useMemo } from "react"`; :66 `const flow = useReactFlow()`; :71 'React Flow owns the viewport imperatively, so this is the one effect'; :77 `flow.fitView({...duration: 620})`; :82 `flow.setCenter(...)`
- The useEffect ban is enforced by a test that scans every non-test .tsx under mainview, experimental/ included — apps/app/src/mainview/Architecture.test.ts:6-7 `new Bun.Glob("**/*.tsx")` scanned from `import.meta.dir`; :18-19 regexes for `React.useEffect(` and `import { ...useEffect... } from "react"`
- House pattern for imperative libs: an adapter in @smthrs/ui (effects allowed there), consumed from apps/app through a thin lazy surface — packages/smithers/ui/src/adapters/terminal.tsx:2 `import { useEffect, useInsertionEffect, useRef ...}` and :169,:178 `useEffect(() => {`; packages/smithers/ui/package.json:79-85 deps `@pierre/diffs`, `@xterm/xterm`, `d3-force`; apps/app/src/mainview/KnowledgeGraphSurface.tsx:1 `import { KnowledgeGraph } from "@smthrs/ui/adapters/knowledge-graph"`; cards/CodeSurface.tsx:24 `import { CodeFileView, languageForFile } from "@smthrs/ui/adapters/code-view"`
- Other no-effect escape hatches in use: useSyncExternalStore for external state, a class component for mount lifecycle, a payload-keyed WeakMap for derived folds — apps/app/src/mainview/cards/WorkspaceCard.tsx:192 '`useSyncExternalStore` — React's own external-store hook, so no `useEffect`'; StartupBoundary.tsx:36 'A class is deliberate: apps/app bans `useEffect`'; RunTraceCard.tsx (working copy) `const folds = new WeakMap<RunTraceCard["payload"], ...>()`
- React Flow 12.11.6 installed in apps/app supports a controlled viewport without an effect — apps/app/node_modules/@xyflow/react/package.json:3 `"version": "12.11.6"`; dist/esm/types/component-props.d.ts:414 `viewport?: Viewport;` :425 `defaultViewport?: Viewport;` :429 `onViewportChange?: (viewport: Viewport) => void;`
- xyflow and dagre are declared in apps/app and imported nowhere; @smthrs/ui does not depend on them and its canvas module says xyflow never enters it — apps/app/package.json:56-57 `"@xyflow/react": "^12.11.6"`, `"dagre": "^0.8.5"`, :77 `@types/dagre`; `grep -rn 'xyflow\|from "dagre' apps/app/src` hits only styles/DeadCss.test.ts:22; packages/smithers/ui/src/canvas/WorkflowCanvas.tsx:19-20 '`@xyflow/react` never enters this package'
- All retired graph CSS is gone from cards.css; DeadCss fails any class no source names, and whitelists only the react-flow vendor prefix — `grep -n 'graph-' apps/app/src/mainview/styles/cards.css` = only :1903 `.wiki-graph-canvas`; at 42b8abbc1cf6 cards.css had 69 graph-/run-timeline/react-flow lines; apps/app/src/mainview/styles/DeadCss.test.ts:23 `const VENDOR_PREFIXES = ["react-flow"]`, :58-63 orphans must equal []
- Button door for a catalog row already exists on the workflow-list row; the Flows pane renders the newest workflow-list card through the same body — apps/app/src/mainview/cards/WorkflowCards.tsx:433 `<Button ... {...flowAction(onRunCommand, "flow.run", flowArgs("flow.run", { name: workflow.key, ...}))}>Run</Button>`; apps/app/src/mainview/FlowsSurface.tsx:16-21 'it shows what `flow.list` last answered with — the newest listing card, rendered through that card's own rows'
- flow.run's entry is the template for flow.plan: same form hints, cloud runtime, signed-in requirement — apps/app/src/mainview/flows/entries/flow.ts:121-140 `name: "flow.run", form: { fields: { name, repo: { optionsFrom: "cloud-repos" }, input: { label: "Input JSON" } } ... runtime: ["cloud"], args: "[sourceCard=id] <name> [owner/repo] [JSON object]", requires: ["signed-in"]`
- Trigger, agent, file and maximize doors already exist; the trigger panel and drill-ins need no new flows — flows/entries/triggers.ts:81,94,128,146,165 `triggers.list|register|approve|run|pause`; flows/entries/agent.ts:33 `agent.list`; runs.ts:130 `runs.seat`; flows/entries/files.ts:39 `files.read`; flows/entries/card.ts:21,31 `card.maximize|card.minimize`
- Every new flow name must be added to FLOW_NAMES, which a test holds to the entries modules in both directions — apps/app/src/mainview/flows/FlowName.ts:7-9 'this module lists them once and derives the union; FlowName.test.ts holds the list and the registry to each other, in both directions'
- Card payloads are written to disk, so a signed Plan envelope should not be parked in one — apps/app/src/mainview/cards/WorkspaceCard.tsx:189-194 'never from the card payload, because everything a payload holds is written to disk by the persistence backend'; ControlSchema.ts:236-237 PlanCard is 'The reviewable, signed payload returned by planning and resubmitted to approval'
- The run monitor polls at 2500 ms and pages run-events by cursor — apps/app/src/mainview/state/controller/context.ts:175 `workflowPollMs: services.workflowPollMs ?? 2500`; workflow-pump.ts:74 `const RUN_POLL_MS = workflowPollMs`, :106 `gateway.runEvents(repo, runId, binding, cursor)`
- DESIGN.md lists the WorkflowCanvas surface as out of scope, so NO INVENTION needs the flow-builder brief (D-029, ruled by Will) cited as the authorizing brief — apps/DESIGN.md:119 '...slash menu full command registry; WorkflowCanvas surface; terminal card; admin surface...'; docs/flow-builder/decisions.md 'D-029 — The vision: agent-led build, live run, incremental re-run, on one canvas. RULED (Will)'
- RunTraceCard.tsx, RunTrace.ts and their tests are being edited right now in the shared default working copy — `jj st`: `M apps/app/src/mainview/cards/RunTrace.ts` (+666), `M .../RunTraceCard.tsx` (+303), RunTrace.test.ts (+442), RunTraceCard.test.tsx (+317); mtimes 09-18 20:03, 20:07, 20:08, 20:14 against `date` 20:28
- Shared registration files are also dirty in the working copy — `jj st`: `M cards/CardRenderers.tsx` (+3), `M packages/rpc/src/Cards.ts` (+15, the `experimental` kind at :2474), `M flows/Flows.ts` (+3), `M flows/registry.ts` (+4), `M flows/parity.test.ts` (+10), `M styles/cards.css` (+172), `M index.css` (+1), `A flows/entries/experimental.ts`, `A styles/experimental.css`
- The default working copy sits 15 commits behind main, and main's apps/app typecheck is red partly from a half-landed experimental kind — `jj log -r '@|@-|main'`: @ vvkyrwvp on qxpxtymo b6d6ece7a3, main = 44545559b4; `jj log -r 'b6d6ece7a3..main' | wc -l` = 15; CHAT.md CL095: '`main@origin` FAILS `pnpm run check` in `apps/app` ... `presentation.ts:508,513` (`"experimental"` not in the surface union'; presentation.ts:508 `kind: "experimental",` is committed while the Cards.ts entry is not

Blockers:
- Status truth per plan node: the run-events journal on the card folds attempt events keyed by stepKeyDigest (EngineEvent.ts:128-134) but not node-settled outcomes, so `clean`, `skipped` and `deferred` cannot be shown as engine-true until the plan-graph projection (D-020) or node-settled events reach the relay. Without it the run graph can show running/built/failed only. Unverified here: that PlanNode.key's digest equals AttemptPayload.stepKeyDigest byte for byte; prove with one real run before building on it.
- Edges: PlanNode carries `dependsOn` only; the typed edge reason (value | continuation | failure) lives in Graph.build output and is not in the Plan RPC answer, so typed edges need a wire addition in packages/smithers/control (other area).
- Code tab: the engine records no file:line for a node, and the app has no seam that reads `flows/<name>/flow.ts` out of the workspace VM into a card. The tab can only be a `files.read` door to the whole flow file until provenance exists.
- Duration predictions (D-030): no predictor and no projection exists; the card must render nothing for it until one does (MINIMAL TEXT forbids a 'not measured' row).
- Re-key preview wall-clock ('4.9s instead of 1h 1m') needs the prior run's per-node durations keyed by action tag; the count half ('re-runs 3 of 11; 8 cache hits') is available today from Plan node status alone.
- Liveness: 2500 ms poll (context.ts:175); streaming is excluded by the apps/server allowlist. The graph ships on the poll unless D-013 is ruled otherwise.
- Shared working copy is mid-edit by another agent on RunTraceCard.tsx, RunTrace.ts, CardRenderers.tsx, Cards.ts, Flows.ts, registry.ts, parity.test.ts, cards.css; and main's apps/app typecheck is red per CHAT.md CL095 (lane L105 open). Work in a separate jj workspace off main (flock the `jj workspace add`, per memory) and verify against main's failing SET, not a green baseline.
- Controlled-viewport alternative (ReactFlow `viewport` + `onViewportChange`, component-props.d.ts:414,429) was not prototyped; the adapter route is chosen because it is the proven house pattern. If moving xyflow into @smthrs/ui is refused, a one-command prototype of controlled viewport with CSS-transitioned transform is the fallback to validate first.

Commands:
- `cd /Users/williamcory/smithers/apps/app && pnpm run check   # node scripts/ensure-devkit.mjs && tsc --noEmit (package.json:15); red on main per CHAT.md CL095, compare failing sets`
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/cards/RunTraceCard.test.tsx src/mainview/cards/CardRenderers.test.ts src/mainview/Architecture.test.ts src/mainview/styles/DeadCss.test.ts`
- `cd /Users/williamcory/smithers/apps/app && bun test src/mainview/flows/FlowName.test.ts src/mainview/flows/agent-parity.test.ts src/mainview/flows/parity.test.ts src/mainview/flows/Commands.forms.test.ts`
- `cd /Users/williamcory/smithers/apps/app && bun test src   # full app suite (package.json:16 runs `bun test src e2e/contracts e2e/real/coverage scripts`); leaks native daemons per memory, kill by pid after`
- `cd /Users/williamcory/smithers/packages/rpc && pnpm run check && pnpm run test   # tsc -b + vitest run (package.json:18,20)`
- `cd /Users/williamcory/smithers && jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx   # also GraphCardLazy.tsx, GraphCard.test.tsx, GraphDrawerFacts.test.tsx, RunTimelineCard.tsx, styles/cards.css at that revision`
- `cd /Users/williamcory/smithers && jj st && jj diff --stat   # collision check before touching shared files`

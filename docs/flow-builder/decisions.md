# Flow Builder & Monitor — Decisions

Append-only decision log. Each entry: the decision, who made it, the reasoning,
and what would falsify it. `OPEN` means nobody has decided yet. `PROPOSED` means
Claude proposed it and Will has not ruled. `RULED` means Will decided.

---

### D-001 — It is a *flow* builder, never a *workflow* builder. RULED (pre-existing)
Will's standing rule: no user-visible "workflow". Chrome is Wiki / Dispatcher /
Flows / Secrets / History / Account.
*Applies to:* product copy, node labels, URLs, package names.

### D-002 — The flow file stays the source of truth; the canvas is a projection. PROPOSED
Every criticism of n8n traces to canvas-as-truth: unmergeable diffs, no code
review, a complexity ceiling (research.md §1). Kestra's answer — one declarative
document, canvas edits *the document* — is the only architecture in the survey
that keeps git diffs, review and types (research.md §5, F2).
*Falsified if:* a canvas edit cannot be expressed as a deterministic edit to the
flow source, for a large enough class of edits that the canvas is read-only in
practice. Then we would need a separate persisted graph document that compiles
to a flow.

### D-003 — How a canvas edit becomes a TypeScript edit. OPEN — central risk
Kestra round-trips for free because YAML is structurally editable. Our flows are
TypeScript + Effect. `Flow.make({...})` is already a declarative manifest
(description, input, output, capabilities, flows, effects) which is promising,
but `Action` wiring is arbitrary Effect code.
Candidate answers, none chosen:
1. Canvas edits only the declarative manifest surface; bodies stay code-only.
2. A typed intermediate flow document (the thing the agent already emits) that
   compiles to TypeScript; the canvas edits the document.
3. Canvas emits an instruction to the agent; the agent edits the code and the
   canvas re-derives. (Slow, lossy, but zero new format.)
4. AST codemods over `Flow.make`/`Action.make` call sites.
*This decision gates the whole engineering doc.*

### D-004 — Ship the monitor before the builder. PROPOSED
Relay.app shut down Sept 2026; Flowise archived Aug 2026 — two canvas-first
products dead in one month. Engine-first, monitor-second products (Temporal,
Inngest, Dagster, BuildBuddy) did not die (research.md F7). We already have runs
happening today with no graph view; we do not have users blocked on authoring by
hand, because the agent authors.
*Falsified if:* user evidence shows people refuse to run agent-authored flows
they cannot edit visually first.

### D-005 — Render the graph that *happened*, with the plan as a ghost. PROPOSED
Our flows are dynamic: the agent decides the next step at runtime. Argo and n8n
draw a static graph and color it, which works only because their graph is fixed
before the run. Prefect refuses to draw a static graph at all. We need both
layers: planned nodes drawn dimmed, actual nodes materializing over them
(research.md §7, F4).
*Falsified if:* in practice our runs are statically shaped and the ghost layer is
always empty noise.

### D-006 — React Flow (xyflow) for the canvas unless a run exceeds ~500 nodes. PROPOSED
Our node counts are tens, not thousands, and our nodes must be live interactive
React (an agent card inside a node). React Flow's DOM ceiling is irrelevant at
our scale; Cytoscape/PixiJS buy performance we do not need at the cost of
interactive nodes (research.md §12).
*Falsified if:* a real run renders >500 simultaneous nodes, or per-node React
subtrees drop frames at 50 nodes.

### D-007 — Pin, fork-from-step and replay are table stakes, not the pitch. PROPOSED
n8n (pin + partial execution + debug-in-editor), LangGraph (checkpoint fork),
Temporal (replay debugger) all converged on it independently (research.md F1).
Ship it, do not market on it.

### D-008 — The agent edits the graph as a visible peer. PROPOSED
Presence, a live cursor and a reviewable diff, as shipped by Figma, Zed and
Cursor in 2026 (research.md §14, F8). Applied to a flow graph this appears
unoccupied. This is the candidate differentiator.
*Falsified if:* watching an agent edit a graph is noise, and users only want the
finished diff.

### D-009 — Docs live in `docs/flow-builder/` as Markdown. RULED (Claude, low stakes)
Follows `docs/mvp/` precedent. Markdown rather than HTML
because these are append-heavy and LLM-read. Mockups will be self-contained HTML
under `docs/flow-builder/mockups/` when we get there.

### D-010 — Emit OpenTelemetry `gen_ai.*`-shaped spans from run events. OPEN
Would make our runs exportable to Langfuse/Datadog/Arize. Attributes are
Development-stability and can change without a major bump (research.md §13).
Decide during the engineering doc, not before.

### D-011 — Name of the product surface. OPEN
Not yet named. Candidates that respect D-001: "Flows" (the existing chrome tab),
"Canvas", "Run graph". Do not ship a second noun if the existing Flows tab can
hold it.

---

## Things Will may want to overrule later
- D-002 vs. speed: a canvas that only *reads* the flow file ships much faster
  than one that writes it. The proposed sequence (monitor first) dodges this for
  one release but not two.
- D-004 orders monitor before builder. If the demo story needs the builder, that
  order flips and D-003 becomes urgent immediately.

---

## Round 2 — after the codebase survey (2026-09-18)

### D-012 — Re-light the deleted `GraphCard`; do not build a canvas from scratch. PROPOSED
`GraphCard.tsx` (452 lines, React Flow + dagre, deps ∪ rdeps focus, critical
edges, node drawer, run-status overlay, view state in the card payload) exists at
`jj file show -r 42b8abbc1cf6 apps/app/src/mainview/cards/GraphCard.tsx`. It was
retired with the local backend, not because it was wrong. `@xyflow/react` and
`dagre` are still installed and unimported; the `react-flow` CSS prefix is still
whitelisted; `@smthrs/ui` ships a renderer-neutral `WorkflowCanvas` anatomy built
for exactly a ReactFlow layer, with the ARIA work already done.
*Falsified if:* the retired card's data model is bound to the local backend in a
way that cannot be repointed at the run journal.

### D-013 — Poll vs. stream for a live graph. OPEN — gates the design doc
The run monitor polls every 2500 ms (`workflow-pump.ts`, `context.ts:175`). The
gateway allowlist (`packages/backend/internal/compose/browser_flow.go` `browserFlowProcedures`) **deliberately excludes**
`Watch` and `Projection.Subscribe`: "a stream belongs on the gateway's separately
authenticated WebSocket mounts." Temporal's stated property is liveness — "the
Workflow updates in real-time" — and a 2.5 s poll will read as lag on a graph
whose nodes light up.
Options: (a) ship on the poll and tighten the interval while a graph card is
open; (b) open the streaming mounts; (c) drive the graph off the already-live
turn NDJSON stream for the current turn and poll for the rest.
*Do not write liveness into the design doc before this is ruled.*

### D-014 — The first version is an experimental pane, not a shipped surface. PROPOSED
`apps/app/src/mainview/experimental/` already exists behind
`VITE_SMITHERS_EXPERIMENTAL`, with reserved panes `Plan`, `Flows`, `TimeTravel`,
`StepCache` that still read "Not drawn yet." Cost of a first canvas: one file
under `experimental/panes/`, one line in `Registry.ts`. Its own doc says "NO
INVENTION does not bind a mock the way it binds a shipped surface: a mock is a
proposal."

### D-015 — Revive the retired `graph` card kind rather than mint a new one. PROPOSED
Kinds `graph` and `run-timeline` still exist in the wire schema
(`packages/rpc/src/Cards.ts:2158-2220`) but route to a retired family that
renders `null`. Separately, TanStack DB type inference gives up past 30 union
members (`state/useCardRows.ts`), so widening the `Card` union has a real cost.
Alternative worth considering: no new kind at all — add `traceView: "graph"` to
the existing `run-trace` card, which already carries `traceView`, `selection`,
`cursorSeq`, `filter`, `liveTail` and `facet` in its payload.

### D-016 — What is actually missing is the graph and the act, not the monitor. RULED (fact, not preference)
`RunTraceCard.tsx` (797 lines) already ships a phase strip on a time axis, filter
chips, a span tree, a waterfall, a span detail pane and a child-run door, over a
span model (`RunTrace.ts`) with eleven span kinds folded from the journal. The
gap versus the survey is narrower than assumed: **a node-link view of the plan,
and the ability to act on a node** (pin, fork, re-run from here, steer this
step). This narrows D-004 — "monitor before builder" is nearly already true.

---

## Round 3 — after the engine survey (2026-09-18)

### D-017 — There is no loop node and there never will be. RULED (engine invariant)
`packages/smithers/flows/plan/src/Node.ts:6-9`: "A plan is always a DAG, so there
is no loop node here and never will be: repetition lives one level up, in what a
flow settles with." Repetition is either bounded unrolling inside the body (see
`examples/src/17-review-loop.ts`, which literally plans `maxRounds` review nodes)
or a `Flow.to()` handoff that ends the round and names the next — a new
`flows_runs` row with `lineage_id` + `round_ordinal`.
*Consequence:* an n8n-style "Loop" widget cannot exist on our canvas. Any looping
affordance must compile to one of those two, and the canvas must show a bounded
loop as N real nodes and a trampoline as a round boundary. This is a product
constraint, not an implementation detail.

### D-018 — The plan already contains both branch arms; D-005's "ghost" is narrower than assumed. RULED (engine fact)
`Graph.build` evaluates every continuation and branch arm exactly once against a
strict `Planned` placeholder and **both** arms expand into the plan
(`flows/flow/src/Graph.ts:6-37`). At run time `Interpretation.skipped`
(`Interpreter.ts:119`) names the arm not taken. So the static graph is real and
complete for a given payload; what "grows" is only append-only subgraph growth
(`Plan.append`, `flows.engine.subgraph-appended`) and new trampoline rounds.
*Revises D-005:* draw the built plan solid, grey the `skipped` arm, and reserve
the ghost treatment for appended generations and future rounds.

### D-019 — Revises D-013: the engine already streams; the gap is the app relay. RULED (fact)
The gateway serves `Projection.Subscribe` over `/projections/ws` with cursored
snapshot/row/delta frames and a 30 s heartbeat
(`packages/smithers/gateway/src/GatewaySchema.ts:444`,
`gateway/src/Projections.ts:56`), and `Watch` over `/rpc/ws`. What excludes them
is the product Worker's allowlist (`packages/backend/internal/compose/browser_flow.go` `browserFlowProcedures`), by a
deliberate choice that "a stream belongs on the gateway's separately
authenticated WebSocket mounts." So liveness is an auth/relay problem in
`apps/server`, not an engine feature request.

### D-020 — The one thing genuinely missing: a plan-graph projection. PROPOSED
Seven projections are served today (`GatewaySchema.ts:171`): `workspace-runs`,
`run-summary`, `run-events`, `transcript`, `run-tree`, `approvals`,
`node-output`. None of them carries the plan's node ids and edges.
`RunTreeRow.nodeId` is "the ordinal the call opened on, because the emitter names
no node" (`GatewayProjection.ts:83-86`). The real graph lives in
`flows_plan_nodes` / `flows_plan_edges` and in the `flows.engine.node-scheduled`
/ `node-settled` / `node-invalidated` / `node-reconciled` journal events
(`engine-store/src/internal/JournalRecords.ts:212-248`), none of which the
gateway projects.
*The work:* one row in the `served` table and one fold in `Projections.ts` — the
selector union, name literals, snapshot/row/delta frames and `rowSchemaFor` all
derive from that table. This is the smallest change that makes a live DAG
possible, and it is the first engineering task.

### D-021 — The pitch candidate is the content-addressed re-run, not the watching. PROPOSED — needs Will
A node's step key is a function of what it consumes, so editing one node re-keys
that node and everything downstream of it **and nothing else**
(`flows/plan/src/Plan.ts:4-12`: "That is the entire invalidation mechanism").
Node ids never enter the hash, so renaming and repositioning are free
(`StepKey.ts:459-461`). Cache state is legible before a run
(`PlanNodeStatus = ["cached","run"]`, `ControlSchema.ts:198`) and after
(`Settlement.outcome ∈ {built, clean, failed, skipped, deferred}`,
`PlanScheduler.ts:125`).
This is Bazel's incrementality applied to agent runs, it is structural rather
than a UI trick, and n8n cannot copy it — their answer is manual pinning plus
partial execution (research.md §1). "Watch a graph run" is table stakes; "change
one step of a two-hour agent run and pay for one step" is not.
*Falsified if:* in practice most edits land near the root, so the cached suffix
is small and the saving is illusory.

### D-022 — Editing a node invalidates approvals bound to the plan digest. RULED (engine fact, must surface in UI)
Approvals bind to the keyed node graph: `ApprovalTarget` is `Plan{planId,
digest}` or `Node{...}` (`control/src/ControlSchema.ts:~140`), and the digest
comes from `Plan.compile` (`plan/src/Plan.ts:341`). Re-keying a node therefore
invalidates the approval that covered it.
*UI consequence:* a canvas edit must show which approvals it just voided, before
it is committed. This is a safety surface, not a nicety.

### D-023 — Approval and human-task rendering is already specified by the engine. RULED (fact)
`flows_runs.waiting_request` holds the question as JSON — `{task, name, kind,
prompt, attempt, maxAttempts, options?, schema?}` with `kind ∈ ask | confirm |
select | json` (`flows/flow/src/HumanTask.ts:70,505`,
`run-store/src/migrations/0004_waiting_request.ts`). `kind` picks the control,
`options` fills a select, `schema` validates a JSON answer. That is the render
spec, and it already matches THE FORM LAW in `apps/app/AGENTS.md`. Do not invent
a second approval schema.

---

## Round 4 — from building the mock (2026-09-18)

### D-024 — The camera follows the action; the graph is never shown unreadable. RULED (from the mock)
A 14-node flow is ~3,700px wide at readable density. Fitting it in a 1,000px
pane puts every node at 0.26 zoom, which is a picture of a graph rather than a
graph. The mock pans to the live node at ~0.94 and pulls back to ~0.62 only for
the cached/dirty boundary. n8n has the same constraint and answers it with
manual panning; following the run is strictly better and costs nothing.

### D-025 — No minimap. RULED (from the mock)
At this aspect ratio every node renders as a 2px sliver. It was built, looked
like noise, and was deleted. Revisit only if flows become genuinely 2-D.

### D-026 — Colour is never the only signal. RULED
Every node carries its state as a word as well as a colour (`waiting on you`,
`cache hit`, `will re-run`, `skipped`). This is the a11y contract `@smthrs/ui`'s
canvas anatomy already assumes, and it is also what makes a screenshot readable.

### D-027 — The third act is the product; the first two are setup. PROPOSED
The mock proves the ordering: drafting and running are recognisable from every
competitor, and the re-key preview is the only beat that has no analogue. If the
demo has to be cut to ninety seconds, cut acts 1 and 2, never act 3.

### D-028 — The mock shows the consequence of an edit, never the edit. NOTED
Deliberate. D-003 is unresolved, so the mock refuses to imply an answer: you see
what an edit re-keys, what it costs and what it voids, but the edit itself
happens off-screen. The next design round has to close D-003 or the builder
half of the product stays a promise.


---

## Round 5 — Will's rulings and a self-review (2026-09-18)

### D-029 — The vision: agent-led build, live run, incremental re-run, on one canvas. RULED (Will)
"Mostly just an agent walking you through building and potentially running the
workflow in real time with n8n animation and [the content-addressed re-run]."
This settles the question D-021 asked. D-004 ("monitor before builder") is
superseded: builder, monitor and re-key ship as one surface.

### D-030 — Flows predict how long things will take. RULED (Will)
Per-node expected duration before it runs, a run ETA over the critical path,
progress against prediction while running, and the re-key estimate. Source:
`flows_attempts.started_at_ms / finished_at_ms` grouped by action tag (stable
across re-keys, unlike the step key). Show p50 with the sample size; fall back to
a range when p90/p50 > 3; show nothing when there is no history — never a row
whose value is "not measured yet" (AGENTS.md MINIMAL TEXT). No predictor exists
in the engine today; this is new engineering work and needs a projection.

### D-031 — The trigger is not a plan node. RULED (engine fact, found in self-review)
A trigger is a Dispatcher registration. It has no step key, is never `built` or
`clean`, and a manual re-run does not re-fire it. On the canvas it is `armed` or
`fired`, joined to the plan by a UI-only `fires` edge, and excluded from every
count. The first mock got this wrong and called a trigger a cache hit.

### D-032 — Skipped nodes are not cache hits. RULED (self-review)
The first mock claimed "11 cache hits" by adding 2 `skipped` nodes and the
trigger to 8 `clean` ones. The honest figures for the demo flow are 13 plan
nodes, 11 executed, and after the edit 3 re-run / 8 clean / 2 skipped.

### D-033 — Code shown in the product must compile against the real API. RULED (self-review)
The first draft of the demo flow source misused four APIs: `Node.andThen` takes
a Node (not a thunk), `Node.catch` takes `{ onFailure }`, `Node.branch` takes a
Node as its subject, and a `Classifier` has `evaluate`/`evaluateAll`, not `call`
— a Jev decision becomes a plan node by wrapping it in an `Action` whose layer
calls the classifier. Fixed against `plan/src/Node.ts`. The graph also gained the
value edge the code implies (`repro → writetest`), which dagre routes on its own
row. Rule: every edge on the canvas must be derivable from the source shown in
the code tab, and vice versa.

---

## Round 6 — round-2 mock and the production map (2026-09-18)

### D-034 — The graph lays out top to bottom. RULED (from the mock)
Nodes are 228×88, so a rank costs 142px vertically and 314px horizontally. A
15-node unrolled `reviewLoop(maxRounds=3)` fits a square pane at a readable zoom
top-to-bottom and is a 0.3-zoom ribbon left-to-right. This also ends the wasted
vertical band the first mock had. n8n is left-to-right because its nodes are
square icons; ours are wide cards.

### D-035 — The drawer's tabs appear only when evidence exists. RULED
Kind-specific first tab (`Schedule` / `Frames` / `Questions` / `Question`), then
`Output · Input · Code · Key · Attempts · Events`. A tab with nothing behind it
is absent, never empty (MINIMAL TEXT). An agent node, a Jev node and an action
node are three different data shapes, so they are three different panels.

### D-036 — The production host serves no plan graph and no node events today. RULED (fact)
`NativeControl.durableFlow` has no `plan` hook, so `PlanCard.nodes` is always
`[]`; `PlanScheduler` (the only emitter of `node-*` records) has no production
caller, and the `Interpreter` that does run emits no journal records. "No mocks"
therefore requires two engine changes before any UI: the plan hook, and
Interpreter node events through a `FlowRuntime.recordNode` seam. Live status
then folds app-side from the `run-events` pages the pump already reads, which
supersedes D-020's separate `plan-graph` selector.

### D-037 — Code drill-in is not cut; it gets an engine lane. RULED (Claude, against the planner's cut line)
The planner cut file:line provenance because the engine keeps only a function
digest. Will asked for "a really high quality way of drilling into things and
seeing the actual code", so it ships: a non-hashed `declaredAt {path, line}`
captured where an Action/Flow is declared and called, carried beside the plan
(never inside `KeyMaterial`, or every edit would re-key everything), plus typed
edge reasons from `Graph.build`. Both ride an additive optional `graph` field on
the PlanCard, outside the digest an approval binds to. Dagster's
`LocalFileCodeReference` is the prior art (research.md R2).

### D-038 — Ship dark behind `flowBuilder`, then flip. SUPERSEDED by D-080
Every `jj bookmark set main` is a production deploy and the Stop-hook autodeploy
does not gate on typecheck. The feature lands behind `VITE_SMITHERS_FLOW_BUILDER`
with the flag off byte-for-byte identical, and the flip is a one-line change Will
makes after testing.

### D-039 — External blocker: cloud workspaces run a *released* @smthrs. NOTED — Will's action
The engine half reaches real cloud workspaces only after a publish, and the
publish campaign is blocked on an `NPM_TOKEN` 401 that only Will can remint.
Until then the feature is fully real on the local stack (one command) and shows
`nodes: []` against production boxes.

---

## Round 7 — what the two critics caught (2026-09-18)

### D-040 — A node is headed by its action tag; titles are not engine data. RULED (fact)
`Plan.PlanNode` is `{id, kind, key, material, effects, dependsOn, conflicts,
strategy, runtime, priority, generation}` and an `Action` has a tag, not a title.
The mock's friendly titles ("Reproduce the bug") were invented. Cards are now
headed by the tag with the plan node id beneath. A human title can return only
as a real, non-hashed annotation on the declaration, next to `declaredAt`.

### D-041 — The state word is `clean`, not "cache hit". RULED (fact)
`PlanScheduler.ts:104-107`: `clean` means a recorded result served the node and
no executor ran, which includes same-run durable replay as well as a cross-run
cache hit. The re-key card may still count "cache hits", because after an edit
that is exactly what the unchanged nodes are. That last sentence no longer
holds on this host: nothing settles `clean` across runs (D-044) and nothing
turns cross-run reuse on (D-049), so an unchanged key is a changed-key count,
never a cache hit. Note also `NodeOutputRow.outcome` is only
`success | failure`; the five settlement words come from `node-settled`.

### D-042 — Only verbs the engine has. RULED
`Pin output` and `Re-run from here` are gone from the mock: the engine's pin is a
pinned read snapshot, not n8n's pin-data, and `runs.rerun-from <runId> <nodeId>`
exists nowhere. D-007 stands as a goal, but it is engine work for a later
milestone, not a button. Cut for the same reason: sticky notes, placement lanes,
conflict edges, a `parked on quota` trigger state, drag-to-wire.

### D-043 — A trigger is a cron schedule. RULED (fact)
`Trigger` is `{id, flowId, input, ...Schedule.fields, enabled}` and
`Schedule.cron` is a required `NonEmptyString`; `@smthrs/triggers` has no event
kind. Factory rules (`FactoryRule.event`) are a different object and are not
drawn as a trigger node. `describeSchedule` narrates five-field cron only.

---

## Round 8 — what wave 1 proved against the real engine (2026-09-19)

### D-044 — Cross-run cache hits do not happen on the production host today. RULED (fact, found by a falsification test)
The L8 lane ran the fixture flow twice on a real bridged engine with the same
input: every step re-dispatched, including the one with a declared
`idempotencyKey`, while `PlanDiff` called every node unchanged. Two causes, both
in the engine: `CacheAdmission.declaration` refuses a sealed action with no hard
`fileBoundary` (`Disabled / missing-boundary`), and `ActionKey.actionKey` folds
`runId` into the key whenever `Action.CurrentCacheEnvironment` is absent
(`kind: "run"`, not `kind: "cache"`). So "8 cache hits" is what the engine is
*designed* to do, not what the shipped host does. The re-key preview ships with
the honest number, re-run N of M, and a cache-hit count appears only where a
second real run proves it. This is the product's core claim and Will should
know it is currently latent. (Amends D-041: an unchanged node is `clean` only
when a recorded result served it; on this host it is not.)

### D-045 — `clean` on resume is not what the plan assumed. RULED (fact)
A resumed walk re-dispatches the parked action and the durable deferred hands
back its stored value, so the body runs again. `clean` is reachable by a second
run whose dispatches hit the step cache, and by same-run replay; both are tested.

### D-046 — Engine behaviour is not behind the app flag. NOTED, landing consequence
Every native `Plan`, including each launch, now runs `Graph.build` over the
delegate body and the card carries `plan`, so plan digests change for every
native flow when L1 lands. Approvals parked before that stop validating.
`VITE_SMITHERS_FLOW_BUILDER` gates only the UI.

### D-047 — Provenance is repo-relative by contract. RULED
`declaredAt {path, line}` is captured at `Action.make` / `Action.makeSystem` /
`Flow.make`, skips framework frames, never enters `KeyMaterial` (tested: the
step key is byte-identical with and without it, and from a different line), and
the journal schema refuses a path starting with `/`. A root of `/` strips
nothing and is treated as no root, so a home directory cannot reach a journal.

---

## Round 9 — what wave 2 proved (2026-09-19)

### D-048 — Evidence the engine cannot yet join to a plan node. RULED, then largely retired by D-052
As first measured: a plan node's `attempts` was always 1 (`Interpreter.settleNode`
wrote it unconditionally; the engine's retry lives inside one dispatch);
`attempt-started` carried no node id and node records no dispatch key; the
`node-output` projection is empty for anything but an agent run (it keys off
`control.agent.cell-call-*`); no node settles `clean` on this host (D-044
confirmed), outcomes observed exactly `built` and `failed`. D-052 closes the
first two; the last two stand.

### D-049 — Cross-run caching: a host may *declare* its environment; nothing turns it on. RULED (from the cache lane)
`Action.CacheEnvironment` is complete-or-absent by contract (`layers` must name
every semantic runtime layer with versions and configuration) and nothing in
the repo can enumerate that for the native host. Worse, a body that spawns a
process reading the tree through the OS escapes the sandbox overlay, yet the
result would still be published as hermetic (`WorkspaceSandbox.violations`
classifies only the overlay's own inputs). The lane shipped the smallest honest
thing: an explicit host option, default off, that lets a host declare the
environment its results are reusable under, with a real two-run test. Making
"edit one node, the rest are cache hits" true in production is a separate,
deliberate engine project: enumerate layers, and either observe OS-level reads
or restrict caching to actions that declare a hard file boundary. Will's call.

### D-050 — Flag off means byte-identical, and a reviewer enforced it. SUPERSEDED by D-080
The run-graph lane first registered `runs.graph.follow`, accepted
`traceView: graph` and wrote `payload.plan` on every launch with the flag off.
Rejected and fixed: with `flowBuilder` off, a run card is the card it was.

### D-051 — Trigger rows from the box store are read-only. RULED (fact)
No Control RPC exists for enable, disable, edit, delete or test-fire on a box
`TriggerStore` row; `triggers.run` and `triggers.pause` are Plue routes keyed by
slug. The panel offers only what exists.

---

## Round 10 — what wave 3 settled (2026-09-19)

### D-052 — A node's evidence is joinable, and the attempt count is the engine's. RULED (facts, asserted on the bridged real engine)
`node-settled` now carries `stepKeyDigests` (the dispatches the node ran under,
capped at 16), the real attempt count, and a bounded result summary: redacted
through `@smthrs/journal`'s `Redaction` *before* it is cut (a credential split
across the cut is a credential the rules no longer recognise), previewed to
2 KiB, and named by size alone above 64 KiB. Every `attempt-started` digest is
claimed by exactly one node of one execution; the retried fixture node settles
at `attempts = 2` with attempt rows `[1, 2]`. `node-scheduled` carries no
digests, and cannot: the engine allocates a dispatch's ordinal when the
dispatch happens, after the schedule record is written. `PlanScheduler` (no
production caller, D-036) was left alone.

### D-053 — Amends D-030: the ETA is the longest path, and the estimate is honest or absent. RULED
`criticalPathEta` is the LONGEST path over `dependsOn`, never a serial sum. A
node that dispatches nothing (no action tag) and the plan's own root cost 0, as
does a settled or skipped node. The ETA is undefined if any node that will
execute has no duration row. p50 with `n`; a range when p90/p50 > 3; nothing at
zero samples; an older box that refuses the selector is silently "no rows". The
re-key HUD shows numbers only and no cache-hit count unless the run it compares
against actually recorded `clean` settlements (tested both ways).

### D-054 — The Code tab renders the file inline, and the plan card gets provenance too. RULED (Claude)
Inline through the app's existing `CodeFileView` (Shiki, line anchoring, hover,
go-to-definition), anchored at `declaredAt.line`, with the plan node id as an
AST path and `Open file` as the escalation to the full card. The plan card gets
provenance through one more additive field, `PlanGraph.nodes: [{id, declaredAt}]`,
outside the approval digest.

### D-055 — `conflicts` is not drawn. RULED
Neither the plan-card node schema nor the run-graph node carries `conflicts`,
and D-042 already cut conflict edges. The Declaration tab omits it.

---

## Round 11 — what wave 4 settled (2026-09-19)

### D-056 — The Code tab landed inline, and a refused read is written on the card. RULED
The tab renders through `CodeSurface` over the file card, anchored at
`declaredAt.line`, for both the run graph and (through the additive
`PlanGraph.nodes: [{id, declaredAt?}]`, outside the approval digest) the plan
card. `withToast` holds a 300 ms debounce, so a read the repository refuses in
40 ms resolved a toast that was never shown: the failure was silent. The refusal
is now `codeError {path, message}` on the card, drawn where the file would be,
cleared by a read that succeeds, with `Open file` as the retry door. The path
relativiser moved to `@smthrs/journal` beside the `DeclaredAt` schema, so the
engine's node records and the control plan card refuse an absolute path by the
same rule.

### D-057 — A plan drawer has no Attempts or Output, and that is correct. RULED (fact)
A plan is what *would* run; it carries no run records. Only the run drawer shows
Attempts and Output. Attempt rows carry ordinal, state and timing and no error
text, because `flows.engine.attempt-finished` records none; the one bounded
typed error the engine keeps is the node settlement's, shown on Output.

### D-058 — Dimming is done with colour, never opacity. RULED (from the a11y review)
`opacity: 0.72` on pending and skipped nodes composited the state word down to
3.07:1. Settled-quiet states are now drawn with muted tokens at full opacity.
The mock's 38%-opacity skipped node was wrong for the same reason.

### D-059 — Known gaps at hand-off. NOTED
- **No axe scan.** `axe-core` is in no lockfile and lanes may not touch
  `pnpm-lock.yaml`; the spec asserts accessible name, role, keyboard reach and
  contrast by hand instead, and `apps/E2E-CANARY-CHECKLIST.md` E13.11 records
  the gap. One lockfile entry closes it.
- **No typed fault class on the plan card's workspace failures.** The relay
  answers `provisioning | no-capacity | quota-exceeded | no-cloud-identity |
  no-cloud-repo`, but `provisionWorkspaceImpl` collapses them to their message
  before the card sees them. That is pre-existing app plumbing shared with every
  launch, and changing its contract is its own lane.
- **An older box cannot refuse an unknown selector with a code**: it dies in its
  request decoder. Silence ("no rows, no chips") is the only honest rendering.
- Cross-run cache hits (D-044, D-049) and trigger editing (D-051) are absent by
  engine truth, and the manual test guide says so.


### D-060 — Re-key counts describe keys; a dispatch-cache preview remains blocked. RULED (cfxengine review fix)
Amends D-041/D-044/D-053: the preview says `re-keyed N of M` (new or
changed keys), never how many nodes will run. Unchanged actions retain p50;
only unchanged nodes recorded `clean` in the compared run cost zero. Missing
history suppresses ETA even when no key changed. `was N clean` is historical
evidence, not a prediction of hits or savings. The persisted `rerun` field
retains its old wire name for existing cards, but represents changed keys.

A bounded cache read cannot honestly answer the proposed probe today:
`packages/smithers/src/internal/NativeControl.ts:495` compiles graph drafts,
without constructing runtime action dispatches. Those dispatch keys are
constructed in `packages/smithers/flows/engine/src/FlowEngine/ActionKey.ts:158`
from runtime idempotency material, declarations, file boundaries, environment
and sometimes execution id/ordinal (`:219`, `:242`). Plan keys are not those
keys. A prior `stepKeyDigests` list identifies prior dispatches, not the next
run's inputs. Even a matching stored row is only a candidate:
`packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts:1384`
checks admission evidence and `:1428` remeasures the current file boundary
before accepting it.
`packages/smithers/flows/engine-store/src/internal/CacheAdmission.ts:82`
refuses missing boundaries, and the native host does not declare the complete
cache environment (D-049).
Exposing a lookup by plan key would invent a verdict; enabling caching or
executing action bodies to discover keys is outside a read-only preview.
A probe needs a shared, side-effect-free dispatch descriptor plus the same
admission/boundary checks as execution. This lane leaves it blocked rather
than claiming Will's cross-run incremental goal is implemented.


### D-061 — Graph pages have an encoded bound, and no width is refused. RULED (cfxengine review fix; AMENDED 2026-09-20)
The interpreter preflights every page at 12,000 UTF-8 bytes. A durable host
measures the full redacted journal entry, including producer/event ids and
reserved sequence/time fields, through `nodeRecordBytes`.

AMENDED: nothing about one node has to fit one page. A node is seated with no
dependencies on it, and then its dependency list and the edges that END on it
are spread over as many following pages as they need; a continuation page
re-seats the same summary with the next DISJOINT slice of `dependsOn`. A
reader assembles pages in order, unions `dependsOn` per node id and
concatenates edges (`FlowGraphStatus.absorb`). The summary is seated no later
than the first page naming one of its dependencies or edges, so an assembled
PREFIX never names an edge whose destination is unknown. The page boundary is
found by bisection, so a thousand-way fan-in costs a logarithmic number of
measurements per page rather than one per item.

The original ruling kept nodes and incoming edges together and refused any
node that could not fit alone. Review 3 measured what that costs: a flat
`Node.all` was accepted at 130 members and refused at 140 under the in-memory
measure, lower on a durable host, while `flows/wiki/workflow.ts:66` fans out
over `input.pages` — a caller-sized width. A plan-time refusal that depends on
the caller's input size is not a bound anyone can design against, so the width
is paged instead. `InterpreterError {code: "node_record_too_large"}` is left
for the one thing paging cannot divide: a node whose summary with NO
dependencies on it still exceeds the budget, and a runtime whose envelope has
no room for a single dependency or edge beside a seated node. Both refuse
before any page is recorded or any work is dispatched.

A 1,000-way fan-in is now recorded, through the durable envelope, park and
resume included (`engine-store/test/InterpreterNodeJournal.test.ts` "pages a
thousand-way fan-in through the durable envelope, once across resume").

Page ids remain deterministic within an execution, including page boundaries:
the reserved page-count width is nodes + dependencies + edges, an upper bound
on how many pages can exist, so replacing it with the final count can only
shrink an encoded envelope.

Measurement reserves numeric envelope widths rather than reading the clock or
journal sequence. Real SQLite park/resume tests compare the persisted pages
byte for byte. The gateway applies its 16 KiB UTF-8 event bound to the complete
bridged graph envelope and returns `resource_limit` for an oversized legacy
page, rather than clipping topology or exempting it with other native results.

### D-062 — Duration history follows the newest terminal run query. RULED (cfxengine review fix)
`List` supports `filters.terminal` and `order: "newest"`; omission keeps the
old listing order and cursor encoding. Newest means creation time, with stable
sequence/id tie breakers, not an invented completion timestamp. Duration
history requests the newest twenty terminal runs of its flow. The filter and
limit apply in the control query, so passing 500 runs cannot freeze history.

## Round 12 — cfxapp falsification fixes (2026-09-19)

### D-063 — Persisted Code-read keys contain no NUL. RULED
Toast identity encodes the repository/path tuple as JSON. The SQLite loader
repairs legacy Code-read toast row keys, including the physical key truncated
by wa-sqlite's NUL-terminated text binding, before a collection may write them.
The row payload and version remain intact. Real Chromium network throttling
covers reload during and immediately after the read; a browser profile saved
in the original broken state also boots after the repair.

### D-064 — A completed plan remains an interactive surface. RULED
Its card stays active. Previously persisted acted cards containing a graph are
also drawn at full opacity, extending D-058 through the ancestor chain. The
embedded canvas grows with the viewport; maximize presents the same component.
Ranks are compact, the camera starts at the entry node at 1x, and run graphs
follow the engine's active node by default (D-024). Explicit follow-off is
persisted. Panning and keyboard focus reach the rest without shrinking text.
The Chromium gate checks rendered caption size and composited contrast through
all ancestors in every theme/palette combination.

### D-065 — Engine node IDs cross every door losslessly. RULED
The four graph select/tab flows have matching FlowArgs encoders and grammars.
Simple arguments keep the existing shorthand; JSON carries spaces, quotes and
other structured values. Pointer, keyboard, dependency and tab navigation use
these encoders. The controller validates the exact ID against recorded nodes.

### D-066 — Time and state decorate geometry; they do not recalculate it. RULED
Dagre runs when topology changes, not on journal status, measurements, selection
or elapsed ticks. The longest-path ranker retains dependency order without the
network-simplex optimization cost. A dagre invocation test and a 500-node graph
check replace the host-dependent repeated-layout CPU-ratio benchmark.
Running elapsed time extends the last engine timestamp by subscribed local
monotonic deltas, with the subscription released at settlement/unmount. No
local wall-clock timestamp is presented as an engine event, and unmeasured
nodes receive no predicted duration or progress bar.

### D-067 — Flag-off equivalence has a pre-feature witness. SUPERSEDED by D-080
The frozen DOM, launch payload, requests, registry and agent catalog were
captured from main@origin commit `7e30df62cf786834a26507f05b5d22f377641f20`
in an isolated jj workspace. That checkout contains neither FlowRunGraph nor
AppController's flowBuilder feature. The capture harness and fixture provenance
live under `apps/app/src/mainview/state/fixtures/FlowBuilderBaseline.*`.
Comparing two renderings of the feature checkout alone does not prove parity.
Integration refreshed that witness from pre-feature main `16a391284f38ed39ff305ec8adead8f17d48d04a`
after its RunTrace and background-launch changes. The same capture harness runs
in an isolated main workspace; only generated request UUIDs are normalized.
It waits for the actual launch receipt and finds its durable card by run ID.
Re-run from pre-feature main `51cf05666542a5e43e2f36247a2c1561b8afbe57` and
again from `394ada6a3fb815b4b62cfc7bc2242e238d42ff44`, two hundred and six
commits after the freeze, the capture is byte-identical both times: the witness
is re-verified rather than merely still asserted.

### D-068 — The Code tab is bound to a recorded revision, or absent. RULED (srcrev)
A declaration site is a path and a line, and neither says which bytes were at
that line. Hosts now record the revision they read their sources at, and the
reader opens the file AT it or opens nothing.

What the host records. `SourceRevision.read` names the tree at a root: `jj log
-r @` first, because jj commits the working copy on every command, so the id it
prints holds uncommitted work and keeps resolving after the copy moves on; then
`git rev-parse HEAD`, but only for a tree `git status --porcelain` reports
clean, because a commit does not describe work it does not hold. Neither
answering is `undefined`, never a guess. `NativeControl` reads it TWICE and
keeps the answer beside `hostCatalog`: once before it composes its executor and
once after registration has read the catalog, and it records a revision only
where the two readings agree. The catalog is a startup snapshot of the modules
on that tree, and the plans walked out of it and the runs the engine drives are
the same modules, so one revision describes both — but only if nothing wrote to
the tree while they were being read. A host is not alone on its tree (a peer
agent, an editor), and startup is not instant: a single reading names a tree the
catalog may not hold. A tree that moved during startup names nothing, exactly as
a dirty git checkout does. A later edit changes neither the catalog nor the
recorded revision.

The engine is given a READER rather than a revision, because its store is
composed before registration reads the catalog, so the verified answer does not
exist when the engine layer is built. `EngineStore.Options.sourceRevision` and
`Runtime`'s host option accept `() => string | undefined` beside a string; the
store asks once per recorded page, which is always after registration, and
records nothing while there is nothing to record. Handing the engine the
make-time reading instead would have left a run's pages naming a tree the plan
had already refused to name.

Where it travels. `ControlSchema.PlanGraph.sourceRevision` rides beside the
edges and the sites, OUTSIDE the digest an approval binds to, so a host that
starts reporting it re-plans to the digest it planned to before
(`control/test/PlanHandoff.test.ts`). `EngineEvent.NodeGraph.sourceRevision`
rides on every recorded graph page, written by `NodeJournal` from the
`EngineStore`/`Runtime` option the host declares, for the reason the
declaration root lives there: only the writer knows which tree it read. The app
carries it onto the plan card and onto the run's plan snapshot
(`cards/PlanNodes.ts`), and a folded execution keeps only the revision every
page of it agrees on — a page naming another, or naming none, leaves the
execution with none, because a site opened at another page's revision is a file
nobody recorded.

What the reader does. `files.read` takes a revision, asks the contents route
for it with `?ref=`, keys the card `(repo, path, ref)` and records the ref it
holds instead of the head it did not read. The drawer draws a Code tab only
where a site AND a revision exist, renders only a file card read at that
revision, and arms no language-server gesture on it: a server answers about the
file on disk, which a revision is not. A read the route cannot serve at that
revision is the typed refusal the card already draws. The door beneath the site
is that tab's own door and no longer `files.read`, which names a path and no
revision: it would answer the working tree and leave a second card of the same
file, under the same title, holding bytes nobody recorded.

What still does not hold. A file card records the ref it ASKED for, never one
the answer proves. A contents route that ignored an unknown `?ref=` would be
indistinguishable from one that honoured it, and the reader would be shown
default-branch bytes under the recorded revision. The only route-level proof
here is the fixture gateway this work wrote (`scripts/flow-graph-e2e-gateway`,
which refuses any ref that is not an object id before it spawns jj or git);
nothing binds Smithers Cloud's contents route to honouring `ref`. The local app
route (`POST /api/repo/files`) serves a working copy and takes no revision, so a
checkout opened on this machine refuses a revision read in as many words rather
than answering with bytes nobody recorded — a native host that wants the tab
back has to serve a revision. A read is keyed `(repo, path, ref)`
and a held card answers for the whole file, so `Open file` on a SECOND node of
the same file at the same revision spends no request: `readDeclaration` moves
that card's anchor to the node's line and puts it at the tail instead. The
integration walk measured the old behaviour — the card stayed on 169 while the
drawer read 180 — and `graph.test.ts` now opens two nodes of one file and reads
the held card's line. A declaration in a file outside the workspace root records no path at
all (D-047) and so has no tab either, revision or not. A host under no version
control, and a git checkout carrying work no commit holds, name no revision:
their plans and runs draw the graph and show no code. Nothing here snapshots
the source into the plan; it names a revision the version control system
already holds, and a revision garbage-collected out of the repository reads as
not found at that revision.

Evidence: `packages/smithers/test/SourceRevision.test.ts` (the decision, and
real git repositories), `NativeControlPlan.test.ts` (a plan and the run it
launched name the same revision on one host, and neither names one when a write
lands while the catalog is being read),
`engine-store/test/InterpreterNodeJournal.test.ts` and
`flows/test/SourceRevisionOption.test.ts` (every recorded page carries it,
including one a reader answered only after the runtime was built),
`state/controller/graph.test.ts` (an edited working tree does not change what an
old plan shows), `e2e/graph/lifecycle/gateway.test.ts` (the route answers a
revision out of jj or git while the tree moves) and `e2e/graph/flow-graph.spec.ts`
"shows the source the plan was built from, not the file on disk".

### D-069 — Authoring updates follow applied source receipts through Plan. RULED (cfxbuilder)
With the builder flag on, `flow.create` persists a launch request and returns
before provisioning or planning the authoring run. Its shared toast continues
through execution and journal settlement. Reload reconnects that request using
the same control idempotency key. The shipped authoring entry is `create-flow`,
not the retired `create-workflow` name.

A `diff-bundle-captured` alone is speculative. Match `copy-back-settled` by
execution, generation, run, attempt, step digest and bundle identity before
using its changed paths. Native successful `write`, `edit` and `apply_patch`
cell-call results also record applied paths. Prose and shell transcripts are
not source receipts. Registry entry paths identify the affected flow; unknown
paths produce no invented target.

The observer invokes the registered `flow.plan` door as a system action, and it
runs on every journal PAGE the run pump persists, not at the terminal summary:
`workflow-pump.ts` calls `observeFlowAuthoring` after each page it commits, so
a receipt that lands in the author's first minute redraws the canvas while the
author keeps working. The observer is deduped per card (`refreshing`) and drops
a page whose owner is no longer the signed-in identity. Guarding that call with
the terminal phase fails `FlowAuthoring.test.ts` "settled source receipts
replan on the same card", which asserts two redraws and then the run's own
`running` status. The
authoring run reserves the preceding transcript position for its plan. Later receipts replan
against the previous plan on the same card, retaining valid selection.
Reload compares recorded receipt times across authors, so an older completed
author cannot replay over a newer edit. Untimed legacy receipts do not establish
that ordering and do not trigger automatic planning. The drawer compares recorded keys (`added`, `unchanged`, `re-keyed`); this comparison
does not predict skipped execution or savings. All state is in card payloads.

The credential-free browser scenario uses a scripted author, real source
writes, sandbox copy-back receipts, journal pages, source compilation and
execution. The gateway uses ESM so dynamically imported source shares the
engine's declaration registry. Its command chat is not Jev. This proves the receipt/canvas wiring,
not provider reasoning. The production native executable catalog is no longer a
startup snapshot: D-073 rebuilds the entry a matched receipt names, and
`packages/smithers/test/FlowCatalogRefresh.test.ts` plans and runs a flow a
native host's own run wrote. The browser scenario reached its authored flow
through a fixture wrapper when this was written; D-081 replaced that with the
host's own registry, catalog and refresh. An
execution-bound source identity (D-068) and a real-provider canary remain
blockers for claiming the complete D-029 goal. No Anthropic or gateway key was
available in this lane.

### D-070 — The approval 502 did not reproduce in twenty integrated Chromium runs. NOTED (integration)
On 2026-09-19, from `apps/app` on the integrated stack over main
`16a391284f38ed39ff305ec8adead8f17d48d04a`, ran:

```sh
SMITHERS_FLOW_GRAPH_PORT=47391 VITE_SMITHERS_FLOW_BUILDER=true pnpm exec playwright test --config playwright.graph.config.ts --grep 'advances each node' --repeat-each=20
```

All 20 repetitions passed in 132 seconds, with one worker and zero retries.
One fresh owned host served all repetitions; each had a fresh browser context.
Each launched `gateway/GraphFixture` through the real relay/gateway, waited for
its HumanTask approval, opened the graph, checked the running gate and pending
arms, exercised Follow, submitted `merge` through the approval card, and waited
for ten `built` settlements, one recovered `failed` node, and `Finished`.
No attempt returned the reported 502 or left a parked run. The integration
retains cfxbuilder's per-origin Bun relay connection policy and cfxengine's
owned process shutdown; no retry or longer timeout was added. This does not
establish the cause of the earlier engine-lane failure or claim a new cause fix.
The host shut down through its finalizers. Full output is retained in the
integration gate evidence (`approval-20.log`).

### D-071 — No surface names a run's id, so the manual walk names the sequence instead. NOTED (integration)
MANUAL-TEST.md step 11 needs a run id to type into
`/flow.plan against=<runId>`. It told the reader to open the run card's
**Progress** fold and read `Started … (run …).` off its first line. That
sentence is never written: `workflow-launch.ts` persists the request card with
`steps: []` before the control plane answers, and `upsertRunCard` keeps that
list (`steps: held?.steps ?? [args.firstStep]` — an empty array is not
nullish), so the `firstStep` string `workflows.ts` computes is discarded on
every durable launch. This is main@origin's behaviour, not this stack's.
`/runs.list` cannot fill the gap on this host either: it refuses with "No
repository is loaded yet", because the graph fixture serves flows without a
loaded repository. Walked on 2026-09-19 against a fresh host on port 47391:
the run card's whole text contains no run id, and `/runs.list` opens no card.

The guide now states the one fact that is true and checkable — this fixture's
control plane keys runs `run-1`, `run-2`, … in launch order — rather than
quoting a sentence the app does not render. Restoring the sentence would put
copy back into every run card in the app for the sake of one manual step, so
it is left to the app's owner as a finding, not fixed from this lane.

### D-072 — Follow-off stops the camera; it does not pull back to the whole graph. NOTED (integration)
MANUAL-TEST.md step 6 said pressing **Follow** again "pulls back to the whole
graph". It does not, and it should not: D-024 rules that the graph is never
shown unreadable, and `FlowRunGraphSurface` fits the camera at `minZoom: 1,
maxZoom: 1`, so zooming out to eleven nodes is not available. Measured on the
same walk: with Follow on and with Follow off the run canvas carries the
identical transform `translate(-46px, 288.5px) scale(1)` and frames 2 of 11
nodes either way. The guide now says what happens — the camera stops where it
is and panning and the keyboard reach the rest — and cites D-024.

### D-073 — A native host rebuilds the catalog entry a run's own receipt names. RULED (cfxcatalog)
`Executable.layer` built the catalog once, while the host started, and froze
it. `NativeControl` planned only from that snapshot, so a flow one of the
host's own runs wrote into `flows/` had a descriptor and no executable:
`flow.plan` answered `FlowNotFound` or a plan with no nodes until the host was
restarted. That is the agent-led builder loop failing on a production box.

The seam is `Executable.Refresh`, provided beside `Executable.Catalog` by the
same layer. `Refresh.flow(name)` rescans discovery, rebuilds that one
executable from the bytes now on disk, registers its body with the runtime, and
swaps it into the catalog. Two properties make it safe on a serving host. The
`Catalog` service object never changes identity, so `AgentSession`, admission
and the plan hook keep the value they were handed while the snapshot under it
changes; one assignment swaps it, so a reader sees the list before or after,
never half-built. And the new body is registered BEFORE the previous body's
scope is closed — `@smthrs/flow` keys registrations by flow tag and a scope
release removes only the registration it still owns — so an execution
dispatched across the swap reaches one body or the other, never an
unregistered tag. Refreshes are serialized.

The trigger is the observer that already reads every native record.
`EngineJournalSupervisor` matches a settled copy-back to its bundle capture by
execution, generation, run, step key digest, attempt and bundle identity — the
rule `apps/app/src/mainview/state/FlowAuthoringReceipts.ts` applies to the
projected control rows, applied here to the engine's own entries — and
rebuilds the entry of each `flows/<id>/flow.ts` the pair applied. It rebuilds
before that record is copied into the control journal, so a client that can
read the receipt can plan the flow it names. A capture alone never triggers a
rebuild: a bundle that loses every rebase is a proposal, not source the
workspace holds. A refusal is logged and dropped; failing the observation over
a flow file that does not compile would take the run's whole evidence with it,
and the catalog keeps the refusal so `ls` still names it.

Module caching needed no new mechanism. The loader already writes the verified
bytes to a private sibling of the source file named by their content digest and
imports that path, so new bytes are a new specifier and the ESM cache cannot
answer with the previous body.

`loadFlows` now lists what the catalog holds as well as what the registry
lists, and a rebuilt entry WINS on a name it shares with discovery.
`materializeEngine` builds the registry layer a second time for the control
plane, so that snapshot can still be the one taken before the file existed —
or, for a flow a run EDITED, the one taken before the new bytes were written.
A host answering from it alone refused to plan a flow its own executor was
holding, and, for a name it already knew, published an approval card for one
body beside a plan of another: `durableFlow` reads the plan hook off the
rebuilt executable and description, capabilities, delegated flows, budget and
execution digest off the descriptor it is passed. Launching that card was
refused `execution_changed` against the file on disk, and every replacement
plan carried the same stale digest, so the refusal never cleared. That is the
builder's edit step, and the second case in `FlowCatalogRefresh.test.ts` is
it: an entry file on disk before the host starts, rewritten by a run to name
a different delegate, re-planned and run.

`flows/coding/host.ts` gets it too, which matters because that is the box the
product runs on: it serves `create-flow`, so it is where an agent's
`flows/<id>/flow.ts` actually lands. It assembles its catalog itself — the
repository's own tree with the verified loader, the reserved job declarations
out of the measured bundle it shipped as — so it serves that catalog through
`Executable.layerRefreshable` and names which half may be rebuilt.
`refreshableEntry` in `flows/repository/registry.ts` is that rule, shared with
`flows/test/coding-catalog-refresh.test.ts` rather than restated there: a
reserved declaration is held `Fixed`, because a run this host is serving can
write anything into the tree and must not be able to replace an admitted
declaration by doing so.

The seam is read, not required. `NativeControl` looks `Executable.Refresh` up
in the registration context and leaves a host that provides none exactly as it
was, so a composition with its own catalog and no rebuild of its own keeps the
startup snapshot rather than being refused at the type level.

Proof is `packages/smithers/test/FlowCatalogRefresh.test.ts`, on one
`NodeControl.layerControl` host with nothing pre-registered on the authored
flow's behalf: `plan` refuses `FlowNotFound`, a run writes
`flows/authored/flow.ts` through the workspace sandbox, the engine journals the
capture and its settled twin under one bundle identity, and the next `plan`
answers five keyed nodes whose declaration sites are `delegate.ts` — which the
host then approves and runs, settling both of the delegate's steps.
`packages/smithers/agent/registry/test/ExecutableRefresh.test.ts` covers the
swap, the re-import of edited bytes, the refusal, the removal, and rebuilding
one entry of several; `ExecutableRefreshSafety.test.ts` covers the three
properties this ruling rests on — the exclusive reservation, the
register-before-release order, and the serialization — each against the
behaviour that would break it. `packages/smithers/test/AuthoredSources.test.ts`
covers the pairing and the paths it refuses, and
`EngineJournalSupervisor.test.ts` covers its wiring: two bundles that each
touched a registry entry, one settled and one not, and only the settled one
rebuilt. `EngineJournalProjection.test.ts` holds the order itself — its hook
reads the control journal and asserts the record it was handed is not there
yet.

One property has no test, because it is not observable. A refresh whose
registration dies closes the scope it forked. `Layer.build` already unwinds
every finalizer its own construction added, whichever branch of a merge
fails, so a finalizer cannot tell the two apart; what the close actually
prevents is an empty scope staying in the layer scope's finalizer set for the
host's life, and no seam exposes that set. The line stays, and this is the
record that it is held by reading rather than by a test.

Two residuals belong to the rebuild rather than to the seam. The rebuild
reads whatever bytes are on disk at refresh time, not the settled bundle's
own content, so the identity half of "pinned by the receipt's bundle
identity" is still D-068's. And the default loader is a plain host-process
`import()`: top-level code in an agent-written `flows/<id>/flow.ts` now runs
unsandboxed in the serving host the moment copy-back settles, where before it
needed a restart. The path cannot leave `flows/<id>/` — `AuthoredSources.flowOf`
refuses `..`, `.`, empty segments, backslashes, control characters and
absolute paths, and the name comes from discovery rather than from the bundle
— and a reserved declaration is held `Fixed`. Nothing approves the import
itself. For the coding host, which holds credentials, that is a decision to
take deliberately: keep it, gate it behind static validation, or put an
approval between the write and the import.

### D-074 — The module loader could not load a project's own flow on any guarded host. RULED (cfxcatalog)
Fixing D-073 uncovered a defect underneath it. `Executable`'s default loader
reserved its private sibling with `FileSystem.makeTempDirectoryScoped`. The
capability kernel implements the `makeTemp*` family only over a wholly isolated
host filesystem (`flows/kernel/src/FileSystem.ts`, `atomic?.isolated`), and the
Node adapter is descriptor-relative rather than isolated, so wherever the
loader ran on the kernel-guarded filesystem the reservation was refused with
"host does not provide descriptor-relative, no-follow filesystem isolation"
and the flow was reported `body_unavailable`.

That is two places. The startup catalog of any host composed from
`Executable.layer` inside `NativeControl`, which builds `modules` under the
guarded platform: such a host could not load a single project module flow, and
no suite caught it because the compositions in the tree hand the loader a
`load` of their own (`flows/librarian/host.ts`) or a stand-in
(`NativeControlPlan.test.ts`, `fixtures/native-control-portable.ts`). And every
refresh, on every host, since a refresh runs in the registration layer's
context — including `flows/coding/host.ts`, which escapes the first case only
by building its catalog under the trusted filesystem before registration and
says so at that call site.

The exclusive create was always the real reservation, so it is now the whole of
it: the loader retries a digest-named sibling under `wx`, which fails on
anything already occupying the name including a symlink, performed relative to
a pinned parent descriptor without following one. Restoring
`makeTempDirectoryScoped` reproduces the exact refusal against
`FlowCatalogRefresh.test.ts`, which is how the diagnosis was established.

### D-075 — The browser fixture keeps its wrapper: an authored graph is not a production shape. SUPERSEDED by D-076 (cfxcatalog)
Review 2 asked for `BridgedEngineRun.ts`'s pre-registered `agent/run` wrapper
to go, so the Chromium authoring scenario runs the production path. It does not
go in this lane, and the reason is not effort.

Discovery does not admit the file the fixture authors. `AuthoringFixture`
writes a `@smthrs/flow` `Flow.make("authoring-demo", { body })` under a NAMED
export — a shape close to what `flows/create-flow/scaffold/flow.mdx` tells an
author to write. Two shapes, two different failures, both measured against a
real scan and `Executable.catalog`. The fixture's exact form returns NO
descriptor at all: discovery warns `missing_description` and
`unsupported_module_metadata` and the registry lists nothing. A file that
follows the scaffold literally — default export, literal `description`,
`input`, `output`, `capabilities` and `effects`, `@smthrs/flow` body — IS
discovered, and is then refused by the loader: `invalid_module` ("must
default-export a `Flow.make` value", meaning `@smthrs/core`'s) where a
delegate named `agent` is registered, and `missing_delegate` for `agent`
where none is. So the
authored graph the canvas draws has no production counterpart: a discovered
module flow declares a DELEGATE, and the plan a host answers with is that
delegate's topology, not the file's own.

Removing the wrapper therefore means changing what the scenario demonstrates —
the authored file would name one host-registered delegate and its edit would
name another, and the second version could no longer add a node of its own.
That is a product decision about what the builder writes, not a fixture repair,
and it is upstream of both this lane and the canvas.

Two things are recorded for whoever takes it. The wrapper's remaining job is
EXECUTION, not planning: `AgentSession` runs a module flow by calling
`executable.flow.execute({ input }, …)` from inside its registered `agent/run`
handler, so a fixture that registers `agent/run` the same way needs no
plan-time splice. And the gap between `create-flow/scaffold`'s instructions and
what discovery accepts is a live defect in its own right: an agent that follows
that stage writes a file this repository cannot see.

### D-076 — The file-based flow API is an ergonomic wrapper, and the repository now reads it that way. SUPERSEDED by D-079 (cfxcatalog)
This bridge is NOT in the integrated tree. `main` landed its own while this
lane was building; D-079 records which one the repository has and why. The
measurement below is kept because it is what the lane found, and because the
residuals it names are properties of the shape, not of one implementation.

Will's design intent, in his words: the file-based flow API "is supposed to
just be an ergonomic wrapper around" the low-level flow. They were siblings.
Discovery and `Executable.loadModule` admitted one shape — a `@smthrs/core`
`Flow.make({ description, input, output, flows, effects })` default export,
whose whole lowering is ONE node delegating to a flow the host registered —
while `flows/create-flow/scaffold/flow.mdx` told an authoring agent to write a
`@smthrs/flow` `Flow.make("<tag>", { payload, success, body })` graph at
`flows/<name>/flow.ts`, which the repository could not see. D-075 measured
both failures. This is the minimal bridge that closes them, and it is a bridge
rather than the refactor: `@smthrs/core` is NOT re-expressed as a layer over
`@smthrs/flow` here. That is D-077.

A module that default-exports a `@smthrs/flow` flow is now a discovered flow.
Its NAME is its path, as every entry's is; a declaration that tags itself
something else is warned about and overridden, because the registry, the
approval card and `ls` all address it by where it sits. Its DESCRIPTION,
CAPABILITIES, EFFECTS and delegated FLOWS are read off exported constants
beside it — `export const description = "…"`, `export const capabilities =
[…]`, `export const effects = { … }` — under exactly the literal rule
discovery already enforces on a manifest's inline fields, because discovery
reads a file without evaluating it. A value that is not wholly a literal takes
the conservative projection and says so; a missing description is refused by
name, because a flow nobody can describe is a flow nobody can choose. Its
INPUT and OUTPUT are the `payload` and `success` the declaration carries; the
descriptor's schema locator names the role, not the field, so one descriptor
shape covers both APIs.

Three properties make the bridged executable honest. The plan is the FILE's
own graph: the registered flow is a renaming of the author's, so
`Graph.build` walks the author's body and the nodes are the author's actions
under their own ids. It DELEGATES TO NOTHING, which is why it runs on a host
that registers no delegate at all — `Executable.delegate` is now optional, and
`Executable.withinEnvelope` is the one rule three admissions in two packages
ask instead of reading it, since an approved envelope covers what a flow calls
OUT to and a flow that performs its own work calls nothing out. And the
caller's JSON is DECODED through the author's own payload schema before the
body sees it, at plan time, so a plan is built from data the flow accepted or
is not built.

Which shape a module declares is read STATICALLY, from the bytes discovery
already measured, before anything is imported. That ordering is the whole
reason a graph flow is not refused `missing_delegate`: a host cannot know a
delegate is unwanted without reading the file, and importing the file to find
out would be the import the decision is supposed to precede. One consequence
is recorded rather than hidden: a module whose bytes are unreadable is now
reported `body_unavailable` before a delegate is named, because the file is
what says whether one is wanted.

`flows/create-flow/scaffold/flow.mdx` now shows one complete entry file and
`flows/test/create-flow-scaffold-conformance.test.ts` takes that example out
of the document, writes it as a project's flow, and drives discovery, the
executable and the plan over it. The instructions and the loader cannot drift
apart without that test failing, in either direction.

The browser fixture still has its `agent/run` wrapper, and the reason has
changed. D-075's reason — the loader would not admit what the fixture authors
— is gone. What remains is registration: `packages/smithers/test/
BridgedEngineRun.ts` composes its engine's flows when the layer is built, so a
flow discovered AFTER startup has nothing to register it, where a production
host composes `Executable.layerRefreshable` and registers a rebuilt body into
a running runtime. Removing the wrapper therefore means giving that fixture
the registration a host has, not deleting three lines, and it is written down
at the wrapper, in `e2e/graph/README.md` and in the manual walk rather than
left to be rediscovered. What is still unproven in a BROWSER is a client
walking an agent-authored graph through the production registry; what is
proven without one is `flows/test/create-flow-scaffold-conformance.test.ts`
and the registry suite, over a real scan and a real plan.

Three residuals, named rather than left to be discovered.

A graph flow's DECLARATION SITES name the verified sibling the loader
imported, not `flow.ts`. The loader writes the bytes discovery measured to a
private, digest-named sibling and imports that, which is what keeps what runs
equal to what was measured and what defeats the ESM cache across an edit
(D-073, D-074); a JavaScript stack frame names the module that was imported.
The line number is the author's and the directory is the author's, so the site
is not wrong, but a Code tab cannot open it. Closing this means either
remapping sites after a load — which needs a seam `@smthrs/flow` does not
expose, since actions declared in sibling files already carry correct sites —
or importing the source path under a cache-busting query and accepting a
TOCTOU window between the digest check and the loader's read. On a host whose
own runs are writing these files, that window is not theoretical, so the
sibling stays.

INPUT the payload schema refuses makes a plan of NO NODES with a logged
warning, because `NativeControl` reads a body that throws as unwalkable. That
is the existing contract for any body that throws, and it is honest as far as
it goes, but a caller who typed the wrong input deserves the schema's own
issue rather than an empty canvas.

And the FIXTURE's wrapper, above: a browser proof of the production path waits
on giving that stack a host's registration.

### D-077 — `@smthrs/core` becoming a layer over `@smthrs/flow` is a separate change. PROPOSED (cfxcatalog)
Still open, and unchanged by D-079: `main`'s bridge is the same kind of bridge.

D-076 makes the two APIs both loadable. It does not make one of them the other.
A manifest still lowers to a single delegating node built by
`Executable.fromDescriptor`, and a graph still lowers to itself; the shared
part is discovery's literal-metadata rule and the descriptor, not the runtime.

What the full change would be: `@smthrs/core` `Flow.make({ … })` returns a
`@smthrs/flow` flow whose body is the delegating node the bridge builds today,
carrying the manifest's declarations as annotations. Then there is ONE
executable shape, `Executable.delegate` goes away again rather than becoming
optional, and the `Invocation` envelope is an ordinary flow payload.

Why it is not this lane's: `Flow.make`'s manifest is a SERIALIZABLE
declaration that discovery reads without evaluating and that a descriptor's
execution digest is computed from. Making it a runtime flow means deciding
what a descriptor is a descriptor OF, and every approval card, execution
digest and journaled descriptor in flight is keyed on the answer. That is a
migration, not a refactor.

*Falsified if:* the two lowerings drift far enough apart that a feature has to
be written twice — a cache policy, a placement directive, a budget — at which
point the shared runtime is cheaper than the duplication.

### D-078 — Rebuilding a flow a run authored is an explicit host option, default off. RULED (cfxcatalog)
D-073 gave a serving host the ability to rebuild the catalog entry behind a
flow file one of its own runs wrote, and its own last paragraph named the cost
without paying it: the default loader is a plain host-process `import()`, so
top-level code in an agent-written `flows/<id>/flow.ts` runs unsandboxed in the
serving process the moment copy-back settles, where before it needed a
restart. Nothing approves that import. The coding host holds credentials.

The rebuild is now `Application.Config.rebuildAuthoredFlows`, OFF unless a
composition asks for it, and the default is the trust statement: turn it on
for a host whose runs you would let run arbitrary code anyway — a fixture, a
disposable box, a sandbox — and not for a host holding credentials a run must
not reach. `flows/coding/host.ts` therefore keeps its startup snapshot; its
catalog is still `layerRefreshable`, so the seam is there for an operator who
turns it on, and nothing calls it until one does.

With it off, an authored flow becomes plannable the next time the host starts,
which is where it was before D-073, and the app says nothing false in the
meantime: `plan` answers `FlowNotFound`, the typed refusal it has always
answered with for a flow this host does not hold, rather than a plan of no
nodes standing in for one.
`packages/smithers/test/FlowCatalogRefresh.test.ts` holds both directions —
the two D-073 cases with it on, and a third case with it off that asserts the
refusal and then proves a restarted host over the same directory plans the
file, so what the rebuild buys is the restart and nothing else.

Two residuals of D-073's own closed with it. A capture whose copy-back never
settled is now dropped when its ATTEMPT finishes: the engine journals a
settled copy-back inside the attempt that produced it and finishes that
attempt afterwards, and a failed attempt returns before the settlement block
runs at all, so nothing that was going to pair is still waiting. And the
rebuild's failure handling is split where it was conflated: a flow file that
does not compile costs the rebuild and nothing else, because the observation
around it is how a client learns a run's nodes settled — but an INTERRUPT is
re-raised instead of reported as a rebuild that finished, so a host shutting
down does not leave a log line claiming a rebuild that never ran.
`packages/smithers/test/AuthoredRebuild.test.ts` is those four endings.

### D-079 — `main` landed the graph-flow loader first; this lane's bridge was dropped, not merged. RULED (integration). Its "the browser fixture keeps its wrapper" ruling is SUPERSEDED by D-081
D-076's eleven commits are not in the integrated tree. While this lane was
building them, `main@origin` `137cebd5cc52` ("a flow file that default-exports
a `@smthrs/flow` flow runs its own graph") landed an independent
implementation of the same bridge. Two loaders for one shape cannot both land,
and the one the repository has is `main`'s: it is already released to every
other lane, and it is the stronger of the two.

Where it is stronger. A module that is its own flow runs the code its RELATIVE
IMPORTS hold, and the entry-file digest never measured that code, so an
approval bound to a `flow.ts` survived an edit to the sibling it imports.
`main`'s loader records the transitive closure of those imports on the body
(`registry/src/internal/ModuleClosure.ts`) and re-measures it before importing,
so an edited sibling refuses the approval. This lane's bridge measured the
entry file alone and would have shipped that hole.

Everything else the lane's bridge did, `main`'s does: `Flow.isFlow` (it lives
in `Flow/make.ts` rather than `Flow/Flow.ts`), discovery reading a graph's
description, capabilities and effects off exported constants under the literal
rule, `payload`/`success` standing where a manifest's `input`/`output` do, a
registered renaming so `Graph.build` walks the author's own body under the
author's node ids, an optional `Executable.delegate`, the author's payload
schema decoding the caller's input, and the capability ceiling merged from the
author's annotation bag (`Context.merge(body.annotations, annotationsOf(…))`).

Two things the lane had that `main` does not, recorded so they are not lost:

`Executable.withinEnvelope`. `main` keeps three copies of `executable.delegate
!== undefined && !card.envelope.flows.includes(executable.delegate)` — in
`AgentSession`, `ModuleAdmission` and `ModuleAuthority`. One question asked in
one place is a wording change with no behaviour in it, which is why it was not
carried over here rather than why it should not be.

A conformance test over the scaffold's own example.
`flows/create-flow/scaffold/flow.mdx` tells an authoring agent exactly what to
write, and nothing on `main` lifts that example out of the document and drives
discovery, the executable and the plan over it. The instructions and the
loader can drift apart silently again, which is the defect D-075 measured in
the first place. That test is worth writing against `main`'s loader.

What is unaffected. D-073, D-074 and D-078 — the rebuildable catalog, the
loader repair a guarded host needed, and the rebuild-on-authoring default —
are this lane's alone and are in the tree. So is D-068's recorded revision.

### D-080 — The flag is removed; the flow builder is the app. RULED (Will, 2026-09-20)
Will: "Remove the feature flag completely it shouldn't be there in first
place". `VITE_SMITHERS_FLOW_BUILDER` and `AppFeatures.flowBuilder` are gone,
with every conditional on them taking the flag-on branch. The plan door, the
plan and run graphs, the drawer, the fire ledger, the box's policy fields,
Pause, the camera and the authoring loop are what every visitor on
smithers.sh gets.

What went with it. The three refusals that existed only to say a shipped
feature was off — `flow.plan`, `runs.trace.view <run> graph` and
`runs.graph.follow` answering "This feature is not enabled." — are deleted;
those doors are registered, so a caller reaching one is a caller using the
product. `flow.create` no longer has two paths: the authoring request IS the
create door, and the launch-then-answer path it shadowed is deleted rather
than kept as a fallback. The flow-graph Chromium tier is one build and one
run, not two selected by the flag.

This supersedes D-038 (ship dark, then flip), D-050 (flag off means
byte-identical) and D-067 (flag-off equivalence has a pre-feature witness).
The witness those rulings were enforced with —
`state/fixtures/FlowBuilderBaseline.*`, `FlowBuilderFlag.test.tsx` and
`FlowBuilderBaseline.test.tsx` — proved a claim about an app that no longer
exists, so it is deleted rather than frozen. What replaces it is the ordinary
suite: the doors, the cards and the graph are asserted as the product's, with
no second app to be equal to.

Two things the flag had been hiding, found by flipping it and measured:

The deterministic claim gate never armed for `flow.create`.
`toolResultLaunchedRun` matched `run-started` and `run-requested`; the
authoring door answers `flow-requested`, which is the whole of what
`flow.create` returns with the builder on. So on the deployed build the model
was free to write "has been created" beside a run that had not launched —
the exact wave-12 lie, live, behind a gate that only ever fired in flag-off
tests. The gate now reads the authoring door's request, and the line it
substitutes says requested rather than started, because that is what the door
did.

The agent's command list crossed its byte bound. `flow.plan` becoming an
unflagged door takes the cloud catalog to 200 commands, which render at 16279
bytes plus the omission note against a 16384-byte tool-result limit, so
`listResult` drops to names only. Every name still reaches the model and the
note says to list one namespace to get the summaries back, which is the
ladder working — but the margin is now about fourteen bytes, and the next
visible command spends it. `flows/agentToolsList.test.ts` asserts the ladder's
contract and the remedy rather than the rung.

*Falsified if:* a reader on smithers.sh reaches a plan or graph surface that
refuses, which would mean a gate survived the removal;
`grep -rn 'flowBuilder\|FLOW_BUILDER' apps packages .github` finds one.

### D-081 — The browser fixture composes the refreshable registration; the authoring wrapper is deleted. RULED (integration)
D-079 said the authoring half of the browser stack keeps a pre-registered
`agent/run` wrapper, because "this stack cannot REGISTER" a flow discovered
after startup. That was true of the composition, not of the repository:
`Executable.layer` provides a live `Catalog` and the `Refresh` beside it,
`SqlControlRuntime.Options.loadFlows` reads a catalog per plan rather than
once, and `EngineJournalSupervisor.onSourceApplied` is the hook `NativeControl`
installs `AuthoredRebuild.rebuild` on. Those three seams are all a fixture
needs to be the production path, and `packages/smithers/test/BridgedEngineRun.ts`
now composes them.

What it does now. Serving a project (`stackWith({ authoring: true })`) builds a
real `Registry` over that project's `flows/` directory and an `Executable`
catalog from it, registered with the ENGINE's runtime. The control runtime
reads the catalog per plan, so a flow that did not exist when the host started
is plannable the moment its entry is registered — and `plan` answers
`FlowNotFound` until then, which is the typed refusal, not a plan of no nodes.
The observer that copies the engine's records into the control journal calls
`Refresh.flow(<id>)` when one of its own runs has applied `flows/<id>/flow.ts`,
before the record it acted on is copied, so a reader of the receipt can replan
at once. The `agent/run` wrapper resolves whatever the approved plan named: the
flows this composition registered by hand, then the catalog — and it refuses a
card whose approved execution identity the host no longer holds, which is the
check `AgentSession.approvedModule` makes before it dispatches a module flow.
Nothing is registered on an authored flow's behalf.

What the author writes. A `@smthrs/flow` GRAPH file in the shape
`flows/create-flow/scaffold/flow.mdx` teaches: one default-exported flow
stating its `description`, `payload`, `success` and `capabilities` literally,
dispatching actions the host resolves by name, importing nothing but bare
specifiers. It is measured, loaded and registered by the same code a deployed
box uses, and its plan's nodes carry `flows/authoring-demo/flow.ts` as their
declaration site — the loader says `Graph.evaluatedFrom(sibling, entry)` before
it imports, so a site names the file the run wrote rather than the
digest-named scratch module. MANUAL-TEST.md's paragraph claiming the opposite
was stale and is corrected.

What is still missing, measured while doing this. The drawer's Code TAB needs
a revision as well as a site (D-068), and `PlanGraph.sourceRevision` is forty
hex digits the contents route spawns `jj` or `git` with, so a content digest
cannot stand in for one. This fixture's project is a scratch directory under
no version control and names none, so the tab is absent — the rule working.
Read, not measured: a deployed box does name one, but `NativeControl` takes
`hostRevision` once while it starts (`NativeControl.ts`, the block that reads
`revisionBefore`/`revisionAfter` around the catalog build) and
`buildPlanGraph` publishes that value, so the revision a REBUILT entry's plan
carries is the one taken before the run wrote the file. Nothing here ran that
host to see what its Code tab then does. Re-reading the revision when the
catalog is rebuilt is the candidate fix, and it is not in this change.
The browser tier asserts discovery instead, where it can see it: the flow is
absent from `/flow.list` before the authoring run and listed after it.

Why this and not a host over `NodeControl.layerControl`. The other option was
to move the whole browser stack onto the CLI's own composition over a scratch
project. It renames `gateway/GraphFixture`: discovery names a flow after the
directory its entry sits in, so the fixture flow, its eleven node ids, its
trigger's `flowId` and its declaration sites would all move into a temporary
directory. `flow-graph.spec.ts` EDITS `packages/smithers/test/BridgedEngineRun.ts`
while the stack is up and reads the result back at the revision the plan
recorded (D-068); a scratch tree is under no version control and can answer no
revision, so that half of the tier would have had to be deleted rather than
moved. The hand-composed half stays where it is declared, under version
control, and only the half that has to be discovered is discovered.

What this costs. The rebuild imports an agent-written file into the serving
process. That is exactly what D-078 made an explicit, default-off host
decision, and this stack is the case it named: a disposable fixture whose
databases and workspace are removed when it stops.

*Falsified if:* `grep -n 'authoring' packages/smithers/test/BridgedEngineRun.ts`
shows a flow registered for the authored file, or the browser tier passes with
the registry's discovery scan removed.

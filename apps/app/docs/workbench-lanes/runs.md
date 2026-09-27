# Lane `runs` — the run lifecycle (the seven P0 gaps)

Brief: `../UI-COVERAGE-GAPS.md` §P0. Laws as every lane (EMBED LAW, NO
INVENTION, no useEffect, state in collections, every act a flow; consequential
acts confirm). Depends on nothing in flight; touches the flow-run card, the
gateway relay allowlist, and adds one card kind. Coordinate on
`Flows.ts` / `registry.test.ts` with any lane still editing them.

Scope, in order:
1. **Relay allowlist.** `packages/backend/internal/compose/browser_flow.go` `browserFlowProcedures` gains List runs,
   Resume, Steer (Message|Seat|Thinking|Tools), Signal, and the `transcript`,
   `run-events`, `approvals` (no runId) projections; server tests.
2. **`run-list` card.** Header: repo and one mono count line by status; rows
   runId · flow · status · waiting reason · age · turns/calls; a row opens
   the flow-run card; filter chips re-invoke `runs.list` with the chip's
   argument; footer `Stop all N` (confirm). Flows `runs.list [status] [flow]
   [by=] [lineage=] [owner/repo]`, `runs.open <runId>`, `flow.run.stop-all
   [owner/repo]` (confirm).
3. **`approvals-inbox` card.** Rows run · flow · question · age with
   Approve/Deny bound to the existing `approval.approve` / `approval.deny`
   by row id; count in the header mono line; `system.recommend` suggests
   `approvals.list` when non-zero. Flows `approvals.list [owner/repo]`,
   `approvals.open <runId>`.
4. **flow-run card: lifecycle.** Stop (confirm, optional reason) on every
   non-terminal phase; Resume when parked and not on an approval; Run again
   when terminal; the phase line names every waiting reason with its unblock
   act: `waiting · provider quota · resumes 12:40`, `waiting · timer ·
   14 min`, `waiting · signal <name>` (Signal button opening one JSON row),
   `accepted · nothing is driving it` (Resume). Flows `runs.resume`,
   `runs.rerun`, `runs.signal <runId> <name> [json]`; `flow.run.stop` gains
   `[reason]`.
5. **flow-run card: steer.** A steer composer row under the steps plus a
   mono strip `seat ▾ · thinking ▾ · tools ▾`; a queued steer reads
   `steering pending · delivered at the next turn` until delivered. Flows
   `runs.steer <runId> <message>`, `runs.seat <runId> <provider:model>`,
   `runs.thinking <runId> <level>`, `runs.tools <runId> <tool,...>`.
6. **flow-run card: Transcript and Events facets.** Transcript rows turn · at
   · kind · text with a follow toggle, maximize for the full log; Events
   shows raw ControlEvent JSON only under `debug.verbose`. Flows
   `runs.logs <runId> [--follow]`, `runs.events <runId>`.
7. Docs: LOCAL-APP.md cards section; WORKBENCH-UX.md gains a "Runs" note.

Exit: relay tests; seam tests with doubles for every projection and
operation; card tests per phase and waiting reason; T1 spec launching a
fixture flow, steering it, stopping it, and seeing it in the run inbox.

## Turn explanations and recorded inspection

The September 8, 2026 coding brief makes the inexpensive turn explanation the
entry point. `RunTraceBody` remains the body of the existing embedded run card.
Its default **Turns** view shows one chronological line per recorded turn. A
bounded excerpt of the model's recorded prose leads; code-only and truncated
responses fall back to actual call names. These excerpts are the model's words,
not independently verified explanations. The projection makes no extra model
request and persists no second transcript.

Selecting a turn opens that turn's recursive call tree and recorded detail in
the same card. The selected span controls source, input, output, failure, usage
and timing. Breadcrumbs navigate the recorded ancestors. **Timeline** exposes
the existing full tree and waterfall when wider execution context is useful.
**Graph** draws the run as flow nodes with their recorded status, falling back
to the plan's nodes; its button appears only when the card has either.
The card stays embedded until the human explicitly maximizes it; both
presentations retain the composer and the same card identity.

Selection pins the latest journal sequence already held by the card, or the
explicit sequence supplied to the command. Every part of the view folds only
that prefix, so an asynchronous result cannot silently appear in an older
inspection. Selecting another span retains the cursor. **Latest** removes the
selection and cursor and returns to the cheap live turn view. The pump keeps
collecting journal records while inspection is pinned. Reopening retains those
records and the view configuration; it does not clear a historical selection
while the next network read is pending.

The pump requests journal rows after the last retained sequence and offset.
Unchanged summary cursors skip journal reads unless the recorded native projection
is still pending. A control verdict can settle before its engine suffix arrives;
empty suffixes keep the retained cursor until the projection-settled marker,
an explicit read refusal, or the existing quiet bound. New rows at a higher
offset of the same sequence count as progress; an empty suffix does not.
Quiet or unavailable
observation preserves the actual terminal verdict and offers the existing retry.
Unchanged card projections skip transitions. Failed reads retain the prefix and
retry without advancing the cursor. Summary status, approval discovery and reconnect recovery still run
when the journal is unchanged. `/runs.events` omits the cursor to read the
full journal for explicit inspection.

### Command and data contracts

These are application flows, available through button, slash and agent doors:

```text
/runs.trace.view <runId> <turns|timeline|graph>  # new
/runs.trace.live <runId>                 # new
/runs.trace.filter <runId> <filter>      # existing; now agent-invocable
/runs.trace.select <runId> <nodeId> [seq] # existing; now pins by default
```

Missing inputs use the existing schema-derived form. Each transition records
the invoking actor. No command in this group requests fullscreen or changes
execution. Returning live uses the existing `card.upsert` transition because
`card.updated` merges payload fields: omitting a cursor in a patch cannot delete
it, and serializing `undefined` would lose that intent.

The shared private RPC card schema adds one optional field:

```ts
traceView?: "turns" | "timeline" | "graph" // absence means turns
```

The existing `selection`, `cursorSeq`, `liveTail`, `filter` and `events` fields
remain the persisted authority in TanStack DB. `TurnNarrative` is a transient
projection (`frame`, `number`, `text`, `source`), and `spanPath` derives
ancestry; neither adds a table or storage service. `SpanDetail.childRunId` is
derived only from a successful `agent/spawn` journal result's `child` field.
That field is the execution ID under the existing `EngineChildren` contract.
Its inspect button invokes ordinary `runs.open` for the card's repository.
Other result objects containing a `child` key do not establish a run edge.

Current limits are explicit: realm variable snapshots are not in these journal
events, and attached child runs do not provide a navigable child execution ID.
The existing call journal matches same-name concurrent settlements FIFO because
it carries no call ID. This UI does not invent a stronger association. The
existing slash grammar cannot address a run ID containing whitespace, so such
a child result is readable but receives no broken navigation button. A
separate, verified semantic summarizer can improve the recorded explanation
later; the browser must not synthesize claims about progress or correctness.

### Prior-art decisions, checked September 8, 2026

- [Temporal's history UI](https://docs.temporal.io/web-ui) groups execution
  history into summary, compact and raw presentations. Smithers adopts
  progressive detail over one recorded history, with a journal cursor that
  applies to every region of its card.
- [Chrome's debugger](https://developer.chrome.com/docs/devtools/javascript/reference)
  connects selected call frames with scoped inspection and reveals additional
  frames on demand. Smithers uses the same selection-to-detail relationship,
  while showing only values that its durable journal actually recorded.
- [Graphite's review UI](https://graphite.com/docs/review-pull-requests) keeps
  navigation context in a secondary tray and allows the tray to disappear in
  focus mode. Smithers keeps the turn list as context and opens its scoped
  tree only when selected, within the existing conversation width.

These are interaction inferences from primary documentation, not claims that
those products implement mythical history. This slice does not implement the
coding plan, JJ stack editor, revision-aware backpressure or wiki editor.

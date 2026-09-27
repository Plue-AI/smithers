# Driving the flow graph by hand

Everything below runs on your machine, against a real control plane and a real
engine. No GitHub session, no Smithers Cloud workspace, no provider key.

## Start it

```sh
cd apps/app && bun scripts/flow-graph-e2e-host.ts
```

The first run builds the SPA, which takes about a minute. Then it prints four
lines and holds the stack open, writing one trail line per request after them:

```
SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:47331
[flow-graph] relay    http://127.0.0.1:<relay port>
[flow-graph] workspace codeplanesmithers/smithers-demo
[flow-graph] open     http://127.0.0.1:47331
```

Open **http://127.0.0.1:47331**. On a rerun, `SMITHERS_SKIP_SPA_BUILD=1`
reuses `apps/app/dist`.

## Click through it

**1. List the flows.** Open the chat and send:

```
/flow.list codeplanesmithers/smithers-demo
```

Find `gateway/GraphFixture`, with a **Run** door and a **Plan** door. The
scripted `create-flow` is listed beside it. `authoring-demo` is NOT: nothing
on disk names it until a run writes it.

**2. Plan it.** Press **Plan**. The card draws 11 nodes with the count `11`
beside them. Each node is titled by the action it dispatches
(`gateway/graph/Steady`, `gateway/graph/Flaky`, `gateway/graph/Doomed`,
`gateway/graph/Cacheable`) or by its own id where it dispatches nothing. Four
arms leave the gate and a merge joins them.

**3. Open a node.** Click `gateway/graph/Steady`. A drawer opens as the row
UNDER the canvas, inside the same card — at every width, not only this one —
with the action tag, the node's own id, the word `run`, and two tabs:

- **Declaration**: tier `sealed`, kind `step`, and the step key the control
  plane keyed this node under (`key1_` and 64 hex characters). That key is the
  node's identity, and it is the number the re-key preview in step 10 moves.
- **Code**: `packages/smithers/test/BridgedEngineRun.ts:<line>`, where the
  graph builder observed this node being declared. The file is read AT the
  revision this host loaded its flows from, so it is the source the plan was
  built from and not whatever the checkout holds while you read it.

Click a node the builder synthesised rather than something you wrote —
`root.flow.then.map`, the merge — and the Code tab is gone: it was declared
nowhere, so there is nothing to open.

Under it, what this node waits on. Click `root.flow.andThen` and the drawer
moves to the gate. The `×` closes it.

**4. Walk it from the keyboard.** Click any node, then:

| Key | What happens |
| --- | --- |
| ↓ or → | follows the FIRST edge out of the open node |
| ↑ or ← | follows the FIRST edge into it |
| Enter or Space | opens the node the focus is on, and closes the one already open |
| Escape | closes the drawer |

Tab moves the focus between nodes, so Enter opens whichever one you tabbed to.

First means first in the order the workspace reported the edges, which is the
order the builder produced them. On the gate that is its `value` edge into the
flow body it returns into, so ↓ there goes to `root.flow` rather than into the
fan-out; on `gateway/graph/Steady`, which has one edge out, it is the merge.
↑ is the first edge IN and not the way you came, so ↑ on the merge goes to the
gate however you reached it: the arrows walk the graph, not your history.

**5. See the schedule.** Send:

```
/triggers.list codeplanesmithers/smithers-demo
```

The dispatcher card lists this repository's declared rules and, under
"listening", the one schedule the box holds. The row reads **Every day at
03:00 UTC**, then `runs gateway/GraphFixture`, then `enabled · next <clock>` — the next 03:00 UTC read in **your** zone and on your clock
(`8:00 PM` on US Pacific), because a card row reads an instant the way every
other card in the app reads one. The panel below is the one place a schedule
is read in the zone it declared.

Press **Plan** again. A twelfth node is now drawn above the plan, wearing
`armed`, with an edge into the plan's FIRST node: the gate,
`root.flow.andThen`, the only node that waits on nothing. Not the node whose
id is `root` — that one is the flow's own body, it waits on everything, and it
is drawn at the bottom of the canvas. The count still says `11`: a schedule is
not a plan node, so it is in no count.

Click it. Its drawer is the schedule panel, not the tabs: the cron in words,
`armed`, the next fire the registration states, and its Run now and Pause
doors. The word is the flag the registration records: a schedule held as off
reads `disabled`, never `armed`. Nothing polls this host, so the schedule is
armed and will stay armed.

**6. Run it.** Press **Run**. A run card opens and the run stops at its gate.
Press **Graph** in the run card's bar. The gate wears `running`; the four arms
behind it wear `pending`, because nothing behind a human task moves until it
is answered. The card says it is waiting for your approval and asks the flow's
own question, **Merge the fan-out?**

**Follow** puts the camera on the node the run is on. Pressing it again stops
the camera where it is and hands it to you: the graph is never zoomed out
below readable text (D-024), so the rest of it is reached by panning and by
the keyboard, never by shrinking it. Follow-off is persisted.

**7. Answer it.** Type `merge` and send. The run finishes in about a second:
ten nodes settle `built` and `gateway/graph/Doomed` settles `failed`. A failed
node is not a failed run: the catch arm beside it recovered, and the run says
**Finished**.

**8. Read what a node did.** Click `gateway/graph/Flaky` on the run's graph.
Five tabs now, because there is evidence behind five, in the order the strip
shows them:

- **Declaration**: tier `sealed`, kind `ActionCall`, boundary `expected`.
  No step key: a recorded graph carries none.
- **Code**: `packages/smithers/test/BridgedEngineRun.ts:<line>`, which is
  where the engine recorded this action being declared, and the node id split
  into the path through the flow's body.
- **Output**: what the node settled with, as the writer's own bounded,
  redacted preview, under the size it was cut from.
- **Events**: this node's own two records, `node-scheduled` and
  `node-settled built`, under their sequence numbers.
- **Attempts**: two rows, `1 failed` and `2 succeeded`, each with what it
  took, and the node on the canvas wears `attempt 2` beside its word. The step's failure is an injected
  counter shared by the whole stack, so this is what the **first** run of a
  host looks like; run it again and the step succeeds on its first attempt
  and the node says nothing about attempts. The rows are joined to the node
  by the step key digests its settlement names.

Press **Open file**. The file opens as a card at the tail, anchored on that
line: the `Action.make("gateway/graph/Flaky", {` the node came from. Step 3
already opened this file at line 169, so the card it opened moves to 180
rather than a second card of the same bytes appearing.

**9. Reload the page.** The drawer comes back open, on the same node and the
same tab. Which node a graph card has open is a fact on the card, not state in
the canvas.

**10. Measure it.** Press **Run** and answer the gate a second time, then
press **Plan**. Every node whose action settled `built` now wears a measured
duration, and hovering it says what the claim is: `p50 of 2 runs · p90 …`.

`gateway/graph/Doomed` wears nothing, and the header states no estimate. Both
are the same fact: only a `built` outcome is measured, Doomed fails every run,
and the estimate is the longest path through the graph, which runs through
Doomed. An estimate missing one node on its path would be short by whatever
that node takes, so there is none.

**11. Compare plan keys.** Nothing on screen states a run's id. A launch
persists its card before the control plane answers, and `upsertRunCard` keeps
the empty step list that card was persisted with, so the `Started … (run …).`
sentence that would have named it is never written; `/runs.list` needs a
loaded repository and this host has none. This fixture's control plane keys
runs `run-1`, `run-2`, … in the order you launch them, so the run you started
in step 6 is `run-1`. With that id, send:

```
/flow.plan against=<runId> gateway/GraphFixture codeplanesmithers/smithers-demo {"label":"edited"}
```

The plan card now carries `re-keyed 10 of 11` and `was <duration>`: ten of the eleven
nodes would be re-keyed by that input, and the run it was compared against
really took that long, first journal row to last.

Send the same command **without** the input and it says `re-keyed 0 of 11`: the same
input keys the same graph. This is a key count, not avoided execution.
Unchanged actions retain their p50 unless the compared run recorded them
`clean`. Doomed has no successful measurement, so both previews omit ETA.
Any clean count is labeled `was`: it describes the compared run.

Editing `packages/smithers/test/BridgedEngineRun.ts` while the stack is up
also says `re-keyed 0 of 11`, and that is correct. The plan is built from the module
this host loaded at startup, and a declaration's source position is
deliberately kept out of its key material. A host re-keys on an edit when it
is restarted onto the new source.

## Author a flow beside its canvas

Use an unused port; lane cfxbuilder uses:

```sh
cd apps/app && SMITHERS_FLOW_GRAPH_PORT=47371 bun scripts/flow-graph-e2e-host.ts
```

1. Open Chat and send `/flow.create Build a flow codeplanesmithers/smithers-demo`.
2. The request returns before launch finishes. The authoring run stays beside
   the `authoring-demo` plan. Its first source version contains `authoring/Read`.
3. Repeat the command while it runs: the same request remains. Chat stays usable.
4. Open the Read node. Send `/flow.create Add validation to authoring-demo codeplanesmithers/smithers-demo`.
5. The same plan card gains `authoring/Validate`, retaining Read's selection.
   Read's Declaration says `unchanged`; Validate's says `added`. These compare
   keys, with no claim of cached execution or time saved.
6. Send `/flow.list codeplanesmithers/smithers-demo` again: `authoring-demo`
   is listed now and was not in step 1. That listing is the registry's own
   answer, so it is the box having discovered the file.
7. Reload: the edited plan and its selected node remain. Press the plan's
   **Run**. The new flow executes both actions; open its graph and inspect
   Validate's actual `built` settlement.

The local chat is a command dispatcher, not Jev or an LLM. `/flow.*` uses the
app's real registry; ordinary text says that local chat accepts commands. The
fixture's `create-flow` is scripted: a real engine action writes TypeScript,
the sandbox copies it into an isolated workspace, and the second chat request
runs another action that writes version two. Real diff-bundle/copy-back records
reach the app through the journal bridge. What happens next is the host's, not
the fixture's: the observer that copies those records across rebuilds that one
catalog entry (`Executable.Refresh`), so the registry discovers the file, the
loader measures its bytes and imports them, and the plan the card redraws is
the FILE's own graph. Nothing is registered for the authored flow, and running
it dispatches the registered body under the execution identity its card was
approved against. The gateway runs as ESM so imported source and the engine
share one declaration registry; its former CommonJS entry is a compatibility
loader. Read and Validate return fixture constants. The existing Jujutsu
adapter supplies fixture snapshot metadata; it does not perform real Jujutsu
operations. Source-change detection
uses the filesystem diff-bundle and copy-back receipts, not that metadata.
No source-change receipt is manufactured, and no browser response is intercepted.

This does **not** certify provider authoring. Production `create-flow` is
`flows/create-flow/flow.mdx`; it needs a configured provider and model seat.
Neither `AI_GATEWAY_API_KEY` nor `ANTHROPIC_API_KEY` was present in this lane.

Production `NativeControl` CAN serve without retaining its startup executable
catalog (D-073), and does so only when a composition turns it on
(`rebuildAuthoredFlows`, D-078). Flat statements about what that buys and what
it costs, all measured:

**What works, with the rebuild on.** A `@smthrs/core` declaration a run writes
into `flows/<id>/`, naming a delegate the host registered at startup, becomes
plannable and runnable without a restart.
`packages/smithers/test/FlowCatalogRefresh.test.ts` is that path end to end on
a real host, with no entry pre-registered for the
authored flow; its delegate is registered at startup, as a project's own
`registry.ts` registers the delegates its declarations name.

**What an edit does, with the rebuild on.** The same, for a declaration that
was already on disk when the host started: the host rebuilds it, and the next plan's envelope,
execution digest and topology all come from the new bytes, so it approves and
runs. A stale descriptor beside a rebuilt plan was refused
`execution_changed`, on that plan and on every replacement; the second test in
that file is the edit step and fails that way when the fix is removed.

**What a graph flow does.** A `@smthrs/flow` graph — the shape
`flows/create-flow/scaffold/flow.mdx` instructs an agent to write — is a
production shape. Discovery reads its description, capabilities and effects off
the constants it exports, the loader accepts it as a default export, and the
plan a host answers with is the FILE's own graph: the author's actions, under
their own node ids. It delegates to nothing, so it runs on a host that
registers no delegate. That loader is `main`'s, not this lane's (D-079): its
tests are `registry/test/Executable.test.ts` and
`registry/test/ModuleClosure.test.ts`, and
`packages/smithers/test/FlowCatalogRefresh.test.ts` lifts the scaffold
instructions' own example out of the document and drives discovery, the
executable and the plan over it, which closes the drift D-075 measured.

**What this fixture is.** It composes that registration (D-081). Serving a
project gives this stack a real `Registry` over the project's `flows/`
directory, an `Executable` catalog built from it, and the `Executable.Refresh`
the observer calls when one of its own runs has applied a flow file. Its
control runtime reads that catalog PER PLAN
(`SqlControlRuntime.Options.loadFlows`, as `NativeControl` supplies it), and
its `agent/run` wrapper resolves what the approved plan named — the flows this
composition registered by hand, then whatever discovery found, refusing a card
whose approved execution identity the host no longer holds, which is the check
`AgentSession.approvedModule` makes. Nothing is pre-registered for an authored
flow. `e2e/graph/flow-authoring.spec.ts` is a browser walking that loop and
`packages/smithers/test/FlowAuthoringRun.test.ts` is the same loop without
one.

**What is off by default.** A production host does NOT import a flow file its
own runs write while it serves. `rebuildAuthoredFlows` is off unless a
composition asks for it, because that import runs an agent's top-level code in
the serving process with the host's credentials and nothing approves it
(D-078). With it off, an authored flow is plannable the next time the host
starts and `plan` answers `FlowNotFound` until then.

**What a graph flow's Code tab does, and what it still cannot.** Its nodes'
declaration sites name `flows/<id>/flow.ts`, not the digest-named sibling the
loader actually imported: `Executable`'s loader says
`Graph.evaluatedFrom(sibling, entry)` before it imports, so a declaration
captured while that module evaluates is reported against the entry file. Both
this fixture and `NativeControl` make the site relative to the project root
before publishing it, and a site outside that root is dropped rather than
published as somebody's home directory.
`packages/smithers/test/FlowAuthoringRun.test.ts` asserts both sites of the
authored plan name that file.

The tab itself does not open for a flow a run authored, on this host or on a
deployed one. It needs a REVISION as well as a site (D-068), and
`PlanGraph.sourceRevision` is forty hex digits a content route spawns `jj` or
`git` with. This fixture's project is a scratch directory under no version
control, so it names none and the tab is absent — which is the rule working.
Read, not measured: a deployed box names one, but `NativeControl` takes
`hostRevision` ONCE while it starts, so the revision a rebuilt entry's plan
carries is the one taken before its run wrote the file. Nobody has run that
host to see what its Code tab then does (D-081).

A live provider canary and execution-bound source identity (D-068) remain
required before claiming the full D-029 loop works on a deployed box.

## Other exclusions

| Missing | Why |
| --- | --- |
| A cache-hit count beside the re-key numbers | No run on this host settles a node `clean`. A sealed action with no hard file boundary is not admitted to the step cache, and while no host declares a cache environment the engine folds the run id into every key, so no second run can address the first run's row (D-044, D-049). The count appears only for a run that really recorded clean settlements. |
| Any way to edit, pause, disable or test-fire the schedule | No Control procedure exists for a box trigger-store row. `triggers.run` and `triggers.pause` are Smithers Cloud routes keyed by a slug, and a box row has none, so the panel offers neither (D-051). |
| An estimate in the plan's header | The longest path runs through a node that fails every run, so nothing has measured it. Step 10. |
| A `clean` node, a cache verdict, or "8 cache hits" | Same as the first row. |

## Stop it

Ctrl-C, or `kill` the process. The gateway child dies with it and both SQLite
files go with the temporary directory that held them.

## If something looks wrong

- **A node shows no duration.** It has no measured history yet. Run the flow
  twice.
- **The Code tab is missing on a node.** That node was declared nowhere the
  graph builder could see. The builder records a site on the nodes a flow's
  body writes — the four actions and the gate — and synthesises the rest
  (`root.flow.then.map` and its kin) with none, on the plan and on the run
  alike. A node whose site this host cannot make relative to the repository
  root also has none, because an absolute path is never journalled.
- **The Code tab is missing on every node.** This checkout named no revision,
  so there is nothing to read that could be called the source the plan was
  built from (D-068). `jj log -r @` answers one for a jj workspace; a git
  checkout answers one only while `git status --porcelain` is empty.
- **The Code tab is missing on every node of an AUTHORED flow.** Expected, for
  the same reason: that flow's file is in the scratch project this box serves,
  which is under no version control and names no revision. Its nodes still
  carry their site, `flows/<id>/flow.ts`
  (`packages/smithers/test/FlowAuthoringRun.test.ts`).
- **`curl` against the origin answers `local_session_required`.** The local
  session token reaches the browser with the page. Drive the stack through a
  browser, or the relay URL directly.
- **The first run seems to hang.** It is building the SPA. The URL prints
  after it.
- **A timing failure.** Keep its trace and inspect the engine journal and
  machine load. A retry or longer timeout does not resolve the failure.

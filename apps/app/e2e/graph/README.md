# The flow-graph real stack

One command brings up a real control plane, a real engine and the app, on
localhost, with no credentials.

## Run it

```sh
cd apps/app && bun scripts/flow-graph-e2e-host.ts
```

It prints three lines and holds the stack open:

```
[flow-graph] relay    http://127.0.0.1:<relay port>
[flow-graph] workspace codeplanesmithers/smithers-demo
[flow-graph] open     http://127.0.0.1:47331
```

Open the third URL. The workspace serves `gateway/GraphFixture`: a
gate, a fan-out, a merge, a failure arm, a step that fails its first attempt,
and a cacheable step. Its plan is 11 nodes. Its dispatcher holds one schedule,
`graph-fixture-nightly`, at 03:00 UTC daily; nothing polls it, so it is armed
and stays armed.

It also serves a scripted `create-flow` that writes `authoring-demo` through
real engine filesystem transactions. See **Author a flow beside its canvas**
in [MANUAL-TEST.md](./MANUAL-TEST.md) for the create → edit → replan → run loop
and the remaining production/provider limitations. Local chat dispatches
commands; it is not a model-backed assistant.

The authored half is the production path and nothing is registered for it
(D-081). The `create-flow` run writes a real `@smthrs/flow` graph file, shaped
the way `flows/create-flow/scaffold/flow.mdx` teaches, into the scratch project
this box serves. A real registry discovers it, `@smthrs/registry` `Executable`
measures and loads it, and `Executable.Refresh` registers the rebuilt body with
the running engine before the run's receipt is readable — the same reaction
`NativeControl` installs from `Application.Config.rebuildAuthoredFlows`, which
D-078 permits for a disposable host like this one. So `/flow.list` holds the
flow only after a run has written its entry file, and the plan the card
redraws is that file's own graph, with its nodes naming it. The drawer's Code
TAB stays absent for those nodes: a scratch project under no version control
can name no revision, and a site without one shows no code (D-068).

## Stop it

Ctrl-C, or `kill` the process. The gateway child dies with it, and the
temporary home and both SQLite files are removed. The removal is a finalizer,
so the gateway is interrupted under the signal rather than exited under it;
`e2e/graph/lifecycle/gateway.test.ts` holds that.

## What is running

| Process | Runtime | Holds |
| --- | --- | --- |
| `scripts/flow-graph-e2e-host.ts` | bun | the SPA build and `startLocalServer` on 47331 |
| `scripts/flow-graph-e2e-gateway.mts` | tsx / Node | the bridged stack, `NodeGateway`, and the Worker's relay |

Both the identity upstream and the cloud upstream are that relay. The identity
upstream is what carries `/api/workflow/*`; the cloud upstream is what puts
`cloud` in the origin's bootstrap capabilities, and `flow.list`, `flow.run` and
`flow.plan` all declare it, so an origin without one lists no flows at all.

The relay answers these families, all of which the local origin forwards to it:

| Route | Answered with |
| --- | --- |
| `/api/workflow/rpc` | the gateway, through the Worker's own procedure allowlist; every call names the stack's one box |
| `/api/user/workspaces` | that one running box (`GRAPH_BOX`), so the app has a box to name |
| `/api/workflow/trigger-registrations` | the one fixture schedule, the way Smithers Cloud lists a registration |
| `/api/repos/{o}/{r}/contents[/path]` | the checkout this command runs out of |

The contents route is what makes a node's Code tab openable: the fixture flow
is a file in this repository, the engine records which line of it each action
was declared on, and `files.read` reads that file back through the route every
other file read in the app uses. A path that climbs out of the checkout is
answered not found. A flow one of this box's runs AUTHORED is not in that
checkout — it is in the scratch project — and no reader asks the route for it,
because its nodes carry no revision and so have no Code tab (D-068).

Two processes because `@smthrs/database` `NodeDatabase` refuses Bun and the
local origin is a Bun server. The origin uses native fetch with
[`keepalive: false`](https://bun.com/docs/runtime/networking/fetch) for its owned
relay, after a pooled socket lost a real provision call. No response is mocked,
and the host does not retry that failure or fabricate its receipt.

The bridged stack is `packages/smithers/test/BridgedEngineRun.ts`: a real
control plane and a real engine over two SQLite files, with the
`EngineJournalSupervisor` bridge `NativeControl` wires, and — when it serves a
project — the real registry, executable catalog and catalog refresh that host
composes. The authoring decisions, action results, Jujutsu snapshot adapter
and workspace/identity relay are scripted. Source writes, discovery, the
module load, diff-bundle/copy-back receipts and engine/control journals are
real. A
spec written against this host intercepts no browser request: Playwright's
routing call appears nowhere under this directory, and L8's gate greps for it.

## Recording the run-events fixture

`src/mainview/cards/fixtures/GraphRunJournal.json` is the journal
`FlowGraphStatus.test.ts` folds. Record it with:

```sh
cd apps/app && pnpm exec tsx scripts/flow-graph-record-journal.ts
```

That command drives `packages/smithers/test/BridgedEngineRun.ts` directly: the
same control plane, engine and `EngineJournalSupervisor` bridge this host
holds open, without the browser, the SPA build or the relay in front of them.
The relay is HTTP framing and changes no journal row, so the rows recorded
this way are the rows a browser would receive. Every row is written verbatim,
one per line, and the plan is reduced by the app's own `planCardNode`
(`src/mainview/cards/PlanNodes.ts`), so the fixture carries exactly what a
launch writes onto a run card.

Nothing in the file may be edited by hand. The fold decodes it with the strict
schemas the app decodes a live run with, so an invented field fails the test
instead of becoming a fact the UI believes.

## Options

| Variable | Effect |
| --- | --- |
| `SMITHERS_SKIP_SPA_BUILD=1` | reuse `apps/app/dist`; the first run must build it |
| `SMITHERS_FLOW_GRAPH_PORT` | the origin port, 47331 by default |

## Traps

- **The first run builds the SPA.** The URL prints only after it. Pass
  `SMITHERS_SKIP_SPA_BUILD=1` on reruns.
- **`curl` against the origin answers `local_session_required`.** The local
  session token reaches the browser with the page. Drive the stack through
  Chromium, or through the relay URL directly, not with a bare `curl` to
  47331.
- **A wedged wrangler on 8788 is not this.** Port 8788 belongs to the site dev
  proxy and nothing here uses it. If a request seems to hang, check the two
  ports this command prints, with `curl -m 5 <relay>/api/auth/session`.
- **Never run `bun test` over `apps/app/src/bun`.** It orphans
  `e2e/native/MainProcess.ts` daemons, about ten per run.
- **A decision refused as `unauthorized` is the approval authority.** Every
  relayed call is stamped with the gateway's bearer identity, never the local
  operator's, and the stack has to delegate to it the way a deployed host
  does. `FlowGraphRun.test.ts` covers it.
- **A timing failure needs a cause.** Read its retained trace and the engine
  journal; do not clear it with a retry or a longer timeout.

## The Chromium tier

`playwright.graph.config.ts` drives this host from `e2e/graph/flow-graph.spec.ts`,
`flow-graph-a11y.spec.ts`, `flow-graph-reload.spec.ts` and
`flow-authoring.spec.ts`:

```sh
cd apps/app && pnpm exec playwright test --config playwright.graph.config.ts
```

`scripts/run-pr-e2e.mjs` runs this tier as the last step of
`//apps/app:browserE2e`.

Nothing in the spec intercepts a request. The app boots against the real
origin, lists the workspace's flows, and the plan door draws the eleven nodes
the control plane keyed, under their own ids, with their actions and the
workspace's labelled edges.

The run half launches that flow and watches the same eleven nodes move. The
gate really holds the run: while it waits it wears `running` and the four arms
behind it wear `pending`, the run card names what it is waiting for and the
approval card asks the flow's own question. Answering it there finishes the
run with ten nodes `built` and `gateway/graph/Doomed` `failed`. No node is
asserted mid-flight: after the answer the whole graph settles in under two
seconds, so catching an arm in `running` would be a timing bet rather than
evidence.

## What the stack can and cannot report

Driven through this origin on 2026-09-19, with no credential: an 11 node plan,
its approval, a run, the nested gate served on the `approvals` projection and
answered there, a `completed` run, and `run-events` carrying ten engine event
types over four executions, `flows.engine.cache-provenance` among them.

Proven by `packages/smithers/test/FlowGraphRun.test.ts` against this same
composition:

- the plan hook keys a non-empty graph, with stable ids and real edges;
- the nested gate reaches the `approvals` projection;
- the engine's own records reach a watching client as `control.engine.event`;
- the retried step's two attempts arrive numbered, keyed by step digest;
- `flows.engine.plan-recorded` carries the whole graph the run was driven
  from, and every plan node id is scheduled and settled under that same id
  (L2 landed the interpreter's node records; this used to be a `test.todo`);
- the run's node records join to the plan's node ids, so a drawer addressed by
  plan node id has evidence to read;
- the engine's node lifecycle, under the plan's own node ids: the interpreter
  records the graph it drives, so `flows.engine.node-scheduled` and
  `node-settled` arrive for all eleven nodes, with the driven graph, its
  labelled edges and each node's repo-relative declaration site beside them.
  The path is relative to the REPOSITORY whichever directory the host was
  started from, because `BridgedEngineRun` declares its own
  `declarationRoot`;

Read carefully, and not to be guessed at in a spec:

- a node id is an address WITHIN one graph. This run drives four executions
  and all four name a node `root`, so a reader folds per execution and joins
  the one it wants by the plan's ids or by the flow the plan record names;
- a node's `attempts` is the count of the DISPATCHES it ran, which the
  settlement carries up from the dispatch (D-052). The retried step settles at
  two, and its two attempts are `flows.engine.attempt-started` records keyed by
  step digest;
- the retry is an injected counter shared by the whole STACK, so only the
  FIRST run of a host fails its first attempt. A second run of the same host
  dispatches the step once and settles it at one attempt. A spec or a manual
  read that expects "attempt 2" has to be looking at the host's first run;
- no `clean` settlement, on any run this host drives. The cacheable step is
  cache-eligible and records a row every run, but under a fresh address each
  time: a composition that installs no complete `Action.CacheEnvironment`
  folds the execution id into the dispatch key, and nothing a host wires here
  installs one. A host that does declare one serves the row and the node
  settles `clean`, which `FlowGraphRun.test.ts` drives on its own stack;
- an attempt record carries a step key digest and no node id, so the join to
  a plan node runs the other way: a node's settlement names the digests it
  dispatched under, and those are what address its attempt rows. A reader
  without that settlement has no join at all;
- the `node-output` projection stays empty. It keys its rows off the
  `control.agent.cell-call-*` records only an agent run writes, and this
  fixture is not an agent run.

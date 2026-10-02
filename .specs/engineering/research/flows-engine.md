# Flow engine, versions, triggers, monitor — current state (main, 2026-10-02)

Paths are repo-relative to /Users/williamcory/smithers. `flows/` = repo root `flows/`; `SF` = `packages/smithers/flows` (the @smthrs/* flow packages). "inferred" marks conclusions not confirmed by a test or run.

## Summary
- The engine is built: `Flow.make` (SF/flow/src/Flow/make.ts:156), a journaled attempt table, replay of settled steps, and effect-tier boundaries. A killed engine re-runs no completed step (fault case01).
- "Reconcile outcome before retry" is not a probe of the outside world. The engine fails closed: an unresolved irreversible step with no idempotency key stops the run (ActionPersistence.ts:2014-2040). With a key it re-executes. Go-side launches use jobs `EffectReconcile`, which repeats the same keyed command against the host.
- A run pins its flow by `executionDigest` and a content-addressed source closure (ExecutionSnapshot). Control and the Go checkpoint store plan/execution digest and source revision. In-flight runs keep their version in a host; two versions of one flow cannot coexist (#3377, do-not-implement).
- Repository `flows/<name>/flow.ts` beats built-ins of the same name, except reserved host flows (flows/repository/registry.ts:333-411). Nothing computes Active / "Merged · active after sync" / "Merged · not active" (zero hits in apps/ and packages/).
- A failed refresh drops the previous entry (Executable.ts:2036), the opposite of spec "previous version stays active" (inferred; no test of edit-breaks-existing-flow).
- Triggers: engine has cron + timezone + overlap + catch-up; the web registrar accepts UTC cron only (schema.ts:278), and hosted registration still refuses without the `repository/trigger` flow (#1888).
- Monitor: trace, steps (time/duration/tokens), graph, DevTools, scrubber exist. Missing: `/monitor` command, per-step cost, a durable-waits view with "since when", custom flow views. No edit-flow-from-chat command exists.
- Self-host runs flows in the app container as `trusted_process`, not a microVM (docs/architecture/0001-shared-product.md:9).

## Inventory
| Component | Path:line | What it does today | Spec row it serves |
| --- | --- | --- | --- |
| `Flow.make` | SF/flow/src/Flow/make.ts:156 | Typed constructor `make(tag, {payload,success,error,body|prompt})`; tag required, non-empty (throws otherwise). Also `PromptFlow`. | Rule 1; AGENTS.md "Flow layering" |
| Graph/interpreter | SF/flow/src/Graph.ts (1787 lines), Interpreter.ts (1593) | The one node/graph model; `Node` planning in SF/plan/src/Node.ts, Plan.ts | Rule 1 |
| Durable waits | SF/flow/src/{Sleep,WaitFor,HumanTask,DurableDeferred,DurableClock,ExternalJob,Poll}.ts | Sleep, signals, approvals, external jobs with probe backoff (ExternalJob.ts:194 `Probe`) | 6.14 Signals and approvals; 6.1 Restart |
| Attempt table + replay | SF/engine-store/docs/concepts/attempts-and-replay.md; src/internal/ActionPersistence.ts | Row written before body; `succeeded` replays recorded result; `failed` rethrows; `running` recovers under run fence; `suspended` continues | 6.1 Restart; 9 Durability |
| Effect boundary | ActionPersistence.ts:2300-2330; SF/time-travel/src/EffectBoundary.ts:23-45 | Tiers sealed/compensable/irreversible; `intended` commits before body, `succeeded`/`unknown` after; `AttemptMeta.effectCrossing` (ActionPersistence.ts:406) | 6.1 "interrupted external actions" |
| Adoption of crashed attempt | ActionPersistence.ts:1981-2040 | `succeeded` crossing seals the attempt without rerun; `intended` + irreversible + no key refuses with `IrreversibleRetryRequiresIdempotencyKey` | 6.1; 9 Durability |
| Plan-level reconciler | SF/engine-store/src/Reconciliation.ts:1-80 | NOT the restart mechanism. Handles expected-set deviation (fail / reorder / factor out). | none (name collision; inferred) |
| Hard-kill reclaim | SF/engine-store/test/HardKillReclaim.test.ts:1-25 | Sweep re-drives a stale-running run whose owner died | 9 Durability |
| Go admission | packages/backend/flowdispatch/service.go:80-200 | `Launch`/`Signal`/`Approve` admitted to jobs with `EffectReconcile`, key `flow-runtime:<requestId>`; `Cancel` writes intent first | 6.12; Rule 5 honest state |
| Jobs recovery | packages/backend/jobs/claims.go:424-480; types.go:40-45 | Expired claim: `unsafe`+started -> `uncertain` terminal; `reconcile`+started -> state `waiting`, `reconcile_required`, retry | 6.1; 9 Honesty |
| Runtime bridge | docs/architecture/flow-runtime-bridge.md; packages/backend/flowruntime/contracts.go:1-80; runtimebridge/client.go | `smithers.flow-runtime/v1`; PostgreSQL holds product request, TS journal holds run truth; observe after cursor; unreachable host = uncertainty | 6.12; 9 |
| Checkpoint | packages/backend/flowdispatch/types.go:63-85 | Stores Identity (artifact digest, source revision, owner generation), PlanID, PlanDigest, ExecutionDigest, RunID, Cursor | 6.12 Pinned versions |
| Host resolver/launcher | packages/backend/flowhost/{resolver,workspace_launcher,process_spec,store}.go | One packaged `coding` host per binding; launched via `WorkspaceManagedHosts`; bearer encrypted at rest | 6.12; 9 Isolation |
| Manifest | packages/backend/flowmanifest/manifest.go:19-23 | Verifies host binary SHA-256; expected flows `coding -> coding/dispatch` | 6.1 Install |
| Coding host | flows/coding/host.ts (729 lines) | Composes native host, seats, repository flows, checks, wiki, landing; operator `seats` pins win over repository (host.ts:~100) | 6.12 Default flows |
| Built-in vs repo catalog | flows/repository/registry.ts:136-411 | `provisionBuiltins` writes `<state>/builtin-flows/<policy>`; `bindRepositoryRegistry` lists project first, builtins only if no project entry; reserved names (`repository/setup`, `repository/trigger`, `repository-jobs/*`) and `hostOwned` always bundled | M-11; 6.12 "repository's own copy wins" |
| Discovery | packages/smithers/agent/registry/src/Discovery.ts:62 | Entry precedence `flow.ts`, `flow.mdx`, `SKILL.md` | 6.12 Run any flow |
| Refresh | packages/smithers/agent/registry/src/Executable.ts:1955-2060; flows/repository/registry.ts:326 | Rebuild one entry from working tree; bundled entries not refreshable; refusal recorded in `catalog.refused` | 6.12 Pinned versions |
| Execution pin | packages/smithers/agent/registry/src/Descriptor.ts:768 (`executionDigest`), :804 (`declarationDigest`); ExecutionSnapshot.ts:45 (`pin`/`restore`) | Digest over full source + metadata; closure retained at admission; `loadBody(name, expected)` refuses changed digest (`execution_changed`, registry.ts:~385) | 6.12 Pinned versions; J5 step 4 |
| Run authority | packages/smithers/src/internal/ModuleAuthority.ts:35-80 | Keeps verified module identity per run; refuses digest that differs from owning approval | J5 step 4 |
| App flow catalog | apps/app/src/mainview/state/seams/RepositoryFlowsSeam.ts:1-40; flows/entries/flow.ts:166-195 | Slash leaves from `.smithers/factory.json` `flows` rows (52 rows today, 6 featured), not from `flows/*/flow.ts` discovery directly | 6.12 Run any flow |
| Typed form | apps/app/src/mainview/cards/FlowFormCards.tsx:17-40; state/controller/forms.ts:402,574; workflow-catalog.ts:60 | Fields derive from the flow's `inputSchema` JSON-schema document | 6.12 Run any flow |
| `flow.create` | apps/app/src/mainview/flows/entries/flow.ts:48 | Description + optional repo; runs `create-flow` (flows/create-flow/flow.mdx, six stages) | 6.14 Write flows; 6.12 |
| `flow.plan` / `flow.run` | flow.ts:120,145 | Plan preview (`against=runId` re-key preview), run with JSON input | 6.14 Write flows |
| Flow viewer | apps/app/src/mainview/cards/{FlowPlanCard,FlowGraphDrawer,FlowGraphSurface}.tsx; FlowsSurface.tsx | Plan graph, node drawer with Code tab as read-only viewer (FlowGraphDrawer.tsx header, D-054) | 6.12 Flow card (read-only) |
| Save script as flow | packages/smithers/agent/src/PromoteFlows.ts:172 | `flows/write-flow` writes `flows/<id>/flow.ts` in a run; not a product command | none (edit path candidate) |
| Triggers store | packages/smithers/agent/triggers/src/{Cron,Schedule,SqlTriggerStore,Overlap,CatchUp,Scheduler}.ts | Cron + optional IANA timezone (Cron.ts:157), overlap, catch-up, revision | 6.14 Triggers |
| Triggers commands | apps/app/src/mainview/flows/entries/triggers.ts:76-190 | `triggers.list/register/approve/run/resume/pause` | 6.14 Triggers |
| Registrar flow | flows/repository/triggers.ts (523 lines); schema.ts:262-290 | `repository/trigger` plans, previews, registers; result `timezone: Literal("UTC")` | 6.14 Triggers |
| Registrar gate | apps/app/src/mainview/state/seams/TriggersSeam.ts:44-53, 642, 867 | Refuses with `registerUnavailableSentence` when box catalog lacks `repository/trigger` | 6.14 "refuses without a registrar flow" |
| Event rules | flows/repository/activation.ts:162-176; schema.ts:44; .smithers/factory.json `on` | Per-job events: review/ci = `pull_request` opened/synchronize/reopened; ci/chores = `push`; chores = `issues labeled`; feature = issues opened/edited/reopened/labeled | 6.14 Triggers (event) |
| Run monitor | apps/app/src/mainview/cards/RunTraceCard.tsx:113-420 | Views: turns, timeline, graph, steps, devtools via `runs.trace.view` (flows/entries/runs.ts:228) | 6.14 Monitor |
| Steps view | cards/RunTraceSteps.tsx:4-70 | time, type, description, duration, tokens; no cost column | 6.14 Monitor (tokens, time, cost) |
| Scrubber | RunTraceCard.tsx:81-150,257; `cursorSeq`, `liveTail:false` | Journal folded up to cursor; read-only | 6.14 Monitor Replay |
| DevTools | cards/RunDevTools.tsx; packages/smithers/gateway/src/RunDevTools.ts | Node tree + evidence; shown by a button on the trace card with no admin check (RunTraceCard.tsx:411-418; `admin` prop gates only admin-decided waits, :184-196) | 6.14 Monitor |
| Run graph | cards/FlowRunGraph.tsx; `runs.graph.*` (flows/entries/graph.ts:30-61) | Recorded engine graph, approved-plan fallback | 6.14 Monitor |
| Time-travel lib | SF/time-travel/src/*; faults/time-travel/case11-frame-scrub-view-only | Fork/rewind libraries retained (AGENTS.md MVP scope); `forks` trace filter still listed (entries/runs.ts:177) | 6.14 Replay "no fork or rewind" |
| Agent seats | .smithers/coding-project.json (`seats`); flows/coding/project-config.ts:34,48,124 | Role -> `provider:model` or `auto`; 10 roles incl. `coding/implement`, `coding/plan`, `coding/review`, `flow/author`; all `auto` today | 6.14 Configure an agent |
| Agent list | apps/app/src/mainview/flows/entries/agent.ts:32 | `agent.list` "Show the agents and their runs" | 6.14 `/agents` |
| Limits/budgets | flows/coding/project-config.ts:12-18 (`modelCallMs`,`toolMs`,`taskMs`, token `weights`); flows/repository/inspection.ts:21-22 | Per-project time limits; deployment job budget 360 min / 200,000 tokens | 6.14 Configure an agent (budget) |

## Gaps vs mvp.md
1. **6.1 Restart / 9 Durability, "reconcile their outcome before retrying"** -> Today a keyless irreversible step refuses (fail closed) and a keyed one re-executes; nothing queries the shell, model provider or GitHub for the real outcome. -> Add a per-action `reconcile` hook (probe by idempotency key; GitHub write = look up the PR/comment/ref by key; model call = sealed so rerun is allowed; shell = refuse unless declared idempotent) at the `intended` branch in `ActionPersistence.ts:2014-2040`, with a fault test beside `faults/engine/case01`. Or reword spec to "refuse or retry with a key". -> M (hook) / S (reword).
2. **6.1 "A process that can't be recovered shows as interrupted"** -> `jobs` state `uncertain` and TS `unknown` crossing exist; no app card text or state for "interrupted" found (inferred; not searched exhaustively). -> map `uncertain`/`quarantine` to a run-card state in `apps/app` run status. -> S.
3. **6.12 / J5 "Active", "Merged · active after sync", "Merged · not active"** -> No code computes the three states; the Flow card has no per-version state. Needs: merged-revision vs loaded-revision per flow, and the load error from `catalog.refused` (Executable.ts:1716). -> New projection in the coding host (`flows/repository/registry.ts` catalog) + a `Flow` card field in `apps/app/src/mainview/cards/FlowPlanCard.tsx` + gateway read. -> L.
4. **6.12 "If loading fails, the previous version stays active"** -> `put(name, undefined, failure)` and `release(name)` (Executable.ts:2036-2040) remove and close the previous entry (inferred; ExecutableRefresh.test.ts:240 tests only a never-loaded flow). -> Keep previous executable on refusal; record refusal beside it; add test "edit breaks existing flow". -> M.
5. **6.12 "Each run records the exact flow revision"** -> Run checkpoint has `ExecutionDigest`, `Identity.SourceRevision` (flowdispatch/types.go:63-71); not confirmed that the run card/API exposes a repo flow revision (commit) rather than a digest. -> Expose `sourceRevision` + `executionDigest` on the run projection and Flow card. -> S/M.
6. **J5 step 4 "running TODOs and their retries keep their own version"** -> One name = one registration per host (#3377, labeled do-not-implement); ModuleAuthority refuses a different digest for an owning run. Retries in the same host keep A, but a refresh to B while A runs retires A's scope. -> #3377 work, or accept: running runs finish on the pinned closure (ExecutionSnapshot.restore) and verify with a kill/restart test. Needs Will to lift do-not-implement for the full case. -> L.
7. **6.12 "Change the factory": first edit copies the built-in to `flows/<name>/flow.ts`** -> No command. Pieces exist: `provisionBuiltins` (registry.ts:152) holds built-in bodies; `write-flow` (PromoteFlows.ts:172); change/TODO creation. -> New `flow.edit <name>` entry in `apps/app/src/mainview/flows/entries/flow.ts` + a repository flow that copies the built-in source and opens a TODO/Change; parity with `smthrs` catalog. -> L.
8. **6.12 Flow card "proposed, merged and active versions told apart"** -> Same as gap 3 plus proposed = open Change touching `flows/<name>/`. -> L (shared with 3).
9. **6.12 Learning** -> `improve.mine` is declared only (packages/rpc/test/FactoryProjection.test.ts etc. reference it; no flow body found). -> new flow under `flows/`. -> L.
10. **6.12 / M-11 "configuration generated and stored in the install, not committed"** -> Seats, reviewer and pages live in committed `.smithers/coding-project.json`; `coding` routes served without it only when that file exists (registry.ts:138-145). -> Generate install-side default config in `flows/coding/project-config.ts` loader. -> M (inferred).
11. **6.14 Triggers: schedule with timezone** -> Engine supports timezone (Cron.ts:157); registrar and UI are UTC-only (`CronUtc`, `timezone: Literal("UTC")`, triggers.ts:42 "five UTC cron fields", default 02:00 UTC). J11 step 5 needs "02:00 in their timezone". -> Widen `TriggerRequest`/`TriggerRegistration` in `flows/repository/schema.ts`, `TriggersSeam.ts`, and Plue registration API. -> M.
12. **6.14 Triggers: "web registration refuses without a registrar flow"** -> Gate at TriggersSeam.ts:642/867 until the box serves `repository/trigger` (#1888). Self-host serves it only if the coding host catalog includes it (reserved name, registry.ts:333). -> Verify self-host bundle includes it; replace e2e refusal test. -> M.
13. **6.14 Triggers: pause/resume/run now/next run shown** -> Commands exist (pause is `hidden`); next run in `next_fire_at` (schema.ts:272). -> Check Run on… door on the Flow card; no `Run on…` button found. -> S.
14. **6.14 Triggers: event triggers (push to `main`, issue labeled, PR opened) for any flow** -> Events are bound to the five reviewed jobs by `normalEvents` (activation.ts:162); no way to attach an arbitrary repository flow to an event; `push` has empty `actions` and no branch filter (inferred). -> Generalize registrar to event rules with branch filter. -> L.
15. **6.14 Monitor: door and list** -> No `/monitor` command (searched flows/entries); `runs.list` is the list. Inspect door on run card exists via trace card. -> Add `/monitor` alias for `runs.list`, Advanced group. -> S.
16. **6.14 Monitor: cost per step** -> Tokens and duration only (RunTraceSteps.tsx:22-26, 66-67; RunMeter.ts). -> Add cost from `modelprice` package via call-fact usage. -> M.
17. **6.14 Monitor: durable waits "what a run waits for, and since when"** -> `waiting` shown on summary (RunTraceSummary.tsx:31-35: approval/resume/budget); no list of Sleep/WaitFor/HumanTask with start time (inferred). -> Fold `flows.engine` wait events in `RunTrace.ts`. -> M.
18. **6.14 Monitor: custom flow view** -> Descriptor carries `presentation` (Descriptor.ts, excluded from digest); no monitor consumer found for a flow-declared view (inferred). -> M/L.
19. **6.14 Monitor: admin-only DevTools** -> Spec says admin-only; code shows the DevTools button to any viewer of the card (RunTraceCard.tsx:411-418). Confirm intent; #2931 (DevTools issue) is labeled do-not-implement. -> Decide: gate or keep; S.
20. **6.14 Replay: no fork or rewind** -> `forks` filter and `span.kind === "fork"` remain in trace (entries/runs.ts:177, TraceSteps.ts:59); AGENTS.md says remove user-facing fork/rewind controls. -> Delete the filter literal and any fork button in `CardActions.ts`. -> S.
21. **6.14 Write flows: Source, Plan, Run on the Flow card; `/flow.new`** -> Spec names `/flow.new`; code has `flow.create`. Plan and Run exist; Source = File card is not wired from the Flow card (inferred). -> Rename/alias; add Source door. -> S/M.
22. **6.14 Configure an agent: Agent card, edits as TODO, budget** -> `agent.list` shows agents and runs only; model/budget editing is a commit to `.smithers/coding-project.json` with no card. D-11 removed custom-agent config. -> Agent card reading seats/limits, writing a Change. -> L.
23. **9 Durability on self-host** -> Executes as `trusted_process`; 9 "Isolation: each awake branch is its own microVM" is not true for the Docker/self-host path today (docs/architecture/0001-shared-product.md:9). -> Spec's Mac install runs microVMs (6.1, Missing package). -> L (outside this area).

## Existing tests
- Fault tier (`SF/../vitest.faults.config.ts` at packages/smithers/vitest.faults.config.ts): real child processes, real SQLite, serial, 180 s timeouts, coverage off. Engine cases in packages/smithers/test/faults/engine: case01 kill mid-action (re-runs interrupted, not committed), case03/04/05 restart while waiting (approval, event, timer), case05 concurrent timer hosts, case06 resume vs sweep, case22 secret never in journal, case31 real engine kill/resume. Time-travel: case08, case11 (scrub view-only), case12. Also case03-cli-durable-recovery, retained-job-restart.
- Engine-store unit tests (SF/engine-store/test): HardKillReclaim, AdoptionGuard, EffectBoundaryRecords, CompensableSnapshotRestart, DurableWaitingRestart, DeferredRestartMatrix, ExternalJobRestart, AttemptQuarantine, ActionTimeoutReplay, ReplayOnly.
- Go: packages/backend/flowdispatch/{service,regression,admission_unit,parked_polling,real_host,start_host}_test.go; flowhost/{workspace_crash_recovery,fresh_box_real_host,store_integration}_test.go; internal/services/durable_crash_restart_test.go (policy x crash point matrix, :183,378); runtimebridge/client_test.go.
- Registry: agent/registry/test/ExecutableRefresh.test.ts (:153-333), ExecutableRefreshSafety.test.ts, ExecutableNativeRefresh.test.ts; packages/smithers/test/FlowCatalogRefresh.test.ts; control/test/CodeDrift.test.ts, PlanDigest.test.ts.
- App: cards/RunTraceCard.test.tsx, RunDevTools.test.tsx, FlowGraph*.test.ts(x), FlowPlanCard.test.tsx, FlowRunGraph.test.tsx, TriggersCard.test.tsx, flows/Commands.forms.test.ts, FormCardsAgainstMain.test.ts, state/seams/TriggersSeam.test.ts; e2e apps/app/e2e/real/approvals-triggers.spec.ts:125 asserts the production refusal (#1888).
- Not found: a test that a GitHub write interrupted mid-call is reconciled; a test that edit-breaks-flow keeps the old version; any test for Active/Merged states (none exist).

## Configured/measured numbers
- Fault case timeout 180 s (vitest.faults.config.ts); case01 fixture wait 60 s.
- Deployment job budget 360 min and 200,000 tokens (flows/repository/inspection.ts:21-22); project limit fields capped at 6 h (project-config.ts:12).
- Retry/lease: jobs claim recovery uses a delay parameter; no lease duration read (not measured).
- Poll: `WaitManual` 3,000 ms interval, 2,401 attempts max (activation.ts:~160); ExternalJob probe backoff `every * 2^(probe-1)` capped at `probe.max` (ExternalJob.ts:373).
- Factory catalog: 52 flow rows, 6 featured (.smithers/factory.json); `flows/` has 35 entries, 9 with `flow.ts` (rest are `flow.mdx`/other).
- Not measured: restart recovery time, run admission latency, monitor render time for a 1,000-step run.

## Related GitHub issues (open unless noted)
- #3377 concurrent pinned execution versions of one flow: do-not-implement; blocks J5 step 4 in full.
- #2931 Flow DevTools: do-not-implement; DevTools view already ships in trace card.
- #1888 hosted Register a rule refuses; needs registrar flow on box image + prod success e2e.
- #1775 epic durable flow runtime gaps; remaining: #1799, #1801/#3243 fork with edited step (control API route unbuilt), #1803/#3244 deadlines, #3242 replay verification, #2055 journal folds.
- #3243 fork with edited step: in-progress; conflicts with MVP removal of user-facing fork (AGENTS.md).
- #2271 make every file flow TypeScript with typed MDX prompts: in-progress, size:hard.
- #1701 live dispatcher rules, parent of #1888.
- #1878 real e2e for GitHub, setup and trigger actions.
- #3378 migrate issue-sweep RemoteFix to durable ExternalJob and retained Sandbox jobs.
- #1723 chat prompt in a Cloud workspace starts coding/request -> coding/vibe.
- #2198 one coding host per box: Worker relay and Go flow seam reach different processes.
- #3360 local coding/dispatch fails before agent start (dispatch-turn implementation missing).
- #3400 Cloud coding image Bun 1.3.9 cannot validate repo requiring Bun >=1.4.0.
- #3416 native read-only agent checkpoints fail on Git capability guard: in-progress.
- #2779 S2 project memory into coding runs (closest open issue to learning; no `improve.mine` issue found).
- No open issue found for: Active/Merged flow states, edit-flow-from-chat, trigger timezone, `/monitor`, per-step cost (searched "flow version", "Flow card", "triggers", "monitor", "timezone schedule", "agent card").

## Risks and unknowns (falsifiable)
1. Claim: restart never double-fires an irreversible GitHub write. Unknown: which GitHub-write actions declare an idempotency key. Confirm: `rg "tier: \"irreversible\"" flows/` and check each has `idempotencyKey`; run case01 with a GitHub-write step.
2. Claim: a broken edit leaves the old flow active. Inferred false (Executable.ts:2036). Confirm: write a test that loads flow X, rewrites it to an invalid body, calls `refresh.flow("X")`, asserts `catalog.executables` still holds the first version.
3. Claim: a run records the exact flow revision. Digest and source revision are in the checkpoint; the product run row/API field is unverified. Confirm: read `packages/backend/internal/db` run projection and `apps/app` run card payload for `sourceRevision`.
4. Claim: merged flow loads "after sync". Unknown what triggers `Refresh` on a self-host after main moves (flow.create path refreshes; a git sync path not found). Confirm: grep callers of `Refresh.flow`/`refresh()` outside create-flow; push a flow commit to a synced repo and list flows.
5. Claim: repo flow becomes a slash command. App catalog comes from `.smithers/factory.json` projection (`flows` rows), produced by `//:factoryProjection`; a new `flows/foo/flow.ts` with no factory declaration may not appear (inferred). Confirm: add a flow without `S.Flow` and check `/` menu on a repo that has none.
6. Claim: self-host provides microVM isolation. Docs say `trusted_process`. Confirm: `docs/architecture/0001-shared-product.md:9` and `workspace/contracts.go:21` capability on the self-host build.
7. Claim: DevTools is admin-only. Code shows no gate. Confirm: render RunTraceCard as a non-admin in RunTraceCard.test.tsx and look for the DevTools button.
8. Claim: triggers support the user's timezone. Engine yes, registrar no. Confirm: submit `triggers.register --schedule "0 2 * * *"` and read `registration.timezone` (expect "UTC").
9. Risk: #3377 and #2931 are do-not-implement, yet J5 step 4 and the Monitor row depend on them. Confirm with Will which parts the MVP may touch before scheduling gap 6.

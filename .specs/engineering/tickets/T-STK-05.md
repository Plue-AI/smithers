# T-STK-05 Stop, resume, Retry and Retry with the current flow, drop, reopen

Stage S1 · Size M · Depends on T-STK-01, T-FLW-11, T-FLW-03, T-STK-04, T-STK-02, T-MCH-08 (S1), T-FLW-04, T-MCH-14, T-STK-12, T-GH-09, T-ACC-03, T-APP-04, T-CAT-01, T-INS-02, T-FLW-01, T-SEC-01, T-GH-03 · Unblocks T-APP-01, T-APP-02, T-APP-07, T-REL-04, T-STK-06 · Issue: [#3530](https://github.com/smithersai/smithers/issues/3530)
Spec: spec.md §3 (`checks.Attempts`), §4.1, §4.1.0a, §10.4.1, §10.7.1, §10.7.2, §10.7.4, §11.4.2, §12.4.1, §15.1.5, §19.1, §19.3 · Delta: delta.md §6 (Add Stop/Resume, Retry with attempt rows, Drop with PR close) · Product: mvp.md §4.1, §6.6 Stop and resume, J4.2, J7.3, Appendix B.2

## Goal
A member stops a working TODO and it shows Paused only after its run parks at a durable boundary. Resume continues that same run from its last finished step. Retry starts a new attempt of the pinned flow version, and Retry with the current flow starts one on the Active version; the earlier attempt stays readable either way. Drop closes the PR and takes the item off the stack. A PR reopened within 7 days restores the TODO with its last accepted generation, and the first input that needs work starts a new attempt.

## Scope
In:
- Land against each dependency's specified contract. Until T-STK-01's attempt/wait projection, T-FLW-11's durable run, T-FLW-03/T-FLW-04's versions and pinned loader, T-MCH-14's retention/wake, T-INS-02/T-FLW-01/T-SEC-01's validated machine execution, T-ACC-03/T-CAT-01's authorization/dispatch, T-APP-04's confirmations, T-STK-04/T-STK-12's fence, T-GH-09's write recovery, T-STK-02's removal and T-MCH-08's fold primitive are available, keep dependent controls dark and refuse before signals, attempts, GitHub writes, archival or removal. Missing T-GH-03 restoration refuses input-triggered restart; it never revives the dropped run. Enable each path only after its named boundary checks pass. Unlanded prerequisites do not block building or merging this slice (parallel-build rule 3). Checks: C-STK-03, C-STK-08, C-J7-02, C-J10-08, C-GH-09, C-SEC-02.
- `POST /api/todos/{n}` with `stop`, `resume`, `retry {steer?}`, `retry-current-flow {steer?}` and `drop`; catalog `/todo.stop`, `/todo.resume`, `/todo.retry` and `/todo.drop` (drop confirms), plus the `in-card` control `todo.retry-current-flow` (**Retry with the current flow**) on the failed TODO card (Appendix B.4).
- Agent permissions (§15.1.5, Appendix B): stop, resume, retry and Retry with the current flow are `agent: run`; drop is `agent: confirm`, so an agent's drop posts a one-click confirmation the member presses.
- Stop is a durable pause, not a cancel (§4.1, §10.7.1): the run parks in a `paused` wait at its next boundary, and the machine is released once safe-idle. Stop applies only while the attempt's run is executing with no open `question` or `approval` wait; otherwise it is refused with class `conflict`. An open branch wait (`conflict`, `moved_off`, `foreign_push`) doesn't refuse it: the TODO shows needs_you until that wait settles, then paused (§4.1.0a).
- Resume settles the pause wait: `paused → queued`, then `starting` when a machine is granted, and `working` when the coding host reports the run attached (`run_attached`, §4.1), on the same run id. A resumed run never waits for a first step it already finished.
- Retry from `failed` (reached from `starting` or `working`): `failed → queued` with a new `checks.Attempts` row and a new run of the pinned flow version from its first step (§4.1, §11.4.2). The earlier attempt and its evidence stay. An optional steer becomes the first message.
- Retry with the current flow (§4.1): as Retry, but the new attempt pins the currently Active version from `workflow_definitions` (§11.3.2). Same TODO identity and evidence history.
- Drop (§10.7.2): confirm, cancel the run, close the PR with "Dropped in Smithers by @x", mark `dropped`, archive the branch (`branches.archived_at`), and call T-STK-02's `Remove` so later items rebase. A final capture runs before the archive; the attempt closes with outcome `dropped`, and its last accepted generation stays on the record. Before later items rebase, Drop calls T-MCH-08's `FoldIntoForks(item)`, so a TODO forked from the dropped item keeps its change (§8.5.3a, C-J7-02).
- After T-GH-03 restores a reopened TODO with its retained generation and no live run, the first input that needs work starts a new attempt of the dropped attempt’s pinned flow version from its first step, with that input as its first message (§10.7.4). T-GH-03 owns inbound close/reopen restoration; this ticket owns input-triggered restart.

Out:
- Machine release by the S2 admission scheduler (T-MCH-06). S1 Stop uses T-MCH-14's retained-workspace path; it does not delete the workspace or disk.
- Detecting a PR closed or reopened on GitHub and restoring position/generation (T-GH-03); this ticket owns Drop and input-triggered restart, not inbound restoration.
- Evidence contents per attempt (T-STK-01). Steer delivery to a working run (T-STK-06).
- The `todo` run's pause wait and signal handling (T-FLW-11's one-run model); this ticket sends the signals.
- Generic background-run retry/stop, flow activation or loading, changing an existing attempt's flow digest, PR polling, retention-policy changes, terminal/SSH controls, CLI/skill doors and UI Views or Containers.

## Changes
- Reshape `packages/backend/internal/services/mythical_items.go:2708-2784` (`RetryItem` and its `SaveMythicalItem` version CAS) into the TODO control path; retain the CAS and typed-stop authority/counter logic. Remove the issue-only gate (`:2750`) and planner `declined` settlement (`:1382`) as delta.md §6 requires. Do not build a parallel control service or a new retry engine. Checks: C-STK-03, C-STK-08. In that existing service:
  - Stop → `flowdispatch.Service.Signal` (`packages/backend/flowdispatch/service.go:94`) named `pause` to the attempt's `todo` run, never `Cancel`. The TODO stays `working` with `stop: requested` until the runtime reports the `paused` wait opened, then moves to `paused` (§19.3). Set `mythical_items.paused_at` only on the wait-opened event. S1 releases execution capacity through T-MCH-14 while retaining the workspace and disk; do not call today's destructive `releaseLane` (`services/mythical_items.go:1182`) for Stop.
  - Resume → settle the pause wait; `paused → queued`. Admission grants a machine and the same run continues; the engine replays settled steps and runs only unfinished ones.
  - Retry → `failed → queued`; insert `checks.Attempts(attempt+1)`; pin the attempt's flow digest (`flow: pinned`) or the Active digest (`flow: current`); the new run's first message is the steer.
  - Reopened TODO input → start attempt n+1 as Retry does, with the input first; T-GH-03 has already restored its position and accepted generation without a live run.
  - Drop → confirm; persist `flowdispatch.Service.Cancel` (`:205`), then observe the run stopped before the final capture; `ClosePull` through `pending_op` (T-GH-09), and best-effort `Comment` through its existing marker (`mythical_github.go:484`, §12.4.1); close the attempt and all open waits, clear `needs_you` and `paused_at`, mark `dropped` and archive the branch. Under T-STK-12's stack lock/fence, call `FoldIntoForks(item)` (T-MCH-08 S1), then `Remove(n)` (T-STK-02), before later rebases. T-MCH-14 retains the final capture and accepted generation for Reopen; today's destructive `retireLane` (`mythical_items.go:1576`) cannot precede retained capture. Checks: C-J7-02, C-STK-08, C-J10-08.
- `packages/backend/internal/services/mythical_github.go` → add `ClosePull(number)` (`PATCH /pulls/{n} {state: closed}`).
- `packages/backend/internal/services/mythical_items.go` → one `checks.Attempts` row per attempt holding the attempt's single `todo` run id and flow digest (T-FLW-11); delete the `request_run_id`/`vibe_run_id`/`verify_run_id` overwrite. Delete the bound-stop resume by re-applying the `todo` label (`:247-258`): Retry is the only way back from `failed`.
- Replace the old `RetryItem` entry point after reshaping its CAS implementation; delete route `POST /mythical/items/{id}/retry` (`internal/compose/router.go:1133`, `internal/routes/mythical.go:274`), its OpenAPI row (`docs/api/openapi/repositories.yaml:12159`), `history.retry` (`apps/app/src/mainview/flows/entries/history.ts:102`) and `retryable` (`packages/rpc/src/StackView.ts:70`). `flow.run.stop` and `runs.resume` stop being TODO doors.
- Reshape the existing catalog descriptors for the four commands and `todo.retry-current-flow` through T-CAT-01; reuse its dispatcher and T-ACC-03 authorization. No parallel command policy or dispatcher. Check: C-STK-03.
- Reshape the existing TODO API documentation in `docs/api/openapi/repositories.yaml`; extract the new TODO route definitions into `docs/api/openapi/mythical_items.yaml` and their documentation into `packages/backend/docs/mythical_items.md` only as required by the TODO slice. These files are absent today; reuse existing definitions rather than duplicate them. Regenerate `packages/smithers/src/internal/backend/ProductApi.ts` (`smthrs run //:openapiClients`), docs gates.

## Tests

C-STK-03 (folded steps and assertions):
- All control and guard cases below enter the composed install router at `POST /api/todos/{n}` and the production command dispatcher. Inbound close/reopen/comment cases enter T-GH-03's production poll and stack delivery paths. Direct service calls supplement these cases only. New machine-backed boundary cases extend the existing service test infrastructure; the direct-process host fixture cannot prove machine isolation.
- With each required authority, execution, retention, fence, fold/removal or GitHub recovery provider absent, invoke its affected control through that same served boundary. Assert a refusal, no run/attempt or signal, no GitHub write and no archive/removal. Repeat with the provider present as a positive control. C-J10-08 also proves input after Drop refuses until restoration commits. Checks: C-STK-03, C-STK-08, C-J7-02, C-J10-08, C-GH-09, C-SEC-02.
- FLW11 QA G02/G03/G14/G16: after s1/s2 finish, Stop in held review and at capture/accept/push boundaries, restart before pause receipt, then Resume with a steer while starting. Race Answer and steer before/after turn dispatch; record stable wait/input ids and model_turn_started.
- FLW11 QA G01/G18/G21/R54/R56/R61: Stop vs external run cancel vs committed Drop vs merge, each working/held; race terminal settlement with pause. Try failed-item steer/Retry with person, delegated and run actors, including no_proposal/proposal_loop/policy stops and an untyped block.
- FLW11 QA R60: exhaust UTC token capacity with a live run, settle its in-flight call and observe the engine pause. Try Resume before capacity, restart, then release capacity/roll UTC and verify same-run recovery. Open an independent person Stop and a branch wait to test their precedence.
1. Wait until `s1` and `s2` are finished and `s3` is running. Send `stop`.
2. Read the TODO state and the run state until the runtime reports the `paused` wait opened. Record each observed state with its timestamp.
3. Send `resume`. Release `s3`.
4. Let `s4` fail. Read the state and `failure`.
5. Send `retry` with the steer "use the helper in lib/retry.ts".
6. Read `checks.Attempts`, and the attempt 2 run's first message, first step and flow digest.
7. In a separate failed TODO pinned to D, activate a literal fixture version D2, then invoke the served Retry with the current flow action.

Pass when:
- Stop succeeds with a live held-review run, unless a question/approval is open; the PR stays open. An in-flight packaged operation settles one durable result before paused opens. Resume restores the prior stack wait or next unfinished boundary, preserving s1/s2 counters and not replaying effects.
- Held starting/resumed steer is consumed once at the next unfinished boundary after run_attached and before model_turn_started. Question steer persists context and steer_received without settling the wait; replacement retains wait identity. Answer and steer consume the committed prefix once.
- Domain merge/drop outcome wins the cancellation/pause race. External run cancel without settlement yields failed/cancelled_external/user/retryable true, preserves branch/PR and offers person Retry with no auto-admission. Held current_step is null. Stale or duplicate events cannot change the first outcome.
- Typed-stop Retry and steer-as-Retry require a person; only an authorized run can Retry an untyped block. Person Retry resets launch/outage/replan/cycle allowances with an audit actor while retaining token spend, prior evidence and ordinary pin; Resume resets none.
- Token exhaustion shows paused only after the engine wait opens, with pause.reason daily_token_budget, install owner id/name and "Paused · daily token budget · <owner>". No generic failure or question/approval is created. The same run retains inputs, releases unused reserve after calls settle and reacquires before recovery. Resume cannot bypass capacity; clearing a budget wait preserves an independent Stop and branch-wait precedence.
- Step 2: observed TODO states are `working` (with `stop: requested`) then `paused`; `paused` appears only after the runtime's wait-opened event; the run is waiting in a `paused` wait, not cancelled; the lane is released.
- Step 3: the state goes `paused → queued → starting → working` on the same run id; the counters for `s1` and `s2` stay 1; `s3` continues instead of restarting a finished step.
- Step 4: state `failed` with `failure = {step: "s4", class, message, retryable: true}`.
- Step 6: two `checks.Attempts` rows. Attempt 1's run id, outcome and evidence are unchanged. Attempt 2 has a new run id that started at `s1` (re-running finished steps is intended for Retry, §4.1), digest D, and the steer as its first message.
- Every transition has a `product_job_events` row with actor Will.
- Step 7 starts a new attempt on D2 with the same TODO identity; the prior attempt, digest D and evidence remain unchanged. Expectations use committed fixture identities, not production pinning code.

Fail when:
- Stop is unavailable during held review, pause appears before an operation settles, resumed starting input repeats s1, or a terminal merge/drop flashes paused.
- External cancellation drops/closes the TODO, typed-stop Retry is delegated, counters reset on Resume, or token exhaustion shows generic failure, omits its owner or resumes without capacity.
- `paused` is shown before the run parks (§19.3), or Stop is lost after a host restart.
- Stop cancels the run, so Resume starts a new run id.
- Resume re-executes `s1` or `s2` (a counter reaches 2).
- Retry overwrites attempt 1 (today's `request_run_id` overwrite) or loads a newer flow version than D without an explicit Retry with the current flow action.
- The steer is delivered after the first model turn of attempt 2.

- Boundary integration, `packages/backend/internal/services/todo_control_db_test.go` (new boundary cases using the existing service/router and database test infrastructure; existing unit retry tests do not cover the served machine-backed controls): send Stop, Resume, Retry, Retry with the current flow and Drop through `POST /api/todos/{n}` on the composed install router and production command dispatcher. Use real PostgreSQL and the real pinned flow host on a microVM, not the direct host-process launcher `startCodingHost` in `packages/backend/flowdispatch/real_host_test.go:131`. Fixed step counters, state/guard cases, flow digests and expected refusals supply the oracles; no test reads spec files or derives expected results from production code at runtime. Checks: C-STK-03, C-STK-08.
- Same suite: Stop retains the workspace id, disk and unfinished file bytes through Resume; Retry retains attempt 1. Drop acknowledges persisted cancellation before completion, captures after writers stop, closes every wait, folds forked work before successor rebase, and refuses under a merge fence with `409 merging` and no close/cancel/archive writes. Crash after a PR close but before its receipt reconciles by lookup without undoing a later GitHub reopen. Checks: C-J7-02, C-J10-08, C-STK-07, C-GH-09.
- Unit, extend `packages/backend/internal/services/mythical_items_test.go`: literal command/guard fixtures across all nine states, including `needs_you` over an executing, paused or blocked item. Stop requires an executing run and no question/approval; Resume requires `paused_at`; both retries require item `blocked`; Drop permits any unmerged item. Guards read facts, not only the derived state (§4.1.0a).
- Integration with real PostgreSQL and the real flow host inside a microVM, `todo_control_db_test.go` (new): a 4-step fixture flow with per-step execution counters. Stop during step 3 → Paused after the boundary, and the run is waiting, not cancelled. Resume → the same run id; the counters of steps 1-2 stay 1.
- Integration, same file: Retry after a failure at step 4 writes attempt 2 with a new run id that starts at step 1; attempt 1's row, run id and outcome are unchanged; both attempts carry the same flow digest.
- Integration, same file: activate a new flow version after attempt 1 fails. Retry pins the old digest; Retry with the current flow pins the new one; attempt 1's evidence is unchanged in both cases.
- Integration, same file: a failure during `starting` gives `failed`, and Retry returns it to `queued`.
- Integration: an app-agent stop runs at once with the author's rights; an app-agent drop creates a one-click confirmation and drops only after the author presses it.
- Integration with the fake GitHub server: Drop of an `in_review` TODO closes the PR once with the comment, even when the call repeats with the same idempotency key.
- Fault: kill the host between the pause signal and the wait opening. After restart the TODO is `working` with `stop: requested`, then `paused`; never `paused` first.
- Integration, same file, for C-STK-08: Stop with a `question` open is refused; Stop with only a `foreign_push` open sets `paused_at` and keeps needs_you, then shows paused after Discard; Resume after `s1` finished turns `working` on `run_attached` within 5 s of the grant, with `s1`'s counter still 1.
- Integration with the fake GitHub server, for C-J10-08: drop T2, reopen its PR 25 h later, deliver the reopen twice, then a member's review comment. One `dropped → in_review` event; no run until the comment; then attempt 2 on the pinned digest with the comment as its first message.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J7-02](../checks/C-J7-02.md): Drop preserves the change of a TODO forked from the dropped item.

- [C-STK-03](../checks/C-STK-03.md): Stop → Resume continues from the last finished step; Retry keeps the earlier attempt.
- [C-J4-02](../checks/C-J4-02.md): retry with a steer from the home card while chatting.
- [C-STK-08](../checks/C-STK-08.md): Stop and Resume with open waits; resume leaves Starting on `run_attached`.
- [C-J10-08](../checks/C-J10-08.md): reopen restores the generation; a later review comment starts a new attempt that merges.

## Risks and notes

- smithers-8a accepts the T-GH-03 restoration / T-STK-05 restart split. Do not add T-STK-05 to T-GH-03 dependencies: that creates T-GH-03 → T-STK-05 → T-STK-04 → T-GH-03. Checks: C-J10-08.
- Risk: a model call in flight delays the boundary past 60 s (§10.7.1). Observation: stop-to-paused time over 60 s in the integration log; then the agent step needs a cancel token.
- Risk: a run parked in `paused` for days holds a durable wait. T-FLW-11's restart test of 50 waiting runs covers it.
- Resolved: the index now lists T-FLW-03 as a dependency.

## Security preconditions and inherited root inputs

Resume, Retry and reopened-input execution use the validated machine launcher and guest dispatcher only. Stop/Drop capture and fork/rebase work stay inside machines as unprivileged users. Missing isolation or validated bootstrap keeps these paths dark; no host-process fallback, sudo, branch-built root executable or guest provider key is allowed. smithers-3f reviews this boundary and the inventories below; smithers-8a accepts cross-owner seams. Checks: C-SEC-02, C-STK-03, C-J10-08.

No new root step is added. Wake/reprovision inherits R1–R3 from T-SEC-01 and R4–R5 from the T-MCH-14 inventory. Main means approved main-pinned or installed-bundle code; install-controlled means trusted host configuration/state, not branch authority. Every branch/member-derived input below blocks enabling its consuming root path until its named production validation test passes. Branch-built scripts, binaries, interpreters, imports and toolchains remain forbidden at root even if a digest matches. Validation must precede use on fresh and retained machines:
- R1: `TestGuestHelperInstallPinsInterpreterAndEnv` validates bundle/helper/interpreter provenance, fixed startup environment, ancestors and replacements.
- R2: `TestRootSetupNeverFollowsMemberSymlinks` validates bounded env.json keys/cache targets, fixed identities and no-follow home/cache writes, including replacement races.
- R3: `TestRootPreflightParsesOnlyEnvelope` validates bounded identity/request parsing, protected request paths, cgroup bounds and relay endpoints before use; argv/env/cwd/file payloads apply after supplementary-group/GID/UID drop.
- R4: `TestRootLayerInputsValidatedBeforeUse` validates layer declarations, archive entries, destinations and retained cache inputs before privileged use. Target indexes and root executable/toolchain bytes come from main; dependency installers run as agent. T-MCH-10's security follow-up owns this gate.
- R5: `TestRootManagedArtifactInstallUsesApprovedBundleOnly` validates installed bundle/catalog artifact provenance and protected destinations before root planting/binding. T-FLW-01's follow-up owns this gate.
All five are C-SEC-02 gates where consumed. Tests run through production fresh/retained-machine paths with literal hostile fixtures and positive controls; supplemental direct helper tests do not enable a path.

### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Terminal request ID, `/run/smithers/requests` directory/ancestors, request `.json` bytes, ownership/mode, stdin/file descriptors, terminal size and signal inputs — **main/install-controlled** IDs and transport settings; request payload and retained filesystem entries can be **branch/member-controlled**. Protected no-follow request creation/read/removal and bounded parsing are proved by TestRootPreflightParsesOnlyEnvelope.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

### R4

Inputs by privileged substep:

- Prepare boot/bootstrap: base OCI image, parent/newest same-family snapshot, owner/holder/repository/name/key labels, CPU/memory/disk/timeout/budget, net-rule allowlist — **install-controlled** configuration/state; recipe key, network destinations and selected tools are **branch-derived**. Image and snapshot contents include upstream OS and prior **branch-derived** outputs. R1/R2 also apply.
- Toolchain root recipe: `.smithers/target-index.json` Environment.Toolchain download versions/URLs/SHA256, Rust channel/components/targets, PostgreSQL major, destinations; or detected language/version evidence from repository manifests and version files — **branch**. Bundled `toolchains.json`, detector and script templates — **main/install-controlled**. `.smithers/machine.json` package additions — **main**, explicitly pinned by resolver. Downloads/archive entries/install scripts/tool `--version` output, Rust dist metadata/artifacts, apt package indexes/packages/maintainer scripts and PGDG key — upstream network responses, **branch-selected** for indexed download URLs/pins, otherwise **install-controlled** approved upstreams. GitHub-hosted release responses are **GitHub**, selected by the branch where index supplies the URL. `/etc/os-release`, apt sources/keyrings, root temp dirs and existing executable/filesystem state — **install-controlled** image/snapshot, including prior branch outputs. Every env.json key/value and root subprocess environment is consumed; fixed overrides are HOME=/root, TMPDIR=/var/tmp, DEBIAN_FRONTEND=noninteractive, system PATH, empty PYTHONPATH; other base_environment values remain inputs.
- Root input plant: all declared input path names and bytes (package/lock/workspace manifests, Go/Cargo inputs, selected tool entry/source files, dprint config, Python/requirements/pyproject inputs as selected by recipe); `tarFiles` regular-entry metadata, generated tar bytes; fixed destination/cache path and UID/GID, existing prepare directory/ancestors — **branch** files/names, **main** tar construction/script/UID, **install-controlled** snapshot paths with prior **branch-derived** cache content. This root step consumes file bytes even though later dependency installers run as agent.
- Root browser system install: Playwright selection/version triggering shipped apt script — **branch**; fixed package argv — **main**; apt sources/signatures/indexes/packages/scripts — **install-controlled** image/upstream network. It is separate from the unprivileged browser installer.
- Marker/sync and offline verification: serialized schema/kind/key/name/parent/repository/inventory/creation record, marker path, existing marker/temp/parent files and snapshot — **install-controlled** record with **branch-derived** recipe identity and output; script/destination — **main**. Reading a matching marker verifies identity, not trust of all layer contents.

### R5

Inputs: artifact source path/bytes, artifact mapping, executable and env-value paths, helper bytes/digest — **install-controlled** bundle/catalog; existing guest destination/parents — **install-controlled** filesystem, potentially **member-controlled** if writable. Coding binding workspace/actor/repository IDs, repository slug, API/git URLs, fixed workspace/user/socket/version — **install-controlled** server authority, with **GitHub/member-derived** identity/slug data. Destination files, owners/modes/symlinks and helper-check response — guest filesystem/response. Root script/helper/interpreter — **main/install-controlled** plus R1 startup inputs.

## Ready checklist
1. Dependencies: the header and index name S1 attempt/wait, durable-run, version/loader, retained-machine, execution/security, authorization/catalog/confirmation, fence, outbound recovery, removal/fold and inbound-restoration contracts. Scope keeps every unavailable dependent path dark and failing closed; unlanded dependencies do not block this ticket's build or merge. Current T-FLW-04 and T-MCH-08 have no reverse dependency on this ticket.
2. Exclusions: S2 admission, inbound detection/restoration, evidence contents, working-run steer, runtime pause handling, generic run controls, activation/loading, digest replacement, polling, retention changes, terminals/SSH, CLI/skills and Views/Containers are explicit. Reshape the existing retry CAS and test/docs infrastructure; no parallel control service, policy, retry engine or table.
3. Tests: C-STK-03/C-STK-08 use the composed TODO route and production dispatcher on real PostgreSQL and a microVM, including absent-provider refusals; C-J10-08 uses production inbound poll/delivery. C-J7-02/C-J4-02 retain their real app boundaries. Literal fixtures, counters and committed digests define expectations; no spec-file or production-derived runtime oracle. Joint checks remain pending until their providers are enabled.
4. Decisions: smithers-3f approves pause/cancel/capture ordering, retention, Drop/fork atomicity and reopen recovery; smithers-b8 approves command payloads, public API/docs and old app-door removal; smithers-38 approves public retryable removal and library changes under §21.1; smithers-8a accepts cross-owner seams and any cancel-token response to the 60 s risk; Will decides product changes. No ADR is introduced.
5. Owner pre-review questions, recorded for post hoc review under the parallel-build directive: smithers-3f: Does Stop retain the resumable workspace and use only validated machine startup? Does Drop fence/capture/fold before successor rebase and reconcile an uncertain PR? Does reopen input create exactly one pinned attempt? smithers-b8: Do both Retry doors and Drop confirmations use the same authorized dispatcher? Are old TODO control doors and their API definitions removed together? smithers-38: Are retryable callers migrated together while persisted history remains readable? Existing owner answers stand; Views are excluded.
6. Security: M-29 confines repository execution and capture/check work to unprivileged machine users, with no host fallback or sudo. The R1–R5 inventory lists all inherited root inputs and sources, names the validation gate for branch/member data, and forbids branch-built root code. Missing validation keeps the consuming path dark. smithers-3f reviews these preconditions; C-SEC-02 and machine-backed C-STK-03/C-J10-08 prove them.

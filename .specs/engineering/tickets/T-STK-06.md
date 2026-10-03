# T-STK-06 Steers and amendments at every boundary of the TODO flow

Stage S1 · Size M · Depends on T-STK-01, T-STK-02, T-STK-05, T-STK-12, T-FLW-11, T-MCH-14, T-INS-02, T-FLW-01, T-SEC-01, T-CAT-01, T-ACC-03, T-ACC-04, T-APP-04 · Unblocks T-APP-02, T-APP-10, T-COL-12, T-GH-04 · Issue: [#3531](https://github.com/smithersai/smithers/issues/3531)
Spec: spec.md §4.1 (`in_review → working`), §5.2, §10.2.2, §10.4.2, §10.7.3, §15.1.5 · Delta: delta.md §6 (steer route; steers between implement turns) · Product: mvp.md §4.2, §6.6 Steer, J3.6, J4.2, J6.3, J7.1, M-21, Appendix B.2
Ready: 2026-10-03 smithers-8a sha256:6bd2222b2a11

Rescoped by the minimal-code synthesis, 2026-10-03 (v2 ticket merges STK-06+15; v2 "Reuse named in tickets"). Absorbs T-STK-06 ([#3536](https://github.com/smithersai/smithers/issues/3536)).

## Goal
A member, or an agent acting for one, steers or amends `Tn`. The live implementing agent receives the text before its next model call on the same run and working copy. An amendment is a new revision of the same TODO, delivered as a steer.

## Scope
In:
- `POST /api/todos/{n} {steer}` and `/todo.steer Tn` (`agent: run`, recorded with `via`).
- `PATCH /api/todos/{n}` and `/todo.amend Tn` (`agent: confirm`): append revision n+1 to `mythical_items.revisions`; no new number, branch or PR. HTTP 202 is the only JSON success response; its body carries `state` for committed and pending outcomes.
- Delivery by state (§10.7.3): held while `queued` or `starting`, delivered on resume while `paused`, `in_review → working` with the run re-entering implement. A failed or reopened TODO starts one attempt through T-STK-05 with the steer first. Merged or dropped refuses `todo_closed`. A merge fence (T-STK-12) refuses Amend with `409 merging` and holds a steer until the fence clears.
- An open question stays open; a steer never settles a wait. Persist the steer once as waiting-agent context and emit `steer_received`. Serialize Answer and Steer by committed sequence; the next model turn consumes all inputs committed before dispatch (§10.7.3). Checks: C-J3-05, C-ACC-01.
- Land dark against every unlanded dependency contract. Without T-STK-01/02/05/12, T-FLW-11, T-MCH-14, T-INS-02, T-FLW-01 or validated T-SEC-01 execution providers, leave the affected mutation/delivery path disabled before effects; never fall back to host execution. Without T-CAT-01/T-ACC-03 authority, disable both commands; without T-ACC-04, disable delegated calls. Without T-APP-04, delegated Amend returns `503 infra/confirmation_unavailable` before any revision, event or signal. Enable each path only after its production tests and prerequisite receipts pass; missing dependencies do not block starting or landing this dark slice. Checks: C-ACC-01, C-J3-05, C-J7-01; execution prerequisite: C-SEC-02.

Out: GitHub reviews as steers (T-GH-04), implementing Retry/reopen or Stop/Resume (T-STK-05), implementing wake/retention (T-MCH-14), S2 burst activity, arbitrary named signals, a new queue or journal, a second TODO/run/branch/PR for Amend, new root helpers or image/toolchain provisioning, host execution of repository code, new confirmation UI, Views and Containers. Consume these tickets’ contracts only.

## Changes
- Reuse `ReceiveFeedback` (`flows/coding/steering.ts:156`) and `routeMessages` (`:28`). Reshape: admit the `todo` root and its step flows, not only `coding/request` (`:15`), and replace the three-value `Boundary` list (`:91`) with every step boundary of the `todo` composition (T-FLW-11).
- Reshape `flows/coding/implementation/flow.ts:33`: call `ReceiveFeedback` between atoms and reuse `EditAtom` (`flows/coding/atoms.ts:49`) with the existing agent-harness notification drain between model turns. Atom-only draining does not meet the one-turn bound. `flows/coding/request/flow.ts:112`, `:130` keep their calls. smithers-38 approves lineage ownership and drain/closure semantics; C-J3-05 proves delivery inside a blocked implement step.
- Reuse the dispatcher signal path (`packages/backend/flowdispatch/service.go:94`). Reshape: add `SignalInTx`, the signal twin of the existing `AdmitInTx` (`:80`), so the item event, revision and signal intent commit in one transaction before the worker delivers.
- Reuse T-STK-01's `product_job_events` for the `steer` and `amend` entries with actor and `via`.
- Delete `runs.steer` (`apps/app/src/mainview/flows/entries/runs.ts:128`) and `steerRun` (`apps/app/src/mainview/state/controller/runs.ts:631`); `/todo.steer` replaces them.
- Reshape the existing stack routes/services in `packages/backend/internal/routes/mythical.go` and `packages/backend/internal/services/mythical_items.go`; reuse the T-CAT-01 command descriptors and T-ACC-03 bound Authorize decision before mutation, replay disclosure or confirmation creation. Use T-APP-04 for delegated Amend. Checks: C-ACC-01, C-J7-01.
- Reshape existing stack API documentation in `docs/api/openapi/repositories.yaml` and the bundled `docs/api/openapi.yaml`; regenerate `packages/smithers/src/internal/backend/ProductApi.ts` with `smthrs run //:openapiClients`. New documentation only: `packages/backend/docs/mythical_items.md` (the cited path does not exist today). Do not create a parallel OpenAPI source at the absent `docs/api/openapi/mythical_items.yaml`.
- New standalone runtime modules, queues and journals: none. `SignalInTx` extends the existing dispatcher; reuse Signal validation and the existing jobs store transaction path.

## Tests
Extend `packages/backend/internal/routes/mythical_test.go` with `TestTodoSteerProductionDispatch`, `TestTodoAmendProductionDispatch` and `TestTodoSteerUnavailableProviders` (new cases). Invoke the served install router’s `POST /api/todos/{n} {steer}`, `PATCH /api/todos/{n}` and the production catalog dispatcher’s `todo.steer`/`todo.amend`, then drain the real flowdispatch worker into the pinned guest coding host. Direct queue/service calls are supplemental. Use real PostgreSQL and a real microVM with a scripted model provider. Expected statuses, states, text, attribution and counts are literal reviewed fixtures; no oracle reads spec files, generated descriptors or production decision code at runtime. C-ACC-01 covers authorization; C-J3-05 and C-J7-01 cover the browser/skill doors.

- Integration, real PostgreSQL and the real pinned coding host in a microVM: the scripted provider holds a turn while a steer arrives; the literal text and actor reach the next model request; run id and working-copy change id are unchanged.
- Same suite: one idempotency key twice yields one signal and one event; queued/starting delivers after run attachment at the next unfinished boundary, paused at Resume, `in_review` re-enters implement on the same run; failed/reopened uses T-STK-05 once with the steer first. Run/machine credentials and merged/dropped items refuse before effects. A steer during an open question records context once and leaves the wait open; race Answer against Steer and inspect committed sequence at the next model request. A fenced steer remains durable and undelivered after merge, or delivers once if the fence clears without merge. Crash after commit and lost delivery acknowledgement deliver once. Remove each prerequisite provider in turn: no unauthorized mutation, revision, event, signal, model dispatch or host execution; an admitted held input remains durable. Restore providers and prove delivery once. Checks: C-J3-05, C-ACC-01.
- Amend: queued Amend is revision 2; working Amend reaches the live run once; replay allocates no number and sends no second signal; a delegated Amend writes nothing until the person confirms; a fenced Amend writes no revision.
- Unit, `flows/test/coding-steering.test.ts`: a Message to a `todo` run is admitted at each boundary; a closed run refuses `notification_closed`.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md) (S1 part), [C-J3-05](../checks/C-J3-05.md) steps 2-4, [C-J7-01](../checks/C-J7-01.md) (Amend: +1, no new TODO, branch or PR, one attributed steer), [C-ACC-01](../checks/C-ACC-01.md) (Amend confirmation).

## Risks and notes
- Activation with T-APP-04: Steer delivery lands before Confirm wiring; delegated Amend remains refused. Missing providers refuse; joint acceptance gates enabling the path.
- smithers-3f accepts the transactional signal intent, merge-fence locking and wake/authorization guards; smithers-38 accepts notification lineage, closure and model-turn draining; smithers-b8 signs off the public API, command replacement and confirmation refusal contract. These owners decide the seam, not the implementer alone.
- Risk: a dispatcher signal never reaches the host's notification queue, because today's steers go through the workspace gateway (`apps/app/src/mainview/state/controller/runs.ts:624`). Observation: the steer is missing from the run transcript. smithers-3f and smithers-38 decide whether to reuse the gateway `steer` inside the existing durable job; smithers-b8 approves its command/API binding. C-J3-05 must prove the chosen production path before enabling it.

## Security preconditions
Repository code, including the pinned TODO composition and implement tools, executes only as an unprivileged user inside a machine (M-29). Steer/amend text is attributed data, never a host/root command. smithers-3f reviews isolation, credential binding and all privileged inputs. No new root step is introduced. Delivery/wake consumes T-SEC-01’s existing R1–R3 boundaries below; T-INS-02 and T-FLW-01 provide the bundled runtime and guest-only dispatch. Branch-built root code is forbidden even if a digest matches. Branch/member data at these root boundaries blocks enabling delivery until `TestGuestHelperInstallPinsInterpreterAndEnv` (R1), `TestRootSetupNeverFollowsMemberSymlinks` (R2) and `TestRootPreflightParsesOnlyEnvelope` (R3) pass through production fresh and retained-machine paths in C-SEC-02. These tests validate inputs before privileged use and before retained wake cleanup. No root layer build or artifact installation change belongs to this ticket.

Inherited root-input inventory (T-SEC-01):

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

## Ready checklist
1. Depends on includes item/revision/fence/retry contracts, composition, wake, launcher, isolation/root validation, catalog, authorization, delegation and confirmation providers; Scope lands dark for each missing provider, with production tests gating activation.
2. Out of scope names review ingestion, lifecycle/wake implementations, S2 activity, arbitrary signals, new ledgers, extra TODO/run/branch/PR allocation, root provisioning, host execution and UI work.
3. Named route tests enter the served TODO routes and catalog dispatcher, use the durable worker and real guest host, and assert literal independent fixtures; C-J3-05/C-J7-01 cover browser and skill commands, C-ACC-01 covers authority.
4. smithers-3f decides transactional delivery, wake and security; smithers-38 decides lineage/draining and any gateway reuse jointly with smithers-3f; smithers-b8 approves public API, command deletion and confirmation behavior.
5. Owner pre-review: smithers-3f: Does SignalInTx commit revision/event/intent atomically and preserve fence ordering? Do wake and refusal gates prevent host execution and unauthorized effects? smithers-38: Does root/child lineage routing preserve durable closure and replay? Does the harness consume steers before the next model turn, including an open question? smithers-b8: Do both command doors use the same authority and confirmation contract? Can runs.steer/steerRun be removed with every retained caller migrated? No View changes require smithers-06 review; owners review post hoc under the parallel-build directive.
6. Security preconditions require machine-only unprivileged execution, named smithers-3f review and the R1–R3 main/branch input inventory with C-SEC-02 validation tests; branch-built root code remains forbidden.

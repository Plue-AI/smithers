# T-COL-03 Host registry, per-boot credentials, daemon planting, reporter replacement and K6 VM faults

Stage S2 · Size M · Depends on T-MCH-04, T-COL-03a, T-COL-03f, T-COL-03r, T-INS-02, T-ACC-03, T-COL-02, T-STK-12, T-COL-10 (S1 only), T-SEC-01 · Unblocks T-COL-04, T-COL-05, T-COL-06, T-COL-10, T-MCH-07, T-MCH-08, T-MCH-12, T-REL-04, T-STK-08, T-TRM-01, T-TRM-02, T-TRM-03, T-TRM-05, T-TRM-07 · Issue: [#3560](https://github.com/smithersai/smithers/issues/3560)
Spec: spec.md §5.3 (`machine`), §7.6.1–7.6.2, §8.4.3, §9 (intro), §9.1.1–9.1.4, §9.4.1, §9.5, §16.1.1, §17.2, §19.1 · Delta: delta.md §3 (sleep/stop row), §4 (`smithers-machined`, host relay, delete head loop) · Product: mvp.md §6.7 Sleep and Cleanup, M-27, M-29
Ready: 2026-10-03 smithers-8a sha256:1f697826788e

## Goal

Register one authenticated connection per branch and boot, plant and supervise the daemon, and route reads, writes and capture through it. Replace the bash head reporter with the daemon capture path, preserving pending-work detection.

## Scope

In:
- Objects travel as git bundles on ADR 0004 object streams before their events. The host verifies bundles and chooses branch-scoped incoming refs. Check: C-DUR-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
- Own reference-host C-DUR-04 K6: force-stop the VM at K1 and K5b, wake and reconcile, and verify acknowledged bytes and receipts. T-COL-04 runs the complete integrated S2 matrix.
- Implement the Go half of §9.1 and §9.5.3: branch-keyed registry, authenticated per-boot connections, newer-boot replacement, RPC client, object verification, transactional event receipts and acknowledgement only after commit. Consume T-COL-03r / ADR 0004 schemas and golden frames; reuse T-COL-10’s S1 file request/response schema.
- Plant and supervise T-COL-03a’s binary, mint per-boot machine credentials and the relay secret, and admit no session or awake state before wake_reconcile finishes.
- Route awake reads, compare-and-writes and capture through the daemon. Publish the captured head and machine state. Replace and delete the head reporter and its route and tests.
- Lands dark until T-MCH-04 and T-INS-02: no daemon boot without the branch-to-machine binding and real microVM runtime. Until T-ACC-03, refuse RPC dispatch without authenticated branch authority. Until T-COL-03r and T-COL-03a, refuse missing/incompatible wire or daemon; no helper fallback, session admission or awake publication. Until T-COL-03f, component fixtures provide no acceptance receipt. Checks: C-COL-01, C-COL-04.
- Lands dark until T-COL-02, T-STK-12 and T-COL-10 (S1): refuse activation without live publication, durable pending-work delivery and digest-aware file routes. Until T-SEC-01, refuse privileged planting without the hardened installer. Until T-INS-01 and T-MCH-11, refuse activation without a main-pinned packaged daemon and trusted guest identities/no-sudo image. These last two are enablement preconditions, not code dependencies. Checks: C-COL-04, C-DUR-04, C-STK-06.
- Cut over each supported provisioning path atomically: retire its reporter before admitting the daemon. When the daemon is unavailable, refuse awake reads, writes, capture and sessions; retained reads remain under T-MCH-07. No second head publisher or reporter shim. Check: C-DUR-04.
Out:
- Rust core, broker, freeze sequence, capture, oplog and outbox producer (T-COL-03a); FIFO executor (T-COL-03r).
- Watcher and change-event ingest (T-COL-04a, T-COL-04); documents (T-COL-08a, T-COL-08b, T-COL-08).
- New transport, socket tunnel or sidecar; presence roster (T-COL-06); session protocol and terminal/SSH migration (T-TRM-07, T-TRM-01, T-TRM-03); member identity allocation (T-MCH-11); image declaration/builds and bundle construction (T-MCH-10, T-INS-01); sleep/admission/cleanup policy (T-MCH-07, T-MCH-06, T-MCH-09); Cloud feature expansion and UI Views. Hosted callers of the removed reporter must still migrate; excluding Cloud expansion does not permit dangling callers.

## Changes
- Write ADR 0004’s boot file with boot id, relay secret, machine credential, topology and bridge port when required; owner `machined`, mode 0400. Use the nonce HMAC, never a bearer secret. Check: C-COL-04. Security review: smithers-3f must approve before this lands (gaps 5–8).
- `packages/backend/internal/machined/fault_test.go`: reference-host K6 harness drives VM force-stop at K1/K5b and records restart, reconciliation, head refs and receipts. Check: C-DUR-04.
- Reshape existing `packages/backend/internal/services/workspace_facets.go:187,244`, `workspace_head.go:288,357,697` and `packages/backend/microsandbox/runtime.go:587` lifecycle plumbing. Enable the existing guest byte stream in `microsandbox/transport.go:92,102` through `Runtime.DialWorkspacePort`; no replacement transport. Reuse the hardened `microsandbox/guest.go:54` installer’s provenance and no-follow checks. Check: C-COL-04.
- Encode and decode only through `packages/backend/internal/machined/wire` (T-COL-03r); no local frame types. The planned `packages/backend/internal/compose/cocontracts_test.go` guards this codec (smithers-3f, 2026-10-02).
- `packages/backend/microsandbox/machined.go` (new): plant the daemon and its init supervision from `prepareGuest` after `installGuest` (`microsandbox/runtime.go:587–588`, `guest.go:54`). Existing one-shot helper installation lacks daemon supervision; extend that lifecycle instead of adding a launcher.
- `packages/backend/internal/machined/` (new): the connection registry keyed by branch, RPC client, outbox acknowledgement, and capture. The existing head-report HTTP handler has no multiplexed boot connection or transactional event acknowledgement; reuse its head-storage and pending-work hooks rather than duplicating them. Capture writes the head to the machine record and publishes `branch:<id>` through `live.Publish` (T-COL-02).
- Reserve `machine_event_receipts` (§3, §9.1.4) as `planned:T-COL-03`, owner smithers-3f, in `packages/backend/db/ownership.csv` before restamp; smithers-8a accepts the reservation and smithers-3f approves the encoding. Assign the unlanded migration number at landing. Checks: C-PRC-02, C-DUR-04.
- `packages/backend/internal/services/workspace_facets.go:187` (`ReadWorkspaceFile`) and `:244` (`WriteWorkspaceFile`): awake microVM machines read and write through `read_file` and `write_file`. Delete the `fs read` and `fs write` subcommands of `microsandbox/guest/smithers-guest.py` if `rg` finds no other caller.
- Credential: mint `machine` (§5.3) per boot in place of the head token (`internal/services/workspace_head.go:357` `rotateWorkspaceHeadToken`).
- Delete (zero tech debt):
  - the bash head reporter (`workspace_head.go:52-171` script, install at `:601`, `:632-695`) and `ReportWorkspaceHead` (`:697`);
  - the route `POST …/workspaces/{id}/head` (`compose/router.go:552`) and its OpenAPI row (`docs/api/openapi/repositories.yaml:10440`, repository-root path);
  - the reporter's tests (`workspace_head_test.go`, `workspace_runtime_head*_test.go`).
- `packages/backend/docs/machined.md` (new): document the boot/registry contract absent from the reporter docs; reuse existing backend docs targets (`docs:sync`, `docs:check`, `smthrs docs //packages/backend:docs`).
- Consume T-COL-03r framing and T-COL-03f fake machined. Do not define a second codec contract.

- Before deleting `ReportWorkspaceHead`, move T-STK-12’s pending-work hook to `packages/backend/internal/machined/` capture ingest: after accepting a captured head for an `in_review` TODO, compare its tree with the accepted generation’s tree and signal `edited` once per new tree. Preserve stack locking, durable signal delivery and replay deduplication. Replace the head-report tests with capture-path tests; keep no reporter shim. Check: C-STK-06.

## Tests
- C-DUR-04: replay a queued capture twice after a host rewrite. A stale `base` commits one receipt, preserves the rewritten head, sets `rebase_pending` and returns `stale_base`; host object transfer and `wake_reconcile(head)` precede the fresh capture that converges.
- C-COL-03 and C-PERF-06: withhold host acknowledgements for 10 s during the freeze sequence. The local capture pins and queues its snapshot; the rewrite thaws before acknowledgement. A later `capture()` waits for and drains the outbox outside the lock.
- C-COL-04: a failed HMAC proof closes only the newcomer. A valid handshake replaces a half-open live connection immediately, without waiting for the 30 s silence timeout. Security review: smithers-3f must approve before this lands (gaps 5–8).

Boundary and oracle rules for every test below: use the composed production router’s authenticated `GET`/`PUT /api/repos/{owner}/{repo}/workspaces/{id}/files/content` routes (`compose/router.go:1443–1444`), production `Runtime.CreateWorkspace`/`StartWorkspace` planting and relay, and the production authenticated connection dispatcher for captures/events. Drive rebase and return RPCs through the real Go client and host registry, not a direct daemon helper. Fixed bytes, independently computed digests, literal refusal codes and T-COL-03r hand-authored frames define expectations; no test reads specs or derives its oracle from production code. Fake-machined tests prove component behavior only.

- `TestMachinedProductionBoundaryFailClosed` (C-COL-01, C-COL-04): disable each named dark prerequisite independently; the production entry refuses, creates no session, publishes no awake/head success and never invokes a helper/reporter fallback. With all prerequisites available, fresh and retained boot reconcile before admission.
- `TestMachinedCaptureDispatchDurability` (C-DUR-04) and `TestMachinedCapturePendingWork` (C-STK-06): invoke production capture dispatch and authenticated event ingest; verify commit-before-ack, missing-object refusal, replay deduplication and the pending-work assertions below. Cover every existing hosted reporter caller before deleting the shared route.

C-COL-03 (folded steps and assertions; `packages/backend/internal/machined/mutation_integration_test.go`, new):
1. Start every writer. Call `rebase(onto)` 50 times, 2 s apart.
2. Move the working copy with `jj new main` from W3's session, then call `return_to_item()`. Repeat 10 times.
3. Pause at the `frozen` point. Issue W1 and W2 writes, one of them with a `base_digest` on `README.md` taken before the rebase. Release.
4. Force a freeze timeout (hook: `frozen` never reported) and call `rebase(onto)`.
5. Race `write_file` against an outside rename: a hook pauses between the daemon's digest check and its swap while W4 saves, 100 times.

Pass when:
- Every write a writer logged before a rebase or move started is, by SHA-256, in the rewritten working copy or in a recorded version (a versions commit in the host store). None is lost.
- Between `frozen 1` and the thaw, the inotify log shows no working-copy event from any session process.
- Step 3: the queued writes complete after the rewrite; the stale `README.md` write gets `409 stale`, and the others apply on the new base.
- Step 4: nothing is rewritten, every session thaws within 1 s, the reply is `busy`, and `rebase_pending` stays set. The reply names the blocking session for the presser; releasing that blocker triggers an automatic retry (§9.4.2).
- Step 5: in 100 of 100 runs the daemon's write is either applied over the base it named or refused `409 stale` with W4's file swapped back; W4's save is never lost.
- (S3) Both document texts after each reconcile hold every keystroke typed during the hold, with its author, and "Rebased onto Tk" is one transaction.
- The lock hold is recorded per run; p95 under 2 s (C-PERF-06 measures it on the reference host).

Fail when:
- A session process writes while frozen, or a write lands between capture and thaw.
- A queued write applies against a stale base, or a stale write silently replaces newer content.
- Keystrokes stop relaying to other clients during the hold.


- integration, real PostgreSQL (`packages/backend/internal/machined/registry_integration_test.go`, new):
  - The machine credential for branch A can't call or publish for branch B.
  - A second connection from a new boot replaces the first.
  - An event delivered twice yields one row.

- Contract: replay T-COL-03r golden frames against the Go RPC client and registry, first with T-COL-03f, then with T-COL-03a. Reserved document frames get typed unsupported in S2; capture calls flush first.
- Integration, real daemon, Linux VM and host store: all original capture, wake, stale-write, branch-credential and newer-boot cases, plus init restart. Own C-DUR-04 K6 on the reference host, ten runs at each trigger; validate K3/K3b/K4/K4b/K5a–c with real host dependencies. T-COL-04 runs the complete K1–K6 matrix once bursts exist.
- Integration: reject unauthenticated relay and cross-branch actor envelopes (C-COL-04); run the C-COL-03 writer matrix with the real Go client.

- Integration, real PostgreSQL and daemon capture: an in_review TODO with a changed captured tree signals `edited` once; identical trees and replayed captures signal nothing. Re-run T-STK-12’s head-report cases through capture ingest. Check: C-STK-06.

## Acceptance

- [C-DUR-04](../checks/C-DUR-04.md): killing the daemon or the VM during a capture loses no acknowledged write and never moves the head ref to a commit the host store lacks.
- [C-COL-03](../checks/C-COL-03.md): the mutation lock and freeze sequence lose no write from any writer.
- [C-COL-04](../checks/C-COL-04.md): no path, special file or forged identity gets past the daemon's confinement.
- [C-COL-01](../checks/C-COL-01.md): real S2 assertions for this component re-run the T-COL-03r golden-frame gate, using the named production boundaries above.
- [C-STK-06](../checks/C-STK-06.md): the named production capture test preserves pending-work ordering and replay behavior; its S2 capture source replaces the old head-report harness for this ticket.
- [C-PRC-02](../checks/C-PRC-02.md): the receipt table reservation is accepted before restamp; migration numbering preserves landed history.

## Risks and notes

- Cross-building a static musl `aarch64-unknown-linux-musl` binary on macOS needs a linker (`cargo-zigbuild` or `cross`). Confirmed if `smthrs build //crates/smithers-machined` fails on a clean Mac. Bundle work belongs to T-INS-01, so coordinate.
- `jj` must never leave files in `.jj/` that members can't write. The daemon runs jj as `machined` with `umask 002` (§9.5.1), never as root. Confirmed broken if a member's `jj st` fails after a capture.
- The head reporter also serves hosted workspaces (`workspace_runtime_head_hosted_integration_test.go`), and Plue composes the same backend. If a hosted path still needs it, deleting it breaks Smithers Cloud. Confirmed if `rg installWorkspaceHeadReporter` reaches a hosted-only caller. Then the daemon must replace it there too, or the tech lead decides the order. Two head publishers must not coexist.
- smithers-3f accepts the Go/runtime/credential/capture seams and root-input validation; smithers-b8 signs off deletion of the public head route and OpenAPI compatibility. smithers-8a accepts ADR 0004 wire changes with smithers-3f’s review (T-COL-03r); ADR 0003 topology remains T-COL-11’s decision. This ticket consumes those contracts and does not decide topology.
- smithers-8a decides shared hosted cutover order with smithers-3f; deletion waits until every supported caller uses capture ingest. smithers-3f decides whether any guest fs caller remains and accepts the static-binary packaging seam with T-INS-01. No public API or privilege seam changes without the named owner’s acceptance.

## Security preconditions and root inputs

Repository commands, hooks, builds, jj and git execute only as unprivileged users inside machines (M-29, §17.3). The host verifies objects as data and never executes their contents. Only init and the narrow broker run as root. smithers-3f reviews the following inventory and the named C-COL-04 tests. Branch-built daemon/helper binaries, scripts, interpreters, imports and toolchains never run as root; a matching branch-supplied digest grants no trust.

- Plant/init/restart inputs: daemon/helper bytes, expected manifest hashes, fixed destination/unit/argv, interpreter/base executables, PATH and startup environment come from approved main and the install-controlled bundle (T-INS-01, T-SEC-01). Machine/branch/boot IDs, relay port/endpoints, machine credential and relay secret come from authenticated host DB/runtime state generated by main code, not branch fields. The base image selection is main-pinned; retained filesystem entries, parent/leaf symlinks, unit files, executable/import search paths and image contents can be branch/member influenced. `TestMachinedRootPlantInputs` drives fresh and retained production startup with substituted binary/unit/parents/environment and races; require main-pinned bytes and protected no-follow descriptors before root use, no root canary execution, secrets mode 0400 readable only by machined, and no ready state on refusal. Positive control starts the approved bundle. Check: C-COL-04.
- Broker startup/identity/cgroup inputs: broker code, fixed account IDs/ranges, socketpair descriptors, cgroup root and secret/environment destinations come from approved main/bundle; login/UID/GID/group bindings and boot/session/run mappings come from authenticated host DB allocations. Retained passwd/group records, filesystem metadata and cgroup entries, plus request sizes/signals/session selectors, are branch/member-influenced state or data. `TestMachinedRootBrokerInputs` uses production host RPC dispatch to prove bounded envelopes, fixed non-root identity, login/UID consistency, authenticated endpoints, cgroup-subtree/no-follow confinement and rejection of forged/malformed IDs before privileged effects. Observe dropped groups/GID/UID before executing payloads. Check: C-COL-04.
- Broker payload/environment/home inputs: argv, cwd, file paths/bytes, environment values and session traffic are branch/member sourced; per-boot secrets and injected environment values originate in host authority, while destination filesystem state can be branch/member sourced. Kernel process/cgroup/filesystem responses originate in the guest OS and are influenced by those processes. `TestMachinedRootBrokerInputs` proves root parses only the bounded privilege envelope; payloads and member home/token I/O are handled after UID/GID/group drop, cannot select privileged executable/import paths or other users, and cannot redirect root environment writes through symlinks. Invalid input produces no session, outside write or secret disclosure. Check: C-COL-04.

Any branch-sourced data consumed by root remains an activation blocker until its named validation test passes. Tests validate data; they never authorize branch-built root code.

## Ready checklist
1. Depends on lists called runtime/auth/live/candidate/file-schema/installer contracts and daemon/codec/testfake providers; T-COL-10 is S1 only. Scope names fail-closed dark behavior for each unavailable dependency and for bundle/image enablement.
2. Out explicitly excludes watcher/documents/presence, replacement transport, terminal/SSH protocol, identity allocation, image/bundle builds, sleep/admission/cleanup policy, UI Views and Cloud expansion; shared reporter callers still migrate.
3. Named tests enter the production router, runtime boot/relay and authenticated host dispatcher; literal fixtures and independent hashes define expectations. Real capture and pending-work checks replace reporter tests.
4. smithers-3f accepts Go/security/packaging seams, smithers-b8 signs off public route removal, and smithers-8a accepts ADR 0004 changes, table reservations and shared cutover order; topology stays with T-COL-11.
5. Owner pre-review, reviewed post hoc under the 2026-10-03 directive: smithers-3f answers: Does reused relay/installer plumbing enforce fresh and retained boot trust? Does capture commit objects/receipts/pending work before ack? Are all hosted callers migrated before reporter deletion? smithers-b8 answers: Can the head route/OpenAPI row be removed without a remaining public client? Does the file route preserve the S1 digest/refusal contract? No UI View or TypeScript library implementation changes are in scope.
6. M-29 confines repository execution to unprivileged machine users; each root step lists main/bundle/host versus branch/member inputs and C-COL-04 validation tests, reviewed by smithers-3f; missing validation fails closed.

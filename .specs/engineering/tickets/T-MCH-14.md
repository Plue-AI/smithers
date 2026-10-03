# T-MCH-14 Keep TODO workspaces until settled; wake before delivering a signal

Stage S1 · Size S · Depends on T-STK-01, T-INS-02, T-FLW-01 · Unblocks T-FLW-11, T-GH-04, T-GH-05, T-REL-02, T-STK-07 · Issue: [#3526](https://github.com/smithersai/smithers/issues/3526)
Spec: spec.md §8.4, §10.4.1, §10.7.4, §8.12 · Delta: delta.md §6 · Product: mvp.md J10.2, M-31
Ready: 2026-10-02 smithers-8a sha256:0b262f7780b5

## Goal
A TODO's working copy and its waiting `todo` run survive days in review, so a GitHub review steer resumes the same run on the same files.

## Scope
In:
- Per-TODO sequence/identity and wake-before-consumption for held/resumed inputs (§10.4.1, §10.7.3). Restore the same run and its next unfinished boundary; paused inputs stay durable until Resume. Model-active reservation reacquisition is T-FLW-11/§15.2's host gate. Checks: C-STK-03, C-STK-06.
- Workspaces bound to an unmerged TODO are exempt from the 5-minute agent idle stop while their run waits on a durable signal, and from the 24 h stopped-disk reclaim.
- They may still be suspended with the disk kept.
- A reopened TODO (§10.7.4) whose workspace cleanup removed gets a new one from the branch's final capture when its first input needs the run.
- Before the stack engine delivers a signal (steer, review comment, rebase, resume) to a run whose workspace is suspended, it wakes the workspace and waits for the coding host.

Out:
- Admission, positions and people-first ordering (T-MCH-06, S2).
- Capture-before-sleep and reads that never wake (T-MCH-07, S2).
- Full cleanup policy after settle (T-MCH-09, S2), terminal/service safe-idle scheduling and daemon outbox drain (T-MCH-07, S2). S1 must refuse disk deletion without a retained final capture; it does not claim the S2 cleanup policy has landed.

- Out of scope: GitHub comment polling (T-GH-04), reopen state/attempt decisions (T-GH-05, T-STK-05), the one-run composition (T-FLW-11), new signal engine APIs, host execution on wake, and disk deletion based only on age.
- Before reclaiming a settled TODO disk in S1, require `head_commit_id` to equal the pinned candidate and verify its retained host ref using the existing head report. S1 suspension has no final push (`services/workspace_lifecycle.go:1000`); do not assume it captures new work. A mismatched, missing or unverifiable head keeps the disk. Reopened work uses the retained capture. Checks: C-STK-05, C-J10-08.

## Changes
- Keep one pending-signal identity through wake and run_attached. Stop/terminal facts are re-read under lifecycle locking: terminal settlement cancels pending work, and paused work cannot dispatch before Resume. Deliver held resumed input at the next unfinished step boundary, before a new model turn, without repeating the original first step. Checks: C-STK-03, C-STK-06.
- Use §10.4.1's durable ordered batch and latest rebase target; finish required rebase before candidate or coding work. No additional host execution or in-memory signal path is added. Reacquire §15.2 run/call reservations before model work; budget denial parks the same run with the named owner. Checks: C-STK-06, C-SEC-02.
- `packages/backend/internal/services/agent_dispatch.go:760` (`createAgentWorkspaceVM`) and `:209` (workspace suspension cleanup) → keep the TODO workspace/session binding while its run waits, and suspend without deleting its disk. `:1128` sets the legacy sandbox timeout; native workspace mode returns at `:1126` and never reaches it. Do not implement the native retention fix only at that timeout.
- `packages/backend/internal/services/workspace_disk_reclaim.go:20` (`defaultAgentWorkspaceDiskReclaimAfter = 24h`) → skip workspaces whose TODO is unmerged (join through `todos.branch_id` and the lane binding).
- Stack engine delivery in `services/mythical_items.go` persists the pending signal identity and queues delivery durably. Wake belongs behind the existing `flowhost/resolver.go:291-302` start path (`packages/backend/flowhost/resolver.go`), where the launcher uses `workspace_runtime.go:141` to start the workspace and verifies the guest host before delivery. Do not add a second pre-delivery wake in `mythical_items.go`. Re-read settlement and binding under the lifecycle lock. Retry the same identity after restart; a wake failure retries with backoff and surfaces as `failed{step: "wake"}` after 15 min. T-FLW-11 consumes this seam. Check: C-STK-05.

- Audit every lane deletion in `services/mythical_items.go`: `advanceItems → releaseLane → retireLane → DeleteWorkspace` (`:1124-1160`, `:1182`, `:1576`, `:2677`), `review()` (`:2391`), `sweepLanes` (`:1118/:1597`) and `start` (`:1646`). A lane bound to an unmerged TODO suspends and retains disk and binding; none of these paths may delete it. Reclaim checks settlement, lane binding and the pinned candidate inside `reclaimAgentWorkspaceDisk`’s runtime lock (`workspace_disk_reclaim.go:55` claim/sweep boundary), after re-reading current rows. C-STK-05 exercises each deletion path and races settlement, reclaim and resume.

## Decisions and pre-review
- Before start, smithers-3f approves TODO/workspace binding, lifecycle locking, retained-capture recovery and signal deduplication, and reviews machine-only execution on wake. smithers-38 pre-reviews any TypeScript signal-call contract; reuse the existing engine API. smithers-8a accepts the delivery seam, 15-minute wake failure policy and reference-host disk-use result. Will decides changes to retention or reopen policy.
- T-INS-02 and T-FLW-01 supply microVM startup and guest coding dispatch. A missing runtime or guest host keeps the signal pending or records the typed wake failure; no host process runs the repository. Provider keys remain on the host. C-SEC-02 checks that boundary. T-FLW-11 depends on this ticket, so tests here drive the production engine delivery seam with a fixture run, without depending on the future composition.

## Tests
- FLW11 QA G02/G05/G19 (I25/I40/F30/K16/K17): on the reference host restart 50 held TODO runs; restore all waits within 60 s of backend/PG readiness. No idle model calls, run-side GitHub reads or polling timer. Stagger machine grants, deliver each queued input once within 60 s of guest run_attached, and report capacity queue/wake times separately. A resumed third step consumes held steer before model_turn_started; first two steps remain finished. Check: C-STK-06.
- FLW11 QA G19/R60: unavailable guest reaches the distinct 15-minute failed{step: wake} policy without host fallback; outage delays do not extend it. Held/paused/person-waiting runs have no unused 60M reservation after calls settle; wake denial projects owner-named budget pause and retains inputs. Terminal settlement while waking consumes no input and cannot revive the run. Checks: C-STK-06, C-SEC-02.
- Integration (real microVM): a TODO in review suspends after idle. A steer delivered 25 h later (simulated clock) wakes it, the same run id resumes, and the working copy holds the files from before.
- Integration: drive the composed reclaim job with its injected clock; it skips an unmerged TODO, keeps a dropped disk without a final capture, and reclaims a dropped disk only with a retained final capture and no active terminal/service. Drive work input through the production delivery seam to verify provisioning from that capture. C-J10-08 later adds the real GitHub reopen and new-attempt path.
- Fault: kill the host while a wake for a signal is in progress. On restart the signal is delivered exactly once.

- Boundary integration in `packages/backend/internal/services/todo_long_wait_integration_test.go` (C-STK-05): run a fixture on the production guest dispatcher, advance the composed lifecycle/reclaim jobs, and deliver a durable input through the stack engine delivery seam, not by calling runtime wake or Signal directly. Assert fixed file contents, run identity and one consumed signal across a host restart. Once T-GH-04 and T-FLW-11 land, also run C-STK-05's GitHub review-comment poll and same-run loop. Use literal reviewed fixtures; no runtime spec reads or implementation-derived expectations. Joint reopen acceptance C-J10-08 remains pending until T-GH-05 and T-STK-05 land.

- C-STK-05 covers every lane retirement caller, a stale sweep list followed by resume, and a settlement race inside the lock. An unmerged TODO always keeps disk and binding. A settled TODO with a head different from its pinned candidate keeps the disk; only a matching retained head permits reclaim. Assert one resolver start and one consumed durable signal across restart.

## Acceptance
- [C-STK-06](../checks/C-STK-06.md): 50-wait restart and delivery timing pass jointly with T-FLW-11; report queue time separately from wake and attached delivery.
- [C-STK-03](../checks/C-STK-03.md): wake and attachment restore the existing run's next boundary without repeating finished steps.
- [C-SEC-02](../checks/C-SEC-02.md): failed wake never dispatches repository work on the host.



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-STK-05](../checks/C-STK-05.md)
- [C-J10-08](../checks/C-J10-08.md): the reclaimed-then-reopened step.

## Risks and notes
- Risk: many waiting TODOs keep suspended disks. Confirm disk use with 20 suspended TODO workspaces on the reference host. The 32 GiB disk per machine is sparse (APFS clone), and the layer budget (§8.2.1) bounds the rest.

## Ready checklist
1. Dependencies: T-STK-01 supplies TODO bindings; T-INS-02 and T-FLW-01 supply safe guest startup/dispatch. The delivery seam lands here; downstream flow, review and reopen owners integrate it later.
2. Exclusions: admission, full S2 sleep/cleanup, GitHub polling, reopen transitions, flow composition, new engine APIs and age-only deletion are explicit; missing final capture keeps the disk.
3. Tests: production guest dispatch, composed lifecycle jobs and stack delivery use fixed fixtures; fault recovery consumes one signal. GitHub/reopen joint checks remain pending until integrated.
4. Decisions: smithers-3f approves lifecycle/recovery seams, smithers-38 library contracts, smithers-8a delivery/failure policy and disk result; Will changes product retention/reopen policy.
5. Owner pre-review: smithers-3f: Answered at 2026-10-02 23:39 UTC; tech lead ADOPTS suspension at every lane deletion path, pinned-head reclaim and settlement checks inside the lock. smithers-38: Answered at 2026-10-02 23:39 UTC; tech lead ADOPTS wake behind the existing resolver start with no second pre-delivery wake.
6. Root-input inventory: wake/reprovision repeats R1–R5 bootstrap/setup/cgroup/bridge/layer/artifact operations. Inputs are install-controlled lifecycle/binding/settlement/signal identities, sizing/clocks/retained refs and packaged helper/catalog/artifact code; branch final capture/tree, target index/tool/version declarations/manifests/archive and member-modified home/cache/env.json/guest paths; main-pinned machine.json; and upstream OCI/tool/apt/GitHub responses. Home account metadata and every chown/chmod/write parent/leaf are inputs, even on a retained disk. GitHub/member steer payloads remain data and execute after UID drop. Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `TestRootManagedArtifactInstallUsesApprovedBundleOnly` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

### Criterion 6 root-input inventory

The following audited inputs include hostile refusal fixtures. They do not authorize branch-built bytes at root. The adopted source restrictions above govern accepted inputs.

#### R1

Inputs:

- Helper bytes and expected digest, fixed `/opt/smithers/guest` destination and install script — **main**, embedded into the **install-controlled** backend.
- `msb` executable/path, host child environment/PATH/HOME, machine identifier, deadlines — **install-controlled** runtime configuration/state; executable provenance must remain bundle-controlled.
- Guest image or layer/snapshot, `/bin/sh`, `python3`, `sha256sum`, `cut`, `mkdir`, `cat`, `mv`, executable search paths, Python startup/import paths and existing helper/temporary-file/parent entries — **install-controlled** base; snapshots/cache/environment can contain **branch-derived** and **member-controlled** entries. Digest comparison alone does not validate parent ownership, symlinks, interpreter provenance or startup imports.
- OCI image pull/metadata/blob responses — **install-controlled** pinned image selection, upstream registry responses; retained snapshot data — **install-controlled** state with **branch/member-derived** contents where applicable.

#### R2

Inputs:

- Setup argv (login, UID, directories), fixed HOME_LINKS/GO_SETTINGS, helper source — **main** constants today; future member login/UID bindings — **install-controlled** DB allocations derived from **GitHub/member** identities, not arbitrary user argv.
- `/etc/passwd`/group account entries, `useradd`, shell, existing home path and account UID/GID — **install-controlled** image/account state.
- `/opt/smithers/env.json`: all keys/values, including PATH, PYTHONPATH, Go settings, tool-cache targets — generated from **main** code and **branch-derived** toolchain selection; file ownership and immutability are separate inputs.
- `/var/cache/smithers/home` names/entries, cache directories, existing `.cache`, `.config`, `.config/go`, `.config/go/env`, all ancestor/leaf symlinks and directory metadata — **branch-derived** dependency output and **member-controlled** retained home state.
- Kernel/filesystem responses to mkdir/stat/open/chown/chmod and symlink operations — **install-controlled** guest OS; which object they address can be **member-controlled**.

#### R3

Inputs:

- JSON request id, argv, env, cwd, root, user and stdin mode; operation/path/content/mode/read limit for fs — **main/install-controlled** envelope and fixed identity fields, with **branch/member-controlled** argv, environment values, relative paths, file bytes and existing symlink graph. Capture metadata and command results are **branch/member-controlled** outputs.
- `/opt/smithers/env.json`, helper/interpreter startup environment, passwd/group records and guest directory state — sources as R1/R2.
- Host-generated exec IDs; kill/kill-all names, child directories, cgroup.procs/kill/events and their observed state — **main/install-controlled** IDs and kernel cgroup state; a guest command influences process population. Any selectable path/name must be validated against the fixed subtree.
- Relay/probe port, fixed host.microsandbox.internal bridge destination, ws relay-port metadata — **main/install-controlled**; bytes flowing over relay/TCP and associated peer responses — **member/branch-controlled** or authenticated host data, depending on channel.
- Fork/wait/signal/exit observations, filesystem resolution and network responses — **install-controlled** kernel responses influenced by member processes/network traffic.

#### R4

Inputs by privileged substep:

- Prepare boot/bootstrap: base OCI image, parent/newest same-family snapshot, owner/holder/repository/name/key labels, CPU/memory/disk/timeout/budget, net-rule allowlist — **install-controlled** configuration/state; recipe key, network destinations and selected tools are **branch-derived**. Image and snapshot contents include upstream OS and prior **branch-derived** outputs. R1/R2 also apply.
- Toolchain root recipe: `.smithers/target-index.json` Environment.Toolchain download versions/URLs/SHA256, Rust channel/components/targets, PostgreSQL major, destinations; or detected language/version evidence from repository manifests and version files — **branch**. Bundled `toolchains.json`, detector and script templates — **main/install-controlled**. `.smithers/machine.json` package additions — **main**, explicitly pinned by resolver. Downloads/archive entries/install scripts/tool `--version` output, Rust dist metadata/artifacts, apt package indexes/packages/maintainer scripts and PGDG key — upstream network responses, **branch-selected** for indexed download URLs/pins, otherwise **install-controlled** approved upstreams. GitHub-hosted release responses are **GitHub**, selected by the branch where index supplies the URL. `/etc/os-release`, apt sources/keyrings, root temp dirs and existing executable/filesystem state — **install-controlled** image/snapshot, including prior branch outputs. Every env.json key/value and root subprocess environment is consumed; fixed overrides are HOME=/root, TMPDIR=/var/tmp, DEBIAN_FRONTEND=noninteractive, system PATH, empty PYTHONPATH; other base_environment values remain inputs.
- Root input plant: all declared input path names and bytes (package/lock/workspace manifests, Go/Cargo inputs, selected tool entry/source files, dprint config, Python/requirements/pyproject inputs as selected by recipe); `tarFiles` regular-entry metadata, generated tar bytes; fixed destination/cache path and UID/GID, existing prepare directory/ancestors — **branch** files/names, **main** tar construction/script/UID, **install-controlled** snapshot paths with prior **branch-derived** cache content. This root step consumes file bytes even though later dependency installers run as agent.
- Root browser system install: Playwright selection/version triggering shipped apt script — **branch**; fixed package argv — **main**; apt sources/signatures/indexes/packages/scripts — **install-controlled** image/upstream network. It is separate from the unprivileged browser installer.
- Marker/sync and offline verification: serialized schema/kind/key/name/parent/repository/inventory/creation record, marker path, existing marker/temp/parent files and snapshot — **install-controlled** record with **branch-derived** recipe identity and output; script/destination — **main**. Reading a matching marker verifies identity, not trust of all layer contents.

#### R5

Inputs: artifact source path/bytes, artifact mapping, executable and env-value paths, helper bytes/digest — **install-controlled** bundle/catalog; existing guest destination/parents — **install-controlled** filesystem, potentially **member-controlled** if writable. Coding binding workspace/actor/repository IDs, repository slug, API/git URLs, fixed workspace/user/socket/version — **install-controlled** server authority, with **GitHub/member-derived** identity/slug data. Destination files, owners/modes/symlinks and helper-check response — guest filesystem/response. Root script/helper/interpreter — **main/install-controlled** plus R1 startup inputs.

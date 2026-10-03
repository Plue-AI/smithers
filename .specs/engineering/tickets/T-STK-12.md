# T-STK-12 Candidate generations: capture, propose receipts, pending work, the item's prefix

Stage S1 · Size M · Depends on T-STK-01, T-INS-02, T-FLW-01 · Unblocks T-APP-17, T-FLW-11, T-GH-03, T-GH-09, T-MCH-08, T-REL-02, T-STK-02, T-STK-04, T-STK-06, T-STK-08 · Issue: [#3533](https://github.com/smithersai/smithers/issues/3533)
Spec: spec.md §4.1 (`working → in_review`, `in_review → in_review`), §10.3.2, §10.4.1, §10.4.3, §10.4.4, §10.4.5, §10.5.3 · Delta: delta.md §6 (one `todo` run per attempt; PRs stay based on `main` as verified candidates) · Product: mvp.md §4.2 Merging ("Each PR is the verified candidate for its item") and Rebase ("checks rerun"), §6.10 PR card, Appendix B.5 (Stack: integrate, Stack: propose)
Ready: 2026-10-02 smithers-8a sha256:360b10e80c07

## Goal
Every PR head Smithers writes has the exact tree of a persisted accepted generation. GitHub may show the previous accepted head while newer work is checked or its push settles. An edit, a steer, an amendment or a base move after the capture yields a new generation before anything is proposed, and a new item starts on whatever verified prefix exists.

## Scope
In:
- Durable capture invocation keys and acceptance receipts under §10.4.4. Authorize the current live run binding server-side before any receipt read; replay returns its original generation/head/status without capture, fresh validation or new outbound decisions. Checks: C-STK-06, C-SEC-02.
- Main-pinned outsider protected-path checks and the Drop terminal fence under §17.5 and §10.7.2. Maintainer admission retains outsider provenance; unreadable policy cannot publish. Checks: C-STK-06, C-SEC-02.
- The generation record on the engine's work record: today's `mythical_items.generation`, `candidate_base`, `candidate_head`, `candidate_verified` and `pr_head`, plus `candidate_inputs_seq` (§10.4.4).
- `stack.candidate`: refuse with `rebase_pending` off the prefix; capture; write the one commit from the captured tree on the prefix head; pin it; record generation g.
- `stack.propose`: the second capture and the five acceptance rules of §10.4.4; the refusals `stale_generation`, `edited`, `stale_inputs` and `rebase_pending`; on acceptance, today's propose path (pin, record, push with lease, open or update the PR).
- The item's prefix (§10.3.2) for admission and for `stack.candidate`, and `rebase_pending{onto}` for later items when an earlier item's verified head changes.
- Pending work (§10.4.5): compare each later capture's tree with the accepted generation's tree and signal `edited`.
- The `generation` tag on every evidence part. This ticket owns the minimal generation field and validation needed by the handshake; T-STK-10 adopts it when building full attempt evidence. T-STK-10 depends transitively on this ticket and is not a prerequisite.
- S1 captures from the workspace: a jj snapshot and the head push that `workspace_head.go` already makes.

Out:
- The `todo` flow's `candidate`, `check` and `review` steps and the run's signal loop (T-FLW-11).
- `MergeReady`, GitHub squash dispatch and merge reconciliation belong to T-STK-04. Shared fence primitives are in scope here (C-STK-07).
- The daemon's `capture()` (T-COL-03). S2 swaps the capture source, not the rules.
- Presence-aware rebase scheduling (T-STK-11) and conflict handling (T-STK-08).

- Out of scope: full evidence presentation (T-STK-10), new retry caps, detecting edits reverted before capture, rewriting working-copy history, new flow-engine APIs, and host execution of repository hooks or checks.

## Changes
- Persist each candidate invocation identity before guest capture. Same-key replay returns its old generation after newer captures; unchanged (base, tree, inputs_seq) may reuse the current generation, while a changed base or consumed input always creates a new one. Reuse cannot clear later verification. Keep actor-scoped canonical request mismatch refusal. Check: C-STK-06.
- Bind admission atomically to install, repository, TODO, attempt, run, branch and workspace. Both reserved Action.make tags resolve this binding from the authenticated run/machine credential and reject wrong or stale bindings, draft runs and public/session/delegated callers before capture or receipt lookup. Repository capture, checks and review execute in the guest; only packaged object handling runs on the host. Checks: C-STK-06, C-SEC-02.
- Look up accepted (todo_id, attempt_id, generation_id) after authentication and before any fresh Propose capture or validation. Return the immutable acceptance receipt and recorded outbound status after g2 exists without restoring g1, creating an intent or rolling verification back; T-GH-09 reconciles existing intents. Check: C-STK-06.
- Serialize Drop and fresh proposal acceptance with the shared TODO fence. Persist a close-after-reconcile obligation keyed to Drop even before PR number discovery; T-GH-09 resolves pending/unknown proposal effects and dependent closure. Do not archive or clean up until reconciliation and retained final capture permit it. Check: C-STK-06.
- Implement the approved candidate-generation rules (§10.3.2a, §10.4.4a–e, §10.4.5, §10.4.5a, §10.5.3a, §10.6.2b, §12.5.1a) as pure `NextGeneration`, `DecideCandidate`, `DecidePropose`, `SelectPrefix`, `RebaseFanout` and `PendingWork` decisions over supplied facts. Adapters own capture, locking, persistence and outbound effects. Evaluate replay receipts before fresh-call decisions under §6.2.1 and the existing Propose receipt contract. Persist the immutable included-items manifest and main base, last accepted pointer, intended and settled PR heads, acknowledged input prefix, capture epoch/sequence and prior ordered capture tree. Checks: C-STK-06, C-STK-07.
- Capture before and after each machine check. A changed tree fails visibly with `check_modified_tree` and changed paths; preserve files and stop automatic repropose cycling. Apply formatting or generation in implement before Candidate, then verify without write modes. Flow composition consumes this failure in T-FLW-11; C-STK-06 tests the fixture dispatcher and C-J1-04 completes the built-in run integration.
- `packages/backend/db/product/migrations/01xx_todo_merge_fence.sql` → `todos.merging jsonb`; `packages/backend/internal/services/stack_lock.go` → `LockStack(tx)` (stack row, then TODO rows) and `FenceSet(tx, todo)`. Every stack mutation shares this seam.
- Implement §10.6.2b's held-signal delivery: steers and review comments commit durably while fenced; release them once if the fence clears without merge, and keep them undelivered after merge. Placements and amends return `409 merging`; rebase and propose defer. T-STK-04 owns setting and reconciling the marker around GitHub dispatch. Check: C-STK-07.
- `packages/backend/db/product/migrations/01xx_candidate_inputs.sql` (new) → `mythical_items.candidate_inputs_seq bigint NOT NULL DEFAULT 0`.
- `packages/backend/internal/services/todo_candidate.go` (new) → `Candidate(todo, inputsSeq) (Generation, error)` and `Propose(todo, generation, evidence) error`, each in one transaction inside the stack claim. The S1 capture runs `jj` in the TODO's workspace and fetches the commit. The candidate commit is written like today's PR head commit (`writeCommit`, `mythical_items.go:2029`), with the prefix head as its parent, and pinned with `pin` before the generation row commits.
- `packages/backend/internal/services/mythical_items.go` → `start` (`:1665`) launches from the item's prefix instead of `r.row.TipCommit`; `propose` (`:1951`) runs only after `Propose` accepts, keeping its pin → record → push order; the `CandidateVerified` reset at `:1901` moves into `Candidate`.
- `packages/backend/internal/routes/workspace_head.go` (`ReportWorkspaceHead`, `:49`) → after recording a head for an item branch whose TODO is `in_review`, compare its tree with the accepted generation's tree and use engine-issued capture epochs and sequences in every state, and signal `edited` only for eligible ordered in_review transitions (§10.4.5).
- `stack.candidate` and `stack.propose` are system operations with Appendix C rows that land in this change. They have no slash, CLI or agent door and are absent from `/help`. T-ACC-03's route→action table admits only run and machine credentials for them. Refusals use named codes `stale_generation`, `edited`, `stale_inputs` and `rebase_pending`, all class `conflict`; `rebase_pending` carries `onto`, the required prefix head. Checks: C-STK-06, C-ACC-01, C-CAT-01.
- `packages/backend/docs/todos.md` (new; absent today) → generations, refusals and pending work; docs gates.

- `Candidate` and `Propose` enter through the stack worker’s `runClaimed` seam (`services/mythical.go`, claim loop near `:168`, current function near `:224`). Queue a keyed operation for the owning stack claim; do not acquire a second independent claim or recursively claim inside the worker. Keep the stack-then-TODO transaction lock and pin-before-record order. C-STK-07 races dispatcher operations against normal stack mutations.

## Decisions and pre-review
- Before start, smithers-3f approves the capture, stack-claim and outbound-write seams and reviews isolation. smithers-b8 approves any public command binding; smithers-38 approves any Flow.make or TypeScript library contract. smithers-8a accepts those seams and has approved S13: tree-writing checks fail visibly; formatting precedes Candidate. Will alone changes the accepted reverted-edit limit.
- T-INS-02 and T-FLW-01 must land before capture is enabled: execute the workspace snapshot and all repository checks inside its machine, refuse an unavailable guest, and keep keys on the host. Host commit-object reads and writes use packaged code and must not invoke repository hooks, filters or configuration-driven executables. C-SEC-02 supplies the isolation check.
- This ticket supplies the shared stack lock and fence before T-STK-04 lands. Preserve the existing stack claim's serialization; T-STK-04 and T-STK-06 consume the same seam (C-STK-07).

- T-STK-12 supplies the production system-operation dispatcher used by its fixture run. Register `stack.candidate` and `stack.propose` as reserved `Action.make` tags over `NativeCoding`, following `flows/coding/stack.ts:14-34`, never as `Flow.make` registrations (§10.4.1). T-FLW-11 consumes that dispatcher and supplies the built-in composition. C-STK-06 exercises both Action tags through the production dispatcher.
- S1 snapshots use `WorkspaceService.runtimeRepositoryCommandOutput` and the guest repository-command seam in `services/workspace_repository.go:301-320`; snapshot and report the resulting head inside the machine. Harden the host object-transfer subprocess environment in `services/github_import.go:2684` using `repository_source_retention.go:368`: a minimal environment, no system/global config, disabled hooks and credential helpers, fixed allowed protocols and redirects, and environment-only credentials. Do not execute configuration-selected filters or helpers. C-SEC-02 injects hostile repository configuration and checks zero host effects; C-STK-06 verifies the captured tree.

## Tests
- FLW11 QA G04/G23 (I15/K7/F17/F19/K13–K15): crash before/after candidate and acceptance commit, replay g1 after g2, compare literal receipt/head/key identities and count zero new snapshots, pins or intents. Unaccepted old generation remains stale_generation; stale credentials cannot read either receipt. Check: C-STK-06.
- FLW11 QA G07/R39 (I14/I15/I52/I33): wrong TODO/attempt/machine/install/repository/branch and draft/session/delegated/unbound callers refuse at production dispatch. For an admitted outsider, policy comes from current trusted main, not the candidate; protected change returns policy/protected_paths, unreadable policy has no acceptance/push/PR, insider control succeeds, egress stays restricted. Checks: C-STK-06, C-SEC-02.
- FLW11 QA G03/G22 (K18/K23/F17/F19): Stop at capture, acceptance and push boundaries settles one operation receipt before pause. Drop before/after acceptance and held PR-create response records one close-after-reconcile obligation. Unknown sent writes reconcile first; unsent superseded writes never dispatch; final state has no open PR from that dropped decision. Terminal merge wins over pause. Check: C-STK-06.
- Approved S1 (C-STK-06): TC-02 / P-G1a–c / P-G6: T1 and T3 accepted, T2 unverified yields T4 includes T1,T3,T4 only; after T2 acceptance and rebases, each change appears once..
- Approved S2 (C-STK-06, C-STK-07): TC-12 / U-X / U-R: after T2 accepts g1 then captures g2, T3 still selects g1; T2 Merge is rechecking; accepting g2 fans out. Obsolete g1 is skipped rather than used..
- Approved S3 (C-STK-06): U-P / I-19 / P-G5: stale inputs + changed tree yields stale_inputs; pending rebase + stale main yields rebase_pending; wrong/missing evidence yields invalid_evidence; explicit zero checks yields eligible; closed item yields todo_closed; refusal leaves durable/outbound state unchanged..
- Approved S7 (C-STK-06): TC-04 / P-G1b / P-G3: fork keeps dropped bytes, dropped item absent from manifest/state merged; TthenX1thenX1thenTthenX1 yields 2 signals..
- Approved S9 (C-STK-06, C-STK-07): F-16 / C-STK-07 race: fence + Candidate yields no snapshot, pin, row or verification change; merge succeeds yields delayed call todo_closed; definitive refusal yields capture may proceed after release..
- Approved S10 (C-STK-06): F-04 / U-G / I-03: same key yields same g and no second effects; new key with identical (base, tree, inputs_seq) may reuse current g; changed base/input yields g+1; attempt restart alone yields same counter; mismatched key yields idempotency_mismatch..
- Approved S11 (C-STK-06, C-STK-07): U-C / U-P boundary rows: negative, future, unacknowledged, non-input, regressing yields invalid_inputs_seq; valid 0 baseline passes; later run answer yields stale_inputs; other-item amendment yields no input-cursor failure, normal rebase rules apply..
- Approved S12 (C-STK-06, C-STK-07): I-27–32 / F-14 / P-G3: in_review differs yields one signal; working differs yields stored, no signal; seq12 X then seq11 T yields newest X and merge held; same seq/tree yields no effect; same seq/different tree or missing ordering yields refusal..
- Approved S13 (C-STK-06): C-STK-06 / C-J1-04 new fixture: check writes tracked file yields failed check, bytes preserved, zero acceptance/push, no autonomous retry cycle; pre-capture formatting + read-only check yields accept..
- Approved S14 (C-STK-06, C-STK-07): F-06–10 / P-G4 corrected row: GitHub H1 during pending H2 is valid; every outgoing head maps to an accepted tree; external H1 merge projects merged after main contains commit, uses H1 manifest, preserves unlanded edits..
- Approved S15 (C-STK-06): TC-15 / P-G5 new rows: own delta empty, even with nonempty prefix yields empty_change, g unchanged, no PR; flow opens one question wait; answer resumes implement; item never auto-merged..
- Approved S16 (C-STK-06, C-STK-07): TC-05 / TC-07 / U-G / C-STK-06 D6: same T, changed base, nonempty own delta yields g+1, fresh checks tagged g+1, old approval void; equal patch-id permits review reuse only..
- Integration, real PostgreSQL, `stack_lock_db_test.go` (C-STK-07): concurrent writers serialize in stack-then-TODO order; fenced placements/amends refuse; steers commit but do not signal. Clearing without merge releases each keyed signal once; a merged TODO never releases it. Full GitHub merge races complete with T-STK-04.
- Unit, `todo_candidate_test.go` (new): the acceptance table. Each of the five rules fails alone and yields its reason with no write. Prefix selection for: no earlier item verified; N−1 verified; N−2 verified and N−1 not; the first item.
- Integration with real PostgreSQL and a real jj working copy, `todo_candidate_db_test.go` (new): `Candidate` writes one commit with the captured tree on the prefix head and pins it. An edit after `Candidate` makes `Propose` refuse `edited`. An edit injected between the snapshot and the generation write lands in the next generation, not this one. A steer event above `inputs_seq` refuses `stale_inputs`. An unaccepted old generation refuses stale_generation with no GitHub write. An accepted old generation returns its existing receipt after a newer generation exists, with no capture, new intent or rollback.
- Integration, same file: after acceptance, a head report with a different tree signals `edited` once; a report with the same tree signals nothing.
- Integration, same file: with T1 still planning, T2 starts on `main`'s tip; T1's acceptance writes T2's `rebase_pending{onto: T1's verified head}`.

- Boundary integration in `packages/backend/internal/services/todo_candidate_flow_db_test.go` (new, C-STK-06): drive `stack.candidate` and `stack.propose` through the production system-operation dispatcher from a fixture run on a real microVM with real PostgreSQL and fake GitHub. Send pending-work reports through `POST /api/repos/{owner}/{repo}/workspaces/{id}/head` on the composed router. Do not call Candidate or Propose directly as acceptance. Use fixed refusal cases and fixture file bytes; compare observed check digests and PR trees, without loading spec files or deriving expected refusals from implementation code. Assert literal code/class pairs for all four refusals and `onto` for `rebase_pending`. Verify the system-operation descriptors and absence of slash, CLI, agent and `/help` doors; C-ACC-01 proves only run/machine admission. Checks: C-STK-06, C-ACC-01, C-CAT-01.
- The fixture run proves the system-operation boundary here; C-STK-06's built-in TODO loop, steer routing and rebase orchestration complete with T-FLW-11 and their owning tickets. A pending integration is never counted as a pass.

## Acceptance
- [C-SEC-02](../checks/C-SEC-02.md): production operation binding and guest capture reject host repository execution.
- [C-STK-07](../checks/C-STK-07.md): shared lock, fence refusal and held-signal rows pass here; merge-dispatch races complete with T-STK-04.
- [C-STK-06](../checks/C-STK-06.md): the PR head's tree is the tree checks ran on; a new item starts on the available prefix. Its run-side parts also need T-FLW-11.
- [C-J1-04](../checks/C-J1-04.md): First TODO to merged PR, unassisted, within 60 minutes of starting the install

## Risks and notes
- May start now against T-STK-01's final migration contract with test-only schema fixtures. Land after T-STK-01 and the other listed dependencies. C-STK-06 and C-STK-07 use real migrated PostgreSQL before acceptance.
- Approved S13 policy: a repository check that changes the captured tree fails visibly with `check_modified_tree` and changed paths. Preserve the resulting files and stop automatic repropose cycling. Formatting and generation belong in implement before Candidate; checks then run without write modes. T-FLW-11 owns the aggregate §10.4.1b proposal-cycle cap; this ticket adds no retry counter or reverted-edit detection. Check: C-STK-06.
- Risk: the S1 capture through the workspace adds a snapshot to every `Candidate` and `Propose`. Observation: `Propose` p95 over 2 s on the smithers repository. T-COL-01 measures snapshot latency (target 500 ms).
- Decision not to make alone: detecting an edit reverted inside the window. §10.4.4 accepts it as a limit.

## Ready checklist
1. Dependencies: T-STK-01 supplies TODO/events; T-INS-02 and T-FLW-01 supply safe machine execution. This ticket supplies minimal evidence generation fields and uses the existing stack claim.
2. Exclusions: full evidence UI, flow loop, merge dispatch/reconciliation, daemon capture, presence scheduling, retry caps and reverted-edit detection are explicit.
3. Tests: C-STK-06 exercises the production system dispatcher and head-report route with fixed fixtures on a real machine; later run-loop assertions stay pending until integrated.
4. Decisions: smithers-3f approves backend seams, smithers-b8 public bindings, smithers-38 library contracts; smithers-8a approved S13 failure policy; Will changes product limits.
5. Owner pre-review: smithers-3f: Answered at 2026-10-02 23:39 UTC; ok, tech lead ADOPTS explicit runClaimed entry, guest snapshot seam and hardened host transfer configuration. smithers-b8: Answered at 17:05 with these changes: system-only bindings, no public doors and conflict refusal envelopes. smithers-38: Answered at 2026-10-02 23:39 UTC; tech lead ADOPTS Action.make tags over NativeCoding; T-STK-12 supplies the production system-operation dispatcher.
6. Root-input inventory: Candidate/Propose repository capture/check payloads run as agent; root helper bootstrap/setup, request/cgroup processing, layer preparation and packaged coding-host/helper installation consume R1–R5. Inputs are shipped helper/scripts/catalog/artifacts and fixed paths/UID (main/install-controlled); authenticated workspace/run/attempt/generation/binding and DB/lifecycle state (install-controlled); branch capture tree, config/instructions, check argv/env/cwd/results, target index/tool pins, manifests/declared files and archive (branch/member-controlled); existing home/cache/guest destination paths (member/branch-derived); machine.json and outsider policy (main-pinned); image/tool/apt/network responses (install-controlled approved upstream or branch-selected, including GitHub). Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `TestRootManagedArtifactInstallUsesApprovedBundleOnly` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

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

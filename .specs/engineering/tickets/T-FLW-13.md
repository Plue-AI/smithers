# T-FLW-13 Review a member's PR in a background machine

Stage S1 · Size M · Depends on T-FLW-01, T-FLW-03, T-FLW-04, T-ACC-02, T-ACC-03 (Authorize), T-APP-04 (confirmations), T-APP-16, T-CAT-01 · Unblocks T-MNT-04, T-REL-02 · Issue: [#3612](https://github.com/smithersai/smithers/issues/3612)
Spec: spec.md §11.1, §12.3, §15.1.5, §17.5 · Delta: delta.md §8 (row 1) · Product: mvp.md §6.3 "A teammate pushes their own branch or opens their own PR", §8, Appendix A `/review`
Ready: 2026-10-03 smithers-8a sha256:0b98e0fee592

## Goal

Run the Active `review` flow on a member's PR in an ephemeral background machine at the PR head, return findings to the requester, and make no GitHub write.

## Scope

In:
- Build against the specified contracts and land dark when an integration is unavailable. Lands dark until T-FLW-01: refuse review dispatch without machine-only flow binding. Lands dark until T-FLW-03: refuse without an Active `(source_commit, digest)`. Lands dark until T-FLW-04: refuse unavailable or mismatched pinned source before repository import. Lands dark until T-ACC-02: refuse when active membership cannot be resolved. Lands dark until T-ACC-03: refuse without the bound Authorize decision. Lands dark until T-APP-04: delegated requests refuse without the requesting person's confirmation. Lands dark until T-APP-16: refuse without host dispatch and findings delivery. Lands dark until T-CAT-01: refuse unresolved command/actor policy through app and CLI doors. No refusal allocates a machine or falls back to browser working-copy execution. Check: C-J10-09, C-ACC-02.
- Lands dark until T-INS-02: refuse review launch without the bundled microVM runtime. Lands dark until T-SEC-01: refuse review launch until the shared guest root-input boundary passes its named C-SEC-02 tests. These enablement gates add no dependency edge. Check: C-J10-09, C-SEC-02.
- `/review <pr>` uses the Active `review` closure in an ephemeral background machine at the selected PR head, returns findings to the requester's conversation and writes nothing to GitHub. It creates no TODO, persistent branch or stack item. Check: C-J10-09 S1 steps 1–3.
- Check the PR author's active membership before requesting a machine. A non-member's PR returns class `permission`; outsider text never admits work on its own. Check: C-J10-09 step 5.
- App-agent and external-agent review requests follow the catalog's `confirm` policy and start only after the requesting person's session approves. Check: C-J10-09 step 4, C-ACC-02.

Out:
- Flow catalog/reserved names and baseline host isolation (T-FLW-01), activation (T-FLW-03) and the shared closure restore mechanism (T-FLW-04).
- S2 admission ordering/capacity (T-MCH-06); S1 uses the existing isolated runtime and typed capacity refusal.
- Non-member PR review, automatic review on GitHub events, GitHub comments/reviews/status writes, TODO creation, using a TODO's machine, Open on a machine, new findings-card visuals, closure archives, dependency-environment packaging and new root provisioning or privileged review code.

## Changes

- Reuse the production command dispatcher and T-ACC-03's bound `Authorize(credential, command, subject)` decision. The review dispatcher checks that the PR author is a member and refuses a non-member's PR with class `permission` before requesting a machine. Check: C-J10-09 step 5.
- `apps/app/src/mainview/flows/entries/prs.ts:81-90` (`prs.triage`, renamed `/review`) and `apps/app/src/mainview/state/controller/issueFlows.ts:91-110` are the existing door, which launches `pr-triage` today. Wire the door to the host's authorized review dispatcher, not the browser's old working-copy launch. Pin the Active `review` source commit/digest and selected GitHub PR head on admission; reuse the pinned source loader and digest verification through T-FLW-03/T-FLW-04, without a closure archive or dependency-environment package, in a fresh ephemeral machine through `packages/backend/flowhost/workspace_launcher.go:24-35`. Deliver findings using the retained `change` card schema (`packages/rpc/src/Changes.ts`) and shared conversation projection (T-APP-16). Check: C-J10-09 steps 1–3.
- Route an app-agent review request through the person's Confirm card before starting the run (§15.1.5). Check: C-J10-09 step 4.
- C-J10-09 already names this ticket for S1. T-MCH-06 retains S2 capacity ownership; no check-header or other index-row edit is needed.

## Tests

- Boundary integration, extend `packages/backend/internal/compose/flow_admission_integration_test.go` and reuse its PostgreSQL/dispatcher harness: run `/review` through the production catalog/API dispatcher on the install composition with real PostgreSQL and fake GitHub. Test each unavailable contract and enablement gate listed in Scope with zero allocation and no fallback; test person dispatch, eligible delegated confirmation, another person's approval, revoked membership, repeated idempotency keys and non-member PR refusal before any runtime allocation. Extend `packages/backend/internal/compose/flow_isolation_microvm_integration_test.go` for the production review door; its existing discovery-only canary does not qualify. Use C-J10-09's reference-host real-microVM variant for head/digest, findings and zero GitHub writes; service calls and process runtimes alone do not qualify.
- Pin literal PR/author fixtures, head SHAs, finding locations and typed refusal envelopes. Change the remote PR head after admission and activate a newer review version while the run starts: the selected head/digest must stay unchanged. No test reads spec files or derives expected membership, closure identity or findings from the implementation under test. Checks: C-J10-09, C-ACC-02.

- Run C-J10-09 S1 steps 1–5 on the reference host. Record the selected flow version, PR head, machine request, findings card and GitHub write log.
- Confirm that a member's PR uses an ephemeral background machine at its head and creates no TODO or stack item; the GitHub write log stays empty.
- Confirm that the app agent starts only after the person's Confirm and that a non-member's PR creates no machine request.

## Acceptance

- [C-J10-09](../checks/C-J10-09.md): `/review` on a teammate's PR.
- C-J10-09 steps 1–5 prove the S1 behavior. T-MCH-06 owns the S2 capacity assertions.

## Risks and notes

- T-FLW-01 owns baseline C-SEC-02 isolation. This ticket adds `/review` admission-boundary coverage with a real microVM and no host fallback.
- A PR head can change before execution. Record the run's selected head and check that the machine uses that head; C-J10-09 step 2 detects a mismatch.
- This follow-up's issue is linked in the header; T-FLW-01's frozen issue remains unchanged.

## Root steps, inputs and sources

Reuse the existing microsandbox adapter (`packages/backend/microsandbox/guest.go`, `runtime.go:586-599`, `exec.go`, `files.go` and `transport.go:126-140`); this ticket adds no root step. smithers-3f reviews this inventory and the C-SEC-02 receipts. Main means approved install-shipped code and install-controlled state, not the reviewed PR's head. Repository code, imports, checks and dependency commands run only after group/GID/UID drop inside the ephemeral machine (M-29); members and agents receive no sudo. Branch-built scripts, binaries, interpreters, imports and toolchains never run as root. Branch/member data consumed by root blocks enabling review until the named test proves validation before use.

- Helper installation/startup: main supplies bundled msb, host child environment/PATH/HOME, machine IDs/deadlines, embedded helper bytes/digest, bootstrap, fixed destination and pinned base image/OCI selection. Registry metadata/blob responses are untrusted remote data. Guest shell/interpreter/base executables and import/search paths come from the approved image; retained snapshots, helper temporary files and ancestor/leaf metadata can contain branch/member state. `TestGuestHelperInstallPinsInterpreterAndEnv` through production CreateWorkspace/StartWorkspace proves trusted executable/import provenance, fixed startup environment, bounded digest checking and no-follow/race-safe installation before any root helper or retained cleanup. Check: C-SEC-02.
- Setup/home defaults: main supplies fixed login/UID/GID, directory arguments, HOME_LINKS/GO_SETTINGS, account records and base executables. `/opt/smithers/env.json` contains main-generated values with branch-derived toolchain selection. Home/cache names, contents, links and all ancestor/leaf ownership/modes can be branch/member-controlled; filesystem responses select those objects. `TestRootSetupNeverFollowsMemberSymlinks` through production CreateWorkspace/StartWorkspace proves bounded allowed env keys/cache targets, fixed identity and no-follow writes across replacement races. Branch selection cannot choose a root executable/import. Check: C-SEC-02.
- Exec/file entry, cleanup and bridge/relay supervision: main supplies request/exec IDs, fixed non-root identity/root, protected request directory, cgroup subtree, signal/timeout settings, host bridge destination, allowed ports and relay metadata. Branch/member data supplies argv/env/cwd/stdin, file paths/content/modes/limits, request-file bytes and retained links/metadata; guest processes influence cgroup population, descriptors, terminal sizes, signals, exit observations and network/relay bytes. Helper/interpreter/env/account inputs have the sources above. `TestRootPreflightParsesOnlyEnvelope` through production command, file, terminal, cancellation and relay paths proves bounded identity-only parsing before group/GID/UID drop, protected request files, cgroup/endpoint bounds and payload application after drop. Review remains unprivileged; main-pinned bridge supervision grants no repository root execution. Check: C-SEC-02.

## Ready checklist
1. Dependencies: T-FLW-01 supplies flow binding; T-FLW-03 supplies Active version schema; T-FLW-04 supplies pinned loading; T-ACC-02 supplies active membership; T-ACC-03 supplies the called Authorize decision; T-APP-04 supplies confirmation; T-APP-16 supplies host dispatch/conversation projection; T-CAT-01 supplies command descriptors and CLI mapping. Scope defines fail-closed dark landing for each contract and the T-INS-02/T-SEC-01 enablement gates; missing integrations do not block Ready.
2. Exclusions: Out names outsider/automatic review, GitHub writes, TODO/persistent branch/stack creation, TODO-machine reuse, Open on a machine, new visuals, closure archives/environment packaging, new privileged code and S2 scheduling.
3. Boundary tests: production prs.triage renamed /review catalog/API dispatcher through confirmation, real microVM and retained findings/conversation; C-J10-09/C-ACC-02 use literal fixtures and independent oracles. Extend existing integration harnesses; test unavailable gates before allocation.
4. Decisions: smithers-3f accepts authorization/membership, head/digest admission, credential scope, root-input validation and ephemeral cleanup; smithers-38 accepts review payload and pinned loader reuse; smithers-b8 signs off command/API and retained findings handoff. smithers-8a accepts the S1/S2 qualification split; Will decides any outsider/automatic-review expansion. No ADR or new View is in scope.
5. Owner pre-review: smithers-3f: Do authorization, membership and confirmation precede allocation with a fixed head/digest? Do all root inputs have trusted provenance or the named validation receipt before use? Does completion retire the ephemeral machine without GitHub write authority? smithers-38: Can the existing review payload and pinned loader serve this run without archives or branch import fallback? smithers-b8: Do app/CLI requests share the authorized dispatcher? Can the retained findings card and conversation accept results without a View change? Recorded owner answers stand; owners review post hoc under the parallel-build directive. New View work requires smithers-06 pre-review and a separate scope decision.
6. Security: Scope gates enablement on microVM-only execution and validated shared root boundaries; the root-input inventory names main/branch sources and C-SEC-02 tests. Repository execution stays unprivileged inside the machine; PR text is untrusted data. No provider key or GitHub write authority reaches the run. smithers-3f reviews security; smithers-38 reviews pinned-load integrity. C-J10-09/C-SEC-02 qualify the production boundary.

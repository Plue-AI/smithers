# T-MNT-02 Triage issues with duplicate and reproduction evidence

Stage M · Size M · Depends on T-MNT-01, T-FLW-03, T-FLW-04, T-MCH-06, T-MCH-11, T-UI-19, T-FLW-01, T-SEC-01 · Unblocks T-MNT-03 · Issue: [#3594](https://github.com/smithersai/smithers/issues/3594)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: none (maintainer extension) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings
Ready: 2026-10-03 smithers-8a sha256:4e33abac31fd

## Goal

A maintainer-requested triage returns classification, cited duplicate candidates and measured reproduction evidence on the Issue card.

## Scope

In:
- Reuse repository research, Jev duplicate judgments, reproduction proposal, review and observation retention from flows/repository/jobs.ts.
- Capture a bounded candidate list from synced issues with their revisions. A duplicate judgment links evidence; it never closes or relabels an issue.
- Bug reproduction runs on the captured trusted base in an ephemeral background machine under existing capacity admission. Proposals are data until the requesting maintainer approves the exact fixture, argv and source digest.
- Issue evidence section records expected/actual behavior, command, exit status, source revision and reproduced/needs-author/not-applicable. Infrastructure failure is failed, never evidence that a report is invalid.
- Land dark against the specified contracts of every listed dependency, including first-merge and unlabeled dependencies. Until admission/confirmation (T-MNT-01), machine-only dispatch (T-FLW-01), Active closure loading/pinning (T-FLW-03/04), capacity (T-MCH-06), no-sudo identity (T-MCH-11), root validation (T-SEC-01) and the View seam (T-UI-19) are available and their named checks pass, keep triage controls hidden and refuse affected dispatch before model work, credentials or machine requests. No host, working-copy or unconfirmed fallback. C-MNT-02 and C-MNT-06 exercise each missing-provider refusal; dependencies do not block dark landing.

Out:
- Fixing code, creating TODOs automatically, automatic labels/closure, author-supplied scripts on the host, or a separate reproduction service.
- Event-triggered triage, author replies or publishing (T-MNT-03), outside-PR review (T-MNT-04), arbitrary PR-head execution, new image packages, credential seeding, host/root reproduction and a second investigation, approval or evidence store.

## Changes

- Reuse `flows/repository/jobs.ts:219-265` duplicate, execution and reproduction-review actions and its investigation composition at `:347`. Reshape `flows/repository/execution.ts:299-354` to execute through the machine executor; delete this slice's host execution path in the same change. Reuse the shared Flow runtime and pinning.
- Correct the host-execution wording in `flows/repository/jobs.ts:197`. Validate argv, cwd and fixture paths; bind the requesting maintainer's approval to fixture bytes, argv, cwd and captured trusted-main source digest. Recheck role, expiry and digest at execution; deny drift before any command. Mount only captured source and fixture inside the machine (C-MNT-02, C-MNT-06).
- Use the existing budget, machine request, run and evidence stores. Release the machine at terminal state and while waiting for a person when safely idle.
- Reshape the existing Issue card (`apps/app/src/mainview/cards/IssueCards.tsx:246`) and issue payload (`packages/rpc/src/Cards.ts:1563`) to show retained evidence and monitor receipts. smithers-06 owns the View in `apps/app/src/mainview/cards/views/`; engineering owns its Container and the per-module `packages/rpc/src/IssueCard.ts` contract (new extraction from Cards.ts, not a second schema). Containers use `cardActions` → `flowAction`; Views call `onAction(action.tag)` with `data-flow` (§14.2.1). Reuse existing approval routes and evidence stores. No new table or parallel triage implementation. No GitHub write credential, personal login seed or repository secret enters a triage machine (C-MNT-02, C-MNT-06).

## Tests

C-MNT-02 (folded steps and assertions):
- Drive the real install catalog dispatcher and T-MNT-01 maintainer triage command from the Issue card, delegated CLI and direct API. Exercise reproduction approval through the served `POST /api/repos/{owner}/{repo}/repository-jobs/{job}/approvals` route (`packages/backend/internal/compose/router.go:1290`), then the production flowdispatch worker and microsandbox executor. Calling an action body, inserting an approval or substituting a process runtime supplies no acceptance evidence. Extend the existing repository execution/approval tests; C-MNT-06 supplies the real-install security harness.
- Use fixed issue IDs/revisions, a duplicate and unrelated candidate, known passing/failing fixture bytes, literal expected outputs and denial envelopes. Compute approval/source digests independently from fixture bytes. No test reads spec files or computes expectations with production classification, approval, digest or projection code.
- Omit each dependency provider in turn: hidden controls, direct dispatch refusal and zero work. Restoring providers permits the positive control; receipts bind the tested release (C-MNT-02, C-MNT-06).
1. Request triage as a maintainer through the production command. Observe queued state, free capacity and let research/duplicate steps finish.
2. Inspect proposed reproduction, then reject it through the served approval route. Request another, change its fixture, argv, cwd or base after approval, then attempt execution. Repeat with expired approval and revoked maintainer authority.
3. Approve a fresh fixture/argv/base digest and execute it inside a real microVM.
4. Run the passing control, a missing-evidence bug and the question. Inject executor/model failure and exhaust the budget.
5. Restart during execution and inspect evidence and machine release. Open the Issue card from a second laptop.

Pass when:
- Duplicate results cite the captured candidate IDs/revisions and distinguish the unrelated candidate; no labels or closures are written.
- Denied and changed proposals execute zero commands. The approved fixture runs only inside a machine on the recorded source; measured command, exit, expected/actual behavior and reproduction judgment have matching receipts.
- Missing evidence requests specific input; questions have not-applicable reproduction; infrastructure/model errors show failed and never reproduced or invalid report.
- Capacity is respected, terminal states release the slot, restart retains one attempt identity and evidence, and the card shows the same measured result.
- No personal credential seed, repository secret, main-only secret or GitHub token reaches the machine.

Fail when:
- A proposed command is reported as executed, a host process runs it, a duplicate closes an issue, or failure fabricates reproduction evidence.


- Unit: schema validation and evidence/status consistency.
- Integration: durable duplicate judgments and failed-step receipts through the real composition.
- E2E: C-MNT-02 executes a real failing reproduction in a microVM and covers denied, expired and changed proposals; C-MNT-06 covers malicious input.

## Acceptance

- [C-MNT-02](../checks/C-MNT-02.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: smithers-06 (View/copy), smithers-b8 (app command/Container/public API), smithers-3f (Go/infrastructure/security) and smithers-38 (contract/runtime composition) answer the checklist questions. Recorded owner answers stand; owners review post hoc under Will's parallel-build directive. Record untouched boundaries.
- C-SEC-02 root-boundary tests below pass before enabling triage; missing receipts keep execution dark.

## Risks and notes

Who decides: the requesting maintainer authorizes the exact triage snapshot and reproduction and decides disposition. Jev supplies duplicate and reproduction judgments with receipts; it grants no authority. smithers-38 accepts composition and evidence/status semantics; smithers-3f accepts executor, source confinement and root validation; smithers-b8 signs off the command and public API; smithers-06 accepts View and copy seams. Will decides product scope changes through smithers-8a. Existing legacy prompts and adapters are evidence to reuse, not permission to execute on the host. Check C-MNT-02 proves actual execution.

## Security preconditions and root inputs

smithers-3f reviews confinement and every root input; smithers-38 reviews pinned closure integrity. Research, repository flow loading, dependency installation and reproduction execute only as unprivileged users in machines (M-29, §17.3). Outsider text remains quoted data. No triage step executes as root. Reuse the existing root lifecycle below; do not build or install branch-produced privileged code. Missing validation receipts block enabling execution, not dark landing. Checks: C-SEC-02, C-MNT-06.

- R1 helper installation/interpreter startup: helper bytes/digest, fixed destination and install script come from trusted main in the installed bundle; msb path/binary, child PATH/HOME/environment, machine ID and deadlines come from install configuration/state. Image selection and OCI metadata/blobs come from the pinned install image/registry. Guest shell, Python, digest/install utilities and search/import paths come from that image. Retained layer/snapshot bytes, helper/temporary parents and filesystem metadata can be branch/member-derived. `TestGuestHelperInstallPinsInterpreterAndEnv` validates provenance, parents and startup environment on fresh and retained machines before root execution.
- R2 setup/home defaults: login/UID/GID and directory argv come from authenticated install identity allocations and trusted-main constants; helper, HOME_LINKS/GO_SETTINGS, account records, useradd and shell come from the installed image/main. `/opt/smithers/env.json` keys/values come from main generation with branch-derived toolchain data. Cache/home entries, ancestors, symlinks and modes can be branch/member-derived; filesystem responses come from the guest kernel. `TestRootSetupNeverFollowsMemberSymlinks` validates no-follow ownership/mode operations and replacement races; `TestRootPreflightParsesOnlyEnvelope` prevents payload environment use before identity drop.
- R3 exec/file supervision, cleanup and relay: fixed request IDs, identity/root envelope, request-directory authority, stdin mode, descriptors, terminal size/signals, cgroup IDs/subtree and relay/bridge endpoint come from main/install authority. argv/env/cwd, fixture paths/content/modes/read limits, request-file bytes, retained directory/symlink state, process population and relay traffic can be branch/member-derived. Helper/interpreter/env/account inputs retain R1/R2 sources. Fork/wait/signal/exit, cgroup and filesystem observations come from the guest kernel. `TestRootPreflightParsesOnlyEnvelope` validates bounded envelopes, request files, cgroup names and relay bounds; it proves supplementary groups/GID/UID drop before payload use. Root never resolves a payload-selected path.
- Existing layer preparation/artifact installation: recipes/toolchain/package declarations, index/archive entries and destination/marker parents can be branch-derived; base image, privileged executables, bundle/catalog bytes and approved digests come from trusted main/install. `TestRootLayerInputsValidatedBeforeUse` validates branch data before root use; `TestRootManagedArtifactInstallUsesApprovedBundleOnly` proves privileged artifact bytes come only from the approved installed bundle. Branch-built root code is forbidden even if its digest matches. This ticket adds no privileged fixture installer or new root step.

## Ready checklist
1. Depends on lists admission, version/pinning, capacity, no-sudo identity, View, machine-only dispatch and shared root validation; T-MNT-01 supplies synced inputs/confirmation and T-FLW-03 supplies launcher prerequisites transitively. Every unavailable contract lands dark and fails closed (C-MNT-02, C-MNT-06).
2. Out explicitly excludes automatic/event-triggered work, fixes/TODO creation, labels/closure, replies, outside-PR execution, new packages/credential seeding, root/host reproduction and duplicate services/stores.
3. C-MNT-02 exercises catalog dispatch, served approval, production worker/executor and two-laptop card rendering with fixed independent oracles; C-MNT-06 proves malicious-input confinement. No runtime spec or production-derived expectations.
4. The requesting maintainer decides authorization/disposition; Jev judges evidence; smithers-38 accepts composition/status, smithers-3f security/executor, smithers-b8 public API, smithers-06 View/copy, and Will through smithers-8a product scope.
5. Owner pre-review questions, with recorded answers retained and post hoc review: smithers-06: Does the Issue evidence View distinguish failed infrastructure from missing evidence? Do all controls use onAction/data-flow? smithers-b8: Do card, CLI and API share one authorized triage command? Does the served approval bind exact inputs and refuse stale authority? smithers-3f: Do fresh/retained machines validate every root input before use? Are reproduction, secrets exclusion and slot release proved through the production executor? smithers-38: Does reuse preserve pinned composition and durable attempt identity? Do evidence schemas keep proposed and measured results distinct?
6. Security preconditions confine repository execution to unprivileged machine users, bind approval/source digests and exclude credentials; the root inventory names main/install and branch/member sources and validation tests. smithers-3f reviews with smithers-38 on closure integrity; C-SEC-02/C-SEC-03/C-MNT-06 gate enabling.

# T-MNT-04 Review outside PRs with the shared review step

Stage M · Size M · Depends on T-MNT-01, T-FLW-01, T-FLW-04, T-FLW-11, T-FLW-13, T-FLW-07, T-MCH-06, T-SEC-01, T-STK-02, T-UI-19 · Unblocks T-MNT-05 · Issue: [#3596](https://github.com/smithersai/smithers/issues/3596)
Spec: spec.md §5.2, §6.1.2b, §8.3, §10.2.1, §12.4, §16.4, §17.1–§17.5 · Delta: delta.md §6 (reuse TODO review and placement), §8 (machine-only pinned review closure), §10 (retain event admission and dispatch) · Product: mvp.md §14, §8, M-05, M-26, M-29; actions.md C.8–C.12; AGENTS.md Superseded 2026-10-01 rulings

## Goal

A maintainer can review an outsider PR and see revision-bound findings on its own review card without creating a stack item.

## Scope

In:
- Extend /review admission to outside PRs only after a maintainer action. Reuse the exact review step/module used by the TODO flow, its findings schema, pinning and monitor.
- Capture PR number, contributor identity, base/head SHAs and diff. Run review in an ephemeral background machine with no host execution of contributor code.
- Read-only review is the default. Reuse the shared reviewer’s trusted pinned instructions and separate session; treat PR text, diff, files and tool output as framed untrusted data, never auto-discovered reviewer instructions. Any already-supported PR-head execution remains inside the isolated machine as `agent`, with no sudo, personal logins, repository secrets, provider keys or GitHub write token. Use an already prepared trusted-main image; do not build a PR-selected image or install branch-built code as root. Checks: C-MNT-06, C-SEC-02.
- Review card shows findings and GitHub links. New pushes make findings stale and require a new maintainer request. No automatic review, steer, approval or merge follows.
- A separate maintainer action can commit work as a TODO through existing stack primitives; preserve the source PR link and identity, never silently convert the outsider PR.
- Land dark against every unlanded dependency in Depends on. Keep outside-PR discovery and actions disabled until the stage-M catalog and card providers are wired. Refuse review or commit-work before drafting, confirmation or durable admission when live membership, delegated identity, confirmation, PR snapshot, pinned review version, findings projection or TODO placement providers are missing. Refuse execution without the microVM-only launcher, verified closure restore, shared TODO review module, monitor/lifecycle, capacity admission, no-sudo isolation and validated root boundary. C-MNT-04 exercises each missing provider through production dispatch; C-MNT-06 and C-SEC-02 gate execution. Unlanded dependencies do not block Ready.

Out:
- A second review engine, quizzes, in-app line comments, automated GitHub reviews, review-thread replies, stack Merge on outside PR cards or new landing machinery.
- Automatic review on pushes or outsider events, author replies (T-MNT-03), issue reproduction (T-MNT-02), new PR-head execution capabilities, changes to the contributor’s PR, new queues/tables/executors, privileged setup or PR-selected image recipes.
- Engineering implementation of design-owned Views, a parallel findings schema or card system, and restoration of Cut tags or user trigger-management routes.

## Changes

- Reshape the retained `/review` door in `apps/app/src/mainview/flows/entries/prs.ts:81` (`prs.triage`) and `apps/app/src/mainview/state/controller/issueFlows.ts:110`, which launches `pr-triage` today. Extend T-FLW-13’s production review dispatcher with T-MNT-01’s maintainer gate; reuse T-FLW-11’s TODO review step and findings contract rather than readiness scoring or a second reviewer. Retain the ordinary review implementation in `flows/review/flow.ts:11` and its step modules; adapt the shared entry, not a fork. C-MNT-04 records the pinned shared module and contract.
- Reuse `packages/backend/flowhost/workspace_launcher.go:24`, verified closure restoration and existing background admission. Pin requester, PR identity, base/head and review digest at admission; recheck live role and revision on confirmation (C-MNT-04).
- Reshape the retained findings card in `apps/app/src/mainview/cards/ChangeCards.tsx:36` and revision schema in `packages/rpc/src/Changes.ts:59` for the outside-PR projection. Reuse the existing card seam; add no second card system. smithers-06 owns any View changes; engineering supplies Containers and subpath view models, with `cardActions` → `flowAction` and `onAction(action.tag)`/`data-flow` (§14.2.1). Keep Review & merge confined to TODO PRs. Stop/retry and restart recover through the shared run lifecycle (C-MNT-04).
- Define the separate commit-work action using existing TODO placement and person confirmation; admission is maintainer-only and does not rewrite the contributor's PR.

## Tests

C-MNT-04 (folded steps and assertions):
1. Open the outside PR card, request /review as Member and as a maintainer agent without confirmation.
2. Confirm as the requesting maintainer; release capacity and run the shared reviewer on the pinned base/head diff.
3. Push a new head during review; reload and explicitly request review again. Restart during the new run, then exercise failure and explicit Retry.
4. Inspect app, CLI/API projections and GitHub for writes or stack changes.
5. Separately request commit-work as Member, delegated maintainer and confirmed maintainer. Inspect resulting TODO and original PR.

Pass when:
- Unauthorized/unconfirmed calls create zero runs. Accepted review queues within existing capacity.
- TODO and outside review execute the same review module and findings contract, not pr-triage readiness scoring; the seeded defect has a supported finding or the quality gate fails.
- Findings bind to base/head; old findings show stale after push, never silently rebind. Only the fresh request launches again. Restart/retry retain attempts and honest errors.
- Review alone creates zero TODOs, stack items, approvals, merges or GitHub comments/reviews. The card keeps PR number/contributor and GitHub links with no stack Merge control.
- Only the separate confirmed maintainer action creates one normal TODO linked to the source PR; the contributor PR is neither rewritten nor adopted as its stack PR.

Fail when:
- A readiness report substitutes for review, a push launches review automatically, stale findings appear current, or review creates stack work.


- Boundary integration: C-MNT-04 enters the production install catalog/API dispatcher for `prs.triage` (`/review`) and the separate commit-work action, then the production confirmation create/approve routes, machine launcher and findings projection. Exercise browser sessions and delegated CLI/API credentials with real PostgreSQL and fake GitHub, including wrong confirmer, revoked membership, changed head, repeated idempotency keys and each missing provider. Direct reviewer, authorizer or launcher calls alone are not acceptance evidence.
- Use reviewed literal PR/author/role fixtures, base/head SHAs, review version and module identity, defect locations, refusal envelopes and counter deltas. Expected findings and module identity do not come from the running TODO reviewer, descriptors, source code or spec files. The real-fork variant retains host execution audit, guest identity, input/version pins, projection snapshots and GitHub write logs (C-MNT-04, C-MNT-06).
- C-SEC-02’s three named R1–R3 tests below must qualify the reused production fresh/retained machine paths; direct Python imports or fake runtimes alone do not qualify.
- Unit: findings revision and role checks.
- E2E: C-MNT-04 against a real fork PR, including changed head, machine contention, failure and explicit commit-work conversion.
- E2E: C-MNT-06 verifies malicious PR code stays confined.

## Acceptance

- [C-MNT-04](../checks/C-MNT-04.md) passes with retained evidence.
- C-MNT-06 passes for every executable path this ticket exposes. C-SEC-03 remains a launch prerequisite, not work deferred to M.
- Owner pre-review: the checklist names the owners and concrete questions for every touched boundary; record untouched boundaries as such. Recorded owner answers stand. Under Will’s parallel-build directive, owners review post hoc and pending answers do not block Ready.

## Risks and notes

Who decides: an owner or maintainer requests review, interprets findings and separately commits any work. The shared reviewer advises and never approves or merges. Will decides product scope and new action names; smithers-8a accepts admission/reuse design decisions; smithers-b8 signs off app/CLI/API and Container seams; smithers-38 accepts shared module identity and TS public contracts; smithers-06 accepts View and copy changes; smithers-3f accepts Go/infra, credential confinement and root-input validation. C-MNT-04 proves correctness review rather than legacy readiness triage.

## Root steps, inputs and sources

This ticket adds or changes no root step. Its fresh/retained machine lifecycle consumes the inherited R1–R3 inputs listed below, owned by T-SEC-01. PR-selected layer builds and branch-built privileged payloads are excluded. Any additional privileged path, including a changed S2 broker path, stays disabled until smithers-3f records every consumed input and source and a named production test proves validation before root use (C-MNT-06, C-SEC-02).


Repository code executes only as an unprivileged user inside a machine (M-29, spec §1.3); members and agents receive no sudo. smithers-3f reviews every root-input validation below. Root installs, loads or executes only main-pinned or bundle-shipped code; branch-built scripts, binaries, interpreters, imports and toolchains are forbidden even if a digest matches. Branch/member data remains a landing blocker until the named C-SEC-02 test proves validation before privileged use.

- R1: `TestGuestHelperInstallPinsInterpreterAndEnv` proves base/interpreter/helper provenance, fixed startup environment, trusted ancestors and replacement resistance on fresh and retained paths before any privileged helper, including cleanup. A branch-derived executable or import is refused.
- R2: `TestRootSetupNeverFollowsMemberSymlinks` proves bounded env.json data, fixed allowed keys/cache targets, trusted account identity and no-follow home/cache writes across replacement races. Branch-selected values cannot choose root executable/import paths; arbitrary or malformed values are refused before root use.
- R3: `TestRootPreflightParsesOnlyEnvelope` proves bounded envelope/request-file parsing, fixed non-root identity, protected request-file parents, cgroup names/subtree and relay endpoints. Command env/argv/cwd/file payloads are applied only after group/GID/UID drop; root never resolves a payload-selected path.

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
1. Dependencies: T-MNT-01 supplies maintainer admission, sync, live authorization/confirmation, pinned versions, launcher and no-sudo isolation transitively; T-FLW-13 supplies the production review door; T-FLW-11/T-FLW-04 supply shared TODO review and verified restore; T-FLW-07 supplies monitor/lifecycle; T-MCH-06 supplies capacity; T-SEC-01 supplies R1–R3 validation; T-STK-02 supplies placement; T-UI-19 supplies the existing visual seam. Scope requires dark, fail-closed integration for every unavailable provider (C-MNT-04).
2. Exclusions: Out names second reviewers/cards/schemas, automatic review, GitHub writes, author replies, issue reproduction, new execution capabilities, contributor-PR mutation, stack Merge, queues/tables/executors, privileged setup, PR-selected recipes, Cut tags and engineering-owned View implementation.
3. Boundary tests: C-MNT-04 exercises production app/CLI/API dispatch, confirmation, real machine launch and findings/commit-work projections; C-MNT-06 audits executable paths. Literal fixtures define expected results; no runtime spec/code/catalog or TODO-review-derived oracle. C-SEC-02 qualifies inherited R1–R3 boundaries.
4. Decisions: Will owns scope/action names; smithers-8a accepts admission/reuse design; smithers-b8 approves public commands/API and Containers; smithers-38 approves shared review identity/TS contracts; smithers-06 approves Views/copy; smithers-3f approves Go/infra/security. A live owner or maintainer decides each review admission and separate TODO commit.
5. Owner pre-review questions (recorded answers stand; reviews post hoc under Will’s directive): smithers-06: Can the retained findings card show outsider identity and stale evidence without stack Merge? Do controls use approved action routing and copy? smithers-b8: Do app, CLI and API share review and separate commit-work confirmation gates? Do absent providers refuse before effects? smithers-3f: Are head/version pins and authority rechecked before allocation and retry? Do fresh/retained machines validate every root input before use and keep PR execution unprivileged? smithers-38: Is the exact TODO review module reused with one findings contract? Do revision pins and literal fixtures cover stale/restarted runs without a second schema?
6. Security: smithers-3f reviews M-29 machine-only execution, trusted review instructions, unprivileged identity, credential/egress limits and the complete inherited R1–R3 input inventory. Branch/member data blocks execution until the named C-SEC-02 validation tests pass at production boundaries; branch-built root code and PR-selected image builds remain forbidden. C-MNT-06/C-SEC-03 prove outsider admission and confinement; unavailable security providers land dark.


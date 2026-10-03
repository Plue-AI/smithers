# T-FLW-02 Install-stored default config: checks, wiki pages, seats

Stage S1 · Size M · Depends on T-FLW-01, T-MCH-10, T-INS-06, T-STK-01, T-STK-04, T-SEC-01 · Unblocks T-APP-01, T-FLW-08, T-FLW-10, T-STK-08 · Issue: [#3449](https://github.com/smithersai/smithers/issues/3449)
Spec: spec.md §3 (`install_settings`), §8.6.2, §11.2, §11.5a, §13.5 · Delta: delta.md §8 (install-stored config row) · Product: mvp.md J1.4, §6.9 Works TODOs, §6.11 Generated pages, §6.12 Default flows, M-11
Ready: 2026-10-03 smithers-8a sha256:b24558c30437

## Goal
A repository with no `.smithers/` files runs TODOs with detected checks, a default wiki page declaration and default model seats, and nothing is committed to the repository.

## Scope
Build against the specified contracts and land dark for every unlanded dependency: T-INS-06 gates Source-ready persistence; T-MCH-10 gates detected metadata and image readiness; T-FLW-01 gates guest dispatch; T-STK-01 gates TODO admission and evidence; T-STK-04 gates merge-triggered refresh; T-SEC-01 gates privileged guest setup and transport. Refuse the affected operation until its provider is available and C-J1-06, C-J8-06 and C-SEC-02 pass; never substitute a detector, fabricated check result or host execution.

In:
- Detect check commands from the files §11.2 names: `package.json` scripts `test`, `lint`, `typecheck` and `build`; `go test ./...`; `cargo test`; `pytest`. The package manager comes from T-MCH-10's detection (`pnpm test`, not `npm test`, in a pnpm repository).
- Planning needs at least one check (§11.2). A repository with no detected check runs a build-only check for every candidate generation, including after rebase, and its PR evidence says "no checks detected". Without an executable build command, return a typed check configuration failure; never record a pass. C-J1-06 covers both fallback outcomes through TODO dispatch.
- The default wiki page declaration (§11.2): an overview, an architecture page and one page per top-level package directory, at most 10.
- Default model seats; the owner's agent model choices (`agent:<role>`, §11.5a) live in the same table and are set through T-FLW-08.
- Store the generated configuration in `install_settings` (§3), written when setup reaches Source ready.
- Merge field by field with `main:.smithers/coding-project.json` when present: the repository's field wins (§11.2).
- Deliver the merged configuration to the coding host at run start, so the run is pinned to it.

Out:
- Toolchain and package-manager detection for the machine image (T-MCH-10). This ticket consumes its result and adds no second detector.
- Plans citing wiki revisions (T-FLW-10).
- The Agent card and owner model choice (T-FLW-08).
- Agent permissions, tools and budget editing ([D] spec §0).
- Ruby detection, executing scripts during detection, committing generated defaults and running checks on the host.

## Changes
- Reuse `install_settings` for owner defaults and detected metadata; no config migration. Overlay repository values field by field.
- Reshape `packages/smithers/src/suggest/Checklist.ts:183` (`evidence`), `flows/coding/project-config.ts:55` (`loadProject`) and T-INS-06's existing `repository_setup.go` step runner. Consume T-MCH-10's evidence for the §11.2 check list and package manager, persist through existing `install_settings` queries at Source ready, and overlay `.smithers/coding-project.json` from the mirror at pinned `main` as data. Remove the mandatory private-config default. No new detector, config service or table.
- Default checks → one built-in check entry per detected command, provisioned beside the built-ins in `provisionBuiltins` (`flows/repository/registry.ts:152`), each a registered body `{argv, cwd: ".", timeoutMs}` as `flows/coding/checks.ts:60` requires. The project config names them in `checks[]` (`flows/coding/project-config.ts:27`). With none detected, the one check is the build-only check.
- Reshape `flows/coding/planning.ts:38,56` (`PlanningContext.checks`, `Draft.changes[].checks`) → minimum one check instead of two; a literal one-check Go fixture must complete planning through TODO dispatch (C-J1-06).
- Default wiki declaration → reuse `PageSpec` (`flows/wiki/schema.ts:6`) for the `pages` inventory, with `wiki: true`, an install-side `wikiOutput` and the required `reviewer` identity (`flows/coding/project-config.ts:106`). Reuse `packages/backend/internal/services/mythical_wiki.go:245` for merge refresh (§13.5); add no second refresh worker. smithers-38 approves stable page IDs, package ordering and semantic review policy; C-J1-06/C-J8-06 use literal inventories and page results.
- Default seats → every role `auto` (`flows/coding/project-config.md` "Seats") until the owner picks a model.
- Other install-stored fields that neighbouring tickets add use the same table and merge rule: `conflictAttempts` (default 1, T-STK-08).
- Delivery → the host writes the merged JSON into the machine at run start and sets `SMITHERS_CODING_PROJECT` to it, the existing explicit-file path (`flows/coding/project-config.ts:55-66`). Don't use `SMITHERS_CODING_SEATS`: operator pins win over repository seats (`flows/coding/host.ts:115`), which inverts §11.2.
- `flows/coding/project-config.md` and the coding host docs → describe install-stored defaults and field precedence; `pnpm docs:sync`, `pnpm docs:check`.

## Tests

- Landing integration, `packages/backend/internal/services/flow_config_integration_test.go`: reach Source ready through the setup API wired by T-INS-06, then create and start a TODO through the production dispatcher and launcher. Observe its machine's merged config, recorded checks and generated-page refresh. Service calls alone do not qualify. Run the execution subcase in real microVM mode on the reference host; a process-runtime test is component coverage only. Check: C-J1-06, C-J8-06.
- All expected commands, precedence results and page inventories are literal fixture values committed with these tests. Tests never read spec files or derive expected values from the detector or registry under test.
- `TestInstallStoredConfigGuestBoundary` in `packages/backend/internal/services/flow_config_integration_test.go` drives setup and TODO creation through the production router/dispatcher on a real microVM. For each missing Scope provider, assert a refusal before its effect and recovery when supplied. Hostile main config, branch check argv/env/cwd and symlinked destinations must cause no host/root canary; observe uid/gid before reading config/check payloads. A valid fixture must run its checks as agent. C-J1-06 and C-SEC-02 retain these receipts.
- Unit, `packages/smithers/test/ChecklistEvidence.test.ts` and `flows/test/coding-project-config.test.ts` (extend): one fixture tree per §11.2 entry yields literal `checks[]` in the stated order; a tree with none yields the build-only check; detection reads no file outside the list; the wiki declaration for a repository with 14 top-level packages lists overview, architecture and 8 package pages.
- Unit, `flows/test/coding-project-config.test.ts` (extend): merge precedence. Repository `checks` replaces stored `checks`; repository `seats` keys override only those keys; absent repository fields keep stored values; an invalid repository file refuses with its path, as `loadProject` does today.
- Unit, `flows/test/coding-project-config.test.ts` (extend): the explicit merged file loads; unknown fields are still refused; one check passes both planning schemas. The admitted snapshot keeps checks/pages fixed for a running attempt; owner `agent:<role>` changes still apply to each subsequent model call (§11.5a), covered through the production owner model command and a live TODO. C-J1-06 runs this subcase once T-FLW-08's command provider is available; without it, use the setup role settings and leave owner editing dark.
- Integration (real PostgreSQL, fake GitHub, test process runtime), `packages/backend/internal/services/flow_config_integration_test.go` (new): Source ready writes the `install_settings` rows; a TODO run receives the merged file; a later `main` commit that adds `.smithers/coding-project.json` changes the next run's config and not a running one.
- e2e: [C-J1-06](../checks/C-J1-06.md).

## Acceptance

- [C-SEC-02](../checks/C-SEC-02.md): merged config and check payloads cross guest transport only after the identity drop; hostile paths and command canaries produce no root or host execution.

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J8-06](../checks/C-J8-06.md): on a repository with no declarations, a merge refreshes the package's generated page as a background run.

- [C-J1-06](../checks/C-J1-06.md): a repository with no Smithers files runs a TODO whose evidence lists the detected checks, with no commit to `.smithers/` or `flows/`.

## Risks and notes
- Risk: `loadProject` reads the file once at host start (`flows/coding/project-config.md:12`). Per-run delivery holds only if each run starts its own coding host or the host reloads per run. Falsified if two runs on one machine see different files but the same config.

Root inputs for the reused launch/delivery path (smithers-3f review; C-SEC-02):
- Helper bootstrap/install: helper bytes, digest, isolated interpreter, fixed environment and coding artifact come from the installed approved bundle built from main, never the TODO branch. Machine ID and binding come from host admission. `TestGuestHelperInstallPinsInterpreterAndEnv` and the managed-artifact subcase prove pinning; branch-built root payloads remain forbidden.
- Guest setup: user `agent`, uid/gid 1500 and fixed directory allowlist come from packaged host code; account records come from the guest OS. Retained directory entries and symlinks can be branch-written. `TestRootSetupNeverFollowsMemberSymlinks` validates these before ownership/mode changes. Root may not read branch-produced home defaults.
- Config/check transport and exec supervision: operation ID, user, protected request directory and cgroup paths come from host admission/packaged code. The merged config contains install settings and pinned-main repository data; check argv/env/cwd/stdin and candidate filesystem bytes can be branch-sourced. `TestRootPreflightParsesOnlyEnvelope`, `TestRootExecNeverParsesBranchPayload` and `TestRootRequestTransferReadsBranchBytesOnlyAfterDrop` prove root validates only the host envelope and consumes payload bytes only after dropping to agent. Delivery writes the snapshot outside the repository working copy as agent; no repository-selected path enters privileged writes. C-SEC-02 adds hostile merged-config/check payloads at the production dispatcher, observes uid/gid before payload use and retains valid positive controls.
- Image preparation remains T-MCH-10's path: pinned bundle manifest/base/tool downloads plus main-derived recipe and image packages; branch source/index/path entries remain untrusted. `TestRootLayerInputsValidatedBeforeUse` in C-SEC-02 must validate them before root use. Dependency installs run as agent. Any additional root input or branch input without a named validation test blocks enabling the affected operation.

## Ready checklist
1. Dependencies: T-INS-06 supplies Source-ready setup and transitively T-INS-02's launcher; T-MCH-10 supplies evidence/image readiness; T-FLW-01 supplies guest dispatch; T-STK-01 supplies TODO admission/evidence; T-STK-04 supplies safe merge settlement; T-SEC-01 supplies guest root validation. Scope gates each unavailable provider and names its boundary checks.
2. Exclusions: Out excludes a second detector, model UI, wiki citations and permission editing. Also exclude Ruby detection, running scripts during detection, committing generated config and executing checks on the host.
3. Boundary tests: setup API → production TODO dispatcher → machine config and merge refresh in C-J1-06/C-J8-06; literal fixture oracles, no runtime spec or implementation-derived expectations.
4. Decisions: smithers-3f approves Source-ready persistence, immutable per-attempt delivery and root-input validation; no migration is planned. smithers-38 approves check registration, bounded fallback command and failure evidence, page IDs/order/reviewer policy and config precedence. smithers-b8 approves setup/owner-command compatibility. Will decides product behavior changes through smithers-8a; smithers-8a accepts any shared settings ownership change (C-PRC-02).
5. Owner pre-review: smithers-3f: Is Source-ready persistence restart-safe and each attempt snapshot fixed? Does config delivery validate all privileged inputs and drop identity before consuming repository payloads? smithers-38: Does the existing evidence/loader path supply real check and wiki declarations without a duplicate service? Do both planning schemas accept one check and the fallback refuse a missing build command? Do live owner model changes retain §11.5a semantics? smithers-b8: Does setup retain its existing request/response contract? Does the owner model command update live calls without exposing sealed values? Recorded owner answers stand; remaining review is post hoc under Will's parallel-build directive.
6. Security: smithers-3f reviews M-29/§1.3 and the root-input inventory below. Detection/config overlay read pinned main data; repository installs, checks and generated-page flows run only as agent inside machines, with no host fallback. T-SEC-01 validates privileged transport; C-SEC-02 and C-J1-06 prove it. Root consumes no merged JSON or check command before the identity drop.


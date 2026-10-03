# T-FLW-02 Install-stored default config: checks, wiki pages, seats

Stage S1 · Size M · Depends on T-FLW-01, T-MCH-10, T-INS-06 · Unblocks T-FLW-08, T-FLW-10, T-REL-02, T-STK-08 · Issue: [#3449](https://github.com/smithersai/smithers/issues/3449)
Spec: spec.md §3 (`install_settings`), §8.6.2, §11.2, §11.5a, §13.5 · Delta: delta.md §8 (install-stored config row) · Product: mvp.md J1.4, §6.9 Works TODOs, §6.11 Generated pages, §6.12 Default flows, M-11

## Goal
A repository with no `.smithers/` files runs TODOs with detected checks, a default wiki page declaration and default model seats, and nothing is committed to the repository.

## Scope
In:
- Detect check commands from the files §11.2 names: `package.json` scripts `test`, `lint`, `typecheck` and `build`; `go test ./...`; `cargo test`; `pytest`. The package manager comes from T-MCH-10's detection (`pnpm test`, not `npm test`, in a pnpm repository).
- Planning needs at least one check (§11.2). A repository with no detected check runs a build-only check, and its PR evidence says "no checks detected".
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
- `packages/backend/internal/services/flow_config.go` (new) → `Detect(tree)` builds checks from T-MCH-10's detected package manager plus the §11.2 list; `Merged(ctx, mainCommit)` overlays `.smithers/coding-project.json` from the mirror at `main` (a data read, never code) over the stored rows, field by field.
- Default checks → one built-in check entry per detected command, provisioned beside the built-ins in `provisionBuiltins` (`flows/repository/registry.ts:152`), each a registered body `{argv, cwd: ".", timeoutMs}` as `flows/coding/checks.ts:60` requires. The project config names them in `checks[]` (`flows/coding/project-config.ts:27`). With none detected, the one check is the build-only check.
- `flows/coding/planning.ts:38` (`PlanningContext.checks`) → minimum one check instead of two.
- Default wiki declaration → a `pages` inventory (`PageSpec`, `flows/wiki/schema.ts:6`) with `wiki: true` and an install-side `wikiOutput`, so `mythical_wiki.go` refreshes generated pages after merges (§13.5).
- Default seats → every role `auto` (`flows/coding/project-config.md` "Seats") until the owner picks a model.
- Other install-stored fields that neighbouring tickets add use the same table and merge rule: `conflictAttempts` (default 1, T-STK-08).
- Delivery → the host writes the merged JSON into the machine at run start and sets `SMITHERS_CODING_PROJECT` to it, the existing explicit-file path (`flows/coding/project-config.ts:55-66`). Don't use `SMITHERS_CODING_SEATS`: operator pins win over repository seats (`flows/coding/host.ts:113`), which inverts §11.2.
- `flows/coding/project-config.md` and the coding host docs → describe install-stored defaults and field precedence; `pnpm docs:sync`, `pnpm docs:check`.

## Tests

- Landing integration, `packages/backend/internal/services/flow_config_integration_test.go`: reach Source ready through the setup API wired by T-INS-06, then create and start a TODO through the production dispatcher and launcher. Observe its machine's merged config, recorded checks and generated-page refresh. Service calls alone do not qualify. Run the execution subcase in real microVM mode on the reference host; a process-runtime test is component coverage only. Check: C-J1-06, C-J8-06.
- All expected commands, precedence results and page inventories are literal fixture values committed with these tests. Tests never read spec files or derive expected values from the detector or registry under test.
- Unit, `packages/backend/internal/services/flow_config_test.go` (new): one fixture tree per §11.2 entry yields the expected `checks[]` in the stated order; a tree with none yields the build-only check; detection reads no file outside the list; the wiki declaration for a repository with 14 top-level packages lists overview, architecture and 8 package pages.
- Unit, same file: merge precedence. Repository `checks` replaces stored `checks`; repository `seats` keys override only those keys; absent repository fields keep stored values; an invalid repository file refuses with its path, as `loadProject` does today.
- Unit, `flows/test/coding-project-config.test.ts` (extend): the explicit merged file loads; unknown fields are still refused; one check passes planning.
- Integration (real PostgreSQL, fake GitHub, test process runtime), `packages/backend/internal/services/flow_config_integration_test.go` (new): Source ready writes the `install_settings` rows; a TODO run receives the merged file; a later `main` commit that adds `.smithers/coding-project.json` changes the next run's config and not a running one.
- e2e: [C-J1-06](../checks/C-J1-06.md).

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J8-06](../checks/C-J8-06.md): on a repository with no declarations, a merge refreshes the package's generated page as a background run.

- [C-J1-06](../checks/C-J1-06.md): a repository with no Smithers files runs a TODO whose evidence lists the detected checks, with no commit to `.smithers/` or `flows/`.

## Risks and notes
- Risk: `loadProject` reads the file once at host start (`flows/coding/project-config.md:12`). Per-run delivery holds only if each run starts its own coding host or the host reloads per run. Falsified if two runs on one machine see different files but the same config.

## Ready checklist
1. Dependencies: T-INS-06 supplies the Source-ready setup boundary and transitively T-INS-02's microVM launcher; T-MCH-10 supplies the single detector and image readiness; T-FLW-01 supplies machine-only execution.
2. Exclusions: Out excludes a second detector, model UI, wiki citations and permission editing. Also exclude Ruby detection, running scripts during detection, committing generated config and executing checks on the host.
3. Boundary tests: setup API → production TODO dispatcher → machine config and merge refresh in C-J1-06/C-J8-06; literal fixture oracles, no runtime spec or implementation-derived expectations.
4. Decisions: smithers-3f approves the migration, Source-ready write and per-run delivery seam; smithers-38 approves check registration, the build-only check's bounded command and evidence, page selection order and config precedence before implementation. Escalate any change to §11.2 behavior to Will through smithers-8a.
5. Owner pre-review before start: smithers-3f: Does Source ready write once and each admitted run receive its own config snapshot? smithers-38: Can registered checks and wiki defaults load without repository declarations? Does the build-only check report real execution evidence rather than unconditional success?
6. Security: detection and merge read repository bytes as data; installs, checks and generated-page flows execute only in machines under T-INS-02/T-FLW-01, with no host-process fallback (M-29, §1.3). smithers-3f reviews this precondition; C-SEC-02 and C-J1-06 prove the boundary.


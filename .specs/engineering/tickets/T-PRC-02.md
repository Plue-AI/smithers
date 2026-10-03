# T-PRC-02 DB-free migration gate and planned table ownership at Ready

Stage S1 · Size S · Depends on — · Unblocks — · Issue: [#3614](https://github.com/smithersai/smithers/issues/3614)
Spec: spec.md §21.3 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-3f + smithers-8a
Ready: 2026-10-03 smithers-8a sha256:ee84fb18860c

## Goal

At Ready, smithers-8a records every new table in `packages/backend/db/ownership.csv` as `planned:<ticket>` with one named engineering owner. Keep the existing `table,target_owner,status` columns and product/private/retired target owners; record the planned ticket and engineering owner in status. smithers-3f approves the planned-row encoding and SQL parsing rules; smithers-8a accepts reservations and resolves competing claims. Reserve tables before implementation; assign migration numbers at landing. The default Go target runs DB-free checks for unique, gapless numbers, registry/embed parity, duplicate CREATE statements (IF NOT EXISTS included), ownership of created tables and removal of dropped tables. A lane cannot create a table planned for another ticket. `scripts/renumber-migration.mjs <file>` renames the migration, updates the registry and regenerates sqlc output at landing. The helper refuses any file already on `origin/main`. `scripts/commit.mjs --push` runs `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` before any push and refuses publication on failure. Check: C-PRC-02.

## Scope

Lands dark until T-SEC-01: refuse machine dispatch of the gate, helper and generator without approved R1–R3 receipts and a main-pinned installed runtime; never fall back to host execution. Lands dark until T-MCH-10's sec10 follow-up: refuse preparation using branch-derived R4 inputs until `TestRootLayerInputsValidatedBeforeUse` proves validation before privileged use. Lands dark until T-FLW-01's R5 follow-up where the coding host is used: refuse that path until `TestRootManagedArtifactInstallUsesApprovedBundleOnly` proves installed-bundle provenance. smithers-3f accepts these receipts. Branch-built code remains forbidden at root regardless of test results. These are enablement preconditions, not code/schema dependencies. Check: C-PRC-02.

Lands dark until T-PRC-01: the new `--push` integration refuses publication if the required drift gates are unavailable or fail; DB-free gate tests and renumbering can land independently. smithers-22 accepts enablement after C-PRC-01 and C-PRC-02 pass. Check: C-PRC-02.

In:
- `packages/backend/db/product/`: DB-free migration tests in the default Go target (`//:backendGo`, declared in root `PACKAGE.ts`) for dense numbering, registry/embed parity, duplicate CREATE and created/dropped ownership. Name the new gate tests with the `TestMigrationGate` prefix so the landing command selects them. Exclude `PARTITION OF` children from independent table ownership, matching the installed-schema test's `NOT c.relispartition` filter; retain ownership checks for the partitioned parent. Check: C-PRC-02.
- `packages/backend/db/ownership.csv`: planned:<ticket> rows at Ready; convert planned status at landing. Update `packages/backend/db/product/ownership_manifest_integration_test.go` to distinguish planned tables from installed tables without weakening installed-schema parity. Check: C-PRC-02.
- `scripts/renumber-migration.mjs` (new): existing `scripts/commit.mjs` handles publication but has no migration renumbering; the registry test detects parity but cannot rename files or regenerate sqlc. Add only the missing landing helper, reusing `packages/backend/db/product/sqlc.yaml` and the sqlc v1.30.0 pin in `PACKAGE.ts`. Assign the landing number to an unlanded migration only, rename it, update `packages/backend/db/product/migrate.go` registry and regenerate sqlc output. Refuse to renumber any file already on `origin/main`, even if the local database has not applied it. Establish that the file is unlanded before changing any file; refuse if that cannot be established. Preserve all landed migration filenames, numbers and checksums. Check: C-PRC-02.
- `scripts/commit.mjs --push` and LAND.md: require `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` before either supported VCS push path. Run the DB-free gate after renumbering and regeneration. Any nonzero exit refuses publication and preserves the gate output. Keep the T-PRC-01 drift gates. Check: C-PRC-02.

Out:
- Product runtime behavior, executing migrations against PostgreSQL for this gate, changing private-schema ownership, renumbering any file already on `origin/main`, rewriting landed/applied migrations, and unrelated SQL/schema repairs. This ticket adds no product table. Machine/root-boundary implementation belongs to T-SEC-01 and the R4/R5 follow-ups; new check runners, publication commands, app/CLI surfaces and public TypeScript library exports are out of scope.

## Changes

- Reshape `packages/backend/db/product/migration_registry_test.go` and reuse `migrationRegistry`, embedded migrations and the existing ownership CSV reader. Add `TestMigrationGate` cases in that existing test file; no parallel gate test file or registry. DB-free migration tests in the default Go target (`//:backendGo`, declared in root `PACKAGE.ts`) for dense numbering, registry/embed parity, duplicate CREATE and created/dropped ownership. Name the new gate tests with the `TestMigrationGate` prefix so the landing command selects them. Exclude `PARTITION OF` children from independent table ownership, matching the installed-schema test's `NOT c.relispartition` filter; retain ownership checks for the partitioned parent. Check: C-PRC-02.
- `packages/backend/db/ownership.csv`: planned:<ticket> rows at Ready; convert planned status at landing. Update `packages/backend/db/product/ownership_manifest_integration_test.go` to distinguish planned tables from installed tables without weakening installed-schema parity. Check: C-PRC-02.
- `scripts/renumber-migration.mjs` (new): existing `scripts/commit.mjs` handles publication but has no migration renumbering; the registry test detects parity but cannot rename files or regenerate sqlc. Add only the missing landing helper, reusing `packages/backend/db/product/sqlc.yaml` and the sqlc v1.30.0 pin in `PACKAGE.ts`. Assign the landing number to an unlanded migration only, rename it, update `packages/backend/db/product/migrate.go` registry and regenerate sqlc output. Refuse to renumber any file already on `origin/main`, even if the local database has not applied it. Establish that the file is unlanded before changing any file; refuse if that cannot be established. Preserve all landed migration filenames, numbers and checksums. Check: C-PRC-02.
- `scripts/commit.mjs --push` and LAND.md: require `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` before either supported VCS push path. Run the DB-free gate after renumbering and regeneration. Any nonzero exit refuses publication and preserves the gate output. Keep the T-PRC-01 drift gates. Check: C-PRC-02.
- LAND.md (new landing instructions; absent in the code clone) documents the gate command and the refusal to renumber any file already on `origin/main`. Check: C-PRC-02.

## Tests

C-PRC-02 (folded steps and assertions):
1. Run the gate as part of the default production `//:backendGo` target with that target's normal PostgreSQL prerequisites. Separately run the selected production gate with DB URLs unset and PostgreSQL unavailable; the migration gate itself needs no DB. Use committed literal SQL/CSV fixtures and literal expected results, never runtime spec Markdown or the parser under test.
2. Insert duplicate numbers, a gap, registry/embed mismatch and duplicate CREATE including IF NOT EXISTS. Record a nonzero gate exit for each fixture.
3. Create an unowned table, a table planned for another ticket, and drop a table without removing ownership. Include a partitioned parent with ownership and a `PARTITION OF` child without an independent ownership row; remove the parent's ownership to test refusal.
4. Reserve a fixture table in packages/backend/db/ownership.csv, invoke production scripts/renumber-migration.mjs <file> with pinned sqlc in the fixture machine, and verify literal filename, registry entry, generated output and planned-status conversion. Assert landed migration bytes and checksums remain unchanged.
5. Invoke the helper on a migration already present on fixture `origin/main`, without applying it to a database. Record refusal and compare migration, registry, ownership and generated bytes before and after the attempt. Also test refusal when the helper cannot establish that the file is unlanded.
6. Invoke production `scripts/commit.mjs --push` for both supported VCS paths. Duplicate-number and gap fixtures each fail with zero push attempts. A clean fixture logs `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` after renumbering/regeneration and before exactly one intercepted push. Preserve the T-PRC-01 gate coverage. Expected values and gate order are literal fixtures, not spec or production-output oracles.

Pass when:
- The migration gate rejects each invalid fixture through the default target and selected invocation. The selected gate needs no DB; the full default target retains PostgreSQL for unrelated integration tests.
- Planned ownership passes for its named ticket and refuses another ticket. Partition children need no independent ownership row; their parent remains checked.
- Renumbering an unlanded file leaves dense unique numbers, registry/embed parity, converted planned ownership and regenerated output.
- The helper refuses every file already on fixture `origin/main`, even when no database has applied it, and changes no fixture bytes on refusal. It also refuses when unlanded status cannot be established.
- Both production push paths run the selected DB-free gate before publication. Gate failure records nonzero, preserves output and reaches no push; a clean fixture reaches one push after all required gates.
- Planned rows do not count as installed tables; existing installed-schema parity still holds. Repository Go tests and generator commands run only in machines without live DB/publication credentials.

Fail when:
- A defective fixture reaches the push or close seam, or either supported push path skips the selected migration gate.
- The helper renumbers a file already on `origin/main`, proceeds without establishing unlanded status, or changes any fixture bytes on refusal.
- Ownership requires an independent row for a partition child or omits the partitioned parent.
- A valid fixture fails, or prose PASS claims replace observed output.


- Unit: extend `packages/backend/db/product/migration_registry_test.go` with `TestMigrationGate` cases implementing C-PRC-02. Run through the default production `//:backendGo` target with its normal prerequisites, and separately run `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` with database URLs unset and PostgreSQL unavailable. Literal fixture migrations and CSV rows cover dense numbering, registry/embed parity, duplicate CREATE (including IF NOT EXISTS), unowned tables, another ticket's reservation and dropped ownership. A partitioned parent requires ownership; its `PARTITION OF` child needs no independent ownership row. Do not derive expected outcomes from spec Markdown or the parser under test.
- Integration: C-PRC-02 invokes production `scripts/renumber-migration.mjs <file>` in an isolated fixture checkout with the pinned sqlc generator. Assert literal assigned filename, registry entry and generated output. A file already on fixture `origin/main` is refused before any write, including when no database has applied it; compare all migration, registry, ownership and generated bytes before and after refusal. Exercise planned-row conversion through the same landing helper. Fixture violations fail the gate; planned rows pass only for their literal ticket owner.
- Landing integration: C-PRC-02 invokes production `scripts/commit.mjs --push` for both supported VCS paths in isolated fixture checkouts. Execute the local DB-free gate; intercept only remote publication. Duplicate-number and gap fixtures each return nonzero with gate output and zero push attempts. A clean fixture records `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` after renumbering/regeneration and before its single push attempt, alongside the T-PRC-01 gates. Use literal command-order assertions and command logs.

- Security integration: `C-PRC-02/generator-uid-before-repository-use` uses the production machine dispatcher and installed main-pinned helper. Independently observe empty supplementary groups and the literal non-root guest UID/GID before SQL/CSV, helper source, test source or sqlc config is consumed. A hostile root-identity request is refused by the trusted dispatcher before branch code starts; no root canary runs and fixture bytes stay unchanged. Missing R1–R3, R4 or applicable R5 approval refuses dispatch/preparation. Go tests, sqlc and landing fixtures have no live DB or publication credentials; intercept only remote publication. Expected identity, refusal and sentinel values are committed literals. Check: C-PRC-02.

## Acceptance

- [C-PRC-02](../checks/C-PRC-02.md): every Pass when assertion holds.

## Risks and notes

- Reserve tables, not migration numbers. Frozen tickets receive follow-ups. Before start, smithers-3f and smithers-8a approve the planned-row format and current migration inventory, including any pre-existing numbering violations; no fixture or renumber command changes landed history. smithers-22 accepts the landing-helper integration; Public TypeScript library exports are out of scope; smithers-38 must accept a scope change under §21.1 before such an export is changed.
- The gate reads SQL/CSV as data and never evaluates SQL. Its Go tests and renumber/sqlc commands execute repository code only in machines (M-29), without live database or publication credentials. smithers-3f reviews this boundary. C-PRC-02 runs the DB-free case with PostgreSQL unavailable.

## Criterion 6 root-input inventory

The following audited inputs include historical paths and hostile refusal fixtures. They do not authorize branch-built bytes at root. The Scope source restrictions govern accepted inputs. smithers-3f reviews every boundary: T-SEC-01's `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks` and `TestRootPreflightParsesOnlyEnvelope` cover R1, R2 and R3 respectively; `TestRootLayerInputsValidatedBeforeUse` covers each R4 substep; `TestRootManagedArtifactInstallUsesApprovedBundleOnly` covers R5. Branch/member-derived data blocks privileged use until the applicable named test proves validation. These are required evidence, not claims that the tests already pass. Check: C-PRC-02.

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
- Terminal request ID, `/run/smithers/requests` directory/ancestors, request JSON bytes, ownership/mode, stdin/file descriptors, terminal size and signals: main/install-controlled transport and IDs; branch/member-controlled payload and retained entries. `TestRootPreflightParsesOnlyEnvelope` proves protected no-follow request creation/read/removal and bounded parsing before privileged use.
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

## Ready checklist

1. Dependencies: Depends on — matches the index; existing registry/embed, ownership manifest, backendGo and pinned sqlc are reused. Scope names fail-closed enablement for T-SEC-01, the T-MCH-10 R4 follow-up, applicable T-FLW-01 R5 follow-up and T-PRC-01; no new code/schema call requires a ticket edge. Check: C-PRC-02.
2. Exclusions: Scope excludes live-DB gate execution, private-schema changes, landed rewrites, new tables, unrelated repairs, root-boundary implementation, new runners/publication commands, app/CLI surfaces and public TypeScript exports.
3. Boundary: C-PRC-02 uses the default backendGo target, the selected no-DB gate, production renumber helper, both production commit --push paths and production machine dispatch. Committed literal fixtures define expectations; no runtime spec or production-derived oracle is allowed.
4. Decisions: smithers-3f accepts parser/CSV encoding, inventory, migration safety and security receipts; smithers-8a accepts reservations and resolves claims; smithers-22 accepts landing integration and enablement. smithers-38 accepts any scope change involving public TypeScript exports.
5. Owner pre-review: smithers-3f's recorded answers stand (BLOCKING edits applied; tech lead adopts). Questions: Does CSV preserve target ownership and distinguish planned from installed? Can the gate check duplicates, drops and parity without PostgreSQL? Do renumbering and machine dispatch preserve landed history and the non-root boundary? smithers-22 reviews the landing seam: Where does the helper run before publication? Do both push paths refuse absent or failed migration/drift gates? Does credential isolation preserve the local gate output? Owner review is post hoc under the parallel-build directive; no app, UI View or TypeScript library seam is changed. Check: C-PRC-02.
6. Security: repository tests, helper and sqlc run only as unprivileged machine users without live DB/publication credentials. The R1–R5 inventory names each root input and its source; the named validation tests and generator UID case prove validation before use. Scope refuses unavailable security providers/receipts; branch-built root code is always forbidden. smithers-3f reviews and accepts this evidence. Check: C-PRC-02.


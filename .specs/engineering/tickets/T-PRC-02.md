# T-PRC-02 DB-free migration gate and planned table ownership at Ready

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3614](https://github.com/smithersai/smithers/issues/3614)
Spec: spec.md §21.3 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-3f + smithers-8a
Ready: 2026-10-02 smithers-8a sha256:e4c4fc5b8fda

## Goal

At Ready, smithers-8a records every new table in `packages/backend/db/ownership.csv` as `planned:<ticket>` with one named engineering owner. Keep the existing `table,target_owner,status` columns and product/private/retired target owners; record the planned ticket and engineering owner in status. smithers-3f approves the planned-row encoding and SQL parsing rules; smithers-8a accepts reservations and resolves competing claims. Reserve tables before implementation; assign migration numbers at landing. The default Go target runs DB-free checks for unique, gapless numbers, registry/embed parity, duplicate CREATE statements (IF NOT EXISTS included), ownership of created tables and removal of dropped tables. A lane cannot create a table planned for another ticket. `scripts/renumber-migration.mjs <file>` renames the migration, updates the registry and regenerates sqlc output at landing. The helper refuses any file already on `origin/main`. `scripts/commit.mjs --push` runs `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` before any push and refuses publication on failure. Check: C-PRC-02.

## Scope

In:
- `packages/backend/db/product/`: DB-free migration tests in the default Go target (`//:backendGo`, declared in root `PACKAGE.ts`) for dense numbering, registry/embed parity, duplicate CREATE and created/dropped ownership. Name the new gate tests with the `TestMigrationGate` prefix so the landing command selects them. Exclude `PARTITION OF` children from independent table ownership, matching the installed-schema test's `NOT c.relispartition` filter; retain ownership checks for the partitioned parent. Check: C-PRC-02.
- `packages/backend/db/ownership.csv`: planned:<ticket> rows at Ready; convert planned status at landing. Update `packages/backend/db/product/ownership_manifest_integration_test.go` to distinguish planned tables from installed tables without weakening installed-schema parity. Check: C-PRC-02.
- `scripts/renumber-migration.mjs` (new): assign the landing number to an unlanded migration only, rename it, update `packages/backend/db/product/migrate.go` registry and regenerate sqlc output. Refuse to renumber any file already on `origin/main`, even if the local database has not applied it. Establish that the file is unlanded before changing any file; refuse if that cannot be established. Preserve all landed migration filenames, numbers and checksums. Check: C-PRC-02.
- `scripts/commit.mjs --push` and LAND.md: require `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` before either supported VCS push path. Run the DB-free gate after renumbering and regeneration. Any nonzero exit refuses publication and preserves the gate output. Keep the T-PRC-01 drift gates. Check: C-PRC-02.
- `.specs/engineering/tickets/README.md`: require planned table ownership at Ready and mechanical numbering at landing. Check: C-PRC-02.

Out:
- Product runtime behavior, executing migrations against PostgreSQL for this gate, changing private-schema ownership, renumbering any file already on `origin/main`, rewriting landed/applied migrations, and unrelated SQL/schema repairs. This ticket adds no product table.

## Changes

- `packages/backend/db/product/`: DB-free migration tests in the default Go target (`//:backendGo`, declared in root `PACKAGE.ts`) for dense numbering, registry/embed parity, duplicate CREATE and created/dropped ownership. Name the new gate tests with the `TestMigrationGate` prefix so the landing command selects them. Exclude `PARTITION OF` children from independent table ownership, matching the installed-schema test's `NOT c.relispartition` filter; retain ownership checks for the partitioned parent. Check: C-PRC-02.
- `packages/backend/db/ownership.csv`: planned:<ticket> rows at Ready; convert planned status at landing. Update `packages/backend/db/product/ownership_manifest_integration_test.go` to distinguish planned tables from installed tables without weakening installed-schema parity. Check: C-PRC-02.
- `scripts/renumber-migration.mjs` (new): assign the landing number to an unlanded migration only, rename it, update `packages/backend/db/product/migrate.go` registry and regenerate sqlc output. Refuse to renumber any file already on `origin/main`, even if the local database has not applied it. Establish that the file is unlanded before changing any file; refuse if that cannot be established. Preserve all landed migration filenames, numbers and checksums. Check: C-PRC-02.
- `scripts/commit.mjs --push` and LAND.md: require `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` before either supported VCS push path. Run the DB-free gate after renumbering and regeneration. Any nonzero exit refuses publication and preserves the gate output. Keep the T-PRC-01 drift gates. Check: C-PRC-02.
- LAND.md documents the gate command and the refusal to renumber any file already on `origin/main`. Check: C-PRC-02.

## Tests

- Unit: `packages/backend/db/product/migration_gate_test.go` (new) implements C-PRC-02 alongside the existing registry test. Run through the default production `//:backendGo` Go-test invocation and `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` with database URLs unset and PostgreSQL unavailable. Literal fixture migrations and CSV rows cover dense numbering, registry/embed parity, duplicate CREATE (including IF NOT EXISTS), unowned tables, another ticket's reservation and dropped ownership. A partitioned parent requires ownership; its `PARTITION OF` child needs no independent ownership row. Do not derive expected outcomes from spec Markdown or the parser under test.
- Integration: C-PRC-02 invokes production `scripts/renumber-migration.mjs <file>` in an isolated fixture checkout with the pinned sqlc generator. Assert literal assigned filename, registry entry and generated output. A file already on fixture `origin/main` is refused before any write, including when no database has applied it; compare all migration, registry, ownership and generated bytes before and after refusal. Exercise planned-row conversion through the same landing helper. Fixture violations fail the gate; planned rows pass only for their literal ticket owner.
- Landing integration: C-PRC-02 invokes production `scripts/commit.mjs --push` for both supported VCS paths in isolated fixture checkouts. Execute the local DB-free gate; intercept only remote publication. Duplicate-number and gap fixtures each return nonzero with gate output and zero push attempts. A clean fixture records `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` after renumbering/regeneration and before its single push attempt, alongside the T-PRC-01 gates. Use literal command-order assertions and command logs.

## Acceptance

- [C-PRC-02](../checks/C-PRC-02.md): every Pass when assertion holds.

## Risks and notes

- Reserve tables, not migration numbers. Frozen tickets receive follow-ups. Before start, smithers-3f and smithers-8a approve the planned-row format and current migration inventory, including any pre-existing numbering violations; no fixture or renumber command changes landed history. smithers-22 accepts the landing-helper integration; smithers-38 signs off any changed public TypeScript library export under §21.1.
- The gate reads SQL/CSV as data and never evaluates SQL. Its Go tests and renumber/sqlc commands execute repository code only in machines (M-29), without live database or publication credentials. smithers-3f reviews this boundary. C-PRC-02 runs the DB-free case with PostgreSQL unavailable.

## Ready checklist

1. Dependencies: no MVP runtime ticket is required; existing migrationRegistry/embed, ownership manifest, root backendGo target and pinned sqlc are the base. Approve the current inventory and planned-row format before enabling the gate.
2. Exclusions: live-DB gate execution, private-schema changes, landed migration rewrites, new tables and unrelated repairs are explicit.
3. Boundary: C-PRC-02 exercises the default Go-test path, a no-DB selected-gate invocation, and the production renumber command with literal fixtures and generated output.
4. Decisions: smithers-3f approves parser/encoding and migration safety; smithers-8a accepts reservations and resolves claims; smithers-22 accepts landing integration; smithers-38 signs off any public TypeScript export.
5. Owner pre-review before start: smithers-3f asks: Does the CSV format preserve target ownership and distinguish planned from installed tables? Can duplicate CREATE, drops and registry/embed drift be checked without PostgreSQL? Does renumbering leave landed history unchanged? smithers-22 asks: Where does the production landing path invoke the helper before publishing? smithers-3f: answered, BLOCKING edits applied (tech lead adopts). The DB-free gate runs before push, the helper refuses files already on `origin/main`, and partition children follow the installed ownership filter. Check: C-PRC-02.
6. Root-input inventory: SQL/CSV parsing, renumber, Go tests and sqlc execute as an unprivileged guest user; root target location is not root identity. Machine preparation/supervision consumes R1–R4 (R5 when using the coding host): shipped helper/scripts/artifacts and fixed identity/path/env (main/install-controlled); image/snapshot/account/cgroup/home/cache/guest filesystem (install-controlled with member/branch-derived entries); target-index/tool/version/manifests/declared archives (branch); machine.json additions (main); upstream OCI/tool/apt/GitHub responses. Repository SQL/CSV/registry/query/sqlc config/test/helper source, path argv/env/cwd and outputs are branch inputs and must not execute at uid 0; landed-history facts come from main/GitHub. Root executable, script, plist and toolchain bytes come only from main-pinned or installed-bundle sources; branch-built bytes are forbidden at root. R4 reads the target index only from main, runs toolchain steps as agent, and validates destinations before use. Lands only after T-SEC-01 (R1–R3) and `TestRootLayerInputsValidatedBeforeUse`, `TestRootManagedArtifactInstallUsesApprovedBundleOnly`, `C-PRC-02/generator-uid-before-repository-use` pass; may start before. R4 is owned by T-MCH-10’s sec10 follow-up; R5 is owned by T-FLW-01’s follow-up where used. R5 proves artifact bytes come only from the installed bundle/catalog digest, never the branch.

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


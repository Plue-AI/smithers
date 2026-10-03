# T-PRC-02 DB-free migration gate and planned table ownership at Ready

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3614](https://github.com/smithersai/smithers/issues/3614)
Spec: spec.md §21.3 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-3f + smithers-8a
Ready: 2026-10-02 smithers-8a sha256:76be93ef738b

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
6. Security: SQL and CSV are inert input; Go tests and renumber/sqlc run only in machines under M-29 with no live DB/publication credentials. smithers-3f reviews execution and path confinement; C-PRC-02 proves the gate needs no database.


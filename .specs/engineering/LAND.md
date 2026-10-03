# Landing procedure

1. Establish that each migration is unlanded before renumbering it. Assign numbers only at landing and regenerate the registry and sqlc output. Preserve landed history. Check: C-PRC-02.
2. Run the T-PRC-01 drift gates in spec.md §21.2. Refuse publication if a gate fails. Check: C-PRC-01.

Run `go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/` without PostgreSQL before any push. `scripts/commit.mjs --push` runs the same DB-free command before either supported VCS push path and refuses publication on nonzero exit, preserving the gate output. Keep the T-PRC-01 drift gates. `scripts/renumber-migration.mjs <file>` refuses to renumber any file already on `origin/main`, even if no local database has applied it. Establish that the file is unlanded before any write; refuse if that cannot be established. Check: C-PRC-02.

3. Publish only after the drift and DB-free migration gates pass. Retain gate output with the landed commit. Checks: C-PRC-01, C-PRC-02.

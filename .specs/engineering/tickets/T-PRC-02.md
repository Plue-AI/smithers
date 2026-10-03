# T-PRC-02 DB-free migration gate and planned table ownership at Ready

Stage S1 · Size S · Depends on — · Unblocks T-REL-02 · Issue: [#3614](https://github.com/smithersai/smithers/issues/3614)
Spec: spec.md §21.3 · Delta: delta.md (engineering process) · Product: mvp.md §12.1 (acceptance evidence) · Owner: smithers-3f + smithers-8a

## Goal

At Ready, the lead records every new table in `ownership.csv` as `planned:<ticket>` with one owner. Reserve tables before implementation; assign migration numbers at landing. The default Go target runs DB-free checks for unique, gapless numbers, registry/embed parity, duplicate CREATE statements (IF NOT EXISTS included), ownership of created tables and removal of dropped tables. A lane cannot create a table planned for another ticket. `scripts/renumber-migration.mjs <file>` renames the migration, updates the registry and regenerates sqlc output at landing.

## Scope

In:
- `packages/backend/db/product/`: DB-free migration tests in the default Go target for dense numbering, registry/embed parity, duplicate CREATE and created/dropped ownership.
- `packages/backend/db/product/ownership.csv`: planned:<ticket> rows at Ready; convert planned ownership at landing.
- `scripts/renumber-migration.mjs` (new): assign the landing number, rename the file, update registry and regenerate sqlc output.
- `.specs/engineering/tickets/README.md` and LAND.md: require planned table ownership at Ready and mechanical numbering at landing.

Out:
- Product runtime behavior and unrelated repairs.

## Changes

- `packages/backend/db/product/`: DB-free migration tests in the default Go target for dense numbering, registry/embed parity, duplicate CREATE and created/dropped ownership.
- `packages/backend/db/product/ownership.csv`: planned:<ticket> rows at Ready; convert planned ownership at landing.
- `scripts/renumber-migration.mjs` (new): assign the landing number, rename the file, update registry and regenerate sqlc output.
- `.specs/engineering/tickets/README.md` and LAND.md: require planned table ownership at Ready and mechanical numbering at landing.

## Tests

- unit: `packages/backend/db/product/migration_gate_test.go` implements C-PRC-02 with positive and refusal fixtures.

## Acceptance

- [C-PRC-02](../checks/C-PRC-02.md): every Pass when assertion holds.

## Risks and notes

- Reserve tables, not migration numbers. Frozen tickets receive follow-ups.

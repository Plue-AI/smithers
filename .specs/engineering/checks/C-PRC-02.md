# C-PRC-02 DB-free migration gate and planned table ownership at Ready

Proves: spec.md §21.3 · Layer: unit · Stage: S1 · Tickets: T-PRC-02
Automation: `packages/backend/db/product/migration_gate_test.go` (new) · Runs in: CI (isolated fixture checkout; no live push or issue write)

## Setup

An isolated fixture checkout with a recorded commit and command logs. Stub remote writes only; execute the local production gate.

## Steps

1. Run the migration gate with no PostgreSQL on a valid fixture registry.
2. Insert duplicate numbers, a gap, registry/embed mismatch and duplicate CREATE including IF NOT EXISTS.
3. Create an unowned table, a table planned for another ticket, and drop a table without removing ownership.
4. Reserve the fixture table at Ready, then renumber and regenerate at landing.

## Pass when

- The gate needs no DB and rejects each invalid fixture.
- Planned ownership passes for its named ticket and refuses another ticket.
- Renumbering leaves dense unique numbers, registry/embed parity and regenerated output.

## Fail when

- A defective fixture reaches the push or close seam.
- A valid fixture fails, or prose PASS claims replace observed output.

## Evidence

`.artifacts/checks/C-PRC-02/<ts>/`: fixture inputs, per-step command logs and exit codes, refusal assertions, log digests and tested commit. T-PRC-03 adds receipt.json when its runner lands.

# C-GH-13 GitHub facts use one pure decision seam

Proves: spec.md §4.1, §12.3 · Layer: integration · Stage: S1 · Tickets: T-GH-04, T-GH-05, T-GH-06
Automation: `packages/backend/internal/services/github_inbound_test.go` and `packages/backend/internal/services/github_inbound_db_test.go` (new) · Runs in: CI (pure matrix without PostgreSQL; consumer tests with real PostgreSQL and fake GitHub)

## Setup

Committed literal fixtures for the §12.3 fact TSV, every TODO state, first/duplicate/reordered facts and a fixed clock. Expected results are reviewed fixtures, not production-derived values. Seed one TODO for each production consumer.

## Steps

- Decode the shared github_check facts {name, state, required, url}, ActorSchema kind:"github" authors and foreign_push waits with id/sha via T-APP-19b (#3601). Assert wrong attention/wait bindings refuse with no effects; no parallel check or actor model exists.
1. Call `decideGitHubFact(fact, todo, item, now)` for every matrix cell.
2. Deliver poll, review and foreign-push facts through their production consumer with real PostgreSQL.
3. Repeat and reorder each delivery and inspect semantic events and activity.
4. Crash each T-GH-05 inbound consumer before commit, after commit and after a keyed remote effect succeeds but before acknowledgement. Restart and replay through production polling. Exercise both merge and completion check callers against the synced-head fixtures.

## Pass when

- Decode the shared github_check facts {name, state, required, url}, ActorSchema kind:"github" authors and foreign_push waits with id/sha via T-APP-19b (#3601). Assert wrong attention/wait bindings refuse with no effects; no parallel check or actor model exists.

- Step 4: before-commit crash leaves no receipt, transition, projection or outbound intent. After-commit restart retains one complete atomic set. Replays and remote-success recovery add no effective close or comment. Merge and completion read synced facts with no second per-head REST path; the completion comment retains the literal named checks.
- Every cell has one asserted `Events`, `Noop reason` or `Attention kind` result; an unknown cell fails.
- Each consumer uses the pure decision, not a private mapping. Item mutation follows its events.
- Duplicate and stale facts record no-ops without repeated merge, issue-close or learning effects.

## Fail when
- A cell is unasserted, a consumer bypasses the seam, or duplicate delivery repeats an effect.

## Evidence
`.artifacts/checks/C-GH-13/<ts>/`: matrix counts, per-cell results, consumer database/event dumps, fake GitHub log, tested commit and C-PRC-03 receipt.

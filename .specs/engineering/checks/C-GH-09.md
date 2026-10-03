# C-GH-09 One pending GitHub operation per item survives restart

Proves: mvp.md §6.1 "Restart", §9 "Durability" · spec.md §3 (`pending_op`), §12.4.1, §12.4.1b, §12.5.2, §19.2 · Layer: fault · Stage: S1 · Tickets: T-GH-09, T-GH-01
Automation: `packages/backend/internal/services/github_outbound_fault_test.go` · Runs in: CI with real PostgreSQL and githubfake

## Setup
Use production install composition, literal expected item rows, a canonical App identity and a bare remote. Prepare one item for each kind: push, open PR, body, merge, close PR.

## Steps
1. For every kind, stop the production service and database pool before send, after potentially-sent commit, after remote success and before local settlement.
2. Restart on the same database and remote; record lookup, any repeat, item facts and pending_op.
3. Hold an open-PR response, Drop, restart and release the response.
4. Hold body v1, request v2; also race a push against a foreign head and close against a person's later reopen.
5. Recover a merge with revoked authority, stale head, missing approval or competing fence; repeat with GitHub already reporting merged.
6. Supply matching event/comment markers from a person, another App and the canonical App. Attempt machine-proxy mutations.

## Pass when
- One pending_op per item; no later operation overwrites or passes an uncertain slot. Every uncertain repeat follows lookup. The expected fixture state settles within 60 s.
- One effective PR, merge and close; push preserves a foreign head and reports conflict. Body v2 follows settled v1. A person's reopen is not undone.
- Drop closes a late-created PR once. Merge repeats only with its bound head, current maintainer authority and shared readiness; already merged settles without another PUT.
- Canonical App identity is required for marker/event settlement. Machine proxy mutations issue no token and make no upstream call.
- Labels, unlabels, comments and issue-close remain best-effort; comment retries use the existing marker. These are not queued writes.
- Recovery receipt and literal expected item state agree; no fabricated success or approval.

## Fail when
Any duplicate effective operation, blind repeat, foreign overwrite, unauthorized send or lost Drop obligation occurs.

## Evidence
Record fixture identity, commit, write log, before/after pending_op, lookup result, item state and recovery receipt for each case.

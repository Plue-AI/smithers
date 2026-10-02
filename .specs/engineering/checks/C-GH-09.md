# C-GH-09 A crash during each outbound write produces no duplicate

Proves: mvp.md §6.1 "Restart", §9 "Durability" · spec.md §3 (`outbound_writes`), §12.4.1, §19.2 · Layer: fault · Stage: S1 · Tickets: T-GH-09
Automation: `packages/backend/internal/services/github_outbound_fault_test.go` (new) · Runs in: CI

## Setup
- Real PostgreSQL and real git. `githubfake` with its write log and per-request hooks; its git smart HTTP serves a bare repository.
- For each write kind, a TODO in the state just before that write: verified and unproposed (open PR, push); In review with a new body (update body); first in order with green checks and a recorded `reviewed_head_sha` (merge); being dropped with a PR open (close PR); merged with `fixes_issue` (close issue); a committed Make TODO (add label); a non-member's label to revert (revert label); a completion notice due (comment).
- A control run of each case without a crash, recorded as the expected final state.

## Steps
For each kind K in {open PR, update body, merge, close PR, close issue, add label, revert label, comment, push} and each kill point P:
- P1, after the key is recorded `intended` and before the request is sent;
- P2, after the fake server applied the write and before the response is returned;
- P3, after the response and before the row is settled `done`;

1. Arm the hook for (K, P).
2. Run the worker step. At P the hook stops the service: the test cancels its context, closes its database pool and drops every in-memory value.
3. Build a fresh service on the same database and fake server and run its reconcile, then the worker step.
4. Read the write log, the `outbound_writes` rows and the TODO.

## Pass when
For all 27 cases:
- The write log shows exactly one effective object per key: one PR per head branch, one comment per marker, at most one successful `PUT /merge` and no merge request after it, one close per PR or issue, each label applied or removed once, and the remote ref equal to the intended head after one ref update.
- At P2 and P3, a lookup request (`GET`, or `git ls-remote` for push) precedes any repeat of the write.
- The `outbound_writes` row is `done` with the GitHub object id or sha in `github_ref`.
- The TODO's state equals the control run's.

## Fail when
- A second PR, comment, close or merge appears, or a PR opens on a new branch name to dodge "already exists".
- A write repeats with no lookup first.
- A push overwrites a head that wasn't the expected one.
- A row stays `intended` or `unknown`, or the TODO shows a state the control run never reaches.

## Evidence
`.artifacts/checks/C-GH-09/<UTC timestamp>/`: one directory per (K, P) with `writes.jsonl`, `outbound_writes.json` and `todo.json`; `summary.json` of 27 results; the test log and the commit.

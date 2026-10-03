# C-GH-09 Outbound writes: no duplicate at any crash point, and no replay over a newer action

Proves: mvp.md §6.1 "Restart", §9 "Durability" · spec.md §3 (`outbound_writes`), §12.4.1, §12.4.1a, §12.4.1b, §12.5.2, §19.2 · Layer: fault · Stage: S1 · Tickets: T-GH-09, T-GH-14
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

Then run four ordering cases, each ending with a fresh service, its reconcile and its worker step:
- O1, contrary action: Smithers closes T2's PR on Drop; the fake applies the close, and the service stops at P2. While it is down, `alice` reopens the PR on the fake.
- O2, superseded intent: T3's PR has a `ready` write recorded and unsent when T3 moves down and a `draft` write is recorded. Repeat with the `ready` write sent, its response held, and the service stopped.
- O3, late response: the fake holds the response to body write v1 for 30 s, and body v2 is recorded meanwhile.
- O4, lease: a push leased against `A2` (a Discard decision) is recorded; before it is sent, `alice` pushes `A3` to the branch on the fake.

## Pass when
For all 27 cases:
- The write log shows exactly one effective object per key: one PR per head branch, one comment per marker, at most one successful `PUT /merge` and no merge request after it, one close per PR or issue, each label applied or removed once, and the remote ref equal to the intended head after one ref update.
- At P2 and P3, a lookup request (`GET`, or `git ls-remote` for push) precedes any repeat of the write.
- The `outbound_writes` row is `done` with the GitHub object id or sha in `github_ref`.
- The TODO's state equals the control run's.

For the ordering cases:
- O1: reconcile finds the App's `closed` event and settles the row `done` with `settled_by: event`. No second close is sent, the PR stays open, and T2 follows the §12.3 reopen row.
- O2: the unsent `ready` row is `superseded` and never sent. With it sent and held, the `draft` write starts only after reconcile settles `ready`. The PR ends as a draft.
- O3: body v2 is sent only after v1 is settled, and the PR ends with v2. v1 is never written after v2.
- O4: the lease refuses the push, the row settles `conflict`, `A3` stays the remote head, and T4's Needs you names `A3`.

## Fail when
- A second PR, comment, close or merge appears, or a PR opens on a new branch name to dodge "already exists".
- A write repeats with no lookup first.
- A push overwrites a head that wasn't the expected one.
- A write to a target is sent while an earlier write to it is unsettled, or a `superseded` row is sent.
- Reconcile repeats a write whose target a person changed since, such as closing a PR again after `alice` reopened it.
- A row stays `intended` or `unknown`, or the TODO shows a state the control run never reaches.

## Evidence
`.artifacts/checks/C-GH-09/<UTC timestamp>/`: one directory per (K, P) with `writes.jsonl`, `outbound_writes.json` and `todo.json`; `summary.json` of 27 crash results and 4 ordering results; the test log and the commit.

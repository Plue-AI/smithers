# C-GH-09 Outbound writes: no duplicate at any crash point, and no replay over a newer action

Proves: mvp.md §6.1 "Restart", §9 "Durability" · spec.md §3 (`outbound_writes`), §12.4.1, §12.4.1a, §12.4.1b, §12.5.2, §19.2 · Layer: fault · Stage: S1 · Tickets: T-GH-09, T-GH-14
Automation: `packages/backend/internal/services/github_outbound_fault_test.go` (new) · Runs in: CI

## Setup
- Real PostgreSQL and real git. `githubfake` with its write log and per-request hooks; its git smart HTTP serves a bare repository.
- For each write kind, a TODO in the state just before that write: verified and unproposed (open PR, push); In review with a new body (update body); first in order with green checks and a recorded `reviewed_head_sha` (merge); being dropped with a PR open (close PR); merged with `fixes_issue` (close issue); a committed Make TODO (add label); a non-member's label to revert (revert label); a completion notice due (comment).
- Committed literal expected final rows and effective-object counts for each write kind, reviewed by smithers-3f. An uncrashed control run is diagnostic only and supplies no expected values.

- Run boot recovery through production install composition. Test merge readiness and authorization through T-STK-04's production gate after that caller lands; those consumer cases remain pending until then. Literal fixtures cover ready/draft crash points, canonical install-App events, a human or another App quoting a marker, and unsent/unknown merge intents whose approving member lost authority.

## Steps
For each kind K in {open PR, update body, merge, close PR, close issue, add label, revert label, comment, push} and each kill point P:
- P1, after the key is recorded `intended` and before the request is sent;
- P2, after the fake server applied the write and before the response is returned;
- P3, after the response and before the row is settled `done`;

1. Arm the hook for (K, P).
2. Run the worker step. At P the hook stops the service: the test cancels its context, closes its database pool and drops every in-memory value.
3. Restart through production install composition on the same database and fake server; boot recovery reconciles outbound work before the worker resumes.
4. Read the write log, the `outbound_writes` rows and the TODO.

Then run four ordering cases, each ending with a fresh service, its reconcile and its worker step:
- O1, contrary action: Smithers closes T2's PR on Drop; the fake applies the close, and the service stops at P2. While it is down, `alice` reopens the PR on the fake.
- O2, superseded intent: T3's PR has a `ready` write recorded and unsent when T3 moves down and a `draft` write is recorded. Repeat with the `ready` write sent, its response held, and the service stopped.
- O3, late response: the fake holds the response to body write v1 for 30 s, and body v2 is recorded meanwhile.
- O4, lease: a push leased against `A2` (a Discard decision) is recorded; before it is sent, `alice` pushes `A3` to the branch on the fake.

Exercise every production GitHub writer: TODO issue creation, landing push and PR creation, outbound mirror push, and check-run creation, cancellation and terminal updates, in addition to existing kinds. Kill before the intended-to-unknown commit, after that commit before the call, and after remote success before local settlement. Only intended is unsent. Every kind durably commits unknown before dispatch; restart looks up unknown work before repeat and produces the literal intended effect once. Preserve per-target order and atomic mirror ref-set preconditions.

Use a member, another App and the canonical App to supply matching comment markers and issue/PR events. Settle by event or marker only when performed_via_github_app.id equals T-GH-14 AppID(). Drive POST/PUT/PATCH/DELETE through the production machine proxy for PRs, refs and check-runs; refuse before token issuance or remote dispatch, with zero outbound rows and upstream calls. Authorized host commands use the keyed outbound module.

## Pass when
For all baseline and extended cases:
- The write log shows exactly one effective object per key: one PR per head branch, one comment per marker, at most one successful `PUT /merge` and no merge request after it, one close per PR or issue, each label applied or removed once, and the remote ref equal to the intended head after one ref update.
- At P2 and P3, a lookup request (`GET`, or `git ls-remote` for push) precedes any repeat of the write.
- The `outbound_writes` row is `done` with the GitHub object id or sha in `github_ref`.
- The TODO's state equals its committed literal expected fixture row.

For the ordering cases:
- O1: reconcile finds the App's `closed` event and settles the row `done` with `settled_by: event`. No second close is sent, the PR stays open, and T2 follows the §12.3 reopen row.
- O2: the unsent `ready` row is `superseded` and never sent. With it sent and held, the `draft` write starts only after reconcile settles `ready`. The PR ends as a draft.
- O3: body v2 is sent only after v1 is settled, and the PR ends with v2. v1 is never written after v2.
- O4: the lease refuses the push, the row settles `conflict`, `A3` stays the remote head, and T4's Needs you names `A3`.

- Exercise every production GitHub writer: TODO issue creation, landing push and PR creation, outbound mirror push, and check-run creation, cancellation and terminal updates, in addition to existing kinds. Kill before the intended-to-unknown commit, after that commit before the call, and after remote success before local settlement. Only intended is unsent. Every kind durably commits unknown before dispatch; restart looks up unknown work before repeat and produces the literal intended effect once. Preserve per-target order and atomic mirror ref-set preconditions.

- Use a member, another App and the canonical App to supply matching comment markers and issue/PR events. Settle by event or marker only when performed_via_github_app.id equals T-GH-14 AppID(). Drive POST/PUT/PATCH/DELETE through the production machine proxy for PRs, refs and check-runs; refuse before token issuance or remote dispatch, with zero outbound rows and upstream calls. Authorized host commands use the keyed outbound module.

## Fail when
- A second PR, comment, close or merge appears, or a PR opens on a new branch name to dodge "already exists".
- A write repeats with no lookup first.
- A push overwrites a head that wasn't the expected one.
- A write to a target is sent while an earlier write to it is unsettled, or a `superseded` row is sent.
- Reconcile repeats a write whose target a person changed since, such as closing a PR again after `alice` reopened it.
- A row stays `intended` or `unknown`, or the TODO differs from its committed literal expected fixture row.

## Evidence
`.artifacts/checks/C-GH-09/<UTC timestamp>/`: one directory per (K, P) with `writes.jsonl`, `outbound_writes.json` and `todo.json`; `summary.json` of all baseline and extended crash results and 4 ordering results; the test log and the commit.

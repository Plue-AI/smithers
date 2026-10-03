# T-STK-10 Evidence per attempt

Stage S1 · Size S · Depends on T-STK-01, T-FLW-11, T-FLW-04, T-FLW-07, T-GH-05, T-ACC-03, T-APP-19 · Unblocks T-APP-02, T-FLW-06, T-GH-03, T-REL-02 · Issue: [#3464](https://github.com/smithersai/smithers/issues/3464)
Spec: spec.md §3 (`todo_attempts.evidence`), §10.4.1, §10.4.3, §11.4.1, §11.6.1, §12.5.1, §14.3 (TODO card), §15.2 · Delta: delta.md §6 (Retry with attempt rows), §7 (checks evidence) · Product: mvp.md J2.5, §4.1 Failed ("earlier attempts and evidence kept"), §6.10 PR card, §6.9 Model access

## Goal
Every attempt of a TODO keeps its own evidence (diff stat, checks run on the machine with logs, the agent's review summary, GitHub checks, tokens and time, the flow version and the model access), readable on the TODO card and used by the PR body, and a later attempt never overwrites it.

## Scope

- `GET /api/todos/{n}/attempts/{attempt}/logs/{digest}` serves a log referenced by that TODO attempt only, after the normal TODO read authorization. The card’s `log_url` targets it; an unrelated digest returns 404. Check: C-J2-04 step 3 and `todo_evidence_db_test.go`.

In:
- `todo_attempts.evidence` with one schema: `{diff_stat, checks[{name, outcome, duration_ms, log_blob}], review_summary, github_checks[{name, conclusion, required}], tokens, time_ms, flow{name, digest}, model_access}`. Each part carries the candidate `generation` it describes (§10.4.3), and the PR body and the card show the accepted generation's parts.
- Writers: the attempt's one `todo` run (T-FLW-11) for machine checks, review and usage; the GitHub sync for checks on the attempt's PR head.
- Check logs stored once in the blob store and referenced by digest.
- The `todo:<n>` projection's evidence per attempt.

Out:
- PR body layout (T-GH-03); required-check names and branch protection (T-GH-05).
- Per-step cost and usage collection in the monitor (T-FLW-07). Learning's use of evidence (T-FLW-06). Wiki citations (T-FLW-10 adds a field).
- Running checks, review or repository commands on the host; retry mechanics; TODO/PR View and Container changes (T-APP-02, T-GH-03).

## Changes
- `packages/backend/internal/services/todo_evidence.go` (new) → `RecordEvidence(attempt, part)` merges one part into the attempt's row under a version check. It refuses writes to a closed attempt, except GitHub checks for that attempt's own head.
- `packages/backend/internal/services/mythical_receipts.go:66` (`mythicalRunReceipts`) → also returns each receipt's `evidence` text (`flows/coding/schema.ts:151`); `todo_evidence.go` stores it through `packages/backend/internal/blob` and keeps the digest.
- `packages/backend/internal/services/mythical_items.go:577` (`ProjectFlowRuntime`) → write receipts, the review verdict and summary (today `checks.Review`, set by `review` at `:2349`), and the run's token and time totals into the current attempt.
- Diff stat from `changedPaths` (`services/mythical_git.go:623`) plus line counts for the attempt's verified candidate.
- Consume T-GH-05's structured check projection for the attempt's PR head → `github_checks`. Today `HeadChecks` (`services/mythical_github.go:611`) returns an aggregate string, not check names and required flags; do not infer those fields from it.
- Flow `{name, digest}` from the pin recorded when the TODO entered `starting` (§11.4.1; T-FLW-04 owns the pin) and `model_access` from the run (§15.2).
- `completionBody` and `mythicalReceiptsSummary` (`mythical_items.go:3255`, `:3301`) read `todo_attempts.evidence` instead of `mythical_items.checks`.
- Extend T-APP-19's `packages/rpc/src/TodoCard.ts` evidence contract (new in that prerequisite; no `Todo.ts` exists today); `packages/backend/docs/todos.md` (new); docs gates.

## Tests
- Unit, `todo_evidence_test.go` (new): merging parts in any order gives the same row; a write to attempt 1 after attempt 2 started is refused, except GitHub checks for attempt 1's head.
- Integration with real PostgreSQL and the blob store, `todo_evidence_db_test.go` (new): a fixture run with two checks, one failing, stores two logs; the failing check's log digest resolves to its text; durations come from `startedAt`/`finishedAt`.
- Integration, same file: first-run evidence uses T-STK-01's `todo_attempts` and T-FLW-11's run receipts (C-J2-04). After T-STK-05 lands, Retry creates attempt 2 with its own evidence; attempt 1's JSON stays byte-identical. That later integration is not a landing prerequisite here.
- Integration with the fake GitHub server: check runs on the PR head land in `github_checks` of the attempt that pushed that head, not the latest attempt.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J2-04](../checks/C-J2-04.md): the PR and the TODO card show the diff, machine checks, GitHub checks and the review summary.

## Risks and notes
- T-FLW-07 supplies recorded usage and T-FLW-04 supplies the pinned closure digest before this ticket lands. Do not substitute zero for missing usage. smithers-3f owns the producer contract; smithers-8a resolves a missing-field change to §11.6.1.
- Risk: check logs grow large. Cap one log at 1 MiB with a truncation marker; the blob keeps the head and the tail.
- C-J2-04's PR-body rows also need T-GH-03, and its GitHub-check rows need T-GH-05.

## Ready checklist
1. Dependencies: the single run and candidate seam arrive through T-FLW-11; T-FLW-04 supplies the pin, T-FLW-07 the usage, T-GH-05 the head-specific check records, T-ACC-03 log authorization, and T-APP-19 the evidence view-model contract. All added edges are S1 and acyclic in the current index. T-GH-03 consumes this ticket and is required only for the later PR-body rows of C-J2-04, not for this ticket's landing.
2. Exclusions: Scope names PR layout, protection policy, cost collection, learning, wiki fields, retry mechanics, visual wiring and host execution of checks.
3. Boundary tests: `todo_evidence_db_test.go` feeds the production flowdispatch projection callback and GitHub check-sync scheduler, then reads GET /api/todos/{n} and the named log route through the production router. Literal receipts include two checks, distinct attempt/head/generation ids, known output and timestamps, usage and pin values; assert stored and returned evidence, closed-attempt refusal, wrong-head isolation, 1 MiB truncation and unauthorized/unrelated log refusal. Expected JSON and text are checked-in fixtures, never generated from spec files or production schemas at runtime. C-J2-04 runs the later real TODO/PR card integration; its downstream UI rows do not replace this landing test.
4. Decisions: smithers-3f approves evidence merge/version semantics, log-route authorization and usage/check producer contracts; smithers-38 approves the TypeScript schema; smithers-b8 signs off the public read route; smithers-8a accepts changes to generation reuse or public contract scope. The 1 MiB head/tail cap is fixed by this ticket.
5. Owner pre-review before start: smithers-3f: Are writes bound to the owning attempt and generation, including late GitHub checks? Does log authorization check the attempt's digest reference before blob access? smithers-38: Does the evidence contract extend TodoCard through its per-module subpath without a second schema? smithers-b8: Is the public log route documented and usable by the TODO card? View changes remain outside scope.
6. Security: smithers-3f reviews the inherited T-INS-02/T-FLW-11 machine boundary and the log route before start. Repository checks and review execute only inside isolated branch machines (M-29, §1.3); evidence collection never reruns them on the host. The host reads data through scoped projections and authorized blob access; C-SEC-02 covers refusal without isolation, and the boundary tests cover log access.

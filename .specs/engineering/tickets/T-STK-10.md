# T-STK-10 Evidence per attempt

Stage S1 · Size S · Depends on T-STK-05 · Unblocks T-GH-03, T-FLW-06 · Issue: [#3464](https://github.com/smithersai/smithers/issues/3464)
Spec: spec.md §3 (`todo_attempts.evidence`), §10.4.1, §10.4.3, §11.4.1, §11.6.1, §12.5.1, §14.3 (TODO card), §15.2 · Delta: delta.md §6 (Retry with attempt rows), §7 (checks evidence) · Product: mvp.md J2.5, §4.1 Failed ("earlier attempts and evidence kept"), §6.10 PR card, §6.9 Model access

## Goal
Every attempt of a TODO keeps its own evidence (diff stat, checks run on the machine with logs, the agent's review summary, GitHub checks, tokens and time, the flow version and the model access), readable on the TODO card and used by the PR body, and a later attempt never overwrites it.

## Scope
In:
- `todo_attempts.evidence` with one schema: `{diff_stat, checks[{name, outcome, duration_ms, log_blob}], review_summary, github_checks[{name, conclusion, required}], tokens, time_ms, flow{name, digest}, model_access}`. Each part carries the candidate `generation` it describes (§10.4.3), and the PR body and the card show the accepted generation's parts.
- Writers: the attempt's one `todo` run (T-FLW-11) for machine checks, review and usage; the GitHub sync for checks on the attempt's PR head.
- Check logs stored once in the blob store and referenced by digest.
- The `todo:<n>` projection's evidence per attempt.

Out:
- PR body layout (T-GH-03); required-check names and branch protection (T-GH-05).
- Per-step cost in the monitor (T-FLW-07). Learning's use of evidence (T-FLW-06). Wiki citations (T-FLW-10 adds a field).

## Changes
- `packages/backend/internal/services/todo_evidence.go` (new) → `RecordEvidence(attempt, part)` merges one part into the attempt's row under a version check. It refuses writes to a closed attempt, except GitHub checks for that attempt's own head.
- `packages/backend/internal/services/mythical_receipts.go:66` (`mythicalRunReceipts`) → also returns each receipt's `evidence` text (`flows/coding/schema.ts:151`); `todo_evidence.go` stores it through `packages/backend/internal/blob` and keeps the digest.
- `packages/backend/internal/services/mythical_items.go:577` (`ProjectFlowRuntime`) → write receipts, the review verdict and summary (today `checks.Review`, set by `review` at `:2349`), and the run's token and time totals into the current attempt.
- Diff stat from `changedPaths` (`services/mythical_git.go:623`) plus line counts for the attempt's verified candidate.
- `HeadChecks` (`services/mythical_github.go:611`) results for the attempt's PR head → `github_checks`.
- Flow `{name, digest}` from the pin recorded when the TODO entered `starting` (§11.4.1; T-FLW-04 owns the pin) and `model_access` from the run (§15.2).
- `completionBody` and `mythicalReceiptsSummary` (`mythical_items.go:3255`, `:3301`) read `todo_attempts.evidence` instead of `mythical_items.checks`.
- `packages/rpc/src/Todo.ts` → the evidence schema; `packages/backend/docs/todos.md`; docs gates.

## Tests
- Unit, `todo_evidence_test.go` (new): merging parts in any order gives the same row; a write to attempt 1 after attempt 2 started is refused, except GitHub checks for attempt 1's head.
- Integration with real PostgreSQL and the blob store, `todo_evidence_db_test.go` (new): a fixture run with two checks, one failing, stores two logs; the failing check's log digest resolves to its text; durations come from `startedAt`/`finishedAt`.
- Integration, same file: Retry (T-STK-05) creates attempt 2 with its own evidence; attempt 1's JSON is byte-identical before and after.
- Integration with the fake GitHub server: check runs on the PR head land in `github_checks` of the attempt that pushed that head, not the latest attempt.

## Acceptance
- [C-J2-04](../checks/C-J2-04.md): the PR and the TODO card show the diff, machine checks, GitHub checks and the review summary.

## Risks and notes
- Risk: per-run token totals aren't in today's projection update. Observation: `tokens` stays 0 on a real run. Then the runtime events of §11.6.1 must carry usage first (T-FLW-07 shares the work).
- Risk: check logs grow large. Cap one log at 1 MiB with a truncation marker; the blob keeps the head and the tail.
- C-J2-04's PR-body rows also need T-GH-03, and its GitHub-check rows need T-GH-05.

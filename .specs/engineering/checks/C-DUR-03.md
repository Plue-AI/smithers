# C-DUR-03 Killing the host during a GitHub write or push reconciles it without duplication

Proves: mvp.md §6.1 "Restart", §9 "Durability", §12 item 1 (restart mid-run, recovery receipts) · spec.md §3 (`pending_op`), §12.4.1, §19.1, §19.2 · Layer: fault · Stage: S1, S2 · Tickets: T-GH-09, T-FLW-09, T-REL-04
Automation: to write, as a `smthrs test` target · Runs in: CI

## Setup
- `smithers-backend` built from the commit under test and started as a subprocess with real PostgreSQL. `SMITHERS_GITHUB_APP_API_BASE_URL` and `SMITHERS_GITHUB_GIT_BASE_URL` point at `githubfake`; the `github_app` row holds a test App key the fake accepts.
- `githubfake` keeps its write log in a file that survives the host, and signals the harness from a hook when a request reaches the chosen point.
- One TODO prepared before each write kind, as in C-GH-09. Committed literal expected final rows and effective-object counts per kind are reviewed by smithers-3f; an uncrashed control is diagnostic only.
- S2 adds a TODO run on a machine whose flow reaches its "open PR" step and a push step (T-FLW-09).

Candidate Automation declaration (unapproved): S1: `packages/backend/internal/compose/github_outbound_kill_test.go` (new). S2: `packages/smithers/test/faults/github-step-kill.test.ts` (new, T-FLW-09) · Runs in: CI

Receipt: CI's own check run at the landed SHA, or a `smthrs test` run on the reference host, recorded through `scripts/check-run.mjs` (minimal-code synthesis ruling 3).

## Steps
For each kind in {open PR, update body, merge, close PR, close issue, add label, revert label, comment, push} and each window W:
- W1, the request is held at the fake before it is applied;
- W2, it is applied and the response is held;
- W3, the response is delivered and the host hasn't settled the record (the harness kills on the host's "write returned" log line);

1. Arm the hook. Let the host's worker reach the write.
2. When the hook fires, `SIGKILL` the host's process group. Release the held request after the kill.
3. Start the host subprocess again. Wait until `pending_op` holds no `intended` or `unknown` entry and the TODO reaches a terminal or stable state, with a 60 s limit.
4. Compare the write log and the TODO with the committed expected fixture rows and counts.

S2: repeat steps 1–4 with the kill inside the run's "open PR" step and its push step.

Exercise every production GitHub writer: TODO issue creation, landing push and PR creation, outbound mirror push, and check-run creation, cancellation and terminal updates, in addition to existing kinds. Kill before the intended-to-unknown commit, after that commit before the call, and after remote success before local settlement. Only intended is unsent. Every kind durably commits unknown before dispatch; restart looks up unknown work before repeat and produces the literal intended effect once. Preserve per-target order and atomic mirror ref-set preconditions.

## Pass when
- Every baseline and extended case in S1 and S2 shows zero duplicate effects in the write log: one PR, one comment per marker, one successful merge, one close per PR or issue, each label applied or removed once, and the intended head pushed once.
- Each repeat in the log is preceded by its lookup.
- The TODO's final state equals its committed expected fixture row, and the run resumes rather than failing (§19.1).
- Restart to settled takes ≤ 60 s per case.
- The host writes one recovery receipt per reconciled write: key, lookup result and action taken.
- No `needs_you{foreign_push}` is raised for Smithers' own push.

- Exercise every production GitHub writer: TODO issue creation, landing push and PR creation, outbound mirror push, and check-run creation, cancellation and terminal updates, in addition to existing kinds. Kill before the intended-to-unknown commit, after that commit before the call, and after remote success before local settlement. Only intended is unsent. Every kind durably commits unknown before dispatch; restart looks up unknown work before repeat and produces the literal intended effect once. Preserve per-target order and atomic mirror ref-set preconditions.

## Fail when
- A duplicate PR, comment, close, label or merge appears in the write log.
- A write repeats with no lookup.
- The run shows `failed` or stays `interrupted` when its write had in fact landed.
- The host's own push is reported as a foreign push.

## Evidence
`.artifacts/checks/C-DUR-03/<UTC timestamp>/`: per case `writes.jsonl`, host logs before and after the kill, `pending_op` entries before and after, the recovery receipts, `summary.json`, the commit and the built binary's version.

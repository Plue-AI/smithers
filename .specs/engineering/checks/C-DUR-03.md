# C-DUR-03 Killing the host during a GitHub write or push reconciles it without duplication

Proves: mvp.md §6.1 "Restart", §9 "Durability", §12 item 1 (restart mid-run, recovery receipts) · spec.md §3 (`outbound_writes`), §12.4.1, §19.1, §19.2 · Layer: fault · Stage: S1, S2 · Tickets: T-GH-09, T-FLW-09
Automation: S1: `packages/backend/internal/compose/github_outbound_kill_test.go` (new). S2: `packages/smithers/test/faults/github-step-kill.test.ts` (new, T-FLW-09) · Runs in: CI

## Setup
- `smithers-backend` built from the commit under test and started as a subprocess with real PostgreSQL. `SMITHERS_GITHUB_APP_API_BASE_URL` and `SMITHERS_GITHUB_GIT_BASE_URL` point at `githubfake`; the `github_app` row holds a test App key the fake accepts.
- `githubfake` keeps its write log in a file that survives the host, and signals the harness from a hook when a request reaches the chosen point.
- One TODO prepared before each write kind, as in C-GH-09. A control run without a kill gives the expected final state per kind.
- S2 adds a TODO run on a machine whose flow reaches its "open PR" step and a push step (T-FLW-09).

## Steps
For each kind in {open PR, update body, merge, close PR, close issue, add label, revert label, comment, push} and each window W:
- W1, the request is held at the fake before it is applied;
- W2, it is applied and the response is held;
- W3, the response is delivered and the host hasn't settled the record (the harness kills on the host's "write returned" log line);

1. Arm the hook. Let the host's worker reach the write.
2. When the hook fires, `SIGKILL` the host's process group. Release the held request after the kill.
3. Start the host subprocess again. Wait until `outbound_writes` has no `intended` or `unknown` row and the TODO reaches a terminal or stable state, with a 60 s limit.
4. Compare the write log and the TODO with the control run.

S2: repeat steps 1–4 with the kill inside the run's "open PR" step and its push step.

## Pass when
- Every case (27 in S1, plus the S2 cases) shows zero duplicate effects in the write log: one PR, one comment per marker, one successful merge, one close per PR or issue, each label applied or removed once, and the intended head pushed once.
- Each repeat in the log is preceded by its lookup.
- The TODO's final state equals the control run's, and the run resumes rather than failing (§19.1).
- Restart to settled takes ≤ 60 s per case.
- The host writes one recovery receipt per reconciled write: key, lookup result and action taken.
- No `needs_you{foreign_push}` is raised for Smithers' own push.

## Fail when
- A duplicate PR, comment, close, label or merge appears in the write log.
- A write repeats with no lookup.
- The run shows `failed` or stays `interrupted` when its write had in fact landed.
- The host's own push is reported as a foreign push.

## Evidence
`.artifacts/checks/C-DUR-03/<UTC timestamp>/`: per case `writes.jsonl`, host logs before and after the kill, `outbound_writes` rows before and after, the recovery receipts, `summary.json`, the commit and the built binary's version.

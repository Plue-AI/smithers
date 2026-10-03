# C-STK-08 Independent waits give the §4.1.0a state; resume leaves Starting; merges on GitHub win

Proves: mvp.md §4.1 (Needs you: "only an answer settles it"; Paused), J3.6, J10.3, J10.5, M-22 · spec.md §4.1, §4.1.0, §4.1.0a, §10.7.1, §10.7.3, §10.8.0, §10.8.2, §12.3 · Layer: integration · Stage: S1 · Tickets: T-STK-07, T-STK-05, T-GH-05, T-GH-06
Automation: `packages/backend/internal/services/todo_waits_db_test.go` (new) · Runs in: reference host (real PostgreSQL, a real microVM flow host and the fake GitHub server)

## Setup
- A fixture `todo` flow with steps `s1..s4` and the post-propose wait. `s3` can raise an `ask`. Per-step execution counters are keyed by (run id, step).
- Owner Will, maintainer Ben and member Alice, each with a session.
- Each case starts from a fresh T1.

- Send stop/resume/retry/answer and Resolve/Done through the composed install router and production command dispatcher; production poll/runtime ingestion raises the named waits. Test expected states, actions and refusal envelopes are checked-in literal cases independent of spec files, TSV and production decisions. Direct wait/state helper calls are unit coverage only.

## Steps
1. Question and foreign push: T1 in `s3` raises a question. Alice pushes a commit to T1's branch on the fake; advance one refs cycle. Alice answers the question. Ben selects Discard.
2. Stop with a question open: with T1's question open, Will sends `stop`.
3. Pause and conflict: Will stops a working T1, and it parks. Move `main` with a change that conflicts with T1's, and let the host-side rebase run. Ben resolves the conflict and presses Done. Will resumes.
4. Stop with only a branch wait open: T1 is working with an open `foreign_push`. Will stops it, and the run parks. Ben selects Discard.
5. Resume after the first step: stop T1 while `s2` runs, after `s1` finished; resume.
6. Merge on GitHub during a steer: T1 is `in_review`. Alice steers, so T1 turns `working`. Merge T1's PR on the fake at its last proposed head; advance one pulls cycle.
7. Merge on GitHub with a question open: T1 is `needs_you` with a question. Merge the PR on the fake; advance one cycle; then Alice answers.
8. Merge on GitHub while paused: as step 7, with T1 `paused`.
9. Failed with a branch wait: T1 is `failed`. Alice pushes to its branch; Ben selects Discard; Will retries.

## Pass when
- Step 1: after the push, T1 is `needs_you` with two open waits and `needs_you.kind = foreign_push`. Alice's answer settles only the question: the run receives it, and T1 stays `needs_you` with `foreign_push`. The agent's next push is held. After Discard, T1 is `working`.
- Step 2: refused with class `conflict`; no pause signal is sent.
- Step 3: the conflict wait opens while T1 is paused, and T1 shows `needs_you` (`conflict`). After Done it shows `paused`. After Resume it goes `queued → starting → working` on the same run id.
- Step 4: Stop is accepted. T1 shows `needs_you` while `paused_at` is set, and `paused` after Discard.
- Step 5: `queued → starting → working`, with `working` following `run_attached` within 5 s of the machine grant; `s1`'s counter stays 1; T1 never stays in `starting`.
- Step 6: T1 is `merged` with one event; the run is cancelled; no wait is open; `paused_at` and `merging` are null; the fake's write log has no `convertPullRequestToDraft` for T1 at the steer.
- Step 7: T1 is `merged`; the question wait is closed; Alice's answer gets `409`, and the run receives nothing.
- Step 8: T1 is `merged`; `paused_at` is null; the run is cancelled.
- Step 9: after the push, T1 shows `needs_you` (`foreign_push`), not `failed`. After Discard it shows `failed`. Retry gives attempt 2.
- Every state change has exactly one `todo_events` row, and the stored state always equals §4.1.0a applied to the stored facts.

## Fail when
- An answer or a Discard settles a wait other than its own.
- A paused or failed TODO with an open branch wait shows paused or failed.
- A resumed TODO stays in `starting` because its first step already ran.
- A merge on GitHub leaves an open wait, `paused_at` or a live run, or the steer turned the PR into a draft.

## Evidence
`.artifacts/checks/C-STK-08/<UTC>/`: `go test -json`, per-case tables of `todo_waits`, `todos` and `todo_events`, the step counters, the fake GitHub write log, the commit SHA.

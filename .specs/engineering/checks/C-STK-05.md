# C-STK-05 A review steer days later resumes the same run on the same working copy

Proves: mvp.md J10.2, M-31 · spec.md §10.4.1, §8.4 · Layer: integration · Stage: S1 · Tickets: T-MCH-14
Automation: `packages/backend/internal/services/todo_long_wait_integration_test.go` (new) · Runs in: reference host (real microVM), simulated clock

## Setup
One TODO T1 in review with run id R and an uncommitted scratch file `notes.txt` in its working copy. The fake GitHub server serves the PR.

## Steps
1. Let the workspace go idle; observe it suspend.
2. Advance the clock 25 h and run the reclaim sweep.
3. Post a review comment from a member on the fake GitHub, and run one poll.
4. Repeat retention through every `advanceItems`, `releaseLane`, `retireLane`, `review`, `sweepLanes` and `start` deletion path named in T-MCH-14. Each unmerged TODO lane suspends with disk and binding retained. Race reclaim with settlement/resume and a stale sweep list; settlement and binding are read inside the runtime lock. A settled head different from its pinned candidate keeps the disk; reclaim requires a matching retained host ref.
5. Restart during queued delivery. Observe wake through the resolver start, one start, one verified guest host and one consumed signal, with no separate pre-delivery wake.

## Pass when

- Drive composed lifecycle jobs and the production stack delivery seam. Reclaim disk only after a retained final capture and no active terminal/service; absent capture retains it. Fixture seam coverage does not replace GitHub poll, reopen or built-in run-loop acceptance owned by their named tickets.

- After step 2 the workspace disk still exists.
- After step 3 the workspace wakes, and run R (not a new run) receives one steer and returns to working.
- `notes.txt` is present with its content.
- The TODO shows `in_review → working` with one event row.

## Fail when
- A new run id appears.
- The disk was reclaimed.
- The steer is delivered twice.

## Evidence
`.artifacts/checks/C-STK-05/<ts>/`: the run id log, `todo_events` rows, the workspace state timeline and the commit.

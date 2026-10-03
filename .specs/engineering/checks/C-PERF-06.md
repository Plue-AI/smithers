# C-PERF-06 Rebase with people present holds writes < 2 s

Proves: mvp.md §4.2 Rebase · spec.md §9.4.1, §10.5.2, §10.5.3, §18 · Layer: perf · Stage: S2 · Tickets: T-STK-08, T-REL-01
Automation: `scripts/perf/rebase-hold.mjs` (new) · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X on the reference host (the team's Mac mini, whatever its size); the scratch repository on GitHub; T1 In review on its awake branch, with a change of about 20 files.
- Member A present on the branch from the second Mac B (File card open; presence heartbeats).
- The harness can push to `main` of the scratch repository and call `POST /api/github/sync` (Retry) to fetch at once.
- `smithers-machined` logs the hold start and end of each rebase on the guest's monotonic clock (§9.4.1).

## Steps
1. For i in 1..100: push a commit to `main` that touches no file of T1; call Retry; wait for the branch to show Rebase pending; A presses Rebase now with the keyboard. Record hold start and end from the daemon, and the activity entry.
2. From stage 3 only: during each hold, A types a unique marker in the File card; record when it appears in the document after the hold.

## Pass when
- n = 100; nearest-rank p95(hold end − hold start) < 2 s on the guest monotonic clock.
- Each rebase showed Rebase pending first and never ran on its own while A was present (§10.5.2).
- Each rebase produced one "Rebased onto" activity entry and cleared approvals only when the head changed (§10.5.3).
- Stage 3: every marker typed during a hold appears after it, attributed to A; none is lost.

## Fail when
- The rebase runs while a burst is open or a flush is pending (§9.4.1 refuses that).
- Held writes fail instead of waiting.
- The reload after the rebase is attributed to A instead of the "Rebased onto …" entry.

## Evidence
`.artifacts/perf/<date>/rebase-hold.json` (raw samples, summary, the detected host profile (§8.2.1), commit, install version) and a copy with `summary.json`, daemon hold logs and activity entries in `.artifacts/checks/C-PERF-06/<UTC timestamp>/`.

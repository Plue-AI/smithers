# C-PERF-03 Keystroke reaches a remote File card < 1 s

Proves: mvp.md §6.8 Live co-editing, §9 Live updates, M-02 · spec.md §7.4, §7.6, §9.2, §18 · Layer: perf · Stage: S3 · Tickets: T-COL-08
Automation: `scripts/perf/keystroke.mjs` (new) · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X on the reference host (the team's Mac mini, whatever its size); one awake branch with a 400-line TypeScript file `src/target.ts`.
- On the second Mac B, two Playwright Chromium contexts signed in as members A and C, both with the File card open on `src/target.ts` through the configured public origin. Both contexts share B's clock.

## Steps
1. For i in 1..200: A types a unique 6-character marker on a different line each time. t0 = `performance.timeOrigin + performance.now()` in A at the keydown of the marker's last character; t1 = the same clock in C when C's editor DOM first contains the full marker (MutationObserver).
2. After the last marker and 2 s of idle, read `src/target.ts` inside the machine (`smthrs ssh` exec, or the agent's read tool).

## Pass when
- n = 200; nearest-rank p95(t1 − t0) < 1 s.
- Every marker arrives exactly once, in typing order per line.
- At the end, C's text equals A's byte for byte, and both equal the file on the machine.
- Clock: B's system clock through each context's `timeOrigin + now()`.

## Fail when
- Both contexts reach the install through `localhost` on the reference host, skipping the network path.
- A marker shows in C but never reaches the disk.
- Markers are duplicated or reordered after a reconnect.

## Evidence
`.artifacts/perf/<date>/keystroke.json` (raw samples, summary, the detected host profile (§8.2.1), origin, commit, install version) and a copy with `summary.json` in `.artifacts/checks/C-PERF-03/<UTC timestamp>/`.

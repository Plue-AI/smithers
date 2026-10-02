# C-PERF-05 Warm wake < 5 s

Proves: mvp.md §9 Branch wake, §6.7 Sleep · spec.md §4.2, §8.2.1, §8.3, §8.4, §18 · Layer: perf · Stage: S2 · Tickets: T-MCH-06
Automation: `scripts/perf/warm-wake.mjs` (new) · Runs in: reference host

## Setup
- Install at commit X on the reference host (the team's Mac mini, whatever its size); free capacity (no other awake machine, no TODO running).
- One branch whose machine has booted at least once, so its disk and image layers exist (warm), now asleep after a final capture.
- The branch's TODO is In review, so the machine sleeps 2 min after it becomes safe-idle (§8.4.2). A shorter sleep delay set through configuration is allowed only if the run records it; the wake path must be unchanged.

## Steps
1. For i in 1..100: open a terminal on the branch through `POST /api/terminals` (a person wake). t0 = the host's monotonic time when the request is accepted (host log); t1 = the host's monotonic time when the machine's `awake` transition is written. Also record the client-side time from request to the `awake` delta on `branch:<id>`.
2. Close the terminal; wait for `asleep` with a final capture; record the captured head.
3. After each wake, compare the working-copy head with the captured head.

## Pass when
- n = 100; nearest-rank p95(t1 − t0) < 5 s on the host's monotonic clock.
- Zero failed wakes; every wake reaches `awake` and the head equals the last captured head.
- The client-observed p95 is reported beside it.

## Fail when
- Cold wakes (a layer rebuild or image pull) are dropped from the sample instead of failing it.
- t0 is taken after admission grants the request, hiding queue time.
- A wake happens through a read (reads never wake, §8.4.4), so the sample is not a person wake.

## Evidence
`.artifacts/perf/<date>/warm-wake.json` (raw samples, summary, the detected host profile and its derived limits (§8.2.1), sleep delay used, commit, install version) and a copy with `summary.json` in `.artifacts/checks/C-PERF-05/<UTC timestamp>/`.

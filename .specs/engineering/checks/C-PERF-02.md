# C-PERF-02 Projection delta reaches subscribers < 1 s

Proves: mvp.md §9 Honesty, §6.4 Home card · spec.md §3.1, §7.1, §7.2.1, §18 · Layer: perf · Stage: S1 · Tickets: T-COL-02, T-REL-01
Automation: `scripts/perf/projection-delta.mjs` (new) · Runs in: reference host plus a second Mac on the same network

## Setup
- Install at commit X on the reference host (the team's Mac mini, whatever its size) with 10 TODOs on the stack.
- On the second Mac B, one Node process holds two authenticated live-channel connections to the configured public origin: S1 subscribed to `home`, S2 to `todo:<n>` for the TODO being moved.
- Background load: 3 Chromium tabs on B subscribed to `home`.

## Steps
1. For i in 1..200: t0 = B's `performance.now()` just before sending a card-visible mutation (`POST /api/todos/{n}` move up, then move down, alternating, each with a fresh `Idempotency-Key`); t1 = arrival at S1 of the delta frame whose cursor follows the last one and whose payload names that move; t2 = the same at S2.
2. Record each mutation's `projection_events` row (`topic`, `seq`, `at`) from the database afterwards.

## Pass when
- n = 200 (at least 100 required); nearest-rank p95(t1 − t0) < 1 s and p95(t2 − t0) < 1 s.
- Every mutation produced exactly one delta per subscribed topic, cursors are gap-free, and no `gap` frame arrived.
- Clock: B's monotonic clock for both ends. The interval includes the request, so it bounds commit-to-delivery from above.

## Fail when
- A subscriber sees a delta for a mutation whose transaction later failed (state before its event).
- Missing deltas are recovered by resubscribing and counted as delivered.
- Deltas are coalesced so a mutation never appears on its own.

## Evidence
`.artifacts/perf/<date>/projection-delta.json` (raw samples, summary, the detected host profile (§8.2.1), origin, commit, install version) and a copy with `summary.json` in `.artifacts/checks/C-PERF-02/<UTC timestamp>/`.

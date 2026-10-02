# T-MCH-06 Admission scheduler, positions, safe-idle release

Stage S2 · Size L · Depends on T-MCH-04, T-MCH-01 · Unblocks T-STK-03, T-FLW-06, T-TRM-03, T-REL-01 · Issue: to file
Spec: spec.md §4.1.1, §4.2, §8.2.2, §8.3, §8.4.1, §8.4.2, §6.2.3, §7.2, §18 (warm wake) · Delta: delta.md §3 (admission row) · Product: mvp.md J3, J4, §6.7 Capacity and queue, M-06, M-13

## Goal

When capacity is full, every request for a machine waits in one visible queue with a reason and position, a person's request goes ahead of TODOs and background runs, a working agent is never stopped, and the longest safe-idle machine is released to make room.

## Scope

In:
- `machine_requests` (§3) with states `waiting`, `granted`, `cancelled` and three classes in priority order (§8.3.1):
  - `person`: a member's terminal, SSH, steer, answer or resume that needs the machine; the `edit` reason gets its caller with co-editing in S3 (§9.2);
  - `todo`: a TODO run;
  - `background`: learning, `flow-load`, wiki refresh and `/review` on a teammate's PR (§12.3), each in an ephemeral machine that counts against capacity and never holds a TODO's machine.
- An event-driven scheduler with a 1 s tick (§8.3.2): while `awake + waking < capacity`, grant the oldest request of the highest class. Position = rank within the ordered waiting set.
- No preemption (§8.3.3). When requests wait and capacity is full, release the longest safe-idle machine.
- No release of any kind for 30 s after the host starts, while presence is unknown (§7.3.0). Grants still proceed in that window.
- The safe-idle predicate of §8.4.1, read from presence, open terminals and SSH sessions, run state, open bursts and unflushed documents. Before T-COL-03, T-COL-04 and T-COL-08 land, the burst and document terms read as "none open".
- Idle release without waiting requests (§8.4.2): sleep after 30 min safe-idle, or after 2 min when the TODO is `in_review`, `needs_you` or `paused`. A scratch branch has no TODO, so the 30 min rule applies.
- Cancel a granted request whose actor leaves before the wake finishes; the machine sleeps again if nothing else holds it (§8.3.4).
- A layer prepare VM counts against capacity while it runs (§8.2.2).
- A typed `capacity` error (§6.2.3) replaces the untyped refusal at `packages/backend/microsandbox/runtime.go:539`.
- TODO states on admission (§4.1): a grant moves the TODO `queued → starting`; the run's first step moves it to `working`; a machine or coding host that fails to start moves it to `failed` with `failure.step = "start"`.
- Projections: TODO `queue {reason: "waiting for a machine", position}` (§4.1.1); `branch:<id>` machine `{state, wait_position?}`; `home` `machines {in_use, capacity}`. Each change writes `projection_events` in its transaction (§3.1).

Out:
- The capture inside "sleep" (T-MCH-07). Until it lands, release uses today's suspend, which keeps the disk.
- `parallel` and stack-order admission of TODOs (T-STK-03). Its default, `max(1, capacity − 1)` (§10.3.1), leaves one machine for people and background runs; this scheduler reads the setting and never enforces it itself.
- Presence itself (T-COL-06); this ticket reads it.
- The hosted fleet cap `WithAgentConcurrencyCap` (`packages/backend/internal/compose/main.go:733`). It is 0, meaning disabled, on the Mac install and serves Plue.

## Changes

- `packages/backend/db/product/migrations/0106_machine_requests.sql` (new; number at landing): the table, plus a partial unique index allowing one waiting request per `(branch_id, class, requested_by actor)` so a duplicate launch reuses the row.
- `packages/backend/db/product/queries/machine_requests.sql` (new): enqueue, rank, grant with `FOR UPDATE SKIP LOCKED`, cancel, list. The claim-and-lease shape follows Pair's `ClaimPairPrompt`, `RenewPairPromptLease` and `SweepStalePairPromptClaims` (`packages/backend/db/product/queries/pair_sessions.sql:210-300` at `a73a77de36`, research/deleted-features.md). Reference only: write new SQL.
- `packages/backend/internal/services/machine_admission.go` (new): the scheduler, the safe-idle predicate and the release policy. One instance per host service, woken by `NOTIFY` and the 1 s tick.
- `packages/backend/internal/services/workspace_agent.go` attach path (from T-MCH-04) and `workspace_runtime.go:141` `ensureRuntimeWorkspaceRunning`: every wake goes through `Request(class, branch, actor, reason)` and waits for a grant. No caller starts a VM directly.
- `packages/backend/internal/services/workspace_lifecycle.go:287` `CleanupIdleWorkspaces` and `packages/backend/internal/cleanup/workspace_cleaner.go`: the 1800 s idle sweep is replaced by the §8.4.2 policy for branch machines. Delete the old sweep for them in the same change.
- `packages/backend/microsandbox/runtime.go:531-541`: return `microsandbox.ErrCapacity`. The service maps it to `{code: "machine_capacity", class: "capacity"}` in `packages/backend/internal/pkg/errors/`. It should be unreachable when the scheduler works.
- `docs/api/openapi/branches.yaml`: the `machine` object gains `wait_position`; rebundle and regenerate clients.
- Metrics (§20.3): queue depth per class, wake count, wake time.

## Tests

- unit (`machine_admission_test.go`, new, fake clock): a grant moves its TODO to `starting`, never straight to `working`; ordering by class then age; positions after every enqueue, grant and cancel; no grant at capacity; release never picks a machine with presence, a terminal, an SSH session or a running step; release picks the longest safe-idle machine; a prepare VM and a background `/review` machine each occupy a slot.
- unit: with requests waiting and every machine safe-idle, no machine is released at 29.9 s after host start, and the longest safe-idle one is released at 30 s (§7.3.0).
- integration (real PostgreSQL, conformance runtime): capacity 1, a working TODO holds it, then background, todo and person requests arrive in that order and are granted person, todo, background. The working agent's machine is never released. Two scheduler instances never grant the same slot twice. This is C-MCH-02.
- integration: a person request cancelled before its wake finishes releases the machine within 2 s.
- fault (`packages/backend/internal/services/machine_admission_fault_test.go`, new): kill the host between grant and boot; on restart the request is granted once and no VM is orphaned.
- perf (reference host): warm wake p95 < 5 s, n ≥ 100 (C-PERF-05).

## Acceptance

- [C-MCH-02](../checks/C-MCH-02.md): person before TODO before background, FIFO within class, positions shown, no preemption, safe-idle release.
- [C-PERF-05](../checks/C-PERF-05.md): warm wake (asleep → awake, granted immediately) p95 < 5 s on the reference host.

## Risks and notes

- A person's request waits behind a capacity held only by working agents, since there is no preemption, and the person sees "waiting for a machine #1" indefinitely. Confirmed by C-MCH-02 with capacity 1 and a long-running TODO. Product accepted this in M-13; record it in the check evidence.
- Safe-idle depends on presence heartbeats (30 s TTL). A stale heartbeat holds a machine for up to 30 s past the person leaving. Confirmed by closing a tab and timing release.
- After a host restart the presence map is empty, so every machine would look safe-idle. The 30 s no-release window (§7.3.0) covers the browsers' 10 s re-send and the daemon's session re-send. Falsified if an SSH session's machine is released within 30 s of a host restart.
- A paused TODO's run waits in a durable pause wait (§4.1), which doesn't count as a running step (§8.4.1), so its machine is released once safe-idle.

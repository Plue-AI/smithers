# C-MCH-02 Admission: person before TODO before background, FIFO within class, positions shown, no preemption

Proves: mvp.md M-06, M-13, J3, J4, §6.7 Capacity and queue · spec.md §8.3, §8.4.1, §8.4.2, §4.1.1, §7.2 · Layer: integration · Stage: S2 · Tickets: T-MCH-06
Automation: `packages/backend/internal/services/machine_admission_integration_test.go` (new) · Runs in: CI (real PostgreSQL, conformance runtime, injected clock)

## Setup

- Real PostgreSQL 18 at head. Capacity set by the owner to 1. Members Ben and Alice.
- TODOs: T1 working on branch A (holds the one machine, step running); T5 and T6 queued in stack order on branches B and C.
- Branch D: a scratch branch, asleep.
- A live-channel subscriber on `home`, `todo:5`, `todo:6` and `branch:D` recording every delta with its cursor.

## Steps

1. Enqueue in this order, 10 ms apart: background `learning` (branch E), `todo` T5, `todo` T6, `person` Alice terminal on D, `person` Ben SSH on C.
2. Read positions from the projections.
3. Advance the clock 2 h with T1 still running a step.
4. T1 reaches `in_review` and the branch has no presence, terminal or SSH. Advance the clock 1 s.
5. Alice cancels her terminal request before D's wake finishes.
6. Release continues until the queue is empty. Record grant order.
7. Repeat steps 1–6 with two scheduler instances running against the same database.

## Pass when

- Step 2: positions are Alice 1, Ben 2, T5 3, T6 4, learning 5 (person by age, then todo by age, then background). `todo:5` shows `queue {reason: "waiting for a machine", position: 3}`, which renders "waiting for a machine #3" (§8.3.2).
- Step 3: branch A's machine is never released and T1 is never paused.
- Step 4: A is released (safe-idle), and the grant goes to Alice within 2 s.
- Step 5: the request is `cancelled` and D sleeps again within 2 s.
- Step 6: grant order is Alice, Ben, T5, T6, learning. Every grant is followed by a projection delta before the next grant. T5 and T6 each show `starting` on grant and `working` only after their run's first step starts (§4.1).
- Step 7: same order, and no slot is granted twice (`held ≤ 1` at every sample, counting provisioning, waking, awake and releasing machines, §8.3.2).

## Fail when

- A TODO or background request is granted ahead of a waiting person.
- A TODO shows `working` at grant time, before its run's first step.
- A machine with presence, an open terminal, an SSH session or a running step is released.
- Positions skip or repeat (1, 3), or a position is shown before its request row commits.
- A capacity refusal surfaces as a 500 or an untyped string instead of `class: capacity`.

## Evidence

`.artifacts/checks/C-MCH-02/<UTC timestamp>/`: `go test -json` output, the grant log (request id, class, granted_at), the recorded projection deltas with cursors, `machine_requests` and `machines` dumps per step, and the commit.

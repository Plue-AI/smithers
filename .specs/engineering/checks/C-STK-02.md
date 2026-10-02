# C-STK-02 TODOs admit in stack order up to `parallel`; `parallel` is clamped by capacity

Proves: mvp.md §6.6 Parallel work, M-06, M-13 · spec.md §4.1, §4.1.1, §8.2.1, §8.3.2, §8.3.3, §8.4.2, §10.3.1 · Layer: integration · Stage: S2 · Tickets: T-STK-03
Automation: `packages/backend/internal/services/todo_admission_db_test.go` (new) · Runs in: CI (real PostgreSQL via `newProductTestPool`; the T-MCH-06 scheduler on a fake microVM runtime)

## Setup
- Product schema at head; one install, owner Will, member Ben.
- A fake runtime whose detected host profile (§8.2.1) gives capacity 3. The TODO flow is a fixture whose `implement` step blocks until the test releases it.
- Five TODOs T1..T5 placed by Append, all `queued`.

## Steps
1. Set `parallel = 2`. Run engine passes until stable.
2. Place T6 with Before T2. Release T1's step so T1 reaches `in_review`, then let its machine reach safe-idle and be released (§8.4.2).
3. Set `parallel = 8`.
4. Change the fake host profile so capacity becomes 2 while T6 and T2 are working.
5. Ben opens a terminal on a sleeping scratch branch (a `person` request) while TODOs wait.
6. Read `todos.queue` positions after each step.

## Pass when
- Step 1: exactly T1 and T2 pass through `starting` to `working`; T3, T4 and T5 are `queued` with reason `machine` and positions 1, 2 and 3.
- Step 2: T1 holds its slot while `in_review` until its machine is released; the next TODO admitted after that is T6, not T3.
- Step 3: the stored value is 8; the effective value reported on `home` is 3; a third TODO admits in stack order.
- Step 4: the effective value drops to 2; no working agent is stopped (both runs keep running to their next step).
- Step 5: Ben's request is granted before any queued TODO; TODO positions update in the same projection delta.
- Positions in every `home` snapshot match the scheduler's waiting order.

## Fail when
- Admission follows creation or issue order instead of `stack_position`.
- More than `min(parallel, capacity)` TODOs hold machines at any sampled instant.
- Lowering capacity pauses or cancels a working agent (preemption, §8.3.3).
- A position stays stale after a reorder (shows #2 for a TODO now first).

## Evidence
`.artifacts/checks/C-STK-02/<UTC>/`: `go test -json`, a CSV of (pass, TODO, state, position) per engine pass, the fake host profile, the commit SHA.

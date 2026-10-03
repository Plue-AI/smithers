# T-MCH-06 Admission scheduler: slots to confirmed stop, per-branch coalescing, disk re-check, positions, safe-idle release

Stage S2 · Size L · Depends on T-MCH-04, T-MCH-01 · Unblocks T-FLW-06, T-INS-07, T-MNT-02, T-MNT-04, T-REL-01, T-REL-02, T-STK-03, T-TRM-03 · Issue: [#3567](https://github.com/smithersai/smithers/issues/3567)
Spec: spec.md §4.1.1, §4.2, §8.2.1a, §8.2.1b, §8.2.2, §8.3, §8.4.1, §8.4.2, §6.2.3, §7.2, §18 (warm wake) · Delta: delta.md §3 (admission row) · Product: mvp.md J3, J4, §6.7 Capacity and queue, M-06, M-13

## Goal

When capacity is full, every request for a machine waits in one visible queue with a reason and position, a person's request goes ahead of TODOs and background runs, a working agent is never stopped, and the longest safe-idle machine is released to make room.

## Scope

In:
- the runtime admission queue (§3) with a `holder` (a branch's machine, a layer prepare or a background run), states `waiting`, `granted`, `released`, `cancelled`, and three classes in priority order (§8.3.1):
  - `person`: a member's terminal, SSH, steer, answer or resume that needs the machine; the `edit` reason gets its caller with co-editing in S3 (§9.2);
  - `todo`: a TODO run;
  - `background`: learning, `flow-load`, wiki refresh and `/review` on a teammate's PR (§12.3), each in an ephemeral machine that counts against capacity and never holds a TODO's machine.
- Slots (§8.3.2): every VM holds one from its grant until the runtime confirms it stopped or was deleted, which covers provisioning, waking, awake and releasing machines, layer-prepare VMs (`layers.go:366` `buildLayer`) and ephemeral background machines. On confirmation the holder's granted rows become `released`. A release unconfirmed after 60 s is force-stopped and keeps its slot until confirmed. At start, slots reconcile with the runtime's VM list: a slot without a VM is released, and a VM without a slot is stopped.
- Per-holder coalescing (§8.3.1): a holder ranks by its highest waiting class, then by its oldest row of that class, so a person's request promotes a waiting TODO's branch. A holder takes one slot however many rows it has, and a request for a holder that already holds a slot is granted at once.
- Extend the runtime admission mutex with an event-driven people-first FIFO and a 1 s tick. Read free disk before each grant, count every held VM state, coalesce demand by holder, and expose rank. No database grant transaction.
- No preemption (§8.3.3). When requests wait and capacity is full, release the longest safe-idle machine.
- No release of any kind for 30 s after the host starts, while presence is unknown (§7.3.0). Grants still proceed in that window.
- The safe-idle predicate of §8.4.1, read from presence, open terminals and SSH sessions, run state, open bursts and unflushed documents. Before T-COL-03, T-COL-04 and T-COL-08 land, the burst and document terms read as "none open".
- Idle release without waiting requests (§8.4.2): sleep after 30 min safe-idle, or after 2 min when the TODO is `in_review`, `needs_you` or `paused`. A scratch branch has no TODO, so the 30 min rule applies.
- Cancel a granted request whose actor leaves before the wake finishes; the machine sleeps again if nothing else holds it (§8.3.4).
- Preparation inside the grant (§8.2.2): when a granted wake needs an unbuilt layer, the prepare VM runs in that grant's slot and hands it to the branch's VM after the prepare VM stops. One build runs per recipe digest; a second grant that needs it waits and holds its own slot.
- A typed `capacity` error (§6.2.3) replaces the untyped refusal at `packages/backend/microsandbox/runtime.go:545`.
- TODO states on admission (§4.1): a grant moves the TODO `queued → starting`; the run's first step moves it to `working`; a machine or coding host that fails to start moves it to `failed` with `failure.step = "start"`.
- Projections: TODO `queue {reason: machine, position}` (§4.1.1); `branch:<id>` machine `{state, wait_position?}`; `home` `machines {in_use, capacity}`. Each change writes source durable cursors in its transaction (§3.1).

Out:
- The capture inside "sleep" (T-MCH-07). Until it lands, release uses today's suspend, which keeps the disk.
- `parallel` and stack-order admission of TODOs (T-STK-03). Its default, `max(1, capacity − 1)` (§10.3.1), leaves one machine for people and background runs; this scheduler reads the setting and never enforces it itself.
- Presence itself (T-COL-06); this ticket reads it.
- The hosted fleet cap `WithAgentConcurrencyCap` (`packages/backend/internal/compose/main.go:733`). It is 0, meaning disabled, on the Mac install and serves Plue.

## Changes

- Keep admission in the runtime’s memory; no migration, lease table or persisted queue.
- Under the runtime mutex, enqueue, promote, rank, grant and cancel per actor; one holder consumes one slot. At restart reconstruct demand from durable jobs and live sessions, then reconcile runtime VMs before granting.
- One sandbox-start guard (minimal-code synthesis v1 §6): the grant runs behind the existing per-start policy hook at `packages/backend/internal/compose/runtime_helpers.go:278` (`AuthorizeSandboxStart`, whose install implementation is the no-op `UnlimitedBillingPolicy`, `billing_composition.go:106`). On the install that hook's policy becomes the admission grant; Plue keeps billing. `InstallCapacityService.ValidateStart` (`install_capacity.go:48`) stays only as the host-start refusal at capacity 0. No third guard.
- Extend `microsandbox/runtime.go` admission and wake notifications; keep service callers on the existing start guard. No parallel scheduler.
- `packages/backend/internal/services/workspace_agent.go` attach path (from T-MCH-04) and `workspace_runtime.go:141` `ensureRuntimeWorkspaceRunning`: every wake goes through `Request(class, branch, actor, reason)` and waits for a grant. No caller starts a VM directly.
- `packages/backend/internal/services/workspace_lifecycle.go:287` `CleanupIdleWorkspaces` and `packages/backend/internal/cleanup/workspace_cleaner.go`: the 1800 s idle sweep is replaced by the §8.4.2 policy for branch machines. Delete the old sweep for them in the same change.
- `packages/backend/microsandbox/runtime.go:542` `admitRunningLocked`: extend it with the typed capacity error and the people-first FIFO in front of it (overview E-11); return `microsandbox.ErrCapacity`. The service maps it to `{code: "machine_capacity", class: "capacity"}` in `packages/backend/internal/pkg/errors/`. It should be unreachable when the scheduler works. The runtime cap equals the memory and core terms of §8.2.1 and counts every VM that isn't stopped; today `admitRunningLocked` counts only Starting and Running.
- `docs/api/openapi/branches.yaml`: the `machine` object gains `wait_position`; rebundle and regenerate clients.
- Metrics (§20.3): queue depth per class, wake count, wake time.

## Tests

C-MCH-11 (folded steps and assertions):
1. Capacity 2, ample disk. Branch D is asleep with TODO T5 queued on it. At the same instant, enqueue T5's `todo` request, Ben's terminal on D and Alice's SSH on D. Read positions, then let the grant happen.
2. Capacity 1, held by T1's working run on branch A. Enqueue T6's `todo` request on branch C at t0, Alice's terminal on branch E at t0 + 1 s, and Ben's terminal on C at t0 + 2 s. Read positions. Then T1 goes to review and A becomes safe-idle.
3. Capacity 1. Grant a wake for branch F, then cancel its only request while the VM boots; the runtime takes 10 s to confirm the stop. Meanwhile enqueue a person request for branch G.
4. Capacity 1. Release a VM whose stop the runtime never confirms.
5. Capacity 1, a fresh install with no built layer. Wake branch H.
6. Capacity 3, free disk 140 GiB (`floor((140 − 40) / 32)` = 3). Wake two branches. Lower free disk to 100 GiB and enqueue a third wake. Raise free disk to 140 GiB.
7. Capacity 3 with three VMs held. The owner lowers capacity to 1. Enqueue a person request.
8. Concurrent admission callers against one runtime mutex, capacity 1, 50 requests across 10 branches.
9. Kill the host while a slot is granted and its VM boots. Separately, start the host with a VM that the runtime has but no slot holds.

Pass when:
- Step 1: one waiting holder, shown at position 1 on all three requests; the grant takes one slot, and `held` never exceeds 1 for D.
- Step 2: positions are E 1 and C 2: C was promoted to `person` at t0 + 2 s and ranks behind Alice's earlier person request. E is granted first after A's release.
- Step 3: F's slot stays held until its stop is confirmed at 10 s, and G is granted only then.
- Step 4: the VM is force-stopped at 60 s, and its slot stays held until the stop is confirmed; nothing is granted before that.
- Step 5: the prepare VM runs in H's slot, and H's VM boots after it stops; `held` never exceeds 1, and H is awake within the prepare time plus 30 s.
- Step 6: both wakes are granted; the third waits while free disk is 100 GiB (`floor(60 / 32)` = 1, not above `held`) and is granted within 2 s of free disk returning to 140 GiB.
- Step 7: no held VM is stopped, and the person request waits until `held` falls below 1.
- Step 8: `held ≤ 1` and the runtime count `≤ 1` at every sample, and every request is granted exactly once.
- Step 9: after restart the booting VM holds one slot and is granted once; the slotless VM is stopped; no slot lacks a VM.
- In every step, the runtime's own cap never refuses: no `ErrCapacity` appears.

Fail when:
- `held` counts only awake and waking machines, so a provisioning, releasing or prepare VM lets the host exceed capacity.
- One branch takes two slots.
- A cold boot at capacity 1 waits forever for a second slot.
- Free disk is read only at start.


C-MCH-02 (folded steps and assertions):
1. Enqueue in this order, 10 ms apart: background `learning` (branch E), `todo` T5, `todo` T6, `person` Alice terminal on D, `person` Ben SSH on C.
2. Read positions from the projections.
3. Advance the clock 2 h with T1 still running a step.
4. T1 reaches `in_review` and the branch has no presence, terminal or SSH. Advance the clock 1 s.
5. Alice cancels her terminal request before D's wake finishes.
6. Release continues until the queue is empty. Record grant order.
7. Repeat steps 1–6 with concurrent admission callers against the same runtime mutex.

Pass when:
- Step 2: positions are Alice 1, Ben 2, T5 3, T6 4, learning 5 (person by age, then todo by age, then background). `todo:5` shows `queue {reason: "waiting for a machine", position: 3}`, which renders "waiting for a machine #3" (§8.3.2).
- Step 3: branch A's machine is never released and T1 is never paused.
- Step 4: A is released (safe-idle), and the grant goes to Alice within 2 s.
- Step 5: the request is `cancelled` and D sleeps again within 2 s.
- Step 6: grant order is Alice, Ben, T5, T6, learning. Every grant is followed by a projection delta before the next grant. T5 and T6 each show `starting` on grant and `working` only after their run's first step starts (§4.1).
- Step 7: same order, and no slot is granted twice (`held ≤ 1` at every sample, counting provisioning, waking, awake and releasing machines, §8.3.2).

Fail when:
- A TODO or background request is granted ahead of a waiting person.
- A TODO shows `working` at grant time, before its run's first step.
- A machine with presence, an open terminal, an SSH session or a running step is released.
- Positions skip or repeat (1, 3), or a position is shown before its request enters the runtime queue.
- A capacity refusal surfaces as a 500 or an untyped string instead of `class: capacity`.


- unit (`machine_admission_test.go`, new, fake clock): a grant moves its TODO to `starting`, never straight to `working`; ordering by class then age; positions after every enqueue, grant and cancel; no grant at capacity; release never picks a machine with presence, a terminal, an SSH session or a running step; release picks the longest safe-idle machine; a prepare VM and a background `/review` machine each occupy a slot.
- unit: with requests waiting and every machine safe-idle, no machine is released at 29.9 s after host start, and the longest safe-idle one is released at 30 s (§7.3.0).
- integration (real PostgreSQL, conformance runtime): capacity 1, a working TODO holds it, then background, todo and person requests arrive in that order and are granted person, todo, background. The working agent's machine is never released. Concurrent callers never grant the same slot twice. This is C-MCH-02.
- integration: a person request cancelled before its wake finishes releases the machine within 2 s.
- integration (real PostgreSQL, conformance runtime with injectable boot and stop delays, an injected free-disk reader): C-MCH-11, covering simultaneous wakes of one branch, promotion, cancelled and slow releases, a cold boot at capacity 1, the disk re-check, a lowered capacity, concurrent callers and restart reconciliation.
- fault (`packages/backend/internal/services/machine_admission_fault_test.go`, new): kill the host between grant and boot; on restart the request is granted once and no VM is orphaned.
- perf (reference host): warm wake p95 < 5 s, n ≥ 100 (C-PERF-05).

## Acceptance
- [C-J10-09](../checks/C-J10-09.md): (S2) a review request is `background` class, waits behind people and counts against capacity.


- [C-MCH-02](../checks/C-MCH-02.md): person before TODO before background, FIFO within class, positions shown, no preemption, safe-idle release.
- [C-PERF-05](../checks/C-PERF-05.md): warm wake (asleep → awake, granted immediately) p95 < 5 s on the reference host.
- [C-MCH-11](../checks/C-MCH-11.md): every VM holds a slot from grant to confirmed stop, demand coalesces per branch with promotion, a cold boot prepares inside one slot at capacity 1, and free disk is re-read before every grant.

## Risks and notes

- A person's request waits behind a capacity held only by working agents, since there is no preemption, and the person sees "waiting for a machine #1" indefinitely. Confirmed by C-MCH-02 with capacity 1 and a long-running TODO. Product accepted this in M-13; record it in the check evidence.
- Safe-idle depends on presence heartbeats (30 s TTL). A stale heartbeat holds a machine for up to 30 s past the person leaving. Confirmed by closing a tab and timing release.
- After a host restart the presence map is empty, so every machine would look safe-idle. The 30 s no-release window (§7.3.0) covers the browsers' 10 s re-send and the daemon's session re-send. Falsified if an SSH session's machine is released within 30 s of a host restart.
- A paused TODO's run waits in a durable pause wait (§4.1), which doesn't count as a running step (§8.4.1), so its machine is released once safe-idle.

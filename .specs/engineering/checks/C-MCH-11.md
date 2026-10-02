# C-MCH-11 Every VM holds a slot from grant to confirmed stop; demand coalesces per branch; a cold boot needs one slot

Proves: mvp.md M-06, M-13, §6.7 Capacity and queue · spec.md §8.2.1a, §8.2.1b, §8.2.2, §8.3.1, §8.3.2, §8.3.4 · Layer: integration · Stage: S2 · Tickets: T-MCH-06
Automation: `packages/backend/internal/services/machine_slots_integration_test.go` (new) · Runs in: CI (real PostgreSQL, the conformance runtime with injectable boot and stop delays, an injected free-disk reader, a fake clock); step 5 also runs on the reference host with real microVMs

## Setup
- Real PostgreSQL 18 at head. Members Ben and Alice. A live subscriber records `home`, `todo:*` and `branch:*` deltas with cursors.
- A sampler records `held` (machines provisioning, waking, awake or releasing, plus prepare and background VMs) and the runtime's count of VMs that aren't stopped, every 10 ms.

## Steps
1. Capacity 2, ample disk. Branch D is asleep with TODO T5 queued on it. At the same instant, enqueue T5's `todo` request, Ben's terminal on D and Alice's SSH on D. Read positions, then let the grant happen.
2. Capacity 1, held by T1's working run on branch A. Enqueue T6's `todo` request on branch C at t0, Alice's terminal on branch E at t0 + 1 s, and Ben's terminal on C at t0 + 2 s. Read positions. Then T1 goes to review and A becomes safe-idle.
3. Capacity 1. Grant a wake for branch F, then cancel its only request while the VM boots; the runtime takes 10 s to confirm the stop. Meanwhile enqueue a person request for branch G.
4. Capacity 1. Release a VM whose stop the runtime never confirms.
5. Capacity 1, a fresh install with no built layer. Wake branch H.
6. Capacity 3, free disk 140 GiB (`floor((140 − 40) / 32)` = 3). Wake two branches. Lower free disk to 100 GiB and enqueue a third wake. Raise free disk to 140 GiB.
7. Capacity 3 with three VMs held. The owner lowers capacity to 1. Enqueue a person request.
8. Two scheduler instances against one database, capacity 1, 50 requests across 10 branches.
9. Kill the host while a slot is granted and its VM boots. Separately, start the host with a VM that the runtime has but no slot holds.

## Pass when
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

## Fail when
- `held` counts only awake and waking machines, so a provisioning, releasing or prepare VM lets the host exceed capacity.
- One branch takes two slots.
- A cold boot at capacity 1 waits forever for a second slot.
- Free disk is read only at start.

## Evidence
`.artifacts/checks/C-MCH-11/<UTC timestamp>/`: `go test -json` output, the `held` and runtime-count samples (CSV), the grant log, `machine_requests` and `machines` dumps per step, the projection deltas with cursors, and the commit.

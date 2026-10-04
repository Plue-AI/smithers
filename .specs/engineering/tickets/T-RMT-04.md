# T-RMT-04 Summed capacity, placement at wake, sticky disks and Move

Stage S1 · Size M · Depends on T-RMT-03, T-MCH-01 · Unblocks T-RMT-05 · Issue: [#3706](https://github.com/smithersai/smithers/issues/3706)
Spec: spec.md §8.13.4, §8.13.5, §8.13.6, §8.2, §8.3, §10.3.1 · Product: #3706 Product position (M-40 pending in mvp.md)

Added 2026-10-04 by smithers-8a for Will's sandbox-placement ruling (#3706). Behind `remoteSandboxes`, off by default.

## Goal
Install capacity is the sum over reachable hosts; a new machine goes where there is room or where its TODO says; a machine with a disk wakes where the disk is; an unreachable host offers Retry and Move.

## Scope
In: per-host profiles and limits; per-host slots in the existing admission; the TODO `placement` field (`auto` or a host name); the "on <host>" line; Retry and Move.
Out: S2 branch-machine admission (T-MCH-06 inherits per-host slots); Cloud.

## Changes
- Reshape `packages/backend/microsandbox/hostprofile.go`, `capacity.go` and `admission.go`: a profile and limits per host; the remote profile is read over the T-RMT-03 connection. One scheduler, one mutex; a grant names a host.
- Reshape the TODO record: `placement` (default `auto`), shown and edited on the TODO card per smithers-06's design.
- `parallel` defaults from summed capacity once T-STK-03 (S2) serves it; until then nothing reads it.

## Decisions and pre-review
- smithers-22 owns the lane; smithers-06 supplies the placement control and line; smithers-8a accepts the tie and wait rules.

## Tests

C-RMT-04:
1. Table test: `this-mac` 64/12/1,024 (capacity 6) plus a remote 32 GiB, 8 physical cores, 500 GiB host (capacity 3); then the remote host unreachable.
2. Seven TODOs with `auto`; then one TODO with placement `beaver` while `beaver` is full.
3. Sleep a remote-placed workspace, then wake it while `this-mac` has free slots.
4. Make the remote host unreachable for 60 s with a workspace on it; press Move; then bring the host back.
5. Turn the flag off with a workspace on the remote host.

Pass when:
- Step 1 sums to 9, then 6 with the remote host unreachable, while its held slots stay held until stopped.
- Step 2 places by most free slots with ties to `this-mac`; the pinned TODO waits for `beaver` rather than falling back.
- Step 3 wakes on the remote host. Step 4 shows "beaver is unreachable", Move recreates on `this-mac` from the last candidate, and the old disk is deleted on reconnect.
- Step 5 shows "Remote machines are off" with Move to this Mac.

## Acceptance
- [C-RMT-04](../checks/C-RMT-04.md)
- [C-RMT-06](../checks/C-RMT-06.md): the product falsifier, end of stage 1.

## Risks and notes
- A pinned placement can wait forever on a dead host; Move is the exit and the card says so.

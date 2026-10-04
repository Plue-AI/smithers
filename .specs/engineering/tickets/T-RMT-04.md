# T-RMT-04 Summed capacity, placement at wake, sticky disks, pause, unreachable and Remove

Stage S1 · Size M · Depends on T-RMT-03, T-MCH-01 · Unblocks T-RMT-05 · Issue: [#3706](https://github.com/smithersai/smithers/issues/3706)
Spec: spec.md §8.13.4, §8.13.5, §8.13.6, §8.2, §8.3, §10.3.1 · Product: #3706 Product position (M-40 pending in mvp.md)

Added 2026-10-04 by smithers-8a for Will's sandbox-placement ruling (#3706). Behind `remoteSandboxes`, off by default.


**ON HOLD (2026-10-04, Will via smithers-56, #3706):** remote machines reuse the Plue Cloud controller and `microsandbox-worker`; this ticket's SSH mechanism is superseded until spec §8.13 is reconciled (§8.13.0). Do not start.

## Goal
Install capacity is the sum over reachable hosts; a new machine goes where there is room or where its TODO says; a machine with a disk wakes where the disk is; an unreachable host offers Retry; the owner may pause or remove a host.

## Scope
In: per-host profiles and limits; per-host slots in the existing admission; the TODO `placement` field (`auto` or a host name); the host suffix on cards; pause and resume; Retry; Remove and its closing of machines.
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
4. Make the remote host unreachable for 60 s with a workspace on it; Retry; then Remove the host; then Retry the TODO; then bring the host back.
5. Pause `this-mac` and add two `auto` TODOs; fork a remote-placed branch.

Pass when:
- Step 1 sums to 9, then 6 with the remote host unreachable, while its held slots stay held until stopped.
- Step 2 places by most free slots with ties to `this-mac`; the pinned TODO waits for `beaver` rather than falling back.
- Step 3 wakes on the remote host. Step 4 shows "Machine unreachable · beaver" and fails the step with `computer_unreachable`; Remove records "Closed · beaver removed by <owner>"; Retry restarts the TODO from its last candidate by `auto`; the old disk is deleted on reconnect.
- Step 5 places both TODOs on the remote host, and the fork runs on the remote host.

## Acceptance
- [C-RMT-04](../checks/C-RMT-04.md)
- [C-RMT-06](../checks/C-RMT-06.md): the product falsifier, end of stage 1.

## Risks and notes
- A pinned placement can wait forever on a dead host; Remove moves queued pinned TODOs to `auto`.
- Design: `.specs/design/placement.md` (4786488c8c) supplies Runs on, the suffix and the queued lines.

# T-MCH-14 Keep TODO workspaces until settled; wake before delivering a signal

Stage S1 · Size S · Depends on T-STK-01 · Unblocks T-FLW-11, C-STK-05 · Issue: to file
Spec: spec.md §8.4, §10.4.1, §8.12 · Delta: delta.md §6 · Product: mvp.md J10.2, M-31

## Goal
A TODO's working copy and its waiting `todo` run survive days in review, so a GitHub review steer resumes the same run on the same files.

## Scope
In:
- Workspaces bound to an unmerged TODO are exempt from the 5-minute agent idle stop while their run waits on a durable signal, and from the 24 h stopped-disk reclaim.
- They may still be suspended with the disk kept.
- Before the stack engine delivers a signal (steer, review comment, rebase, resume) to a run whose workspace is suspended, it wakes the workspace and waits for the coding host.

Out:
- Admission, positions and people-first ordering (T-MCH-06, S2).
- Capture-before-sleep and reads that never wake (T-MCH-07, S2).
- Cleanup policy after settle (T-MCH-09, S2). This ticket only stops early reclaim.

## Changes
- `packages/backend/internal/services/agent_dispatch.go:1128` (`defaultAgentIdleTimeout = 5m`) → a waiting run on a TODO workspace suspends the VM, keeping the disk, instead of tearing down the session.
- `packages/backend/internal/services/workspace_disk_reclaim.go:20` (`defaultAgentWorkspaceDiskReclaimAfter = 24h`) → skip workspaces whose TODO is unmerged (join through `todos.branch_id` and the lane binding).
- Stack engine signal delivery (`mythical_items.go` launch and signal paths, T-FLW-11) → `ensureRuntimeWorkspaceRunning` before `Signal`. Delivery is durable: a wake failure retries with backoff and surfaces as `failed{step: "wake"}` after 15 min.

## Tests
- Integration (real microVM): a TODO in review suspends after idle. A steer delivered 25 h later (simulated clock) wakes it, the same run id resumes, and the working copy holds the files from before.
- Integration: the reclaim sweep skips an unmerged TODO's workspace and reclaims a dropped one.
- Fault: kill the host while a wake for a signal is in progress. On restart the signal is delivered exactly once.

## Acceptance
- [C-STK-05](../checks/C-STK-05.md)

## Risks and notes
- Risk: many waiting TODOs keep suspended disks. Confirm disk use with 20 suspended TODO workspaces on the reference host. The 32 GiB disk per machine is sparse (APFS clone), and the layer budget (§8.2.1) bounds the rest.

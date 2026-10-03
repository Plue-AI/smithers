# C-MCH-08 Fork never stops the source machine and starts from the captured revision

Proves: mvp.md J7.2, §6.7 Fork · spec.md §8.5.1, §8.5.2, §9.1.2 (`capture()`) · Layer: integration · Stage: S2 · Tickets: T-MCH-08
Automation: `packages/backend/internal/services/branch_fork_integration_test.go` (new) · Runs in: reference host (real microVM, real PostgreSQL, real jj)

## Setup

- The reference host at the commit under test, capacity ≥ 2, `smithers-machined` installed (T-COL-03).
- TODO T2 on `smithers/retry-webhooks`, awake. Ben's terminal on it runs `while :; do date +%s%N >> /workspace/.tick; sleep 0.1; done`.
- An uncommitted new file `src/try.ts` in the working copy, written 1 s before the fork.
- TODO T3's branch is asleep with a captured head H3.

- Expected tree bytes, patch content and source refs come from fixed test setup, never from spec files or production code at runtime. HTTP calls use the production router and dispatcher; service-only calls do not count.

## Steps
1. Record the source VM's boot id (`/proc/sys/kernel/random/boot_id`) and the counter loop's pid.
2. Ben forks T2: `POST /api/branches {from: "T2", name: "try-retry"}`.
3. Record the capture's commit C, the scratch branch's `forked_from`, and the source boot id and loop pid again.
4. Compute the largest gap between consecutive `.tick` lines during steps 2–3.
5. Fork T3 (asleep) and fork `main`.
6. Open a terminal on the scratch branch. `cat src/try.ts`, `jj log -r @-`.

7. Write a fixed uncommitted fixture edit on the awake scratch branch, invoke branch.add-to-stack through the production catalog dispatcher and complete its person confirmation. Assert the seed contains those fixture bytes after capture, the branch/workspace ids are preserved and no source machine stops.
8. Exercise every retained hosted ForkWorkspace consumer and its served workspace fork route with the compatibility decision applied. Verify revision-based creation and the same source boot id, loop pid and no-stop timing assertions; a deleted route is explicitly absent rather than silently falling back to stop/snapshot.

## Pass when
- Step 8: retained hosted callers use revision-based creation and preserve the no-stop guarantee. No caller can reach the old wake/stop/snapshot path.


- Step 3: the boot id and loop pid are unchanged, and `forked_from.commit` equals C.
- Step 4: no gap exceeds 1 s.
- Step 5: the T3 fork starts from H3 with 0 runtime starts for T3's machine; the `main` fork starts from the mirror's `main` tip.
- Step 6: `src/try.ts` is present with its content at fork time, and the scratch branch's parent revision is C's.

## Fail when

- The source VM restarts or pauses (new boot id, the loop pid gone, or a gap over 1 s): the old stop-snapshot-resume path (`packages/backend/internal/services/workspace_runtime.go:547-560`) is still live.
- The fork copies the disk instead of starting from C. That shows as files written after C appearing in the fork.
- Forking an asleep item wakes it.

## Evidence

`.artifacts/checks/C-MCH-08/<UTC timestamp>/`: `go test -json` output, boot ids and pids before and after, the `.tick` gap histogram, the commit ids (C, H3, `main` tip), the runtime start counter, the commit and the `msb` version.

# C-MCH-03 Reading a sleeping branch never wakes it

Proves: mvp.md §6.7 Sleep, J4 · spec.md §8.4.3, §8.4.4 · Layer: integration · Stage: S2 · Tickets: T-MCH-07
Automation: `packages/backend/internal/services/branch_sleep_reads_integration_test.go` (new) · Runs in: CI (real PostgreSQL, real jj, runtime fake that counts starts) and reference host (real microVM)

## Setup

- Real PostgreSQL 18 at head; the host repository store with the mirror.
- Branch `smithers/retry-webhooks` for TODO T2, awake. Its working copy has a committed change to `src/retry.ts` and an uncommitted new file `src/backoff.ts`.
- Credentials: the owner's session, Alice's (member) session, and Ben's delegated CLI credential (`via=cli`).

## Steps

1. Put the branch to sleep (capture, then stop). Record `machines.head_commit_id`, the ref `refs/smithers/branches/<id>/head`, and the runtime start counter.
2. With each credential: list files, read `src/retry.ts` and `src/backoff.ts`, get the diff, and get activity through the HTTP API (the same calls the File, Diff and Branch cards make).
3. Read the `branch:<id>` projection.
4. Positive control: Alice opens a terminal on the branch.

## Pass when

- Step 1: the ref equals `head_commit_id`, and the captured tree contains `src/backoff.ts`.
- Step 2: every call succeeds with content byte-equal to the captured tree, and the runtime start counter is unchanged (0 starts, 0 resumes) for all three credentials.
- Step 3: the machine state is `asleep` throughout step 2, with no `waking` delta.
- Step 4: a `person` admission request is created and the machine wakes, which proves the counter works.

## Fail when

- The owner's or a writer's read wakes the VM (the old `workspaceRuntimeFacetTarget` branch at `packages/backend/internal/services/workspace_facets.go:457-461`).
- A read returns 409 "workspace is stopped" instead of the captured content.
- `src/backoff.ts` is missing because the sleep stopped the VM without a final capture.
- The diff is computed against `main` instead of the item's base.

## Evidence

`.artifacts/checks/C-MCH-03/<UTC timestamp>/`: `go test -json` output, the runtime start counter before and after each step, response bodies with SHA-256 digests next to `git ls-tree -r` of the captured commit, the projection deltas, the commit and (reference host) the `msb` version.

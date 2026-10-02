# C-MCH-01 Two members and the agent on one branch share exactly one VM and one working copy

Proves: mvp.md J3.1–J3.3, §6.7 One live branch, §11 item 9, M-17 · spec.md §2 (Machine), §8.1.2, §3 (`machines`) · Layer: integration · Stage: S2 · Tickets: T-MCH-04
Automation: `packages/backend/internal/services/branch_machine_integration_test.go` (new) · Runs in: CI (real PostgreSQL, conformance runtime) and reference host (real microVM, `SMITHERS_MICROSANDBOX_BIN` set)

## Setup

- Real PostgreSQL 18 migrated to head. Install system user present. Members: Ben (maintainer) and Alice (member), both with live GitHub write access (fake GitHub server).
- One TODO T2 with item branch `smithers/retry-webhooks` and no machine yet.
- CI run: the workspace conformance runtime (`packages/backend/workspaceconformance`). Reference-host run: the microVM runtime, capacity ≥ 2.

## Steps

1. Ben, Alice and the TODO run each request the branch's machine at the same moment, 20 times in parallel (60 requests).
2. Count `machines` rows for the branch, active `workspaces` rows for it, and (reference host) `msb list` machines carrying its label.
3. Reference host: Ben's terminal runs `echo ben > /workspace/shared.txt`. Alice reads `shared.txt` through the file API. The agent's tool reads it through its own step.
4. A second agent session attaches to the same branch (a retry). Count `workspace_agent_sessions` rows.
5. Erase Ben's account (`account_erasure.go`), then read the branch's machine.
6. Read `workspaces.user_id` of the branch machine.

## Pass when

- Step 2: exactly 1 `machines` row, 1 active `workspaces` row and (reference host) 1 VM.
- Step 3: Alice and the agent both read `ben`.
- Step 4: 2 rows in `workspace_agent_sessions` and still 1 `workspaces` row, with no unique-violation error.
- Step 5: the machine row, its VM and its disk still exist.
- Step 6: the value is the install system user's id, not Ben's or Alice's.

## Fail when

- Any request creates a second `workspaces` row (a `kind=agent` row, or one per member).
- The agent forks a separate machine (`agentForkSource` path still live).
- Erasing the first joiner deletes the machine.
- The test passes only with requests serialized: the race in step 1 must run concurrently.

## Evidence

`.artifacts/checks/C-MCH-01/<UTC timestamp>/`: `go test -json` output, a SQL dump of `branches`, `machines`, `workspaces` and `workspace_agent_sessions` for the branch after each step, `msb list` output (reference host), the commit and the `msb` version.

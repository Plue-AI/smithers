# Durable remote fixes

`placement: "vm"` and `"cloud"` run Codex or Claude through `ExternalJob`
and `Sandbox.job`. A job's key is its execution ID plus generation (`#g1`,
then at most `#g2`). Closing a probe scope or losing the host leaves the
machine running. The restarted host attaches to it; only confirmed loss or an
exited quota/network failure permits a replacement. Probes back off from 15
seconds to 2 minutes; the whole job has a 2-hour deadline across restarts.

`Remoted`, adoption and landing keep their existing shapes. Collection saves
refreshed Codex credentials, captures the patch, cools an exhausted account,
persists the result, then destroys the machine. Cancellation stops the job and
copies its refreshed login before destruction. Account identities are durable;
credentials remain outside the checkout and receipts. Outstanding account
reservations are restored before a new host admits work.

Receipt files under `~/smithers/.flows/issue-sweep-jobs` are shared by the
pinned hosts on this machine. They use hashed names and atomic, synced writes.
Retain this directory across host restarts; these receipts are part of the
run's recovery state. Cross-host receipt replication is not provided.

## VM capacity

Each durable job owns one retained, detached microVM. Use `agentsPerVm: 1`
(the default); pooled sessions are scoped and are not used by RemoteFix.
`maxVms` (default 24) counts retained job machines, including those left by an
earlier host. Reattachment bypasses the capacity/disk admission gates and
never refreshes an existing job's checkout. New boots serialize. VM reaping
retains non-terminal executions and unknown status; a proven terminal
execution can be removed once its holder is gone.

The default shape is 2 CPUs and 4 GiB. The sizing fields `memoryBaseMib`,
`memoryPerAgentMib`, `cpusPerAgent` and `maxCpus` remain available. A new VM
waits below 25 GiB host free disk. Before waiting, admission bounds each
Go cache trim and pnpm store prune to two minutes, reaps proven settled
workspaces, then checks disk again. New landing and recovery workspaces
reserve another 3 GiB above that floor. Existing retained workspaces and
jobs reattach without allocating another checkout. Do not raise production concurrency on a
full host; real restart tests use one VM with a test-only disk floor.

## Validation

```sh
node --test flows/issue-sweep/test/{accounts,vm,receipts,work,remote-job,remote-job-restart}.test.ts
SMITHERS_VM_JOB_RESTART=1 node --test --test-name-pattern='vm job survives' flows/issue-sweep/test/job-restart.real.test.ts
SMITHERS_CLOUD_JOB_RESTART=1 node --test --test-name-pattern='cloud job survives' flows/issue-sweep/test/job-restart.real.test.ts
```

The fake transport tests exercise the real job protocol and a real SQLite
engine: SIGKILL mid-poll, restart, exactly one launch, Lost to generation 2,
rotated login, quota/network failures, and durable caller cancellation. The
real tests kill and restart separate host processes, verify one launch/edit,
collect twice from the durable receipt, and remove the machine. Run real VM
tests one at a time.

Executed 2026-10-01: the real VM restart passed in 118 seconds and left no
machine. Live Cloud creation returned HTTP 500 after admitting a workspace,
including with 2 CPU / 4 GiB / 32 GiB; all test workspaces were removed.
[#3379](https://github.com/smithersai/smithers/issues/3379) tracks the blocked
Cloud restart qualification. This is not evidence of a successful Cloud job.

Use `placement: "cloud"` with `cloudAgents` for Cloud-only work even when
local disk has recovered above the VM floor.

## Operator cutover

The supervisor owns `~/smithers-runner`. Stop or drain the old sweep before
moving that checkout. Under `~/Smithers-Ops/dispatch/vcs_lock.py`, fetch main
and move the runner's empty working copy to the landed commit with
`jj -R ~/smithers-runner new <commit>`. Install there using
`pnpm install --prefer-offline --frozen-lockfile --ignore-scripts`.

Copy the previous sweep's JSON payload, set `attempt` to **one greater than
its previous value**, and keep `agentsPerVm: 1`. Do not resume an old attempt
onto this changed declaration. Preserve the rest of the operator's filters,
concurrency and placement choices. From the pinned runner:

```sh
SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$HOME/smithers/target/release/smithers-jj-export" \
  pnpm exec smthrs flow start issue-sweep --data "$(cat /absolute/path/new-attempt.json)" --detached
```

Retain the returned run ID and inspect `smthrs runs show <id>` and
`smthrs runs logs <id> --follow`. Admission is not completion. VM placement
requires the disk floor above; Cloud qualification remains blocked on #3379.
Local `Fix` is scoped and does not survive host death.

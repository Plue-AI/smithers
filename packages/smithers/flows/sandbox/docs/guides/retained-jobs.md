---
title: "Retained jobs"
description: "Run and recover detached commands on retained sandbox machines."
---

## Declare the adapter

`Sandbox.job(provider, { command, files, capture })` returns `start`, `status`,
`collect`, and `cancel` effects for a durable external job. The provider must
advertise `retained: true`, connect through `attach` without creating or restarting
machines, and support idempotent `destroy`. Ephemeral providers are refused.

Use `MicrosandboxSandbox.make({ persistence: "sticky", ... })` for detached
microVMs. `CloudSandbox.make({ persistence: "sticky", ... })` leaves its workspace
running on scope closure, creates a client lease, and renews it on every attach.
Cloud's default lease is 900 seconds; configure a longer lease than the maximum
probe interval. Configure the workspace idle limit to outlast the job, since
renewal alone does not establish that idle suspension counts as activity.

```ts
const adapter = Sandbox.job(provider, {
  command: "agent --brief brief.txt",
  files: { "brief.txt": new TextEncoder().encode(brief) },
  capture: { base: "HEAD" }
})
```

Files use absolute guest paths or paths relative to the session workdir.
The command runs in `capture.checkout` when supplied, otherwise the workdir.
Job metadata defaults to `/var/lib/smthrs-jobs`, outside the checkout and the
transient process directory. Cloud supplies the developer-owned default
`/home/developer/.local/state/smthrs-jobs`; `jobDirectory` overrides either
location. An overlap with the captured checkout is refused.

## Recovery and cleanup

An atomic directory creation fences the launch by the durable job key.
A duplicate start returns the same handle. The worker records its process-group
identity before running the command and atomically publishes its exit status.
Status returns `Running`, `Exited`, or `Lost`. A failed transport stays a typed
provider failure; it is not evidence that the worker is gone.

Collect reads stdout, stderr, exit status, and `Work.capture`. Supply an Effect
`KeyValueStore` backed by durable storage shared by every host that can collect
the job. Collect persists a schema-checked receipt before destroying the machine.
A reconstructed adapter reads that receipt and retries destruction without
requiring the machine to still exist. A memory store does not establish crash
recovery. Keep receipts until the corresponding durable execution is no longer
reachable.

Cancel records a tombstone, sends TERM to the process group, waits two seconds,
sends KILL, and destroys the machine. The tombstone prevents a delayed launcher
from starting work after cancellation. Cleanup failures remain visible and must
complete before starting another generation.

Microsandbox labels retained machines with `smithers.execution` derived from the
job execution key. Supply `MicrosandboxSandbox.reap`'s `retain(labels)` hook to
preserve machines whose executions remain live. Cloud's API does not expose
workspace labels; its client lease is the cleanup backstop.

## Executed spike

On 2026-10-01, Microsandbox 0.6.16 on macOS with `kern.hv_support=1` and
`kern.hv_vmm_present=0` ran a cached `node:26-trixie` guest, 512 MiB, one vCPU,
network disabled. A `setsid /bin/sh` child outlived the raw exec launcher and
later recorded exit 0. The same command through the actual Microsandbox SSH
boundary returned in 0.861 seconds for eight seconds of detached work; an
independent exec subsequently read its exit 0. The temporary machine was removed.
The guarded `RealSandboxJob.integration.test.ts` also executed successfully:
`Sandbox.job` survived its host process receiving SIGKILL, ordinary acquire
cleared transient pids without losing the job, collection returned the guest
patch, a reconstructed filesystem receipt replayed after destruction, and status
then reported Lost. These observations establish local exec and SSH survival;
hosted Cloud execution was not measured.

Reproduce with `python3 test/fixtures/job-survival-spike.py` from this package.
The image must already be cached. The script prints transport receipts and
removes its own uniquely named machine in `finally`.

Run that host-death regression with
`SMITHERS_REAL_SANDBOX_JOB=1 pnpm exec vitest run test/RealSandboxJob.integration.test.ts --coverage.enabled=false --maxWorkers=1`.
Without the explicit guard or cached image, the suite reports its missing
capability and starts no machine.

# Durable external work: attach, don't restart

Status: proposal, 2026-10-01; §3.5 approved by Will on 2026-10-02 UTC. Line references are `main` at 954a8125.
Scope: liveness of long external work (10-60 min coding agents in microVMs or
Cloud workspaces) under host stalls, network loss, restarts and code changes,
without duplicate external workers and without `smthrs runs resume`.
Non-goals: a second graph model; changing `@smthrs/flow` as the one flow model;
who restarts a dead host process (serve/launchd stays as is).
Fault cases: #3367 (`packages/smithers/test/faults`).

## 1. Why each fault stopped the run

### F1. Host stall over 19 s parks the run until `runs resume`

1. `heartbeatWriteTolerance` = stale cutoff 30 s - skew 10 s - interval 1 s = 19 s
   (`flows/journal/src/Consensus.ts:45-101`).
2. The lapse is decided by the clock, not by evidence: the deadline fiber calls
   `expire`, which interrupts once 19 s pass without a confirmed pulse
   (`flows/run-store/src/Ownership.ts:323-339`). It never asks whether anyone
   claimed the run. On one host nobody can: `sameHostPidProbe` refuses to steal
   from a live pid (`Ownership.ts:220-230`).
3. The loop races the flow body (`flows/engine-store/src/internal/RunDriver.ts:2053-2076`).
   Every execution has its own loop, so ~24 work children, the rounds child
   and the root all lapse at once.
4. Interruption destroys the external work, not only the fiber. `remoteFix` runs
   `Sandbox.run` inside `Effect.scoped` (`flows/issue-sweep/work/flow.ts:532-548,
   613-640`). Closing that scope kills the guest process and removes the
   ephemeral microVM (`flows/sandbox/src/Sandbox/run.ts:68-80`,
   `MicrosandboxSandbox/make.ts:580`) or DELETEs the Cloud workspace
   (`src/CloudSandbox.ts:148-165`). Any later RemoteFix restarts the agent.
5. `settleInterrupted` and `releaseOwned` record `interrupt-released`
   (cause `lease-lapsed`) and park with reason `released`
   (`RunDriver.ts:1391-1433, 2257-2267`).
6. The sweep wakes released rows (`RunDriver.ts:2304-2329`). `ControlAffinity`
   refuses a released child whose control ancestor belongs to this same live
   process (`src/internal/ControlAffinity.ts:79-101`), unless
   `canRetryReleased` finds an explicit-resume grant or a dead same-host owner
   (`src/internal/ReleasedChildResume.ts:173-196`). The owner is alive, so the
   run ends up `needs-resume`.
7. Burndown releases every open claim as `requeued: round interrupted`
   (`flows/patterns/src/Burndown.ts:887-911`).

Two root causes:
- (a) A lapse is treated as a loss, even though a compare-and-swap could prove
  that exclusivity held.
- (b) The external process lives in the engine fiber's scope, so re-execution
  means restarting it.

Given (b), #2982's fail-stop is correct. This design removes (a) and (b);
it does not weaken #2982.

### F2. DNS outage becomes terminal action failures

1. Dispatch retries only when an action declares `retryPolicy`
   (`flows/engine/src/FlowEngine/Dispatch.ts:333-376`). No issue-sweep action
   declares one.
2. `Fault.respond` already says `infra -> retry, then park`
   (`flows/flow/src/Fault.ts:185-194`), but nothing on the action path consults
   it. `ProviderError`, `HostFailed` and `GhFailed` are unregistered, so they
   classify as `bug` (`Fault.ts:142-160`).
3. Burndown settles every typed claim, work or land failure as `failed`
   (`Burndown.ts:786-805, 873-879`), which is final for the lineage
   (`Burndown.ts:364`). Run-6 lost 118 items to one 75-minute outage.
4. Outage detection exists in only one flow and gives up after about 20 minutes
   (`flows/issue-sweep/host.ts:113-135`). Cloud create errors collapse into a
   single message (`src/CloudSandbox.ts:132-140, 153`).

### F3. A code change under a live run breaks it

- `body_unavailable` (#3320): `Registry.loadBody` refuses changed live bytes
  (`agent/registry/src/Registry.ts:386-422`). 7d810ed1 retains the verified
  module per live host, but only in memory (`src/internal/ModuleAuthority.ts:55-59, 184-193`).
  After a restart the host refuses the module (`ModuleAuthority.ts:169-183`,
  which raises a `LaunchFailed` defect), or resume raises `CodeDrift`
  (`control/src/ControlError.ts:130-150`) until someone passes `--allow-code-drift`.
- `ExecutionIdentityConflict` (run-8): joining a child admitted under a wider
  capability ceiling is a defect (`RunDriver.ts:1600-1608`). issue-sweep re-keys
  only interrupt-only causes (`flows/issue-sweep/flow.ts:434-446`), and a member
  defect fails the round (`Burndown.ts:713-715`). One child failed the whole run.

### F4. Fixed 30 s flow-load timeout (#3359)

`Executable.catalog` races each entry against `loadTimeoutMs ?? 30_000` and
records a timeout as `body_unavailable`, the same code as a broken file
(`agent/registry/src/Executable.ts:1604-1619`). Nothing retries it. The
detached host exits before admission, and its error names only the admission
window (`src/Detached.ts:470-483`).

## 2. Core mechanism: two designs

Both designs need three things:
- the job has a key outside the engine fiber;
- creation is create-or-get at the side effect itself, which is the "external
  fencing token at the side effect" that `Consensus.ts:85-90` says is needed;
- any engine incarnation can observe the job.

**A. Attach inside one action** (like Temporal's activity heartbeat)
- The action writes its handle with `Action.checkpoint(handle)`. AttemptStore
  already has `checkpoint` and `heartbeat` (`flows/run-store/src/AttemptStore.ts:166, 321`).
- A re-executed attempt is adopted under the same number
  (`engine-store/src/internal/ActionPersistence.ts:1948-2003`). It reads the last
  checkpoint and re-attaches instead of starting again.
- The fiber keeps waiting on the job and holds the run lease the whole time.

**B. Park on the job** (like Temporal's async completion)
- `Start` creates or gets the job by key; its handle is journaled.
- `Poll` runs a read-only `Status` probe, parked on a durable timer between probes.
- `Collect` captures the work and tears down; it is idempotent.
- A suspended run holds no lease (`RunDriver.ts:2290`), so stalls cannot lapse
  it, restarts resume on the timer, and any host can probe.

| | A: attach in action | B: park on job |
|---|---|---|
| Host stall | Lapse, release, re-drive, re-attach (churn) | No effect while parked |
| Host restart | Adopted attempt re-attaches | Timer wakes; the probe re-attaches |
| Network loss | Stream breaks, so the action needs its own polling loop | Probe fails as `infra` and is retried; the job is unaffected |
| Cancel vs release | Interrupt finalizers must tell them apart (they cannot today) | Explicit `Cancel` step plus a reaper |
| New engine API | `checkpoint` read/write, attach flag, guard change | None (a pattern), plus a `keyed` attempt-meta bit |
| Authoring | One action body | Four functions |
| Latency, journal | Immediate, one attempt | Up to the probe interval, ~40 probes/hour |

**Recommendation: B.** It removes lease coupling instead of recovering from it,
reuses `Action`/`Poll`/`Flow.to`, and its safety does not rely on finalizers.
A's only advantage, latency, does not matter for jobs that run 10-60 minutes.
§3.1 is still required, because the Burndown round is an action that waits
in-fiber on `Work.execute` in the parent for hours.

## 3. Changes

### 3.1 Lease reconfirm by the same live owner
- Add `Consensus.reconfirm(runId, owner, nowMs): Renewed | Lost`. It is a
  compare-and-swap: when `owner = me AND claim IS NULL`, set
  `heartbeat_at_ms = nowMs`. Implement it in SqlConsensus (next to `heartbeat`
  at :161) and in `layerLocal`.
- In `heartbeatLoop`, `expire` (`Ownership.ts:323-328`) first calls `reconfirm`,
  bounded by one `heartbeatInterval`.
  - `Renewed`: reset the confirmed-pulse time, call a new `onReconfirm(ms)` hook, and continue.
  - `Lost`, an error, or a timeout: today's `onLapse` followed by interrupt.
- RunDriver journals `run-decision lease-reconfirmed {unconfirmedMs}` next to
  `onLapse` (`RunDriver.ts:2066-2073`). `runs show` reports it as a warning,
  not as `needs-resume`.
- Why the check includes `claim IS NULL`: `steal` writes the claim before the
  thief activates (`SqlConsensus.ts:208-236`). In that window an owner-only
  heartbeat would still succeed.
- Why this is safe: exclusivity is a property of the lease row, not of the clock.
  - If reconfirm commits, no other owner was ever activated, and none can be now,
    because `steal` requires a stale heartbeat.
  - If a steal commits first, reconfirm fails and the owner interrupts exactly
    as it does today.
  - The 19 s tolerance still bounds non-durable overlap when a peer on another
    host really did steal.
- No generation bump. The fence is owner identity (`guard`), and the owner never
  changed. The journal decision is the audit record.

### 3.2 `@smthrs/flow/ExternalJob` (next to Poll)

```ts
export const RemoteFix = ExternalJob.make("issue-sweep/remote-fix", {
  payload: RemoteFixPayload, handle: JobHandle, success: Remoted, error: AgentFailed,
  probe: { every: "15 seconds", max: "2 minutes" },  // exponential; parked between probes
  timeout: "2 hours",                                 // from the journaled start, across restarts
  restarts: 1                                         // new generation only after the last one is proven over
})
RemoteFix.toLayer({
  start:   (payload, key) => Effect<Handle, AgentFailed | Unreachable>,   // create-or-get by key
  status:  (handle, key) => Effect<Running | Exited | Lost, Unreachable>, // read-only
  collect: (handle, key, exited) => Effect<Remoted, AgentFailed | Unreachable | ExternalJob.Again>,
  cancel:  (handle, key) => Effect<void>                                  // idempotent
})
```

- **Key.** The engine derives `key = <job execution id>#g<generation>` from durable
  identity, never from the payload. A replay rejoins its job, and two sweeps
  never share one.
- **Start.** An action with `idempotencyKey: key` and `tier: "irreversible"`.
  The engine already refuses to repeat unkeyed irreversible actions
  (`ActionPersistence.ts:955, 2026-2035`). The provider guarantees at most one
  process per key.
- **Status and Collect.** Keyed actions. `infra` failures retry (§3.4) without
  touching the job.
- **Outcomes.**
  - `Exited`: run `Collect`.
  - `Lost` (no exit record and no live process or machine), or `Collect`
    returning `Again`: if generation g < `restarts`, run `Cancel(key_g)`, then
    `Flow.to` g+1 after a backoff. Otherwise fail with `ExternalJobLost`
    (class `infra`).
  - Timeout: `Cancel`, then fail with `ExternalJobTimedOut` (class `dependency`).
- **Cancellation.** `Cancel` is registered with `Flow.withRollback` for the
  in-process case. The durable backstop is the reaper and the Cloud client lease
  (§3.3), because rollbacks do not survive a restart.

### 3.3 `Sandbox.job` and retained machines (`@smthrs/sandbox`)

`Sandbox.job(provider, { command, files, capture })` implements the four
functions over any `Session`:
- **start.** Acquire the retained machine for the key, then
  `mkdir /var/lib/smthrs-jobs/<slug>`. The mkdir is atomic; `EEXIST` means the
  job already started, so return its handle. Otherwise write the files and run
  `setsid sh -c '<cmd>; echo $? >exit.tmp && mv exit.tmp exit' </dev/null >out 2>err & echo $! >pid`.
  The launcher returns at once, so the spawn scope never holds the job.
- **status.** An `exit` file means Exited. A live process group
  (`kill -0 -<pgid>`) means Running. Anything else, including a missing
  machine, means Lost.
- **collect.** Read out, err and exit, run `Work.capture`, then destroy the machine.
- **cancel.** `kill -TERM -<pgid>`, wait 2 s, `-KILL`, then destroy the machine.
- The job directory sits outside the workdir (never captured) and outside
  `pidDirectory`, which every acquire wipes (`internal/pidDirectory.ts:9`).

Retained machines:
- Microsandbox already has `persistence: "sticky"` plus `detached`, which
  survives host death (`MicrosandboxSandbox/make.ts:114, 146, 331`).
- CloudSandbox gains `persistence: "sticky"` (skip the DELETE finalizer). Each
  probe renews the backend `client_lease_seconds` lease from #2457.
- `Provider` gains an optional `destroy(session)`.

Reaping:
- Machines carry the label `smithers.execution=<id>`.
- `MicrosandboxSandbox.reap`'s existing `retain(labels)` hook (`reap.ts:42`)
  keeps a machine while its execution is non-terminal.
- Cloud workspaces of dead executions are cleaned up when their client lease lapses.

### 3.4 Fault classification and bounded retry
- Register:
  - `ProviderError`: `unavailable` and `timeout` are `infra`; `spawn_error` and
    `not_found` are `bug`.
  - A new kernel `Unreachable`, lifted from `isNetworkOutage` and extended with
    EAI_AGAIN, ENOTFOUND and HTTP 429/5xx, is `infra`. Add a
    `classifyExit(stderr)` helper for host commands.
- Dispatch (`Dispatch.ts:333-376`): when an action declares no policy, retry
  under `RetryPolicy.transient` (5 s doubling to 5 min, expiring after 2 h)
  only if both hold:
  - `Fault.of` gives class `infra`;
  - the action is repeat-safe (has an `idempotencyKey`, or declares
    `effects.writes: []`).

  Otherwise there is no retry, and the failure keeps its class.
- `Fault.retryTransient(effect)` covers plain effects such as Burndown's land
  and release members.
- Burndown: an item that fails with class `infra` gets `requeued` instead of
  `failed`, up to `maxRequeues` (default 3, counted in rows), then `failed`.

### 3.5 #2982 guard: consent only for unkeyed in-flight effects
- `AttemptMeta` records `keyed: true` when the action has an idempotency key
  (`ActionPersistence.ts:968-971`).
- `canRetryReleased` (`ReleasedChildResume.ts:173-196`) also returns true when
  the released execution has no `running` attempt without `keyed`.
- **Approved by Will on 2026-10-02 UTC: "Approve §3.5".** This narrows
  #2982's "explicit resume" to releases whose unfinished effect could run twice.
  Legacy metadata without `keyed: true` remains unkeyed. Owner death never
  substitutes for explicit consent to retry an unfinished unkeyed effect. The consent
  policy is checked again inside the native activation transaction, so a new
  release or rewind generation after eligibility cannot spend old consent.
  Implementation: #3409.

### 3.6 Per-child isolation in Burndown
- A member defect settles only that item as `failed`, with `Fault.of(defect)` in
  the detail; its siblings keep running (`Burndown.ts:797-818`).
- A typed `Burndown.Stop` is the only way to stop the round. issue-sweep's
  `Effect.die(WorkspaceFailed)` (`flow.ts:444`) becomes `Burndown.Stop`.
- Optional: `execute` returns `ExecutionIdentityConflict` as a typed failure that
  carries the existing execution's status. A caller may then pick a fresh id,
  but only when the old execution is terminal; a fresh id beside a live child
  would start a second worker.

### 3.7 Flow load
- The flow being started or resumed loads through the direct path, which has no
  deadline (`Executable.ts:419-421`), and logs progress every 30 s. The admission
  window stays the single bound.
- Catalog timeouts get a new code, `load_timeout`, and are retried on first use.
  `SMITHERS_FLOW_LOAD_TIMEOUT_MS` sets the catalog deadline. The admission error
  names whichever limit fired.

### 3.8 Pinning by execution digest across restarts
- At first admission, store the verified closure in `ArtifactStore`. This is the
  `modules` map that Executable already measured (`Executable.ts:431-437`).
  Add a manifest `{executionDigest, entry, modules: path -> digest, lockfileDigest}`
  indexed by execution digest.
- In `Registry.loadBody(name, approved)` and `ModuleAuthority.owner`: when the
  live digest differs and a manifest exists, load the pinned bytes through the
  existing private-sibling loader (`Executable.ts:565-620`) instead of refusing.
- `--allow-code-drift` still adopts new code on purpose. A missing manifest or a
  changed lockfile still raises today's `CodeDrift`.
- Workspace packages are not pinned. Run hosts from a pinned checkout.
- Manifests of non-terminal runs are gc roots.

## 4. #2982 guarantees

| Guarantee | Status | How |
|---|---|---|
| No unrequested second external worker | Kept | Reconfirm never releases a run nobody else took. `Start` is create-or-get by key at the side effect (atomic mkdir in the guest, stable Cloud name), so one process per key. Generation g+1 starts only after g is proven exited or lost. |
| Consent binds the release and the journal generation | Kept | Grant schema unchanged |
| Background wake or approval is not consent | Kept | Unchanged |
| Cancellation and dead-owner recovery | Kept | Unchanged; `ExternalJob` adds `Cancel` and the reaper |
| Unknown cross-machine liveness needs explicit resume | Narrowed (approved 2026-10-02) | Still required when any in-flight attempt is unkeyed |
| ClaimLost, heartbeat guards, fenced durable writes | Kept | Reconfirm is a compare-and-swap in the same Consensus; `guard` unchanged |

## 5. issue-sweep migration
1. After 3.1, 3.4, 3.6 and 3.7:
   - `WorkspaceFailed` becomes `Burndown.Stop`.
   - Supply Burndown's `cancelled` member (still open from #3328).
   - Declare `effects: { writes: [] }` on FetchIssue, ListIssues and Accounts.
   - Replace `host.ts` `isNetworkOutage` with `Unreachable` and `Fault.retryTransient`.
2. After 3.2, 3.3 and 3.5, RemoteFix becomes an `ExternalJob` with the same
   `Remoted` success, so Adopt and landing do not change.
   - **start:** reserve the account and record it in the handle. The
     reservation lives in host memory (`accounts.ts:161`), so re-attaching must
     re-mark it. Acquire the sticky machine under the job key, write the login
     and the brief, then run `Sandbox.job`.
   - **collect:** capture `Work` and copy the refreshed login back, as
     `codexInGuest`'s release step does today. Then cool the account and
     destroy the machine. A network signature or quota exit returns `Again`;
     any other failure is `AgentFailed`.
   - **vm.ts:**
     - Add a second provider with `sticky` and `detached`.
     - `maxVms` counts live job machines by label, not permits held by scopes.
     - `reapOrphans` uses `retain` with the execution's status.
     - Flip `vm.real.test`'s "SIGKILL takes its microVM with it" for job machines.
   - **Session key:** change it from `issue-sweep:<repo>#<issue>` to the job
     key, which is scoped to the attempt.
3. Cut over on a new `attempt`, running from the pinned checkout.
4. Local placement (`Fix`) stays in-fiber and does not survive restarts. Keep
   sweeps on `vm` or `cloud`.

## 6. Order and tests (each step lands alone; each flips a #3367 case in `packages/smithers/test/faults`)
1. **Reconfirm.**
   - Ownership.test with TestClock covers four cases: a lapse with an
     untouched lease reconfirms; a pending claim interrupts; a foreign owner
     interrupts; a write timeout interrupts.
   - Consensus conformance for both strategies, including a race between
     reconfirm and steal.
   - NativeControlExternalPeerRecovery with a 25 s SIGSTOP: exactly one spawn,
     no `interrupt-released`, and `lease-reconfirmed` in the journal.
   - Cross-host steal mode keeps the 5/5 #2982 runs green.
2. **Isolation and Stop.** Burndown.test:
   - a defect in one member fails only that item while the others land;
   - `Stop` ends the round;
   - an identity-conflict fixture fails only its own item.
3. **Faults.**
   - A registry sweep test.
   - Dispatch tests: a keyed `infra` failure retries with backoff; an unkeyed
     writer does not retry; exhaustion keeps the fault class.
   - Burndown requeue cap.
   - Fault case: a 10-minute resolver blackhole produces zero `failed` rows.
4. **Load.**
   - A 45 s loader under TestClock.
   - A catalog `load_timeout` followed by lazy success.
   - The error names the limit that fired.
5. **Pinning.** Extend ModuleSnapshotAuthority.test and ModuleSourceSnapshotCli.test:
   - edit, SIGKILL, restart and resume runs the pinned bytes with no `CodeDrift`;
   - a lockfile change or a missing manifest still raises `CodeDrift`.
6. **Sandbox.job.**
   - Spike first: does a `setsid` child outlive the end of a Microsandbox exec?
   - Conformance: concurrent starts produce one process; Running, Exited and
     Lost are all reachable; cancel kills the process group; the job survives
     its scope; acquire wipes pids but not jobs.
   - Real Microsandbox: the job survives a host SIGKILL; the reaper retains
     the machines of live executions.
   - Cloud: no DELETE when sticky; the lease is renewed per probe.
7. **ExternalJob and guard.**
   - Restart mid-poll: start runs exactly once.
   - Lost and Again each move to g2.
   - Timeout and cancellation both call `Cancel`.
   - A released execution with only keyed attempts is re-driven without a
     grant. With an unkeyed running attempt it is still refused.
   - #2982's 49/49 and 5/5 stay green.
8. **issue-sweep.**
   - work.test with a fake provider.
   - vm.real.test: a job across a host SIGKILL.
   - Live canary: 24 items, a 40 s `kill -STOP`, a host SIGKILL and restart,
     and a 10-minute DNS blackhole. Expect Codex sessions == items and zero
     `runs resume`.

## 7. Risks
- Cloud's idle timeout may suspend a workspace that is running a job. Either set
  idle >= the job timeout, or make lease renewal count as activity (plue backend).
- The probes add journal rows (24 jobs x ~40/hour). Measure with gc and compaction.
- A `keyed` flag is only as honest as the key behind it. `ExternalJob` derives
  its own keys; hand-written keyed actions that are not actually idempotent will
  now be re-driven after a release.

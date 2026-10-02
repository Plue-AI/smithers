# Burndown infrastructure faults (#3367)

[Campaign #3367](https://github.com/smithersai/smithers/issues/3367) reproduces
infrastructure interruptions recorded on 2026-10-01. This suite starts the real
`smthrs flow start --wait --json` CLI, reads its real SQLite journal/run store,
and uses real external fixture agents, DNS packets, HTTP sockets and statfs.
The preload only installs the repository's Effect resolution loader. A real
Node compilation cache bounds repeated CLI startup cost. It does
not replace a runtime, service, clock, network or persistence implementation.

The normal `//packages/smithers:faults` target discovers
`burndown-infrastructure.test.ts` through `vitest.faults.config.ts`. Fault files
run serially; do not start a second process-boundary run on the same machine.
The package's ordinary unit target excludes this tier.

## Run and retain receipts

Use the repository's pinned Node and dependencies, `jj`, `python3`, and the
real native workspace helper (`cargo build --locked --release -p smithers-ffi
--bin smithers-jj-export`, or an absolute `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`).
No provider credentials are required. The disk case needs a working local
Microsandbox hypervisor and cached `node:26-trixie` image. It refuses image pulls
and uses one CPU and 512MiB of guest memory. If the maintainer's machine-wide `vcs_lock.py` exists it wraps all explicit
jj initialization; otherwise the fixture's portable `vcs_lock.py` uses flock.
No git executable is invoked.

```sh
cd packages/smithers
FAULT_3367_RECEIPTS=/absolute/receipts \
  pnpm exec vitest run --config vitest.faults.config.ts \
  test/faults/burndown-infrastructure.test.ts --reporter=verbose
```

All current assertions are ordinary tests: fault identification, preserved work,
caller recovery, admission refusal and cleanup. The former generic identity
expected-failure pin is explicitly retired below; historical raw failures remain
available. The pin register is [scripts/test-pins.md](../../../../scripts/test-pins.md).

Run the added host-kill/restart cases serially:

```sh
FAULT_3367_RECEIPTS=/absolute/receipts pnpm exec vitest run \
  --config vitest.faults.config.ts test/faults/retained-job-restart.test.ts --reporter=verbose
```

Replay an executed historical receipt with no fault injection or inversion:

```sh
node test/faults/fixtures/burndown/recovery.ts \
  /absolute/receipts/fault-3367-host-XXXXXX/recovery.json
```

Historical raw replay exits 1 for the generic capability identity desired
assertion and 0 for the historical green receipts. `desired-assertion.log` contains the exact raw
assertion diff. `recovery.json`, `runs.json`, the real `.flows/engine.db`, CLI
stdout/stderr/exits, `commands.jsonl`, `processes.jsonl`, changes and `landed`
retain state and ordering. DNS adds query/HTTP/URL receipts and external process
network outcomes. Disk adds real guest statfs polls, source hashes, ordered cleanup and VM teardown
evidence. The current owning `disk.ts`, its `host.ts` dependency and
`msb-nice.sh` bytes are verified against this checkout before loading
`makeDiskGate`. The former `vm.awaitDisk` fixture is obsolete and does not
qualify the production admission gate introduced in #3392.
`cleanup.json` records owned process termination and no remaining descendants.
Roots are deleted by default and after preservation. No manual resume is issued.

## Executed evidence

Qualification on base `20e6edc45874` (2026-10-02), pinned Node 26.5.0,
macOS arm64, ran the original assertions without inversion: **8 passed,
2 failed** (178.88s). The identity failure is the typed
`Fail/capabilities/completed` refusal. The disk fixture failed during
`hdiutil create` with `Device not configured`, before the guard executed.
Earlier green disk evidence does not qualify the current production gate.
Disk-only qualification on `88f998ded4d8` (2026-10-02), pinned Node 26.5.0,
macOS arm64 and Microsandbox 0.6.16, passed the actual current production-gate
case in **17.236s**. The prerequisite receipt also passed; nine other fault cases
were filtered, so this is not a current-pin full campaign pass.
The exact owning `makeDiskGate` read a real 32MiB guest tmpfs through bounded
SDK execution. Available bytes were 4MiB, then 4.1875MiB after three ordered,
once-only owned cleanup deletions, still below the 8MiB test floor. No work or
landing started during pressure. Removing pressure restored 32MiB and
permitted automatic N=2 completion: each worker and landing ran once, preserved
work matched exactly, all four native runs completed and manual resumes were zero.
Unmount succeeded, owner-labeled VMs remaining were empty, and owned process
cleanup reported no survivors. Retained `disk-receipt.json`, `statfs.jsonl`,
cleanup attempts/results, `source-receipts.jsonl`, SDK identity, real SQLite,
CLI output and both process/VM cleanup receipts support this narrow result.
It does not qualify default host cleanup, full placement, other platform hosts,
subsequent runtime revisions or the remaining campaign.

The generic identity fixture intentionally lacks the caller's policy. An
engine cannot choose a new work identity on behalf of a caller, because that
may repeat completed irreversible work. Its refusal remains a control.
The added `recover` fixture copies the exact terminal-conflict predicate from
`flows/issue-sweep/identity.ts`; it drives that owning policy through the public
CLI. Its terminal case passed with fresh work after the old children exited,
and its running-conflict case refused narrowing without another worker:
**2/2 passed** (45.80s). These replace the wrong-layer desired-recovery pin;
the generic refusal remains an ordinary control rather than being weakened.
The predicate status table separately passes all pending/running/suspended/
completed/failed/cancelled/unknown and malformed-error controls. No capability
or identity guard changes are involved.

`retained-job-restart.test.ts` adds a real native host, public Control admission,
SQLite, a keyed local ExternalJob adapter, and an independent external process.
It kills only the first host with SIGKILL, starts a replacement without resume,
and requires the original worker/key and preserved work. The edited case changes
the entry, layer and imported helper, then requires the original approved bytes
after restart. Start, collect and finish must each occur once; cancellation must
not occur. This is an ordinary durable timer suspension, not a released action
or an intervention wait.

That test exposed [#3408](https://github.com/smithersai/smithers/issues/3408): a
clock completion can wake a replacement before dead-owner admission permits
claiming; the durable completion then has no later wake. The fix revisits only
due timer waits with an unconsumed completion through ordinary admission and
CAS. Real SQLite recovery/filtering/stale-admission tests passed **9/9**, and
the engine-store strict test typecheck passed. After the fix, the edited restart
passed (152.806s), and the unchanged restart passed on a clean serial retry
(87.381s): replacement status after 29.378s, whole-run completion 46.740s after
releasing the worker to finish. Both retain the original 120-second poll budgets. A prior
unchanged retry exceeded that budget under heavy load; its raw failure is retained
and does not become a pass. Failure snapshots and stage timestamps distinguish
external completion from whole-run settlement.

Full raw commands, databases, journal, processes, output and cleanup receipts
are retained externally. [The current summary](receipts/burndown-20e6edc4/summary.json)
retains results and source/receipt hashes without private paths or process identities.
The generic refusal control passed (27.10s); strict engine-store and Smithers
test typechecks passed. The pin checker still reports the same pre-existing
`observing host over PostgreSQL` condition on the baseline and candidate;
the declared history PostgreSQL URL supplies that suite's fallback condition.
This update does not claim full fault qualification,
Cloud/provider restart coverage, or 100% coverage; #3367 remains open.

Historical integration validation uses base `7309afb21bef` on pinned Node 26.5.0,
macOS arm64: **9 ordinary passes, 1 expected capability-conflict failure,
0 failures/skips** (252.08s). All eight final receipts were replayed uninverted:
capability identity exits1 with `ERR_ASSERTION`; the seven green cases exit0.
All temporary roots are deleted and cleanup records zero remaining processes.
[The measured integration summary](receipts/burndown-7309afb2/summary.json)
records the serial run, raw replay, cleanup and source hashes. Each current common
receipt was freshly executed and deep-compared with its linked `8776a979` receipt;
the summary retains a canonical SHA256 instead of duplicating identical JSON.
Replay the final capability result without inversion:

```sh
node test/faults/fixtures/burndown/recovery.ts \
  test/faults/receipts/burndown-8776a979/identity.json
```

The previous validated base `8776a9794721` remains unchanged: **9 ordinary
passes, 1 expected capability-conflict failure, 0 failures/skips** (219.61s).
[Its full summary](receipts/burndown-8776a979/summary.json) and adjacent receipts
retain those exact results; raw identity exited1 with `ERR_ASSERTION`, and the
other seven cases exited0. All temporary roots were deleted and all owned
process cleanup receipts reported zero remaining.

Historical validation at `2714bb64`, before concurrent fixes: **9 ordinary
passes, 5 expected recovery failures, 0 failures/skips** (207.21s).
[The preserved historical summary](receipts/burndown-2714bb64/summary.json)
records actual results and source hashes. Raw host/load/model/landing/identity
receipts exited 1 with `ERR_ASSERTION`; control/source/disk exited 0.

The older model scenario put DNS inside the irreversible long-lived worker
and exited it unsuccessfully. That receipt describes the old fixture, whose
immutable failed exit makes its desired recovery assertion unsuitable as a
future gate. The current fixture separates successful durable Work from a
keyed ModelNetworkProbe action, passes the actual typed `Unreachable` fault to
engine default transient retries, and requires Work's persisted results to
remain unchanged. These model receipts are not identical-fixture before/after
evidence. Landing formerly exhausted nine retries with a compressed backoff;
current owning code uses the shared transient policy and recovery happens while
it remains active, with real default delays. Host and load retain their real
23-second stall and 31-second evaluation fault triggers.

Full SQLite/process/socket receipts and raw assertion logs are retained under
explicit external receipt destinations. Repository JSON contains no temporary
paths, real pids, operator identities, credentials, or databases.

## Contract and observed root causes

Payload `count` controls fanout: faults use N=2, the healthy control uses N=3.
Every desired assertion compares exact durable child IDs/counts/statuses, every
child's unique pid/start/progress/done/exit order and exact `work-<id>` bytes,
unique per-child landing processes, landing IDs in order, a real exclusive lock
with no overlap, all landing after all work completes, and zero manual resumes.
Ordinary fault tests separately assert exact current work and absence of duplicates.
The CLI's outer run plus registry parent account for two additional run rows;
the identity scenario intentionally launches two parent invocations.

The following root map describes executed base `7309afb21bef`, except the disk
row, which identifies its newer current-gate qualification:

| Fault                        | Current evidence and owning source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Issue                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 23-second host SIGSTOP       | Green: same owner reconfirms after the real gap at `packages/smithers/flows/run-store/src/Ownership.ts:332`, through `:336`; four `lease-reconfirmed` journal decisions at `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:2091`. Workers continue once, then land. Lease tolerance remains at `packages/smithers/flows/journal/src/Consensus.ts:97`.                                                                                                                                                                                                                                                                                                                                                                         | [#3328](https://github.com/smithersai/smithers/issues/3328), [#3372](https://github.com/smithersai/smithers/issues/3372) |
| Agent-facing DNS probe       | Green: a separate keyed sealed action after successful irreversible Work uses real `Unreachable` at `packages/smithers/flows/kernel/src/Unreachable.ts:15`; default safe transient retry selected at `packages/smithers/flows/engine/src/FlowEngine/Dispatch.ts:154`. Failure and recovery attempts are persisted under one probe key; Work results and exit histories stay unchanged.                                                                                                                                                                                                                                                                                                                                                        | [#3369](https://github.com/smithersai/smithers/issues/3369), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| External landing DNS         | Green: byte-verified owning `flows/issue-sweep/host.ts:126` classifies real command DNS failures and delegates to `Fault.retryTransient` at `:131`. `packages/smithers/flows/flow/src/Fault.ts:171` uses the actual 5s initial/2h expiry policy from `packages/smithers/flows/flow/src/RetryPolicy.ts:181`. Same service restores while the run is active and landing completes once in order.                                                                                                                                                                                                                                                                                                                                                | [#3369](https://github.com/smithersai/smithers/issues/3369), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| Capability identity conflict | Expected red at this fixture boundary: admission refuses a narrower ceiling at `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:1583`, constructing the shared conflict at `:1619`. The public execute wrapper converts it to typed `Effect.fail` at `packages/smithers/flows/flow/src/Flow/internal.ts:149`. The fixture records that exact Fail/capabilities/completed refusal before subsequent codec diagnostics and preserves its cause. The second parent fails; original Work and landing stay unique. Current `flows/issue-sweep/flow.ts:574` declares a terminal-conflict fallback at `:576`; this generic fixture intentionally does not include that flow-specific handler, whose effectiveness is not tested here. | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |
| Live source edit             | Green: measured closure import at `packages/smithers/agent/registry/src/Executable.ts:580`; admitted in-memory catalog retained at `:1825`. Parent and imported child/layer sources are edited before child2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [#3320](https://github.com/smithersai/smithers/issues/3320), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| Slow body load               | Green: catalog timeout still defaults to 30000ms at `packages/smithers/agent/registry/src/Executable.ts:1638`, but first-use load retries the measured descriptor at `:1939`. CLI requests that recovery at `packages/smithers/src/internal/NativeControl.ts:780`. Two real module evaluations finish and each worker runs once.                                                                                                                                                                                                                                                                                                                                                                                                              | [#3359](https://github.com/smithersai/smithers/issues/3359)                                                              |
| Disk floor                   | Passed on `88f998ded4d8`: exact `flows/issue-sweep/disk.ts makeDiskGate`, real 32MiB guest tmpfs, 8MiB test floor, ordered once-only owned cleanup ports, automatic N=2 work/landing with no resume. Default host cleanup and complete placement are excluded. Historical `vm.awaitDisk` receipts do not qualify this gate.                                                                                                                                                                                                                                                                                                                                                                                                                   | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |

[#3342](https://github.com/smithersai/smithers/issues/3342) concerns resume
reporting, including newer resume routing on this base. This suite never invokes
resume and does not test that behavior. The latest typed identity class and
ExternalJob changes are present in the historical measured base. The generic
action fixtures do not exercise ExternalJob; the added retained-job test
exercises its lifecycle against a local adapter, without claiming provider behavior.

The following historical map records the pre-fix executed base `2714bb64`.
Its model and landing entries describe the older fixture/policy above.

| Fault                                           | Historical evidence and owning source                                                                                                                                                                                                                                                                                                                                                                                                                                 | Issue                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 23-second host SIGSTOP                          | Ownership expiry interrupts owned work at `packages/smithers/flows/run-store/src/Ownership.ts:313`; 19-second tolerance is computed at `packages/smithers/flows/journal/src/Consensus.ts:97`. `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:1420` records suspended `interrupt-released`; `:2265` records lease lapse. Both children are released; parent waits can be released or event. Real journal receipts identify lease-lapsed interruption. | [#3328](https://github.com/smithersai/smithers/issues/3328), [#2982](https://github.com/smithersai/smithers/issues/2982) |
| DNS loss during external agent action           | No action retry policy is declared; action failure is final. `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:2166`. Work files survive, same restored DNS/HTTP operation succeeds standalone, run stays failed.                                                                                                                                                                                                                                       | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |
| DNS loss during external landing action         | Exact copied owning `ridingOutages` at `flows/issue-sweep/host.ts:126` classifies outage and caps retries at `:133`. Nine real DNS failures exhaust it before restoration.                                                                                                                                                                                                                                                                                            | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |
| Reused attempt with narrower capability ceiling | `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:1566` refuses incompatible admission; `:1602` dies with ExecutionIdentityConflict. `flows/issue-sweep/flow.ts:569` chooses a fresh round only for interruption, not this defect.                                                                                                                                                                                                                      | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |
| Live source edit before later children          | Green: the admitted executable/closure remains in memory. `packages/smithers/agent/registry/src/Executable.ts:575` imports measured closure bytes; `:1791` retains the admitted catalog. This edits both parent and imported child/layer code before child 2 starts.                                                                                                                                                                                                  | [#3320](https://github.com/smithersai/smithers/issues/3320), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| Slow body load                                  | A real 31000ms module evaluation meets fixed 30000ms catalog refusal at `packages/smithers/agent/registry/src/Executable.ts:1605`. No agents launch.                                                                                                                                                                                                                                                                                                                  | [#3359](https://github.com/smithersai/smithers/issues/3359)                                                              |
| Disk floor                                      | Green: actual `awaitDisk` from exact owning `flows/issue-sweep/vm.ts:276`, invoked before acquire at `:346`, polls real statfs callbacks. Dedicated 32MiB volume falls below 8MiB, then pressure removal allows all work and landing automatically.                                                                                                                                                                                                                   | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |

## Limits

- DNS uses a local authoritative UDP responder and actual `node:dns.Resolver`
  A queries followed by HTTP sockets for one unchanged `.test` hostname/URL.
  It does not alter host DNS, substitute endpoints on recovery, mock fetch,
  invoke a real model provider, or exercise actual git/jj fetch/push/apply or
  SandboxMerge. These are generic external agent/action networking boundaries.
- The incident lasted 10–75 minutes. This test holds DNS down until
  an actual failed request before restoring the same service while the run is active.
  The current run must reach automatic terminal success with the real transient
  policy and 5s initial retry delay. Two further seconds of observation and every
  process exit receipt verify settlement. The `dns-receipt.outageMs` field spans
  injection through final recovery observation, including post-restoration time.
  Historical landing receipts compressed the old initial delay to 1ms.
  No 75-minute outage, full 2h expiry, or fleet scale claim is made. Host suspension and body delay use real wall-clock time.
- Current disk pressure is confined to a real 32MiB tmpfs in one 1CPU/512MiB
  guest. No host disk is filled. A bounded synchronous helper uses the real
  local Microsandbox SDK and guest statfs; readings are never fabricated.
  The public CLI executes the exact production `makeDiskGate` with an 8MiB
  test minimum. Three injected cleanup ports delete only owned guest files;
  assertions cover their production ordering and once-only execution. This
  does not qualify the default host path, 25GiB default floor, host Go/pnpm
  cleanup programs, settlement reaper policy, or the complete VM placement path.
  Each guest execution is bounded; the guest has a 120-second maximum lifetime.
  Finally attempts unmount even after partial startup, destroys only owner-labeled
  VMs, asserts zero remaining VMs, and reaps all owned CLI/agent descendants.
  Unsupported platforms report prerequisites and skip this case; an advertised
  platform or capability proof alone is not a production-gate pass.
- Source editing covers later children in an already admitted live host and
  the added host-kill/restart case's pinned entry, layer and imported helper.
  Provider deployment replacement and catalog refresh are not exercised.
- The fake agents perform long-lived file work and landing; they are not model
  providers or full coding agents. Unclassified external errors and unkeyed irreversible actions do not establish
  an automatic network recovery contract and are not promoted into invented
  product bugs here. Fault-tier coverage is disabled because the
  product work runs in subprocesses; no 100% coverage claim is made.

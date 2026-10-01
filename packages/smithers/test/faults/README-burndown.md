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
No provider credentials are required. macOS also needs `hdiutil` for the disk
case. If the maintainer's machine-wide `vcs_lock.py` exists it wraps all explicit
jj initialization; otherwise the fixture's portable `vcs_lock.py` uses flock.
No git executable is invoked.

```sh
cd packages/smithers
FAULT_3367_RECEIPTS=/absolute/receipts \
  pnpm exec vitest run --config vitest.faults.config.ts \
  test/faults/burndown-infrastructure.test.ts --reporter=verbose
```

The default runs all faults, with one synchronous desired-recovery assertion
registered through `it.fails`. Setup, precise fault identification, preserved
work and cleanup are ordinary tests. A setup failure also leaves the associated
expected-failure test as an unexpected pass, so an import error cannot count as
successful fault evidence. The control, host stall, DNS recovery, slow-load, source-edit and disk cases are green.
The pin register is [scripts/test-pins.md](../../../../scripts/test-pins.md).

Run desired assertions without their expected-failure marker:

```sh
FAULT_3367_RAW=1 pnpm exec vitest run --config vitest.faults.config.ts \
  test/faults/burndown-infrastructure.test.ts --reporter=verbose
```

Or replay an executed receipt with no fault injection, Vitest or inversion:

```sh
node test/faults/fixtures/burndown/recovery.ts \
  /absolute/receipts/fault-3367-host-XXXXXX/recovery.json
```

A current raw replay exits 1 for the capability identity conflict and 0 for
control/host/load/model/landing/source/disk receipts. `desired-assertion.log` contains the exact raw
assertion diff. `recovery.json`, `runs.json`, the real `.flows/engine.db`, CLI
stdout/stderr/exits, `commands.jsonl`, `processes.jsonl`, changes and `landed`
retain state and ordering. DNS adds query/HTTP/URL receipts and external process
network outcomes. Disk adds real statfs polls, source hashes and volume evidence. The owning
`vm.ts`, `vm-pool.ts`, `vm-options.ts` and `msb-nice.sh` bytes are verified
against this checkout before loading the actual guard.
`cleanup.json` records owned process termination and no remaining descendants.
Roots are deleted by default and after preservation. No manual resume is issued.

## Executed evidence

Final integration validation uses base `7309afb21bef` on pinned Node 26.5.0,
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

The current root map is for the executed base `7309afb21bef`:

| Fault                        | Current evidence and owning source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Issue                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 23-second host SIGSTOP       | Green: same owner reconfirms after the real gap at `packages/smithers/flows/run-store/src/Ownership.ts:332`, through `:336`; four `lease-reconfirmed` journal decisions at `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:2091`. Workers continue once, then land. Lease tolerance remains at `packages/smithers/flows/journal/src/Consensus.ts:97`.                                                                                                                                                                                                                                                                                                                                                                         | [#3328](https://github.com/smithersai/smithers/issues/3328), [#3372](https://github.com/smithersai/smithers/issues/3372) |
| Agent-facing DNS probe       | Green: a separate keyed sealed action after successful irreversible Work uses real `Unreachable` at `packages/smithers/flows/kernel/src/Unreachable.ts:15`; default safe transient retry selected at `packages/smithers/flows/engine/src/FlowEngine/Dispatch.ts:154`. Failure and recovery attempts are persisted under one probe key; Work results and exit histories stay unchanged.                                                                                                                                                                                                                                                                                                                                                        | [#3369](https://github.com/smithersai/smithers/issues/3369), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| External landing DNS         | Green: byte-verified owning `flows/issue-sweep/host.ts:126` classifies real command DNS failures and delegates to `Fault.retryTransient` at `:131`. `packages/smithers/flows/flow/src/Fault.ts:171` uses the actual 5s initial/2h expiry policy from `packages/smithers/flows/flow/src/RetryPolicy.ts:181`. Same service restores while the run is active and landing completes once in order.                                                                                                                                                                                                                                                                                                                                                | [#3369](https://github.com/smithersai/smithers/issues/3369), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| Capability identity conflict | Expected red at this fixture boundary: admission refuses a narrower ceiling at `packages/smithers/flows/engine-store/src/internal/RunDriver.ts:1583`, constructing the shared conflict at `:1619`. The public execute wrapper converts it to typed `Effect.fail` at `packages/smithers/flows/flow/src/Flow/internal.ts:149`. The fixture records that exact Fail/capabilities/completed refusal before subsequent codec diagnostics and preserves its cause. The second parent fails; original Work and landing stay unique. Current `flows/issue-sweep/flow.ts:574` declares a terminal-conflict fallback at `:576`; this generic fixture intentionally does not include that flow-specific handler, whose effectiveness is not tested here. | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |
| Live source edit             | Green: measured closure import at `packages/smithers/agent/registry/src/Executable.ts:580`; admitted in-memory catalog retained at `:1825`. Parent and imported child/layer sources are edited before child2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [#3320](https://github.com/smithersai/smithers/issues/3320), [#3367](https://github.com/smithersai/smithers/issues/3367) |
| Slow body load               | Green: catalog timeout still defaults to 30000ms at `packages/smithers/agent/registry/src/Executable.ts:1638`, but first-use load retries the measured descriptor at `:1939`. CLI requests that recovery at `packages/smithers/src/internal/NativeControl.ts:780`. Two real module evaluations finish and each worker runs once.                                                                                                                                                                                                                                                                                                                                                                                                              | [#3359](https://github.com/smithersai/smithers/issues/3359)                                                              |
| Disk floor                   | Green: exact current owning `flows/issue-sweep/vm.ts:276` polls actual statfs through the imported `awaitDisk`, which gates acquire at `:346`. Pressure on a dedicated 32MiB volume falls below 8MiB, then its removal allows all work and landing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | [#3367](https://github.com/smithersai/smithers/issues/3367)                                                              |

[#3342](https://github.com/smithersai/smithers/issues/3342) concerns resume
reporting, including newer resume routing on this base. This suite never invokes
resume and does not test that behavior. The latest typed identity class and
ExternalJob changes are present in the measured base; ExternalJob
lifecycle/provider behavior is not exercised by these generic action fixtures.

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
- Disk pressure is confined to a 32MiB macOS volume. No host disk is filled.
  The owning module imports the real installed Microsandbox SDK; it is not
  stubbed, and no VM is acquired. This exercises the real exported gate through
  CLI action execution, not the complete microVM placement path. Linux emits
  a visible capability receipt and skips this one dedicated-volume case.
- Source editing covers later children in an already admitted live host;
  restart, catalog refresh and deployment replacement are not exercised.
- The fake agents perform long-lived file work and landing; they are not model
  providers or full coding agents. Unclassified external errors and unkeyed irreversible actions do not establish
  an automatic network recovery contract and are not promoted into invented
  product bugs here. Fault-tier coverage is disabled because the
  product work runs in subprocesses; no 100% coverage claim is made.

# Deterministic performance gates

The manual [flow discovery measurement](flow-discovery/README.md) retains
before/after timings, filesystem operation counts, and descriptor equality
receipts for #2837. Its deterministic regression tests count resolution probes;
wall times on a shared developer machine are observations, not CI thresholds.

`node scripts/bench/gate.mjs` is the required PR target
`//scripts:benchmarkGate`. It executes 18 fixtures: scheduler chain, wide and
shared-write conflict graphs of 8, 32 and 64 nodes, and journal append, reopen
replay and 31-entry paging over 32, 256 and 1,024 events.

The scheduler, durable stores, and SQLite driver are production implementations.
The executor returns known arithmetic results and the filesystem boundary and
jj service are deterministic fixtures. This tier measures scheduling and SQL,
not actual filesystem syscalls, subprocess spawn cost or native jj operations.
Every node must settle as built exactly once with its independent expected
result; chained execution must preserve order and shared writes must serialize.
Journal reads reopen the actual SQLite file through a fresh connection and
compare all sequence numbers and complete payloads. Reducing useful work cannot
earn a lower cost result.

## Baseline and noise

`baseline.json` records the fixture roster, size, independently validated output
SHA-256, actual SQLite statement execution counts, statement allocations
(`prepares`), direct `exec` calls, scheduler dispatches and paging calls.
Instrumentation wraps the real Node SQLite methods in the isolated benchmark
process and is restored in `finally`. Migrations and setup are outside the
measured region. There is no wall-time threshold in the PR verdict.

Each counter may increase at most 5%, rounded up. This small allowance covers
legitimate scheduler interleaving differences. Zero remains zero. Missing or
non-finite counters, changed outputs, reduced inputs and roster changes fail.
Counter reductions still require all output assertions. The baseline is a
checked input, never automatically updated by CI. `--candidate` writes a
proposed measurement to an artifact directory; a reviewer must inspect changed
costs and semantics before editing the baseline. A broad performance claim
also needs the owning package's differential, fault and coverage gates.

## Scheduled observations

The `benchmark-observations` job runs
`node --expose-gc scripts/bench/gate.mjs --measure` on Ubuntu and Node 26.4.0.
One cold corpus records first-process/JIT observations. One corpus warms up
without contributing to the repeated samples. Three subsequent warm corpora
reuse loaded code and JIT state but each uses new SQLite files and connections.
GC is requested before and after each measured repetition. This is an explicit
warm-code/cold-storage policy, not a claim to flush the host's OS page cache.

Artifacts contain elapsed time, validated operations per second, fixture size,
and output hash. Scheduled journal cases also retain every durable append
receipt/page-read latency with empirical nearest-rank percentiles: p95 requires
at least 20 samples and p99 at least 100, otherwise the value is null. These are
observed samples for this workload, not established service-level guarantees.
The artifacts also include retained heap,
RSS, descriptor counts where available, active handles and sockets, and database,
WAL and SHM bytes while connections are open. Raw samples are retained rather
than presenting a three-repetition p99 as a statistically established tail.
Counters still gate every repeated sample. Timing observations are advisory
measurements pending controlled-runner baselines; they are not PR thresholds.

`SMITHERS_BENCH_ARTIFACT_DIR` selects a fresh output directory. A completed
`result.json` is never overwritten; failure writes `failure.json` and throws.
Any nonempty artifact directory is refused, including one containing only a
prior failure, so stale partial results cannot enter a new run.
CI uploads even on failure and retains results for 30 days. Temporary database
directories are removed on both success and handled failure. Process termination
can leave OS temporary files, but cannot write a completed result. The scheduled
sync soak is a separate lifecycle/growth tier; its receipt verifier is
`scripts/check-soak-campaign.mjs`.

The upload-on-failure and 30-day retention policy above applies to the scheduled
`benchmark-observations` job. The generated PR workflow collects and uploads
`ci-test-tier-evidence`, including `/tmp/smithers-benchmark-*`, under
`if: always()`, so a failed PR step still uploads whatever receipts exist. It
permits missing files (`if-no-files-found: ignore`) and its generator exposes
no retention control, so a lost runner or an unwritten receipt yields no
artifact and no error. Local failed receipts remain on disk.

## Rebase cache reuse

`scripts/bench/rebase-cache.mjs` measures whether a rebased stack replays
every target whose inputs did not change. It is a manual measurement, not a PR
gate; the deterministic gate is `build-cli/test/RebaseKeyStability.test.ts`.

Method: on a base revision it commits one change per `--stack` package (a
comment appended to that package's first tracked source file), then commits
`--insert` below the stack and rebases it, so every commit id and tree changes.
Each revision is exported with `git archive` into a fresh directory at a new
absolute path with no `.git`, installed from the frozen lockfile, and planned
with `ci //... --plan`. A result store is replayed in check order: the original
stack, then the inserted change and the rebased stack. A target's input
signature is its ambient identity plus every declared input file digest in its
dependency closure. A cacheable target whose key was stored earlier is a hit;
a key that moved while the signature did not, or stayed while it moved, fails
the run. `--execute` also runs labels for real through
`scripts/ci/check-cache.mjs`, the persistence coding checks use, and fails when
the executor's hit/ran disagrees with the prediction from earlier effective
keys, or a label fails outside `--allow-failed`.

```sh
node scripts/bench/rebase-cache.mjs --out /tmp/rebase-inside \
  --insert packages/smithers/notifications \
  --execute //flows:codingPolicy,//flows:codingRuntime,//packages/smithers/notifications:docs \
  --allow-failed //flows:codingRuntime
```

Results from 2026-09-25 (macOS arm64, Node 26.4.0, 650 `ci` roots, 204
cacheable), in `rebase-cache/`. The stack touched `agent/memory`,
`flows/journal`, `apps/site` and `build/targets`:

| Inserted change | Rebased roots hit / cacheable | Misses | Coding gates (6) |
| --------------- | ----------------------------- | ------ | ---------------- |
| `apps/app` (outside the coding gate inputs) | 816 / 816 | 0 | hit in all 4 rebased changes |
| `smithers/notifications` (inside them) | 798 / 816 | 18: the 6 coding gates in 3 changes; the fourth matched an earlier check | miss where the content is new |

Both runs had zero unexpected misses or hits and zero executor disagreements.
`//flows:codingPolicy` measured 2.6-4.7 s ran (11 runs) and 1.7-2.0 s hit (6 of 7
hits; one 5.5 s outlier), most of it planning; the native and bundle gates it stands for have 45 minute budgets.

Limitations:

- 446 of the 650 roots are not cacheable (`NodeTest`, `Vitest`, `Typecheck`,
  `EsLint`, `Dprint`, `TsBuild` without `cache: true`) and re-run on every
  revision; 432-446 of them had unchanged keys in each rebased revision.
- The coding gates declare every Smithers package source, so any change there
  re-runs all six. A change to the build implementation (`build/targets`,
  `build-cli`, the flow engine packages it loads) or the lockfile re-keys every
  target.
- The signature covers declared inputs only. An input a target reads without
  declaring cannot be detected here, and Go, Cargo and import-closure keys that
  derive inputs from the toolchain can report a miss the oracle calls unexpected.
- `//flows:codingRuntime` failed on the base for an unrelated reason (#1728);
  failures are never cached. The native gates were not executed (no JJ export
  helper on the measuring host).
- Wall times are single samples on a developer laptop, not controlled runs.

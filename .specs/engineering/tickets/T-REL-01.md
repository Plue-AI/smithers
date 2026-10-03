# T-REL-01 Performance benchmarks on the reference host

Stage R · Size M · Depends on T-APP-01, T-COL-04, T-COL-08, T-APP-14, T-MCH-06, T-MCH-07, T-STK-08, T-INS-06, T-COL-02, T-APP-16, T-APP-11, T-TRM-01, T-TRM-03, T-GH-07, T-STK-01, T-ACC-03 · Unblocks T-MNT-05 · Issue: [#3592](https://github.com/smithersai/smithers/issues/3592)
Spec: spec.md §8.2.1 (host profile), §9.3.4, §18, §20.3, §21 (Performance row) · Delta: delta.md §1 (reuse the host profile), §11 (one check runner) · Product: mvp.md §9 Quality bar, M-19
Ready: 2026-10-03 smithers-8a sha256:250b63fd5530

## Goal
One command on the reference host (the team's 64 GB Mac mini with 10 performance cores) measures every spec §18 budget except GitHub freshness at p95 with n ≥ 100, and writes raw samples, summaries and the detected host profile under `.artifacts/perf/<date>/`.

## Scope
Lands dark until each dependency's production contract is available: T-APP-01 (`home` machine counts), T-COL-02 (live topics), T-APP-16 (prompt and Inspect), T-APP-11 and T-COL-04 (disk-write reload), T-COL-08 and T-APP-14 (co-editing), T-MCH-06 and T-MCH-07 (wake and final capture), T-STK-08 (rebase), T-INS-06 (configured models), T-TRM-01 (terminal admission), T-TRM-03 (SSH), T-GH-07 (Retry), T-STK-01 (TODO mutations) and T-ACC-03 (authorization). An unavailable contract skips its budget with the missing ticket named, emits no passing receipt and makes the full run incomplete. Build against the specified contracts; do not add bypasses. C-PERF-01–06 prove the enabled paths.
Lands dark until T-INS-04 enables the configured network origin: remote-browser budgets refuse localhost-only serving. Machine budgets also land dark until T-INS-02's microVM launcher, T-MCH-11's non-root identities, T-SEC-01's R1–R3 validation and T-MCH-10's root-layer validation are qualified; refuse process execution, sudo and unvalidated root inputs. These are activation preconditions, not code dependencies.
In:
- One script per budget (C-PERF-01 to C-PERF-06) and a runner that runs the budgets whose features exist and names the ones it skipped.
- Shared helpers: nearest-rank percentiles, a refusal below the stated sample size, the artifact writer.
- Every artifact records commit, install version, the detected host profile (§8.2.1: memory, performance cores, free disk, macOS version, Hypervisor.framework) and the limits derived from it, never a Mac model name; the public origin used (plain-HTTP LAN or HTTPS proxy); the browser and version; the app agent's model (`agent:` setting, §11.5a, for C-PERF-01); and the clock each sample used.
- Each run also copies its summary into the check's evidence directory, `.artifacts/checks/C-PERF-01 through C-PERF-06/<UTC timestamp>/`.
- `/api/install/metrics` (owner, §20.3) supplies the server-side latencies as a cross-check, never as the pass value.

Out:
- GitHub freshness (C-GH-07, T-GH-02). Load and soak tests beyond §18. Public benchmark claims (M-19 forbids them without a sealed, paired run).
- Product logic in scripts: a script drives the public API, the live channel and the browser only. No replacement dispatcher, direct database writes or daemon RPC bypass.
- New host-profile detection or sizing, a second check executor, capacity tuning, model selection policy, View changes, root provisioning code and TypeScript library public exports.

## Changes
- Reuse `packages/backend/microsandbox/hostprofile.go:66` and `:126`, and `packages/backend/internal/services/install_capacity.go:20` through authenticated `GET /api/host`; no script runs `sysctl`, `statfs` or parses an ops health line. `scripts/perf/lib/host.mjs` (new) only reads and records that response.
- Reshape existing `packages/backend/internal/routes/metrics.go` and `metrics_http.go` to reuse their in-process collectors. Add `packages/backend/internal/routes/install_metrics.go` only for the owner-authorized `GET /api/install/metrics` adapter and missing §20.3 measurements; existing `/metrics` does not supply the owner-only install contract. Mount through `packages/backend/internal/compose/router.go` with T-ACC-03 authorization; extend `docs/api/openapi/install.yaml`.
- Extend existing `scripts/PACKAGE.ts` with a `perf` run target in an exclusive tier, so CI wildcards never run it. Reuse `scripts/check-run.mjs` for check receipts; do not create another check executor.
- `scripts/perf/run.mjs` (new): selects budgets, writes `.artifacts/perf/<date>/summary.json`. Existing `scripts/bench/gate.mjs` measures library counters, not the six installed-product boundaries; keep that gate unchanged.
- `scripts/perf/lib/stats.mjs`, `scripts/perf/lib/artifact.mjs` (new): nearest-rank percentiles, sample validation and the per-check artifact format; the existing counter gate's result format has no per-sample clocks or C-PERF evidence copies.
- `scripts/perf/{agent-first-token,projection-delta,keystroke,disk-write,warm-wake,rebase-hold}.mjs` and `scripts/perf/questions.json` (new): production-boundary drivers and 20 fixed no-machine questions. No existing `scripts/perf/` drivers implement these checks.
## Tests
- unit `scripts/perf/lib/stats.test.mjs`: nearest-rank p95 on known samples (n = 100: the 95th sorted value); refusal for n below the check's minimum; a sample missing its clock field is rejected.
- unit `scripts/perf/lib/artifact.test.mjs`: the artifact schema includes the host profile and the origin.
- `TestPerfRunnerMissingProvider`: run the declared `perf` command against an install with each required contract unavailable; it names the skipped budget, reports incomplete and emits no passing receipt. Security/origin precondition failures refuse the affected budget before mutation.
- `TestInstallMetricsOwnerBoundary`: real PostgreSQL and the production authenticated install router, `GET /api/install/metrics`; owner succeeds, anonymous returns 401, member/maintainer/delegated callers return 403. Literal fixtures assert the §20.3 metric fields. No direct handler acceptance test.
- C-PERF-01: composer submission through `POST /api/conversations/{b}/prompt`, production turn dispatcher and Inspect, rendered first token/cards; use the configured `fast` role and include preflight.
- C-PERF-02: authenticated `POST /api/todos/{n}` mutations and production `GET /api/live` subscribers. C-PERF-03: two real File cards and an unprivileged machine file read. C-PERF-04: production branch SSH and the open File card's `file_written` reload.
- C-PERF-05: production `POST /api/terminals`, admission and asleep/awake transitions. C-PERF-06: scratch GitHub main push, `POST /api/github/sync` and the File/Branch card's Rebase now action through the production command dispatcher, with guest hold logs and retained typed markers.
- Run C-PERF-01–06 on the reference host with the second Mac where required. Commit literal thresholds (1.5/8/1/1/1/5/2 seconds), sample minima, question/marker fixtures and expected route/status tuples. Never read spec files or derive expected policy from production code at runtime. Failed samples fail the budget; unavailable features are skipped, never counted as passes.

## Acceptance
- [C-PERF-01](../checks/C-PERF-01.md): app agent first token p95 < 1.5 s and answer with cards p95 < 8 s.
- [C-PERF-02](../checks/C-PERF-02.md): projection delta p95 < 1 s.
- [C-PERF-03](../checks/C-PERF-03.md): keystroke to a remote File card p95 < 1 s.
- [C-PERF-04](../checks/C-PERF-04.md): outside disk write to an open File card p95 < 1 s.
- [C-PERF-05](../checks/C-PERF-05.md): warm wake p95 < 5 s.
- [C-PERF-06](../checks/C-PERF-06.md): rebase write hold p95 < 2 s.

## Risks and notes
- The runner skips a budget whose feature hasn't landed and names it. This ticket is done only when all six run, so it closes after T-COL-08 and T-APP-14 (stage 3).
- C-PERF-04 measures to the File card reload driven by `file_written`, which the daemon sends within 200 ms of each write (§9.3.4), not by the burst event that closes 1.5 s later. Observation that confirms a regression: p95 ≥ 1.5 s, which means the card reloads on the burst event.
- §18 binds C-PERF-01 to the configured `fast` model. Record provider/model, preflight model and any coding fallback; never tune the model to obtain a pass. smithers-8a accepts the measurement method and skipped-feature classification; Will decides any budget or reference-host change. smithers-3f approves the metrics and machine-log seams; smithers-b8 signs off the public metrics API and browser/CLI action seams.
- Clock skew between Macs would corrupt cross-machine timings. Every sample uses one clock (stated in each check).

## Security preconditions
- smithers-3f reviews execution provenance. The benchmark harness runs as an ordinary user from approved main/bundle tooling. Scratch repository commands, writes, commits and pushes run only as unprivileged members inside machines (M-29); the two Macs drive browsers, authenticated APIs and SSH without executing scratch repository code. No sudo or new root step is in scope.
- Machine lifecycle calls inherit root steps R1–R3 and their complete input/source inventory in T-SEC-01, “Root steps, inputs and sources”: main/bundle helper, interpreter, install script and destinations; install-controlled runtime/image/account/identity/cgroup/relay state; branch/member request argv, env, cwd, paths, bytes, retained homes, caches and symlink graphs. Require `TestGuestHelperInstallPinsInterpreterAndEnv`, `TestRootSetupNeverFollowsMemberSymlinks` and `TestRootPreflightParsesOnlyEnvelope` through production fresh/retained lifecycle and exec/file/terminal paths before enabling machine budgets. Branch-built code is never a root executable or import.
- Root layer builds consume only main-pinned image/toolchain declarations, target index, package selections and bundle executables. Branch fixture code and machine writes cannot select root build inputs. Require T-MCH-10's `TestRootLayerInputsValidatedBeforeUse`; any branch-sourced root input without its named validation test blocks the affected run. smithers-3f signs off both root inventories and their receipts; the harness adds no privileged input.

## Ready checklist
1. Depends on lists the production code/schema contracts called by the drivers and metrics route; Scope names fail-closed dark behavior for every dependency and the launcher, identity, security and network activation preconditions. Missing dependencies do not block implementation against their contracts.
2. Out explicitly excludes GitHub freshness, soak, public claims, product logic, bypasses, duplicate host/check readers, tuning, Views, root provisioning and library exports; Changes reuse the Go host profile, metrics collectors and check runner before adding boundary drivers.
3. C-PERF-01–06 and the named runner/metrics tests exercise production commands, authenticated routes, live subscribers, real cards, SSH and admission; committed literal fixtures define expectations independently of spec files and runtime code.
4. smithers-8a accepts method and skip classification; smithers-3f approves backend/infra seams and security receipts; smithers-b8 signs off the public metrics API and action seams; Will decides budget or reference-host changes. The configured fast role is settled by §18.
5. Owner pre-review, post hoc under the parallel-build directive: smithers-3f answers: Does the metrics adapter reuse collectors and enforce owner-only access? Do host-profile reads use the existing Go response? Do lifecycle/root receipts cover every benchmark machine path? smithers-b8 answers: Do browser/CLI drivers reach production action boundaries? Is the public metrics API compatible with its OpenAPI row? No View or TypeScript library public export changes are in scope.
6. M-29 confines scratch repository execution to unprivileged machines; no benchmark root step is added. Security preconditions inventory inherited root inputs/sources and name R1–R4 validation tests; smithers-3f reviews them, and unvalidated branch-sourced root inputs block activation.


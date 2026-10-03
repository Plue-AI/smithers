# T-REL-01 Performance benchmarks on the reference host

Stage R · Size M · Depends on T-APP-01, T-COL-04, T-COL-08, T-APP-14, T-MCH-06, T-MCH-07, T-STK-08, T-INS-06 · Unblocks T-MNT-05 · Issue: [#3592](https://github.com/smithersai/smithers/issues/3592)
Spec: spec.md §8.2.1 (host profile), §9.3.4, §18, §20.3, §21 (Performance row) · Delta: none (new) · Product: mvp.md §9 Quality bar, M-19

## Goal
One command on the reference host (the team's 64 GB Mac mini with 10 performance cores) measures every spec §18 budget except GitHub freshness at p95 with n ≥ 100, and writes raw samples, summaries and the detected host profile under `.artifacts/perf/<date>/`.

## Scope
In:
- One script per budget (C-PERF-01 to C-PERF-06) and a runner that runs the budgets whose features exist and names the ones it skipped.
- Shared helpers: nearest-rank percentiles, a refusal below the stated sample size, the artifact writer.
- Every artifact records commit, install version, the detected host profile (§8.2.1: memory, performance cores, free disk, macOS version, Hypervisor.framework) and the limits derived from it, never a Mac model name; the public origin used (plain-HTTP LAN or HTTPS proxy); the browser and version; the app agent's model (`agent:` setting, §11.5a, for C-PERF-01); and the clock each sample used.
- Each run also copies its summary into the check's evidence directory, `.artifacts/checks/C-PERF-01 through C-PERF-06/<UTC timestamp>/`.
- `/api/install/metrics` (owner, §20.3) supplies the server-side latencies as a cross-check, never as the pass value.

Out:
- GitHub freshness (C-GH-07, T-GH-02). Load and soak tests beyond §18. Public benchmark claims (M-19 forbids them without a sealed, paired run).
- Product logic in scripts: a script drives the public API, the live channel and the browser only.

## Changes
- `scripts/perf/run.mjs` (new): selects budgets, writes `.artifacts/perf/<date>/summary.json`.
- `scripts/perf/lib/stats.mjs`, `scripts/perf/lib/artifact.mjs`, `scripts/perf/lib/host.mjs` (new; host profile from `sysctl` and `statfs` on the reference host).
- `scripts/perf/{agent-first-token,projection-delta,keystroke,disk-write,warm-wake,rebase-hold}.mjs` (new), with `scripts/perf/questions.json` (new) for C-PERF-01.
- `packages/backend/internal/routes/install_metrics.go` (new): `GET /api/install/metrics` (owner) with the §20.3 counters; row in `docs/api/openapi/install.yaml`.
- `scripts/PACKAGE.ts` → a `perf` run target in an exclusive tier, so CI wildcards never run it.

## Tests
- unit `scripts/perf/lib/stats.test.mjs`: nearest-rank p95 on known samples (n = 100: the 95th sorted value); refusal for n below the check's minimum; a sample missing its clock field is rejected.
- unit `scripts/perf/lib/artifact.test.mjs`: the artifact schema includes the host profile and the origin.
- The checks themselves run on the reference host.

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
- Open (tech lead): §18 doesn't name the model C-PERF-01 binds to, and first-token latency is mostly the provider's. The check records the app agent's configured model.
- Clock skew between Macs would corrupt cross-machine timings. Every sample uses one clock (stated in each check).

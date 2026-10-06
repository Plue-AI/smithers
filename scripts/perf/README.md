# Installed-product performance evidence (#3592)

`node scripts/perf/run.mjs` currently records **incomplete** runs (exit 2).
Set `SMITHERS_PERF_ORIGIN` to the configured LAN/HTTPS origin and
`SMITHERS_PERF_TOKEN` to an authenticated token. Host metadata comes only from
`GET /api/host`; no local detection or capacity calculation is performed.
Optional `SMITHERS_PERF_INSTALL_VERSION` and `SMITHERS_PERF_BROWSER` record
operator-supplied metadata, not verified release/browser identities.

Fresh `.artifacts/perf/<UTC timestamp>/summary.json` records six skipped budgets,
their required tickets and activation preconditions. An absent production driver
is named explicitly. This runner does not detect whether dependency tickets have
landed, execute a benchmark, or emit check receipts. It adds no privileged step.
Existing library counter benchmarks remain unchanged because they measure
different boundaries.

`node scripts/perf/keystroke.mjs` drives C-PERF-03 on the second Mac using
the real File cards. Set `SMITHERS_PERF_PAGE` to the repository page,
`SMITHERS_PERF_MEMBER_A` and `SMITHERS_PERF_MEMBER_C` to distinct authenticated
Playwright storage-state files, and `SMITHERS_PERF_READ_ARGV` to a JSON argv
array that reads `src/target.ts` inside the machine. The scratch file must have
400 lines and no `K00000`–`K00199` markers. The driver edits the first 200 lines;
use only an authorized scratch branch. It requires the origin, token and install
version variables above and the app's installed Playwright Chromium. Run on macOS
(the editor/clipboard keyboard bindings use Command).

It records 200 browser keydown-to-remote-DOM timings, verifies full documents
via clipboard against the independent machine read, rejects missing/duplicate/
reordered markers, and requires nearest-rank p95 below 1000 ms. It writes raw
samples and failures under `.artifacts/perf/` and copies them to
`.artifacts/checks/C-PERF-03/`. Storage states, tokens and machine-read argv
are not copied into artifacts. A driver is not reference-host evidence: no
passing real-stack run has been recorded yet. The operator must ensure this
runner is the second Mac and the selected install is the reference Mac mini.

Outstanding: five other public-boundary drivers, 20 fixed repository/wiki questions,
browser and SSH fixtures, owner-only install metrics adapter and its real
PostgreSQL authorization tests, qualified network/machine security evidence,
raw-sample artifacts and per-check evidence copies, second-Mac runs, and
C-PERF-01–06 results. Receipt approval remains with `scripts/check-run.mjs`;
no check mapping is activated here. Keep #3592 open.

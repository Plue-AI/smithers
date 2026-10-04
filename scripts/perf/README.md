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

Outstanding: all six public-boundary drivers, 20 fixed repository/wiki questions,
browser and SSH fixtures, owner-only install metrics adapter and its real
PostgreSQL authorization tests, qualified network/machine security evidence,
raw-sample artifacts and per-check evidence copies, second-Mac runs, and
C-PERF-01–06 results. Receipt approval remains with `scripts/check-run.mjs`;
no check mapping is activated here. Keep #3592 open.

# Dollar budget accounting

`fullbench.sh` and `run-45.sh` read `fullbench-report.mjs --spend-cents`
before launching workers, after waiting for a free worker slot. They read
`costAttempts` in `lib/fullbench-manifest.mjs`, the one attempt projection the
report, `compare-runs.mjs`, `three-way.mjs` and `n-way.mjs` also read.
`spendByInstance` returns `{ cents, unknownAttempts }` for every recorded
attempt. A retry's `pulled` row preserves the earlier attempt's spend. A `graded` row can supply an
attempt's cost without counting its `ran` cost twice. Cents are rounded after
summing all attempts.

Missing, null, invalid or explicitly unknown attempt costs make the command
print `unknown`. Malformed ledger rows and torn tails also produce `unknown`.
Both drivers pause on non-numeric output. Reports expose `unknownAttempts`
and leave total, mean and projected dollar costs unavailable when any attempt
has unknown cost. Comparisons print such an instance's and total's dollars as
`unknown` and answer both dollar criteria `unknown`, never met.

The budget reader checks the latest session header's seat against `prices.ts`
when the header declares a dollar cap. An unpriced seat produces `unknown-seat`
before the first worker launches. Existing unknown attempts still require
accounting repair even after switching to a priced seat.

`lib/run-cost.mjs` returns `unknown: true` with `usd: null` for missing or
unreadable journals, invalid usage and unpriced calls. A readable journal with
no model settlements records zero usage. A numeric zero cost remains valid.
Workers in flight have not yet recorded their costs; the cumulative gate does
not reserve their future spend.

Run `node fixtures/check-fullbench-budget.mjs` and
`node fixtures/check-run-45.mjs` for offline regressions. Both are included in
`verify.sh`.

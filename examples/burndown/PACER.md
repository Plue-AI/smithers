# Burndown pacer

Offline Node.js pacing, without credentials or network calls.

```sh
node examples/burndown/pacer.mjs < usage.json
sh examples/burndown/burndown.sh usage.json 3 0
sh examples/burndown/burndown.sh usage.json 3 60 -- ./run-batch
node --test examples/burndown/pacer.test.mjs
```

The batch command receives `BURNDOWN_CONCURRENCY`. It owns dispatch, completion,
usage collection and deduplication, runs synchronously once per positive tick,
and stops the loop on failure. Command output goes to stderr; recommendations
remain JSON lines on stdout. Without `-- COMMAND`, the loop only prints results.
Ticks default to 1, interval to 60 seconds. Sleep happens between ticks after
execution. Both arguments are decimal integers, at most 999999999; ticks must
be positive. Leading zeroes are accepted.

Input is one JSON object:

```json
{
  "now": 1000,
  "resetAt": 4600,
  "remaining": 120,
  "usagePerJob": 2,
  "samples": [3, 2],
  "alpha": 0.3,
  "jobSeconds": 600,
  "maxConcurrency": 24,
  "machine": {
    "cpu": 8,
    "memoryMb": 16384,
    "reserveCpu": 1,
    "reserveMemoryMb": 1024,
    "cpuPerJob": 1,
    "memoryPerJobMb": 1024
  }
}
```

Times are Unix seconds. Required `now` and `resetAt` make replay deterministic.
The loop rereads the file each tick. Refresh it atomically with current time,
remaining quota and observed usage. An old snapshot repeats its recommendation;
it does not reserve budget. Fetch a fresh quota window after reset.

Usage and duration must be positive. Nonnegative samples update usage in order:
`estimate = alpha * sample + (1-alpha) * estimate`. Alpha defaults to 0.3 and
must be greater than 0 and at most 1. A zero estimate pauses work. Carry the
returned estimate forward without replaying samples.

Machine capacity floors CPU and memory after reserves, then takes the minimum.
Defaults reserve 1 CPU and 1024 MB; each job needs 1 CPU and 1024 MB. Quota
capacity floors `remaining / estimate * (jobSeconds / secondsUntilReset)` and
never exceeds the whole jobs affordable with remaining quota. Concurrency is
the minimum of machine capacity, quota capacity and `maxConcurrency` (default
24). Exhausted quota, passed resets and insufficient resources return zero.
Capacities are saturated at JavaScript's maximum safe integer.

Output fields: `concurrency`, `usagePerJob`, `machineLimit`, `quotaLimit`.
Invalid input prints an error to stderr and exits nonzero. Values must be finite
numbers; capacities, quota, reserves and times must be nonnegative.
Recommendations assume stable job duration and cost. They do not enforce
provider limits or persist state, and this example does not run a Cloud factory.

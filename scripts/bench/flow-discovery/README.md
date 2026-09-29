# Flow discovery (#2837)

Run from the repository root with installed workspace dependencies:

```sh
bun scripts/bench/flow-discovery.ts . /tmp/discovery.json 3
```

The last argument selects the number of warm samples (default one). The script
times the TUI's real `FlowControl.make({ cwd, environment, approvals }).discover()`
on this checkout, without opening the execution host. Each call builds a fresh
registry and a fresh closure cache. The first sample includes lazy native-host
imports; subsequent samples reuse loaded code and the OS page cache. No sample
executes a discovered flow or calls a provider.

After timing, the script scans the same sources with the real host filesystem
wrapped to count `stat`, `readFile`, and `readDirectory`. It retains complete
descriptors and warnings, normalizes the checkout path to `<repo>` in JSON, and
hashes that JSON with SHA-256. It checks that every timed listing equals the
projection of the counted scan. Compare both full-descriptor and warning hashes
between revisions; a count alone is insufficient evidence of equal results.

The output path must be new. To reproduce the baseline, run the same script
against revision `1e21e9b37f37a5b7dec723f2296586a43227736f` and set
`SMITHERS_WORKSPACE_JJ_EXPORT_BINARY` to the absolute path of a built
`smithers-jj-export` helper outside the scanned workspace. The patched discovery
does not need that helper. Keep the same checkout path, dependency tree, and
`flows/` corpus when comparing full-descriptor hashes.

`evidence.json` records the local comparison, including all timing samples and
counts. Measurements used Bun 1.4.2 on macOS arm64, with 14 logical CPUs and
other issue workers active. Cold means the first call in the process, not a
flushed disk cache. These observations do not establish a tail-latency guarantee.
Intermediate optimization samples are retained separately from the final run.

| Measurement                      | Before    | Final                                  |
| -------------------------------- | --------- | -------------------------------------- |
| First call                       | 546.757 s | 2.446 s                                |
| Warm calls                       | 472.339 s | 1.212, 0.459, 0.853 s (median 0.853 s) |
| Counted stat calls               | 15,622    | 1,464                                  |
| Unique stat paths                | 1,388     | 1,388                                  |
| Read-file / read-directory calls | 308 / 63  | 308 / 63                               |
| Descriptors / warnings           | 47 / 3    | 47 / 3                                 |

Complete descriptor and warning JSON matched before/after. The final warm
median meets the one-second target on this run; one of three samples exceeded
it. The stat budget is the repeatable regression check. Prompt-body loading
still uses the guarded filesystem and is outside these discovery timings.

The deterministic regression suite is:

```sh
cd packages/smithers/agent/registry
pnpm exec vitest run test/ModuleClosure.test.ts test/Discovery.test.ts test/Executable.test.ts --coverage.enabled=false
```

It asserts one stat per candidate across shared entries and wildcard aliases,
including misses, unchanged complete closure receipts, fresh-scan edits, cached
byte limits, and loader precedence when probes complete out of order. Node/Bun
registry tests also discover real files with guarded access unavailable. TUI
tests cover shared pending listings, a one-second cache age, explicit refresh,
failure retry, and unknown-agent refusal without another scan or body read.
Agent launches take current settings and prompt bytes from the same verified
snapshot, including edits made while a listing is cached.
These are focused behavioral checks; the run does not measure whole-package
coverage or change its configured thresholds.

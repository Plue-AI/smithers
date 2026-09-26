# Test-pin register and release-candidate posture

This file is the register every test pin must appear in, and the one-page
ledger of the 1.0.0-rc.0 posture and limits a reader would otherwise have to
discover from the test tree. The release train packs the `engine`, `agent` and
`tooling` groups at one synchronized version, and `publishedPackages` in
`scripts/pack-release.mjs` is the roster. These are statements of current
behavior, not promises of planned behavior.

## Support posture

The supported durable target is **Node.js with local SQLite**. Published
manifests declare `engines.node` as `>=26.4.0`, and the release workflow
runs the candidate tarballs on `26.4.0`. That floor is the Node the published packages support, and it is a
separate fact from the Node the toolchain runs: `.node-version` at the root
holds one exact release, `ci.yml` reads it through `node-version-file`,
`scripts/ci/cloud.sh` bootstraps a Cloud runner from it, and
`scripts/check-toolchain-pins.mjs` fails when it drops below the declared
floor or when a workflow names a release of its own. The durable database backend is
`@effect/sql-sqlite-node`; see
[SQLite only](../packages/smithers/flows/database/docs/concepts/sqlite-only.md)
before placing a database file on disk.

**PostgreSQL and PGlite are unsupported.** The write-retry seam recognizes
some of their transient failures, but release 1 ships neither a client layer
nor a migration ladder for either backend. This accepted parity gap is tracked
in the [storage boundaries](../apps/site/docs/reference/support-matrix.md#storage).

Bun is a second runtime rather than a second support claim. `BunRuntime`
composes the durable engine on the native Bun SQL driver, the adapter declares
`engines.bun` as `>=1.4.0` while CI pins `1.4.1`, ten packages declare
`bunTest` targets, and `NativeRuntimeParity` covers a Node/Bun restart in both
directions; that is package and parity evidence, not a claim that every
application runs on Bun. Browsers bundle only and no browser execution suite
exists, so bundling establishes no durable-engine support. The
[support matrix](../apps/site/docs/reference/support-matrix.md#runtimes) states
the status of each runtime, platform and storage combination.

The substrate is a release candidate: every release-1 engine manifest pins
`effect` to exactly `4.0.0-rc.115`. An upstream defect against that pin is not
fixed by a patch range. `scripts/check-single-effect-version.mjs` enforces the
one pin across the workspace, and a candidate that moves it records the move as
a breaking change in [CHANGELOG.md](../CHANGELOG.md).

The alpha control server defaults to loopback (`127.0.0.1`). A non-loopback
bind requires the explicit `--listen`/`listen: true` opt-in and does not add
TLS, token rotation, or multi-principal authorization. Keep ordinary alpha
use localhost-only; if an operator opts into a network bind, they must provide
the bearer-token and TLS/ingress protections described in the
[serve beyond loopback](../packages/smithers/gateway/docs/guides/serve-beyond-loopback.md).

### Advisory CI lanes

The required release gate is the `test` job, `workspace graph (coverage gates
enforced)`, whose steps run `pnpm exec smthrs ci '//packages/...'` and
`pnpm exec smthrs test '//scripts/...'`. Three lanes are advisory. The macOS
and Windows legs of the one `package suites (${{ matrix.os }})` matrix carry
`advisory: true` and inherit `continue-on-error: ${{ matrix.advisory }}`, while
its `ubuntu-latest` leg is required; `model reviews (advisory)` is
`continue-on-error: true` outright. An advisory failure establishes no support
for that host and does not block the required Node/Linux target.

The Windows lane remains red. On Windows, the server seed-allowlist test
constructs a module path with a doubled drive prefix, and the `jj` package's
symlink/dirent assertions do not yet match Windows behavior. This is a tracked
CI-portability gap, not a waived required check; promote the Windows lane only
after its failures are fixed and repeated main-branch runs are green.

## Not in 1.0.0-rc.0

The release train packs the `engine`, `agent` and `tooling` groups together at
one synchronized version: the 49 names `publishedPackages` restates in
`scripts/pack-release.mjs` and checks against what the workspace declares. Four
tooling packages are public, `@smthrs/build`, `@smthrs/build-cli`,
`@smthrs/create-app` and `@smthrs/targets`; deployment and repository-local
tooling stays out of the roster through its manifest `private` flag.
Membership is not a proxy for feature scope, so a package can ship and still
not be a release-candidate feature. `@smthrs/triggers`, `@smthrs/evals` and
`@smthrs/scorers` publish as libraries an application wires itself; no CLI verb
composes them. Memory semantic recall and observability OTLP export are not
rc.0 features either, and `@smthrs/gateway` publishes because consumers need
its wire schemas while its supervision runtime is still a noop. The
[known limitations and evidence](../apps/site/docs/reference/support-matrix.md#known-limitations-and-evidence)
table records what each limit rests on; in particular, the published OTLP layer
is application-wired rather than a shipped default.

## Cutting a release

Start from a clean `main` checkout and run
`node scripts/cut-release.mjs <version> --commit`, without a `v` prefix.
The cut refuses detached HEADs, existing release tags, and branches other than
`main` unless `--allow-branch` explicitly permits a named branch.

The sequence bumps manifests and internal ranges, generates the changelog,
refreshes `pnpm-lock.yaml` with `pnpm install --lockfile-only --ignore-scripts`,
and refreshes a tracked `bun.lock` with
`bun install --lockfile-only --ignore-scripts`. It then checks the version and
runs `node scripts/generate-changelog.mjs --check --version <version>`.
`--commit` records the manifests and lockfiles, checks the changelog again on
the exact release commit, and creates an annotated `v<version>` tag locally.

The generated changelog must be regenerated for the exact release commit;
do not refresh it on a preparation branch and assume its commit count will
still match after integration. A stale block fails the cut before tagging.
Without `--commit`, the script prints the remaining commit, check, and tag
commands. Publishing requires a separate operator push.

The tag workflow uses `secrets.NPM_TOKEN` for `NODE_AUTH_TOKEN`, including the
first publication of names that cannot yet configure trusted publishing.
It retains provenance, publishes detached tag checkouts with `--no-git-checks`,
and waits two seconds between packages. Registry 404 responses allow a first
publication; 429 and 5xx responses retry, while other precheck failures stop.
Publication and transient prechecks get an initial attempt followed by at most
three retries after 10, 30, and 60 seconds.

The Script gates invocation (`smithers-build test '//scripts/...'`) builds
the site before checking shipped links: `//scripts/repo-contract:smithersLinks`
depends on `//apps/site:build`. The link gate can also run by its own label
from a clean checkout; no earlier workflow step must supply `apps/site/dist`.

## Known test pins

A **pin** is a test the default gate does not run to a pass. Three forms count:

- `it.fails` / `test.fails`. The test asserts that current behavior is wrong, so
  the suite goes red on the day it starts passing.
- `.skip` / `.todo`. The test does not execute at all.
- `.skipIf` / `.runIf` on an environment variable nothing in the repo sets. The
  test executes only for someone who remembers it exists.

A `.skipIf` / `.runIf` on a platform, an installed binary, or a built artifact
is a capability gate rather than a pin, because it runs on the supported
configuration. `describe.skipIf(process.platform === "win32")`,
`describe.skipIf(!jjInstalled)` and `describe.skipIf(wasmBytes === undefined)`
are all capability gates, and CI installs `jj`, so the jj-gated suites execute
there. `process.env.CI` is a capability gate for the same reason.

Every pin in every package group (`smthrs.group` in each manifest) must appear
in the table below. `scripts/check-test-pins.mjs` enforces that and CI runs it,
so a new pin fails the build until it is either fixed or written down here. The
1.0 release train packs the `engine` and `agent` groups together, so the
register covers `agent` as well; before 1.0 it covered `engine` and `tooling`
only.

### Surviving pins

| Package | Test | Form |
| --- | --- | --- |
| `smithers/flows/platform-bun` | `executes the declared Bun lane in a Bun worker` | `it.skipIf(process.env.SMITHERS_PLATFORM_BUN_LANE === "1")` |
| `smithers/agent/harness` | `workerd smoke` | `describe.skipIf(FLOWS_WORKERD_SMOKE !== "1")` |
| `smithers/create-app` | `layerTevm against a mainnet fork` | `it.skip` in `template/aomi` |
| `smithers/agent/integrations` | `GitHub live contract (GITHUB_TOKEN)` | `describe.skipIf(GITHUB_TOKEN === undefined)` |
| `smithers/agent/integrations` | `Linear live contract (LINEAR_API_KEY)` | `describe.skipIf(LINEAR_API_KEY === undefined)` |
| `smithers/agent/integrations` | `Telegram live contract (TELEGRAM_BOT_TOKEN)` | `describe.skipIf(TELEGRAM_BOT_TOKEN === undefined)` |
| `smithers/agent/integrations` | `long-polls without confirming any update (TELEGRAM_CHAT_ID)` | `it.skipIf(TELEGRAM_CHAT_ID === undefined)` |
| `smithers/build/targets` | `SecretProxy brokered origins over the network` | `describe.runIf(SMITHERS_E2E_NETWORK === "1")` |
| `smithers/agent/model` | `OpenAIChatCompletions over Gemini` | `describe.skipIf(SMITHERS_LIVE_MODEL_TESTS !== "1" || GEMINI_API_KEY absent)` |
| `smithers/migrate` | `migrates a single-file JSX project through the bin (${reason})` | `it.skip` when `SMITHERS_MIGRATE_SEAT` names no funded seat |
| `smithers/migrate` | `records what a single-file project could not settle (${reason})` | `it.skip` when `SMITHERS_MIGRATE_SEAT` names no funded seat |
| `smithers/migrate` | `refuses what it cannot translate in a multi-workflow pack (${reason})` | `it.skip` when `SMITHERS_MIGRATE_SEAT` names no funded seat |
| `smithers` | `the smthrs init scaffold on a funded seat` | `describe.skipIf(SMITHERS_OPENAI_AUTH !== "chatgpt")` |
| `smithers/build/build-cli` | `answers the envelope contract through a real codex session` | `it.skipIf(SMTHRS_CODEX_SMOKE !== "1")` |
| `smithers/agent/std` | `streams a file larger than available memory (skipped: a hermetic test cannot exhaust its runner)` | `it.skip` |
| `testing` | `registers a skipped layered Effect body` | `test.skip` |

**`migrate`: apply against a real model.** The three cases in
`packages/smithers/migrate/test/flow/MigrateFlow.live.e2e.test.ts` drive the migration
tool against a real model: they rewrite a 0.x JSX workflow, record what the
run could not settle, and refuse a multi-workflow pack the tool cannot
translate. Everything else under `test/flow` scripts the seat, so these are
the only cases that prove the contract, the prompt, and the captured sources
are enough for a model to produce a flow the registry discovers. They cost
real money and real minutes, and the package hard-codes no model id on
purpose, so the operator names the seat: set `SMITHERS_MIGRATE_SEAT` to a
`provider:model` seat and set that provider's key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`), then run
`pnpm --filter @smthrs/migrate test`. Without both, each case skips and says
which variable is missing rather than passing without doing the work. What
breaks if it regresses: an operator's migration could
stop producing a compiling flow and only the release rehearsal would find out.
Closing it for the default gate means paying for a model seat in CI, which
the RC does not do.
**`integrations`: the three live contract suites.** Each one talks to a real
vendor API, `api.github.com`, `api.linear.app`, or `api.telegram.org`. Each
skips when its credential is absent, naming the variable in the suite title and
in a comment above it. They exist because the fixture suites prove the clients'
behavior against a server this repository controls, and only a live call proves
the wire contract those fixtures encode is still the one the vendor serves.
What breaks if they regress: a provider changes a response shape, a header, or
an error code, and nothing notices until an application does. Run them with
`GITHUB_TOKEN=…`, `LINEAR_API_KEY=…`, or `TELEGRAM_BOT_TOKEN=…`; all three are
read-only, and the Telegram poll confirms no offset so a running bot keeps its
backlog. GitHub and Linear are `1.0.0-rc.0`'s release-smoke integrations, so
both are run by hand at release time. Inside the Telegram suite one case is
gated again on `TELEGRAM_CHAT_ID`: the long poll needs a chat the bot can
see, and a token alone does not name one.

**`harness` — workerd smoke.** The suite boots a real `workerd` process to
prove the QuickJS cell runtime runs unchanged on the Cloudflare runtime.
`workerd` is not a repository dependency and CI installs no binary for it, so
the suite is gated off the default run rather than failing on every machine
without one. What breaks if it regresses: the cell runtime could acquire a
Node-only dependency and nothing would notice until an edge deployment. Run it
with `FLOWS_WORKERD_SMOKE=1 pnpm --filter @smthrs/harness test` after
installing `workerd`. Closing it for the default gate means adding `workerd` to
the toolchain the CI lane installs, which the RC does not claim (see the
[support matrix](../apps/site/docs/reference/support-matrix.md#runtimes)).

**`migrate` — the three live-model cases.** `MigrateFlow.live.e2e.test.ts`
runs the migration flow against a real provider, and a real provider costs
money: the suite reads `SMITHERS_MIGRATE_SEAT` for a `provider:model` seat and
requires that provider's key, and skips with the reason in the test title when
either is missing. It is written as `it.skip` inside the no-seat branch rather
than `describe.skipIf` so the skipped titles carry the reason an operator has
to act on, which is why the register scanner counts three pins here. Everything
the flow does with the seat scripted is covered by the rest of `test/flow`;
what only a live call proves is that a real model's output still translates.
Run it with `SMITHERS_MIGRATE_SEAT=anthropic:<model> ANTHROPIC_API_KEY=... pnpm
--filter @smthrs/migrate test`. What breaks if it regresses: `smithers migrate`
could stop producing a flow the registry discovers, and only a paid run would
notice.

**`create-app` — `layerTevm` against a mainnet fork.** The pin is inside
`packages/smithers/create-app/template/aomi`, a scaffolding template copied into a new
project rather than a suite this repository runs: `create-app`'s own
`vitest.config.ts` includes `test/**/*.test.ts` only, because the template's
tests resolve against the scaffolded copy's `node_modules`. The test needs a
funded mainnet fork RPC endpoint, which no gate here provides. What breaks if
it regresses: nothing in this repository; a scaffolded project inherits a
skipped test it can enable with its own endpoint. It is listed because the pin
register scans package directories, not vitest include globs, and a pin the
scanner can see is a pin the register documents.

**`smithers`: the funded-seat init scaffold.** `Bin.test.ts` gates one suite
on a signed-in ChatGPT seat. It runs `smthrs init hello` and then
`smthrs up hello` against a real provider, which is the only way to hold the
claim `smthrs init` makes about the directory it writes. A real agent run
costs three to four minutes and real tokens, so the suite requires
`SMITHERS_OPENAI_AUTH=chatgpt` and the Codex auth file the CLI suite already
stages, and skips when either is absent. Every other `init` case asserts the
scaffold's contents against a scripted seat. What breaks if it regresses:
`smthrs init` writes a project `smthrs up` cannot run, and only a funded run
notices. Run it with `codex login`, then
`SMITHERS_OPENAI_AUTH=chatgpt pnpm --filter @smthrs/cli test`. Closing it for
the default gate means paying for a model seat in CI, which the RC does not do.

**`build-cli`: the real codex session.** `AgentSession.test.ts` gates one case
on `SMTHRS_CODEX_SMOKE=1`: it opens a session through the installed `codex`
binary and asserts the envelope contract on what comes back. Every other case
in that file drives the same factory against a stub binary, so the stubs prove
the argv and the parse, and only a real session proves the CLI still answers
the shape those stubs encode. What breaks if it regresses: a `codex` release
changes its output and the build agent's envelope parse fails for a user
first. Run it with
`SMTHRS_CODEX_SMOKE=1 pnpm --filter @smthrs/build-cli test` on a machine with
`codex` signed in. Closing it for the default gate means spending model tokens
on every run, which the RC does not do.

**`model`: the Gemini chat-completions contract.** `GeminiChatCompletions.integration.test.ts`
runs the OpenAI-compatible Chat Completions protocol against Google's endpoint,
which is billable provider traffic. Two conditions gate it, and both are
deliberate: `GEMINI_API_KEY` supplies the credential, and
`SMITHERS_LIVE_MODEL_TESTS=1` states the intent, so a developer who merely has
a key exported does not turn an ordinary suite run into provider spend. The
fixture suites next to it prove the request shaping and the event decoding;
only a live call proves the endpoint still serves the protocol the route
assumes. What breaks if it regresses: Google changes the compatible endpoint
and a user's Gemini seat stops streaming. Run it with
`SMITHERS_LIVE_MODEL_TESTS=1 GEMINI_API_KEY=... pnpm --filter @smthrs/model test`.
Closing it for the default gate means paying for provider traffic on every
run, which the RC does not do.

**`std`: the larger-than-memory stream.** `SearchConformance.test.ts` pins one
`it.skip` whose title says why: the conformance suite proves `Grep` streams a
file instead of reading it whole, and the only direct proof is a file larger
than the runner's memory, which a hermetic test cannot create without
exhausting the process that runs it. The bounded-window and truncation cases
around it prove the same property on files that fit. What breaks if it
regresses: a search over a large file reads it whole and the runner, not the
caller, runs out of memory. Closing it means a dedicated runner with a
tmpfs larger than its heap, which the RC does not provision.

**`testing`: the skip registration case.** `Vitest.test.ts` pins one
`test.skip` on purpose: `@smthrs/testing/Vitest` wraps vitest's `test` with
Effect bodies, and the case proves that `.skip` on that wrapper registers a
skipped test rather than running the `Effect.die` it is handed. It is a test
of the skip form itself, so it can never execute. What breaks if it regresses:
a `.skip` on the wrapper runs the body, and a suite that parked a live case
starts paying for it. It stays a pin because vitest reports a skipped test
only by skipping it.

### Resolved: the database open-retry pin

`packages/smithers/flows/database` pinned "dies with the original lock defect after the fixed
open-retry budget is exhausted" behind `FLOWS_SLOW_TESTS=1` because every open
attempt blocked inside SQLite's own WAL-conversion wait, and exhausting the
retry ladder cost 220-240 s against the package's 30 s per-test budget.
`ef7ee4d0c0` gave the open path a read-only probe that exhausts the ladder
first. Against a lock nobody releases the case now costs 8.9 s, so it runs on
every gate as `reports database_locked after the fixed guard-retry budget is
exhausted` in `packages/smithers/flows/database/test/NodeDatabaseConcurrentOpen.test.ts`. A
resolved title does not authorize re-pinning the test: the guard reads the
Surviving pins table only, so a pin here again needs a new row above.

### Resolved: the audit's `it.fails` count

A 2026-08-16 readiness audit recorded "`it.fails` pins: 29
remain", distributed across engine-store, flow, kernel, time-travel,
capability, database, harness, jj, platform-node, sync, targets and
build-cli. That count was stale at the commit it was filed against. There are
no `it.fails` pins anywhere in `packages/` at `3fcf5fcd`:

```sh
git grep -n 'it\.fails\|test\.fails' -- packages   # no output
```

The last commit carrying any was `c890e65d`, with 12. All 12 were closed by
fixing the defect and flipping the pin, not by deleting the test — each one
still exists as a live assertion in the same file, and each of those suites is
green:

| Package      | Test                                                                                        | Now at                                 |
| ------------ | ------------------------------------------------------------------------------------------- | -------------------------------------- |
| `canonical`  | has no canonical form for a lone surrogate returned by `toJSON`                             | `test/Canonical.test.ts`               |
| `canonical`  | has no canonical form for a lone surrogate key returned by `toJSON`                         | `test/Canonical.test.ts`               |
| `capability` | bounds wall time for adversarial repeated-star patterns against long non-matching resources | `test/Capability.property.test.ts`     |
| `capability` | completes a 10k-character non-match for a repeated-star grant pattern                       | `test/Capability.test.ts`              |
| `flow`       | normalizes Windows and POSIX separator spellings when comparing overlaps                    | `test/FileBoundary.test.ts`            |
| `flow`       | rejects separator variants of the same written and removed path                             | `test/FileBoundary.test.ts`            |
| `flow`       | rejects a very deep `AndThen` graph with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `flow`       | rejects a cyclic unknown payload with a typed error instead of overflowing the stack        | `test/Graph.test.ts`                   |
| `flow`       | rejects a very deep unknown payload with a typed error instead of overflowing the stack     | `test/Graph.test.ts`                   |
| `kernel`     | rejects an envelope carrying request-only payload fields                                    | `test/GrantEvent.test.ts`              |
| `kernel`     | fails closed when a page repeats its last sequence with `hasMore`                           | `test/JournalGrantStoreReplay.test.ts` |
| `keys`       | rejects an unsupported `key2_` key until its complete format is implemented                  | `test/Key.test.ts`                     |

Agent-group packages are outside this register and outside the guard; F4's
`harness` entry belongs to that group.

## Known limitations

The agent gateway does **not** automatically recover abandoned runs in the
private alpha (audit P1-2). `@smthrs/gateway` has no supervision port; no
production gateway layer connects to the durable engine's run-driver sweep.

Consequently, a run abandoned by its gateway host is not discovered, reclaimed,
or resumed by the gateway. Operators must recover it explicitly, or use a host
composition that runs the durable engine driver with the relevant flows
registered. Do not rely on unattended gateway recovery for alpha workloads.

This limitation can be retired after a production gateway composition wires
the engine recovery path and a crash-recovery test proves that a stale owner is
reclaimed and the run makes progress automatically.

The rest of what release 1 declines to do is documented where the behavior
lives. The items an alpha operator hits first:

- **Recovery has no deadline.** Inside a process that is already running the
  engine, the 30-second stale cutoff is an eligibility floor, not a
  recovery-time objective: a run becomes eligible only after its heartbeat is
  older than the cutoff, the sweep re-drives at most 64 stale rows per
  one-second tick, and a caller-supplied `isAlive` can refuse the steal for
  unbounded time. See the
  [known limitations and evidence](../apps/site/docs/reference/support-matrix.md#known-limitations-and-evidence)
  table.
- **Flow registrations are in-memory.** A restarted process resumes nothing
  until it re-registers the handlers for its stored runs, because registration
  is what re-arms durable clocks and deferred wakes.
- **The production layer packages two levels, and only one of them is
  complete.** `@smthrs/flows/NodeRuntime.layer` composes database, migrations,
  stores, and the engine, and leaves host services, the step boundary, and the
  workspace sandbox to the caller. `NodeRuntime.layerHost` adds the rest: the
  contained Node host, the guarded `HostServices` kernel over an unattended
  grant store, the default step boundary and filesystem workspace sandbox, the
  liveness probe, and `SIGINT`/`SIGTERM` shutdown bounded by
  `shutdownTimeoutMs`. A program that composes `layer` still owes `Crypto`,
  `FileSystem`, and `Jj`, and installs its own signal handlers.
  `examples/src/durable-layer.ts` is the worked composition, and
  [the barrel's API page](../packages/smithers/flows/docs/api.md) lists both
  entry points.
- **Detached child flows need a composed child port.** A host that composes
  `EngineChildren` runs `agent/spawn`, `agent/send` and `agent/await` as real
  linked runs; a composition that supplies no child port refuses all three with
  `ChildError` code `unsupported`, and `agent/await` polls the child's run row
  rather than parking the caller
  ([subagents](../packages/smithers/agent/docs/guides/subagents.md)).
- **Cross-process wake is polled.** The in-process `WakeBus` completes a
  resume signal directly; a wake published from another process still lands
  through polling and the stale sweep.
- **Copy-back applies without a human gate.** The engine applies a settled
  diff bundle to the host itself. The pending-diff review gate is a spec, not
  shipped behavior.

The [support matrix](../apps/site/docs/reference/support-matrix.md) is the
authoritative list; this section names only the limits that change how an
alpha pilot is operated.

## Adding a pin

Prefer fixing the defect. If a pin is genuinely the right call:

1. Keep the test executable in some configuration — an env-gated `runIf` beats
   a bare `.skip`, because a skipped test rots silently.
2. Add a comment on the pin pointing at this file.
3. Add a row to **Surviving pins** and a paragraph saying why it is pinned,
   what breaks if the behavior regresses, and the workaround.

`node --test scripts/check-test-pins.test.mjs` enforces step 3. Steps 1 and 2
are review conventions; nothing checks them.

**`platform-bun` — nested runner guard.** The ordinary Node suite starts the
declared Bun test runner and asserts that its selected test runs inside Bun.
`SMITHERS_PLATFORM_BUN_LANE=1` prevents that child from starting another child;
the verification still runs in the default Node suite. This is a recursion
guard, not an unexecuted compatibility case.

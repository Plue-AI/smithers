# Smithers test infrastructure inventory for the MVP validation plan

Researched 2026-10-02 against `~/smithers` (main at `d4d2eacc`–`4f55ae15`), read-only. No jj, no full suites run. Sources: root and package `PACKAGE.ts`, `.smithers/target-index.json` (1,089 targets), `.github/workflows/*`, GitHub Actions run logs (`gh`), `.specs/engineering/{spec.md §21,delta.md,checks/,tickets/}`, issue #2290, memory `index_reds.md`.

**One sentence.** The repo has a large, real-dependency unit and integration base (8,940 Go tests, 528 app test files, 65 Playwright specs, a Go kill-point harness, a PostgreSQL-per-test fixture), but CI on `main` has not been green since 2026-09-08, the Go suite and the coverage-gated package graph do not reach execution today, and none of the MVP-specific harnesses the checks assume exist yet: no shared fake GitHub server, no browser e2e against a self-hosted install with microVMs, no `scripts/perf`, no scratch GitHub org.

**One paragraph.** Tests are declared as `PACKAGE.ts` targets and run with `pnpm exec smthrs test '<label>'`; CI (`ci.yml`, 14 jobs, push to `main` and PRs) calls the same labels with `--known-red .github/ci-known-red.json`. Actions run (billing is not blocking now), but 88 of the last 100 `main` runs were superseded (concurrency group keeps one pending run) and the other 12 failed. In the last completed run three gates fail before their tests start: actionlint (two deleted workflow files are still listed), `gofmt` on `csrf.go` (so `go test` never runs), and `apps/app` typecheck. The CLI suite hits its 40-minute cap. No `main` ruleset requires any status check. Of 131 automation paths named in `.specs/engineering/checks/*.md`, 6 exist; 125 are to write, and 3 of the planned paths would never execute as written (rpc `src/` tests are outside the vitest include).

---

## 1. Runners, targets and exact commands

### 1.1 How tests are declared and run

```
PACKAGE.ts (per package)  ──►  .smithers/target-index.json (generated, 1,089 targets)
        │                                   │
        ▼                                   ▼
pnpm exec smthrs test '<label>'      pnpm exec smthrs ci '//packages/...'   (build+test+lint)
        │  starts declared services (Docker PostgreSQL), sandbox, timeout
        ▼
vitest | bun test | node --test | go test | cargo test | playwright
```

- Root `package.json` scripts: `test` = `pnpm -r --if-present run test`; `test:e2e` = `pnpm --filter smithers-app run test:e2e`; `check`, `lint`, `docs:check`, `docs:sync`, `browser` (bundle contract, not a browser test).
- `exclusive: true` targets are skipped by wildcard selections: `//apps/app:browserE2e`, every `:faults` target, `//flows:registrationCalibrationReal`.
- `--known-red .github/ci-known-red.json` lists 5 entries, all `win32`-only (advisory lane, expire 2026-10-10..31). Every Linux red is "newly red".

### 1.2 MVP packages: targets, runners, thresholds, commands

Delta.md keeps/modifies: Go backend (`packages/backend`, `apps/backend`), `apps/app`, `packages/rpc` (new catalog), the CLI `packages/smithers` (`@smthrs/cli`), `flows/` (todo/coding/learning flows), `@smthrs/flow` + engine/journal/engine-store (carried over), `packages/smithers/agent/registry` (`Executable.ts` refresh fix), `packages/smithers/ui` (CodeSurface), `crates/smithers-ffi` (Yrs). Adds `crates/smithers-machined` and `packages/backend/internal/live` (neither exists).

| Package | Label(s) | Runner | Coverage floor | Fast loop (exact) | Full gate |
| --- | --- | --- | --- | --- | --- |
| Go backend | `//:backendGo` (root `PACKAGE.ts:358`) | python boundary tests, `gofmt -l`, `go build`, `go vet`, `go test -count=1 ./packages/backend/... ./apps/backend/... ./distribution/... ./docs/api/...` | none measured (no `-cover` anywhere) | `SMITHERS_TEST_DATABASE_URL='postgres://smithers:smithers-backend-test@127.0.0.1:55435/postgres?sslmode=disable' go test -count=1 ./packages/backend/internal/services -run 'TestMythical'` (needs PG 18 on :55435; without the URL, DB tests skip unless `SMITHERS_REQUIRE_DATABASE_TESTS=1`) | `pnpm exec smthrs test '//:backendGo'` (starts Docker `postgres@sha256:ef257d…` on 55435, builds FFI + sqlc, 30 m cap). `internal/services` alone needs `-timeout=30m` (1,759 s measured, #2290) |
| `apps/app` | `:check`, `:unitTests`, `:conformance`, `:browserE2e` (excl.) | `bun test` (unit, conformance); Playwright (e2e) | none ("no source coverage percentage is claimed", `apps/app/PACKAGE.ts:86`) | `cd apps/app && bun test src` · `bun test lint/conformance` · `pnpm --filter smithers-app check` | `pnpm --filter smithers-app test` (9,048 tests, ~8 min, #2290) · `pnpm exec smthrs test '//apps/app:browserE2e'` (~24 min) |
| CLI `@smthrs/cli` | `//packages/smithers:test` (Linux-only host), `:faults` (excl.), `:check`, `:lint`, `:fmt` | vitest (two halves merged), PG via Docker service on 55435 | branches 91, functions/lines/statements 96 | `cd packages/smithers && pnpm exec vitest run test/<File>.test.ts --coverage.enabled=false` (a partial run with coverage on fails the floor and means nothing) | `pnpm exec smthrs test '//packages/smithers:test'` (40 m cap; 244 test files) · `pnpm exec smthrs test '//packages/smithers:faults'` |
| `@smthrs/flow` | `//packages/smithers/flows/flow:test`, `:bunTest`, `:referenceCodeBlocks` | vitest | 100/100/100/100 | `cd packages/smithers/flows/flow && pnpm exec vitest run --coverage.enabled=false` (58 files) | `pnpm exec smthrs test '//packages/smithers/flows/flow:test'` |
| `@smthrs/engine`, `flows` umbrella, journal, engine-store | `…/engine:test`, `…/flows:test`, `…/journal:test`, `…/engine-store:test`, `…:disasterRecovery` | vitest / node test | 100 (engine, flows) | `cd packages/smithers/flows/engine && pnpm exec vitest run --coverage.enabled=false` | `pnpm exec smthrs test '//packages/smithers/flows/...'` |
| `@smthrs/rpc` | `//packages/rpc:unitTests` | vitest, `include: ["test/**/*.test.ts"]` | none | `cd packages/rpc && pnpm exec vitest run` (1,676 tests, 7 s) | same |
| `flows/` (`@smithers/release-workflows`) | `//flows:coding`, `:suite`, `:repository`, `:fixtures`, `:wiki`, `:memory`, `:pack`, `:egress`, `:testCoverage`, `:codingBundle*`, `:codingNative*` (23 test targets, 182 test files) | `node --experimental-strip-types --test` | `:testCoverage` target-coverage test | `cd flows && node --experimental-strip-types --test test/<file>.test.ts` | `pnpm exec smthrs test '//flows/...'` |
| `@smthrs/registry` | `//packages/smithers/agent/registry:test` | vitest | 100 | `cd packages/smithers/agent/registry && pnpm exec vitest run test/ExecutableRefresh.test.ts --coverage.enabled=false` | `pnpm exec smthrs test '//packages/smithers/agent/registry:test'` |
| `@smthrs/ui` | `//packages/smithers/ui:unitTests` | `bun test tests` (126 files) | none | `cd packages/smithers/ui && bun test tests` | same |
| `crates/smithers-ffi` | inside `//:nativeFfi` (build target: clippy + `cargo test -p smithers-ffi` + build) | cargo | none | `cargo test -p smithers-ffi --locked` (183 `#[test]`) | `pnpm exec smthrs build '//:nativeFfi'` |
| TUI (deferred) | `//apps/tui/...`, `:e2eTests` | bun | — | not MVP | — |

Local toolchain on this Mac: Go 1.26.8, Bun 1.4.1, PostgreSQL 18 at `/opt/homebrew/opt/postgresql@18/bin`, Docker, cargo, `msb 0.6.16`, `target/{debug,release}/smithers-jj-export` present. `jj` resolves to an agent-guard wrapper.

Traps for the plan:
- `//:backendGo` and `//packages/smithers:test` both bind Docker PostgreSQL to host port 55435 with different users. They run in different CI jobs; a local `smthrs test '//...'` that schedules both concurrently can collide.
- `//packages/smithers:test` declares `hosts: ["linux"]`. Checks that put CLI integration tests there (C-J6-02 `DelegatedLogin.integration.test.ts`) cannot run through `smthrs` on the Mac reference host.
- Go tests needing native pieces read `SMITHERS_FFI_LIBRARY_PATH` (21 uses), `SMITHERS_WIKI_TEST_FFI`, `SMITHERS_WORKSPACE_JJ_EXPORT_BINARY`; the `backendGo` shell sets the first two.

---

## 2. CI

### 2.1 What runs

| Workflow | Trigger | What | Status 2026-10-02 |
| --- | --- | --- | --- |
| `ci.yml` "CI" | push `main`, PR | 14 jobs: workspace graph (`smthrs ci //examples/...`, `//packages/... --jobs 2`, coverage-enforced); repository flows/apps/evals; script gates; docs sites; apps e2e (Playwright T1, `apps/app` check/unit/conformance/browserE2e, TUI); rust (flows-jj); rust-ffi (`//:nativeFfi`); wasm repro; fault matrix (`//packages/...:faults --jobs 1`); web bundle; package suites ubuntu (required) + macOS/Windows (advisory); go-backend (`//:backendGo`) | **red**; last green on `main` 2026-09-08 (`a659f17a`) |
| `drift.yml` | push `main`, PR | fmt across `//...:fmt`, OpenAPI bundle/clients, target index, docsDrift, conflict markers, apiBaseline | red (dprint in `packages/smithers`, flows, engine, engine-store, database, patterns; `build/targets` docs table) |
| `distribution.yml` | push `main`, PR | Docker self-host image | red (`distribution/install-cli.mjs` missing); delta.md deletes this image (T-INS-05) |
| `apps-deploy.yml` | push `main` | Cloud app deploy (re-runs app gates) | red |
| `mirror-sync.yml` | push `main` | mirror to Smithers Cloud | green |
| `canary.yml` | hourly | Chromium canary + uptime probe of the deployed Cloud product | green (not the MVP install) |
| `reliability.yml` | nightly 03:23 | bench counters, 60-min sync soak, signal state machine (rotating seed), run-lifecycle model | red every night since at least 09-27 (signal state machine; scheduler/journal counters) |
| `release.yml` | tag `v*`, dispatch | full gate set + publish | not run |
| `native-windows.yml` | path-filtered | FFI/platform on Windows | — |

### 2.2 Is it working, and what is required

- **Actions run.** The memory note "org Actions billing failed since Sep 3" is stale: on 2026-10-02 jobs start, run up to 60 min and upload logs.
- **No required checks.** `main` has no branch protection; the one ruleset ("Main", active) enforces only `deletion`, `non_fast_forward`, `required_linear_history`. Squash, merge and rebase merges are all enabled in repo settings.
- **Runs are superseded.** Of the last 100 completed CI runs on `main`: 88 `cancelled`, 12 `failure`, 0 `success`. `cancel-in-progress` is false for pushes, but the concurrency group keeps one pending run, so frequent pushes cancel the queue.

### 2.3 Last completed CI run on `main` (37056107155, `d4d2eacc`, 2026-10-02 19:44Z)

```
job                                      result   first failing gate
workspace graph (coverage enforced)      FAIL     actionlint: .github/workflows/pr-review.yml (and review.yml) missing → 21 s, nothing tested
shared Go backend (PostgreSQL)           FAIL     gofmt: packages/backend/internal/middleware/csrf.go → go test never ran
apps e2e (Playwright T1)                 FAIL     apps/app:check TS2550 (SlashPayload.test.ts:414 toReversed)
                                                  unitTests/conformance blocked by gateway:check TS2339 (ProjectionsUnit.test.ts 'limit')
                                                  browserE2e: T1 214 pass / 1 fail (chat-draft.spec.ts:4) / 13 skip;
                                                  showcase 19 pass, site 13 pass, graph 20 pass
package suites (ubuntu, required)        FAIL     14/186 targets: packages/smithers:test (killed at 40 m cap, 2,403 s),
                                                  rpc:unitTests (1/1,676, Refusal.test.ts auto-retry), flows:test
                                                  (NodeRuntimeReap), flows/jj, time-travel, platform-node, control,
                                                  agent, agent/registry, agent/harness, migrate, build, build-cli, ui
fault-injection matrix                   FAIL     packages/smithers:faults 7 cases (burndown #3367 disk gate, case03
                                                  CLI restart, case31 containment ×2, reparent/SIGKILL, handshake)
                                                  jj/database/agent faults pass
repository flows, apps and evals         FAIL     flows:pack, :egress, :fixtures, :fmt, :lint, //:jsdocTree, evals/agent
script gates                             FAIL     9/112 incl. benchmarkGate, faultSkips, apiBaseline, dependencyBoundaries
rust, rust-ffi, wasm, web bundle, docs   PASS
```

Consequence for QA: there is no current CI evidence that the Go backend tests pass, that `apps/app` unit tests pass, or that any package meets its coverage floor. The freshest executed evidence is #2290's local runs at unlanded prepared commits (§5).

---

## 3. Harnesses on disk

### 3.1 Browser e2e

| Harness | Where | Count | Runs against | In CI |
| --- | --- | --- | --- | --- |
| T1 Playwright | `apps/app/e2e/playwright/*.spec.ts`, `playwright.config.ts` | 65 specs (228 tests) | SPA + `scripts/browser-test-host.ts` on :47311, `SMITHERS_CHAT_STUB=1`, `page.route` fixtures; Chromium (WebKit via `SMITHERS_E2E_BROWSER=webkit`) | yes (`browserE2e`) |
| Showcase | `e2e/showcase/cases/*.case.ts` | 19 | T1 host | yes |
| Site | `e2e/site`, `playwright.site.config.ts` | 5 specs | built smithers.sh | yes |
| Flow graph | `e2e/graph`, `playwright.graph.config.ts` | 4 specs (20 tests) | real control plane + real engine on localhost | yes |
| Real tier | `e2e/real/**/*.spec.ts`, `scripts/run-real-e2e.ts`, `playwright.real.config.ts`, gate `scripts/check-real-e2e.ts` + `e2e/real/coverage/README.md` | 41 specs | local host in **hybrid Cloud mode**, `SMITHERS_CHAT_STUB=0`, signed-in **Cloud** user; or a deployed canary | **no** (memory: 23 scenarios red 09-20) |
| Mode matrix | `scripts/run-mode-matrix.ts`, `scripts/mode-matrix/{local-own,docker-web-selfhost,plue-target}.ts` | 4 modes (`web-selfhost`, `web-plue`, `local-own`, `local-plue`), 14 feature rows | `local-own` builds `apps/backend` + PG 18 locally | **no** |
| Probes / auth / graph-lifecycle | `e2e/probes`, `e2e/native/CloudAuthFragment.test.ts`, `e2e/graph/lifecycle` | — | bun tests | yes |
| Design mock | `.specs/design/mock/{check,copy,shot}.mjs` | 20 journey files | `file://` mock build | **no** (no `PACKAGE.ts` or workflow references it) |

No Puppeteer and no agent-browser usage. The `multi-test-github-account` skill holds a saved signed-in GitHub account (`codeplanesmithers`) and Playwright profile; C-GH-01's latest evidence (`.artifacts/checks/C-GH-01/…/spike-answers.json`) is `blocked_by_GitHub_sudo_email_verification`.

**Gap:** nothing drives a browser against a self-hosted install with microVM isolation. No app e2e sets `SMITHERS_WORKSPACE_ISOLATION` or `SMITHERS_MICROSANDBOX_BIN`. The existing real tier depends on a Smithers Cloud sign-in, which the MVP removes. The scratch GitHub owner `smithers-mvp-canary` named by `checks/README.md` returns 404 as both org and user.

### 3.2 Fake GitHub

- **No shared fake GitHub server exists.** `packages/backend/internal/githubfake/` is planned in T-GH-01 (manifest conversion, `/app`, installations, tokens, write log), extended by T-GH-02 (issue events, ETags/304, rate-limit headers, `Retry-After`, git smart HTTP, request counter) and T-GH-09 (write log + kill hooks). 16 tickets and at least 8 checks depend on it.
- Today: 608 `httptest.NewServer` calls in Go tests, about 19 files with per-test GitHub fakes (`fakeGitHub`, `newReconcileFakeGitHub`, `newFakeIssueTextGitHub`, `githubImportHAPI`); none handles ETags (`If-None-Match` appears in no services test). The stack tests use an in-process interface fake (`fakeMythicalGitHub` in `mythical_items_test.go:422`), not HTTP.
- Seam exists: base URLs are configurable (`SMITHERS_AUTH_GITHUB_API_BASE_URL`, `auth.github_oauth_base_url`, `defaultGitHubGitBaseURL`); `repo_connection_github_app.go:98` still has its own `https://api.github.com` default.

### 3.3 PostgreSQL fixtures

- Go: `packages/backend/testkit/testdb` gives each test a fresh database on the server in `SMITHERS_TEST_DATABASE_URL`; `SMITHERS_REQUIRE_DATABASE_TESTS=1` turns skips into failures; orphan DBs older than 6 h are reaped. `testkit/postgresfixture` adds product-schema pools (`NewProductDatabase`, `Suite`, template clone via `newProductTestPool`). 179 test files use them; 176 `*integration_test.go`, 3 `*_db_test.go`, 13 `TestMain` suites. `testdb.Tools` runs its own server from `SMITHERS_POSTGRES_TEST_BIN` for backup/restore tests.
- TS: `packages/smithers` history tests read `SMITHERS_HISTORY_TEST_PG_URL` (Docker PG on 55435); `flows/database/scripts/test-matrix.mjs` runs SQLite and PostgreSQL matrices for time-travel and control.

### 3.4 MicroVM harness

- `packages/backend/microsandbox`: 14 real-VM tests (`real_vm_test.go` 6, `real_layers_test.go` 3, `real_runtime_share_test.go` 1, `egress_secrets_test.go` 3, `internal/compose/hostile_host_environment_test.go` 1), skipped unless `SMITHERS_MICROSANDBOX_BIN` is set; `SMITHERS_REQUIRE_MICROVM_TESTS=1` makes absence fatal. README: `SMITHERS_MICROSANDBOX_BIN=/path/to/msb go test ./packages/backend/microsandbox -run TestRealMicroVM -v`.
- `packages/backend/workspaceconformance` (`RunCore`, `RunColdSnapshots`) is the shared runtime conformance suite, run against the `process` runtime (`process/conformance_test.go`) and microsandbox.
- Opt-in heavy tests: `SMITHERS_FLOWDISPATCH_REAL_HOST=1` (`flowdispatch/real_host_test.go`, bundled coding host with `openai:scripted`), `SMITHERS_FLOWHOST_FRESH_BOX=1` (`flowhost/fresh_box_real_host_test.go`, currently red, #2287).
- **Nothing sets `SMITHERS_MICROSANDBOX_BIN` or `SMITHERS_REQUIRE_MICROVM_TESTS` in CI or in any target.** The comment "a release gate sets SMITHERS_REQUIRE_MICROVM_TESTS=1" has no implementation.

### 3.5 Fault injection and kill points

- TS: 4 exclusive `:faults` targets (`packages/smithers` 27 files under `test/faults/{engine,sandbox,time-travel,harness,budgets,…}`; `agent`, `flows/database`, `flows/jj`), serial, 180 s per case, coverage off. CI job "fault-injection matrix".
- Go: `internal/services/durable_crash_restart_test.go` runs the jobs and stack workers in a child process and SIGKILLs at `pre-commit | post-commit | pre-launch | post-launch | stale-owner` (`SMITHERS_CRASH_POINT`), then requires one completion and one external effect. Also `git_mirror_restart_test.go` (`SMITHERS_MIRROR_RESTART_*`), `flowhost/workspace_crash_recovery_test.go`, PostgreSQL crash helper (`SMITHERS_POSTGRES_CRASH_*`). This is the seam C-GH-09, C-DUR-03 and T-STK-04's merge kill points should reuse.
- Missing: host-kill of a TODO run (C-DUR-01), machine kill (C-DUR-02), daemon/VM kill during burst (C-DUR-04; `crates/smithers-machined` does not exist), GitHub-outbound kill with a write log.

### 3.6 Fuzz and property tests

- Go: 28 `func Fuzz` in 5 files (`internal/auth/key_auth_fuzz_test.go`, `internal/routes/{validation,input_fuzz}_test.go`, `internal/services/{validation_fuzz,auth_fuzz}_test.go`). No `testdata/fuzz` corpora. CI runs seeds only; no fuzz campaign. None covers stack, TODO, GitHub sync or catalog.
- TS: fast-check in 26 files (plan 5, journal 3, capability 3, gateway 2, sync 2, canonical 2, engine, engine-store, crypto, keys, CLI `Bug.test.ts`, notifications, `repo-targets` effect-property helper). Nightly model-based campaigns: `control/test/SignalInboxModel.test.ts` (rotating seed, mutation check) and `engine-store/test/RunLifecycleModel.test.ts`.
- Rust: no `cargo fuzz`, no proptest.

### 3.7 Benchmarks and perf

- `scripts/bench/gate.mjs` (`//scripts:benchmarkGate`): 18 deterministic fixtures, counter-based (SQLite statements, dispatches), ±5% vs `baseline.json`, no wall-time threshold. Red in CI today. `scripts/bench/{flow-discovery,rebase-cache}` are manual measurements.
- Go: 54 `func Benchmark`. Nightly 60-min sync soak (`flows/sync` `ServerLongSoak.test.ts`).
- `evals/`: agent, ale, authoring, harbor, recommend, review-seeded-bugs, swebench (offline in CI).
- **MVP perf (spec §18, C-PERF-01..06): `scripts/perf/` does not exist.** `.artifacts/perf/` does not exist.

### 3.8 Model and agent doubles

- `openai:scripted` implement model for the coding host (`flowdispatch/real_host_test.go:136`, `flowhost/fresh_box_real_host_test.go:110`, `local-own` launcher).
- `@smthrs/testing` (`packages/testing/src`): `CachedModel`, `RecordedModel`, `Fixture`, `TestHost`, `MemoryEngine`.
- `SMITHERS_CHAT_STUB=1` stubs app chat in T1.

---

## 4. Known reds relevant to MVP packages

Ground truth is §2.3 (CI, today). Memory entries below are older and some are marked STALE; treat them as leads, prove by source swap.

| Package | Red (date, source) | Still relevant? |
| --- | --- | --- |
| Go backend | `gofmt` `csrf.go` blocks the suite (CI 10-02); `TestWorkspaceProviderPoolRotationDoesNotPersistBootAccountModel` fails under Node 22 (stdout+stderr JSON parse), services suite needs `-timeout=30m` (#2290 body) | yes |
| `apps/app` | typecheck TS2550 (CI 10-02); T1 `chat-draft.spec.ts:4` (CI 10-02); ~60 unit reds after boot began GETting `/api/user/settings/signup`, and `src/bun/*` importing deleted `smithers-server/*` (memory 09-30); `FormCardsAgainstMain` 2 reds, `ControllerTestScope`, `Wave12` (09-18..28); real tier 23 scenarios red (09-20); T1 chat/boot-identity reds (09-20). #2290 reports whole App **9,048 pass / 1 skip** at prepared, unlanded `4bb78118` | conflicting; unit suite has not run in CI |
| CLI `packages/smithers` | 40-min cap exceeded (CI 10-02); 4,440 pass / 8 fail / 10 skip, 2,377 s at `4bb` (6 `NativeBodyCli` #3414, 2 `Bin` retry-warning) (#2290); `UnifiedControlCommands` 8 + `McpModeCli` 1 (09-30); `ModuleBudgetPark` flaky (09-28); faults 7 cases (CI 10-02) | yes |
| `packages/rpc` | `Refusal.test.ts` auto-retry 1/1,676 (CI 10-02); older `Cards.test.ts` TS2741, `RouteOwnership` (09-18..20) | yes (1 red) |
| `flows/` | `pack`, `egress`, `fixtures`, `fmt`, `lint` (CI 10-02); `coding-gates`/`coding-host`/`publication` (opencode missing from `codingPackages`) and Jev `repository-host` (09-18) | yes; `//flows:repository` passes today |
| `@smthrs/flow`, engine, flows umbrella | `flows:test` NodeRuntimeReap integration (CI 10-02, also memory 09-09); dprint fmt in flows/engine/engine-store (Drift 10-02); flows/flow bun timeouts (09-09, load) | yes |
| registry | red in CI 10-02; branch coverage 98.9% vs 100% floor (`Executable.ts`, `MarkdownFlow.ts`, `ModuleMetadata.ts`) (09-10) | yes; `Executable.ts` is an MVP change site |
| gateway (app dep) | `gateway:check` TS2339 blocks app unit/conformance (CI 10-02); coverage < 100% (09-10) | yes |
| `@smthrs/ui` | `ui:unitTests` red (CI 10-02); `--info` token css-contract (09-10) | yes |
| flowhost | FreshBox: engine completion precedes journal projection (#2287) | yes |
| docs | `pnpm docs:check` sync drift (09-19) | recheck |

---

## 5. Issue #2290 (testing campaign)

Open, `in-progress`, created 2026-09-27, last updated 10-02. All 8 acceptance boxes unchecked (inventory; unit; integration; e2e; fuzz; benchmarks; Astra fix + Fable review per bug; landing via stack + wiki). More than 20 folded items (#2292–#2358) wait only for "Cloud qualification, mythical-stack/owner-merged PR and wiki receipts".

Executed evidence, all at **prepared, unlanded** commits:

```
suite                        commit      result
Go 12-package API            c563711a    7,461 tests + 10,976 subtests PASS, 20 skips (routes, compose, services, db, …)
apps/app whole               4bb78118    9,048 PASS / 0 FAIL / 1 declared SKIP (477 s)
TUI unit / PTY               4bb78118    2,116 / 233 PASS
CLI whole                    4bb78118    4,440 PASS / 8 FAIL / 10 SKIP (2,377 s)
RPC                          c563711a    1,706 PASS
flowhost FreshBox            4bb/bd93    64 PASS / 1 FAIL (#2287)
browser real (local-own)     4bb         anonymous sign-in PASS; synthetic flow case FAIL before List
```

Outstanding: full browser/onboarding parity, hosted/GitHub/non-admin/factory/wiki/release evidence, executed coverage numbers (no numeric coverage claimed anywhere), latest-main reconciliation and canonical landing. Fable reviews are blocked ("Credit balance too low"). A TUI watcher qualification is unverified; Chromium failed to start on one host (`MachPortRendezvous bootstrap_check_in`).

---

## 6. Design mock harness (`.specs/design/mock`)

- `build.mjs`: esbuild + the app's real Tailwind/PostCSS pipeline over `apps/app/src/mainview/index.css` and `@smthrs/ui` source → one self-contained `dist/index.html`. Cards are mock components in `mock/src/cards/*.tsx`, not the production cards.
- `check.mjs`: Playwright Chromium at 1440×900; for every journey (20 journey files: j1–j10, agent, ask, run, states, later…) and every step `s=0..n`, loads `?j=<id>&s=<i>&still=1`, fails on any `pageerror` or console error, and fails if the step's `target` selector is absent inside `[data-frame="<viewer>"]`.
- `copy.mjs`: copy lint over every step: banned words `workflow|thread|task|lane|box|workspace|mythical|sandbox|VM|microVM|seat|profile|jev|forge` in visible product text (skipping code, terminals, prompts, chat, GitHub frame), and card body lines over 12 words.
- `shot.mjs`: screenshots `shots/<name>-<light|dark>.png` at a chosen step, width and theme.
- Typecheck: `apps/app/node_modules/.bin/tsc -p .specs/design/mock/tsconfig.json`.
- It validates the mock only. Nothing links mock cards to production `<Card>View` components, and it runs in no CI target.

---

## 7. Check automation: on disk vs to write

113 check files (`checks/README.md` indexes 110; C-MCH-09, C-MCH-10, C-REL-05 are newer). 131 automation path references.

**Exist (6):** `apps/app/e2e/real/run-inspection.spec.ts` (C-J11-01, extend), `apps/app/e2e/real/agents.spec.ts` (C-J11-03, extend), `packages/smithers/agent/registry/test/ExecutableRefresh.test.ts` (C-J5-02, add case), `apps/app/e2e/playwright/browser-keyboard.spec.ts` (C-UI-01), `apps/app/src/mainview/Architecture.test.ts` and `apps/app/src/mainview/flows/parity.test.ts` (C-UI-08).

**To write (125)**, by home:

```
apps/app/e2e/real/*.spec.ts (+ github-j10/, support/)        42   reference host
packages/backend/internal/services/*_test.go                 26   CI (real PG) / reference host
rpc src/catalog, apps/app unit, playwright, app scripts       11   CI
packages/backend/internal/compose/*_test.go                   9   CI
packages/backend/{microsandbox,flowhost,internal/live,
                  internal/machined,internal/routes}          9
scripts/perf/*                                                7   reference host
scripts/spikes/*                                              7   reference host
packages/smithers/test/** (CLI, faults)                       5
scripts/journeys/*                                            4   reference host, recorded
crates/smithers-machined, scripts/{checks,release},
  scripts/mvp-docs, apps/site mvp-docs                        5
```

Directories that do not exist yet: `scripts/{perf,journeys,spikes,checks,release}`, `packages/backend/internal/{githubfake,live,machined}`, `crates/smithers-machined`, `apps/app/e2e/real/github-j10`, `packages/rpc/src/catalog`. Spike scripts live in unlanded sibling checkouts (`~/smithers-mvp-spike`, `~/smithers-mvp-col`).

**Evidence directory** `.artifacts/checks/` exists (gitignored at `.gitignore:20`), all written 2026-10-02, for 11 checks: C-CAT-01, C-CUT-01, C-GH-01 (blocked by GitHub sudo verification), C-J1-06 ("partial component evidence"), C-REL-01, C-SEC-02, C-SPK-02 (answer **NO**: shared virtiofs homes lose writes across two VMs), C-SPK-03 and C-SPK-07 (only `env.json`, in progress), C-SPK-06, C-UI-02.

**Spec defects in automation paths** (fix in the check files before tickets start):
1. C-CAT-01, C-CUT-01, C-UI-08 place tests at `packages/rpc/src/**/*.test.ts`, but `packages/rpc/vitest.config.ts` and `PACKAGE.ts:52` include only `test/**/*.test.ts`. As written they never execute. Existing card tests live in `packages/rpc/test/` (`Cards.test.ts`, `SubagentCard.test.ts`).
2. C-COL-01 cites `apps/app/src/mainview/cards/CodeSurface.test.tsx` without "(new)"; it does not exist.
3. C-MCH-09 says "extend" `microsandbox/real_users_test.go`, which C-MCH-06 has not created.
4. C-INS-05 needs "CI on a macOS arm64 runner"; no CI job runs `apps/app` on macOS (the macOS package lane is advisory and covers `//packages/...` only).
5. C-UI-03 needs CI Chromium and WebKit; CI installs Chromium only (WebKit is an env switch).
6. C-J6-02 puts a CLI integration test in `packages/smithers/test/`, whose target is `hosts: ["linux"]` with a 40-min cap already exceeded.
7. New `apps/app/e2e/real` specs must register scenarios in the real-tier coverage contract or `check-real-e2e.ts` fails them.

---

## 8. Biggest harness gaps, ranked by how many checks they block

```
gap                                                        blocks                     owner ticket
──────────────────────────────────────────────────────────  ─────────────────────────  ────────────
1  No CI signal: actionlint, gofmt, app typecheck stop     every CI-layer check       none named
   gates before tests; no required checks on main
2  No browser e2e against a self-hosted install with       42 e2e specs, J1–J11       none named
   microVMs (real tier needs a Cloud sign-in)
3  No shared fake GitHub server (REST, GraphQL drafts,     ≥8 checks, 16 tickets      T-GH-01/02/09
   ETags, write log, kill hooks)
4  No scratch GitHub owner (smithers-mvp-canary 404) and   all J2/J10 e2e, C-GH-01    none named
   GitHub sudo verification blocks App-manifest automation
5  Real microVM tests never run anywhere automated          C-MCH-*, C-SEC-01/02,      none named
   (no SMITHERS_REQUIRE_MICROVM_TESTS gate)                 C-DUR-02, C-STK-05
6  No perf scripts or reference-host profile capture       C-PERF-01..06, C-GH-07     T-REL-01
7  No machined crate, no inotify/cgroups Linux CI lane     C-DUR-04, C-J3-03, C-PERF-04 T-COL-03/04
8  Go has no coverage measurement; fuzz targets miss       C-STK-01 exhaustiveness    T-STK-01
   stack/TODO/sync; no fuzz campaign
9  Design mock not in CI and not linked to production      C-UI-02, C-UI-08 (indirect) T-APP-19
   Views
```

Raw CI logs used: `(local scratchpad)` (`111005369*.log`, `full-505.log`, `full-352.log`).

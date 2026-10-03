# apps/app/scripts

E2E and live-check scripts. Unless a section says otherwise, run them from
`apps/app`.

## Server bundle

From the repository root, after the frozen pnpm install:

```sh
SMITHERS_BUILD_SHA=<full-commit-id> pnpm exec smthrs build //apps/app:serverBundle
bun test apps/app/scripts/build-server-bundle.test.ts
SMITHERS_BUILD_SHA=<full-commit-id> pnpm exec smthrs test //apps/app:serverBundleIntegration
```

The assembler writes only `apps/app/.server-bundle/`. Its intermediate files are removed after a build; the shipped jj binary is reused only at the pinned revision. The exclusive integration gate builds an exact committed checkout, relocates the bundle, checks every manifest hash, starts with an empty state directory and an OS-only runtime PATH, verifies PostgreSQL persistence, and boots the bundled image with registry access blocked. See [distribution prerequisites](../../../distribution/README.md#mac-install).

Build intermediates use `.server-bundle/.build/`, including the default Go cache. `CARGO_BUILD_JOBS` and `GOMAXPROCS` default to the host's available cores; operator values for either, `GOCACHE`, and `GOFLAGS` are inherited.

## Declared test runners

| Command (from `apps/app`) | Files executed | Requirement |
| --- | --- | --- |
| `pnpm test` | Tests under `src/`, `scripts/`, `e2e/contracts/`, `e2e/real/coverage/`, `e2e/real/support/`, and `e2e/real/auth-permissions/profile.test.ts` | Bun |
| `pnpm run test:e2e` | Specs under `e2e/playwright/` | Playwright Chromium and the local app server |
| `pnpm run test:e2e:auth` | `e2e/native/CloudAuthFragment.test.ts` | Playwright Chromium; starts isolated loopback OAuth fixtures |
| `pnpm run test:e2e:site` | Specs under `e2e/site/` | Playwright Chromium; builds and previews `apps/site` |
| `pnpm run test:e2e:probes` | Tests under `e2e/probes/` | Playwright Chromium; no server and no deployed host |

Headless host process probes are Bun tests, separate from Playwright specs. `lint/conformance/TestInventory.test.ts`
checks that each test file belongs to an executable runner. The `unitTests`
target uses the same discovery as `pnpm test`; its inputs include scripts,
E2E harnesses, configs and RPC fixtures. It depends on the RPC, gateway and
shared UI typechecks so the inspected package sources contribute their keys.
The `browserE2e` target invokes `run-pr-e2e.mjs`, which installs Chromium, runs
`test:e2e:auth`, `test:e2e:probes` and `test:e2e:graph-lifecycle`, then the
offline Playwright, showcase, site and flow-graph suites, serially: T1 and
graph each rebuild `dist/`, the showcase serves T1's `dist/`, and T1, site and
graph write `test-results/`. A failed Chromium install stops the wrapper; a
failed suite does not stop the later ones, and the wrapper exits with the first
failure's code. Each step prints its duration. The run takes ~22 min on
ubuntu-latest under the target's 30m timeout. TestInventory admits a CI
browser tier only from that runner's argv, never from a `package.json` alias.

## Launch checklist (`launch-checklist.ts`)

Run the signed-in launch checklist (§A-F) against an explicit origin.
`--target`/`-t` overrides `$CHECKLIST_TARGET`; there is no default target.

From the repository root:

```sh
pnpm run checklist -- --target https://canary.smithers.sh
```

From `apps/app`:

```sh
pnpm run checklist -- --target https://canary.smithers.sh
```

The root script forwards to the UI package. Both commands run
`bun scripts/launch-checklist.ts` with `apps/app` as the working directory.
A local origin can be passed to `--target` for local verification.

### Probes and prerequisites

The §A, §B, §C and §F rows, plus D-3 and D-4's pause half, use a system
Chrome/Chromium through `headless-page.ts`. The §D HTTP rows inspect billing
and turn seams; §E inspects the billing upstream. D-4 checks both the turn
response and the workflow refusal at zero balance.

The checklist downloads no browser. Choose one with `--browser <path>` or
`$CHECKLIST_BROWSER`, or use automatic system-browser discovery. One browser
process serves the run, with a separate page per session cookie.
`--no-browser` skips browser prerequisites while HTTP probes still run.

Missing prerequisites produce `not-testable-yet` rows with a named reason.
A probe that starts but cannot decide also produces `not-testable-yet`, with
`undecidedInProbe: true`. These outcomes have different exit codes below.

### Auth material

The `CHECKLIST_*` credentials are auth material; never commit them.

| Variable | Rows | Value |
| --- | --- | --- |
| `CHECKLIST_SESSION_COOKIE` | §A except A-1, §B, §C, §F, D-1, D-2, D-3 | Cookie header for a signed-in session |
| `CHECKLIST_ZERO_BALANCE_BEARER` | D-4 | Cookie header for an account at zero balance |
| `CHECKLIST_BILLING_UPSTREAM_URL` | §E | Billing upstream origin |
| `CHECKLIST_BILLING_ADMIN_TOKEN` | E-2, E-3 | Billing upstream admin token |
| `CHECKLIST_BILLING_PRODUCT_SERVICE_TOKEN` | E-3 | Product Worker billing service token |

Set cookie headers as `name=value; name2=value2`. Missing required variables
skip that row's prerequisites; the run continues and writes a report. A-1
checks the signed-out view without a cookie.

### Dry run

From either directory:

```sh
pnpm run checklist -- --dry-run
```

No target, credentials or browser are required. Dry runs make zero network
calls, mark every row `skipped-dry-run`, write both reports, and exit `0`.
They verify CLI wiring and report generation, not the deployed application.

### Output and exit codes

Every completed run writes `launch-checklist-report.json` and
`launch-checklist-report.md` under
`apps/reports/launch-checklist/<timestamp>Z-<dry-run|run>/`.
`--out <dir>` overrides the report directory; relative paths resolve from
`apps/app`, including when invoked through the root forwarding script.
Reports contain `generatedAt`, `target`, `totals`, and `rows[]`.

| Exit code | Meaning |
| --- | --- |
| `0` | No failed rows and no run-mode probe-undecided rows. A run containing only passes and prerequisite-skipped rows also exits zero; zero alone does not prove every row ran. Dry runs exit zero. |
| `1` | At least one row is `fail`, even if other probes are undecided. Invocation without a target outside dry-run mode also exits one. |
| `2` | No failed rows, but at least one run-mode probe-undecided row (`undecidedInProbe: true`, counted in `totals.probeUndecided`). |

Prerequisite-skipped rows include missing auth variables and unavailable or
disabled browsers. Probe-undecided rows include an empty watched set or no run
identifier in the rendered state. Inspect row reasons and totals before
accepting a release. Connection failures from probes that run are failed rows.

The catalog, runner and CLI contract live in `./launch-checklist/`.
`pnpm test` covers them and the script contracts. The process shell owns the
clock, filesystem, browser lifecycle and final exit code.

## Live checks

`live-signed-in-check.ts`, `live-workflow-check.ts`, `canary-seam-probe.ts`,
`launch-seam-probe.ts` and `canary-browser.ts` inspect deployed hosts. Each
script's header states its required environment and evidence directory.

Install the browser with `pnpm exec playwright install chromium`.
`lint/conformance/LiteralPin.test.ts` checks suite literals against the product.

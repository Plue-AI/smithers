# apps/app/scripts

E2E and live-check scripts. Unless a section says otherwise, run them from
`apps/app`.

## Stage-1 service

Requires Apple Silicon, macOS 15 or later, Homebrew, and a browser. Use a fresh
macOS account with no Smithers state and at least 72 GiB free on the home volume
(40 GiB floor plus one 32 GiB machine). Have GitHub repository admin access,
a provider key and an AI Gateway key ready. Run as the logged-in user; no sudo.

Unpack `smithers-server.tar.gz` into an empty directory and open a terminal there.
Start the per-user service:

```sh
./bin/smthrs host start --bundle .
```

After readiness it prints one JSON line:

```json
{"setup_urls":["http://localhost:4000/setup?token=...","http://127.0.0.1:4000/setup?token=..."]}
```

Open the first link in your browser. Repeat start keeps the token. The service
restarts after a crash and starts at login. Keep the unpacked directory in place.
Check or stop it (data stays):

```sh
./bin/smthrs host status
./bin/smthrs host stop
```

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

## Server bundle

On darwin-arm64, install the toolchain the assembler checks: Node 26.4+
from nodejs.org first on `PATH` (the assembler refuses a Node that links
Homebrew libraries), the root's pinned pnpm, Bun, the pinned Rust and Go, Xcode
Git, PostgreSQL 18, skopeo and Zig. From the repository root:

```sh
brew install postgresql@18 skopeo zig
pnpm install --frozen-lockfile
```

The assembler cross-builds the Linux arm64 guest helper, `smithers-jj-export`,
from the commit it bundles, and the pinned jj revision for guests, with Zig as
the C compiler and linker. `manifest.json` records both under
`bin/linux-arm64/` as stage `guest-helper`, and `share/build-tools.json`
records the Zig release. Then assemble and verify:

```sh
smthrs build //apps/app:serverBundle
bun apps/app/scripts/server-bundle-manifest.ts apps/app/.native
```

Assembly runs as
the build user and takes about 5 minutes once Rust and Go caches are warm. It
downloads the pinned jj source, the msb 0.6.16 package and the 430 MB base
image, and writes about 1 GiB. Python 3 writes deterministic archives.
The resulting `.native` directory contains `README.md`, `bin/smthrs`, `bin/smithers-server`,
the backend, packaged hosts and tools, `postgres`, `views/mainview`, `lib/libkrunfw.5.dylib`,
and `share/microsandbox/{smithers-guest.py,base-image.oci.tar,base-image.json}`.
`manifest.json` records each file's SHA-256, mode and producing stage; symlinks
must stay inside the bundle. `.native-archive/smithers-server.tar.gz` contains
the whole bundle; its sibling `manifest.json` records the archive and README
digests (an archive cannot contain its own digest). Member order, owners and
mtimes are normalized, including the OCI archive. Web build stamps use the
source commit timestamp, and jj uses a fixed Cargo output directory. Unpack to relocate, then
verify the payload manifest again. The [Stage-1 service](#stage-1-service)
section is copied into the bundle README at assembly.

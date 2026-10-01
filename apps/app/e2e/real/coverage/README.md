# Real E2E coverage contract

Every `e2e/real/**/*.spec.ts` file declares each scenario through the shared
fixture. The declaration is inventory, not proof that the test ran:

```ts
test("opens a repository", scenario("repo.open.success", {
    capabilities: ["local.repositories"],
    coverage: [
      "action:repo.open",
      "host:local",
      "path:success",
      "door:button",
      "dimension:keyboard",
      "evidence:filesystem-readback"
    ]
}), async ({ page }) => { /* real interaction and assertions */ })
```

`scenario(id, metadata)` is the canonical per-test form and returns Playwright
details containing `real-*` annotations. `test.use({ realScenario: metadata })`
is supported for suite defaults, but cannot replace unique per-test ids. The
gate rejects every `test(...)` without its own `scenario(...)` details.

Action tokens refer to the current `FLOW_NAMES` source declaration plus the
literal search factory names returned by `entries/search.ts`. Those generated
search actions are built-in UI features and receive individual missing-action
and execution checks, even though they are absent from the static union.
The one family marker, `action:repository-flow:*`, records runtime repository flow leaves;
it does not stand in for static actions. Hosts are `local` (production build
against owned local services), `production` (deployed canary), and `native`
(packaged app). Critical paths are success, permission, error, persistence,
and keyboard. A scenario may declare multiple dimensions and actions.

Success metadata requires an `evidence:*` token describing independent
completion evidence, such as a filesystem or service readback, process exit,
persisted state after relaunch, or a provider response bound to the submitted
turn. Metadata cannot make an assertion sufficient. Reviewers must verify the
test actually asserts the named evidence.

The quality gate parses TypeScript ASTs for real specs and their executable
relative-import closure. It rejects definite doubles and disabled tests:
Playwright HTTP/WebSocket/HAR interception, module mocks, skip/fixme, stub
environment flags, obvious fake API/credential literals, refusal-as-success,
and assertions that use only arbitrary nonempty text as completion. Ambiguous
assertions are reported for manual review because a nonempty precondition can
be legitimate before a stronger state assertion. Literal refusal copy in an
error or permission scenario is reviewed unless the same test later proves the
boundary held: `expect(sideEffects).toEqual([])`, `toHaveLength(0)`, or a 4xx
`response.status()`.

Fault-path tests must disturb a real boundary. Killing an owned process or
making an actual network unavailable is permitted; substituting its API is
not. Tests must restore the boundary in `finally` cleanup.

Reporter evidence is a JSON array of records defined by
`RealScenarioRunEvidence`: scenario id, host, verdict, revision, timestamps,
deployed build SHA when applicable, timestamps, and optional artifact. The gate joins only a passed record for the same id and
host. Failed, missing, or stale declarations remain visible execution gaps.
The report also lists every uncovered static action and critical-path/host/door
dimension, so partial suites never display artificial 100% coverage.

Add `./e2e/real/coverage/reporter.ts` to the Playwright reporter list. The run
must set `SMITHERS_REAL_E2E_HOST` to local, production, or native and
`SMITHERS_REAL_E2E_REVISION` to the tested revision. The reporter refuses to
write unattributed evidence and defaults to
`test-results/real-e2e-evidence.json`. The fixture must also emit a
`real-host-verified` annotation from actual host evidence; the reporter rejects
host identity asserted only through an environment variable.

Run `bun apps/app/scripts/check-real-e2e.ts --results <reporter-results.json>`.
The machine report defaults to `apps/app/test-results/real-e2e-coverage.json`.
Use `--require-complete --expected-revision <exact-sha> --expected-host <host>`
for each host's release receipt: execution gaps are restricted to scenarios
that declare that host. Run the aggregate gate without `--expected-host` to
require evidence for every declared host. Both modes keep global action,
critical-path, and door inventory gaps visible. Evidence for an unknown
scenario or a host absent from its declaration is rejected.
Both modes fail a built-in action that has no scenario and no entry in
`deferrals.ts`, the reviewed ledger of unscenarioed actions. The ledger rejects
an entry for an action that has a scenario or left `FLOW_NAMES`, and any entry
for a `RELEASE_CRITICAL_ACTIONS` action: only a real scenario accounts for
those. Delete an entry in the change that adds its scenario.
Quality-only mode prints the remaining gaps without failing on them;
completeness mode fails any inventory, dimension, or executed-evidence gap.
`run-real-e2e.ts` passes `--require-complete` on a bare host run, the only run
that executes every scenario its host declares; a `--grep`, file, shard, or
matrix-mode run gates its own selection.
Global path and door totals are diagnostics; they do not claim every path
applies to every action. Per-action applicability stays explicit in scenario
tokens.

Browser-only features such as Wiki notes, drafts, and appearance declare
`capabilities: []`: they still use real browser storage and verified bootstrap,
and must run on every declared applicable host. Do not invent a local-only
service dependency to exclude them from production.

A default-off release flag is not such an invention. Wiki is gated by
`VITE_SMITHERS_WIKI`, read at build time, and the deployed canary ships it off:
`/wiki.*` and `/world.*` are absent from the registry there and the app answers
"There is no /wiki.new-note flow." The Wiki scenarios therefore declare
`host:local` only, and `playwright.real.config.ts` turns the flag on for the
local host's own build so that coverage stays real. Restore `host:production`
when the deployed build ships Wiki on, not before.

Use `openApp(page)` from `support` instead of navigating to `/`: the deployed
root is the marketing site. `SMITHERS_REAL_APP_PATH` selects a same-origin app
repository path; its production default is
`/codeplanesmithers/canary-sandbox`.

## Six-mode release matrix

`scripts/run-mode-matrix.ts` applies one obligation catalog to
`web-selfhost`, `web-plue`, `local-own`, `local-plue`, `native-own`, and
`native-plue`. It selects scenarios by their stable `real-scenario` tag, not
their old host tag, so a mode cannot get a smaller copied suite. `audit`
records readiness only; `run` also runs the deterministic nonblocking/toast
specs and every currently implemented real scenario in the catalog.
Each mode's readiness requests, bodies included, share one 30 s deadline
(`--readiness-timeout-ms` overrides it); an expired probe fails that mode and
the matrix continues to the next.

Pass `--config <path>` or set `SMITHERS_MODE_MATRIX_CONFIG`. The JSON file has
one exact source revision and an array of mode records:

```json
{
  "revision": "0123456789012345678901234567890123456789",
  "modes": [{
    "mode": "native-own",
    "origin": "http://127.0.0.1:47321",
    "endpoint": "http://127.0.0.1:47321",
    "auth": { "kind": "owner-session", "environment": "SMITHERS_OWNER_SESSION" },
    "executionReceipt": "/absolute/path/to/native-own.json"
  }]
}
```

The auth field names an environment variable; its value is never copied into
the report. `browser-profile` is wired to the current real fixture;
`owner-session` remains explicitly unavailable until issue 05 supplies its
real injection seam. The launcher receipt binds mode, origin, backend endpoint, revision, readiness, and
started process roles. Own modes must prove fresh launch and data-preserving
restart. `native-own` must prove its supervisor, app, and PostgreSQL;
Plue-backed local/native modes fail if they started any of those processes.

Readiness reads `/api/bootstrap` for every mode and records its `buildSha`.
A mode owes each scenario whose capabilities are all core features of its
provider in the feature matrix below, so a Plue mode never owes `model.turn`.
The report has one row per owed scenario, and every obligation is owed by at
least one mode.

A scenario both providers owe declares `host:local` and `host:production`,
so self-hosted and Plue builds run the same assertions. Beyond the core loop,
the catalog owes approve and deny, duplicate-input replay, and a surfaced
flow error in every mode. Owed scenarios use `authenticatedTest`: a
signed-out scenario cannot run under a mode's application token.

Each invocation creates an execution UUID and a directory beside its report:
`<report-name>.evidence/<executionID>/`. It retains the exact launcher and raw
child receipt bytes, SHA-256 references, isolated Playwright/native artifacts,
and its own immutable `report.json`. Failed raw receipts are retained too.
The requested report path points at the same evidence directory; repeating a
run does not replace an earlier run's artifacts.

`coverage/evidence.ts` is the shared verifier. `readEvidenceReference` checks
safe relative paths and hashes; `validateRawMatrixEvidence` requires the exact
invocation UUID, mode, origin, selected endpoint, source, deployment, time
window and one successful raw receipt per owed scenario. Reporter errors fail
validation. Raw execution metadata also records the actual renderer origin
and native CDP/window target when applicable. Summary rows cannot substitute
for this evidence. The `origin` is the launcher's readiness origin; `endpoint`
is the selected backend (different from the local renderer for `local-plue`).

| Provider | Also requires | Build check |
| --- | --- | --- |
| selfhost | `/api/health` ok | `buildSha` equals the checkout revision |
| Plue (the Worker origin, e.g. `https://smithers.sh`) | `authFlow` is not `none` | `buildSha` is exact; the `web-plue` receipt names it |

The `web-plue` launcher runs nothing from the checkout: it observes the
Worker's bootstrap and app document. Scenario runs receive the certified
`buildSha`, and a Plue attempt against any other build fails its obligation.

The default run selects all six modes. Missing Plue configuration appears as
`not-configured` and fails the gate. For a developer run, `--modes own-only`
selects the three owned modes; an explicit comma-separated list can select
other subsets. A passing subset report has `scope: "partial"`, lists its modes,
and has `sixModeAccepted: false`. Only a passing full selection sets
`sixModeAccepted: true`.

Rows are `passed`, `failed`, `unavailable`, or `not-configured`; there is no
skip state. A scenario row is `failed` when the mode's launch or readiness
failed, an attempt failed, or the Plue build moved. A feature row is `failed`
when the bootstrap omits that core feature.
`unavailable` means no executed receipt. Every status but `passed` fails the
gate. Deterministic, local-infrastructure, live-provider, and Plue-production
tiers remain separate rows.

The shared `scenario()` details also derive `@real-host:*` Playwright tags.
The real config selects the current host before fixtures execute, so a
production-only case is not a local preflight failure or a skipped test.
Use `run-real-e2e.ts` for targeted `--grep` runs: it combines the requested
name expression with the host filter instead of overriding it. Omitted
applicable scenarios still appear as execution gaps; aggregate review still
requires all declared hosts. Test discovery (`--list`) is not execution proof.

### Feature matrix

Feature matrix version 2. `FEATURE_MATRIX` in `matrix.ts` classifies every
runtime capability for each provider:

- `core`: every mode of the provider must advertise it. The report has one
  feature row per core feature; a disabled one fails the gate.
- `optional`: served only when the operator configures it. Not owed.
- `absent`: the provider does not serve it. Not owed.

Every core feature is exercised by a scenario its modes owe, so a stub cannot
stand in for it. Each report publishes `featureMatrix` with the version and a
SHA-256 digest of the table. Change a row only with a version bump.

| Capability | selfhost | Plue |
| --- | --- | --- |
| `agent` | optional | optional |
| `model.turn` | core | optional |
| `recommend` | optional | optional |
| `commands.select` | optional | optional |
| `browser.read` | optional | optional |
| `identity` | core | core |
| `github` | optional | core |
| `cloud` | core | core |
| `billing.balance` | optional | optional |
| `billing.overview` | optional | optional |
| `billing.plans` | optional | optional |
| `billing.checkout` | optional | optional |
| `billing.portal` | optional | optional |
| `cloud.terminal` | core | core |
| `cloud.pat` | optional | absent |
| `native.shell` | absent | absent |

Plue owes `github` because its hosted backend serves GitHub sign-in and
import. A self-hosted operator enables it with a GitHub OAuth app.

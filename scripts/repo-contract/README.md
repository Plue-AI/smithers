# Repo-contract gates

## Resolved CI and runtime policy

`node scripts/ci-inventory.mjs <output.json>` plans the actual commands in the
generated CI workflow, with no target execution. The required
`ci-inventory.test.mjs` gate checks those roots against the package/app/script/
eval/fault requirements and retains a machine-readable row for each selected
target and platform: runner argv, input declarations, config, CI job/step,
trigger, installed runtime versions, required/advisory status and cache policy.
The `ci //packages/...` and `test //packages/...` selections must agree on every
package test root. A `unitTests` target cannot sit in an E2E step. `browserE2e`
must invoke the real Playwright entrypoint; every `faults` root must invoke its
actual serial Vitest fault config. The former `browserContract` is now named
`webBundleContract`, with a compilation-only displayed job name. The historical
job id `browser` is pinned by the release roster test; it does not claim E2E
execution. Every selected browser/E2E/faults suite name must map to its real
Playwright or serial fault runner.

Linux on Node 26.4.0 is the required release-candidate package platform.
macOS and Windows package rows are advisory, so the generated root README
explicitly makes no support guarantee for them. The required web UI scope is
offline Chromium. Node 26.10.0 is the additional local gateway baseline,
not a claim that every package was re-certified here on every newer Node.

### Bun coverage exceptions

The owning app `PACKAGE.ts` files declare `Coverage policy: assertion-only`.
Their Bun suites remain required. None claims a numeric source coverage floor:
Bun's loaded-module measurements do not by themselves establish a complete
production denominator across Worker, CLI, React and static assets.

| Owner | Required behavior | Missing coverage evidence |
| --- | --- | --- |
| `apps/server` | Worker unit and canary-wiring assertions | Whole Worker/script source denominator and failure-branch measurement. |
| `apps/app` | Typecheck, Bun units, offline Playwright | TSX/host/React denominator and live provider acceptance. |
| `flows/review` | Strict source/test typechecks, host registry integration and seeded review contracts | Live model review quality remains separate from deterministic coverage. |
| `apps/tui` | Bun unit and terminal assertions | Explicit source roster is measured by the Istanbul collector; no numeric floor until TUI child-launch paths and complete behavior coverage are qualified. |
| `apps/bug-worker` | Real fetch handler against in-memory KV | Complete Worker branch measurement, including transport failures. |

These are explicit transitional exceptions owned by the corresponding app, not
zero-percent thresholds or completed coverage work. A future numeric gate must
first measure all production sources, add missing behavior tests and establish
a baseline. Existing package floors and ignore rationales remain in
`coverage-conformance.md` and the flows coverage-isolation suite. The lower
build-cli, std, migrate and CLI branch floors remain behavioral test debt owned
by those packages; this lane changes none of their thresholds or exclusions.

### Failure propagation and cache identity

`runner-contract.test.mjs` creates disposable workspaces and uses the real CLI:
the Bun server assertion, a browser DOM assertion through the actual PR
Playwright wrapper, and a Vitest coverage threshold all fail the target.
The coverage sentinel first passes its assertion, so an assertion failure
cannot accidentally stand in for a coverage failure.

The current general NodeTest and Vitest runners are uncacheable. The inventory
ratchets that policy until their ambient helpers, fixtures, configs, dependency
implementations, actual runtime and seeds have a complete identity. A separate
cacheable Shell.Test fixture proves a genuine warmed result-cache hit, then
independent helper, fixture, config and declared seed changes must each fail
instead of returning the previous pass. Scheduled campaigns run directly and
never consult build-result caches. This establishes the current safe policy;
it does not claim complete cacheability for all workspace rules.

Workflow drift uses `pnpm exec smthrs lint '//:ci'`. Regeneration uses
`node scripts/generate-ci.mjs`, which calls `GithubCiGen.render` in its declared
`write` mode and the generated-file writer. This legacy rule keeps its explicit
`mode: "check"` even when the CLI receives `target --write`; that command was
verified to check drift without applying it. The YAML is never edited by hand.

The claims this repository makes about itself, checked. Each file here is a
`node:test` suite that reads the real tree rather than a fixture, because the
defects they exist for are the ones a fixture cannot have: a package that is
installed and never tested, a barrel that typechecks and throws at load, a
fault case that has quietly not run since somebody focused a test in it.

Two records sit beside the suites rather than inside them.
[`fault-gaps.md`](./fault-gaps.md) is what the fault matrix does not cover and
what closing each entry would cost; [`fault-flake-log.md`](./fault-flake-log.md)
is the hand-kept flake history. Both used to live in the standalone `e2e/`
workspace member. The cases moved into the packages they test, and these two are
the part of that directory that belongs to no single package: they are read
across all of them.

Run them all:

```sh
node --test "scripts/repo-contract/*.test.mjs"
```

Or by label, which is what CI does:

```sh
pnpm exec smithers-build test '//scripts/repo-contract/...'
```

| Suite | What it guards |
| --- | --- |
| `package-contract.test.mjs` | One version across the release line, a declared publishable surface, the `next` dist-tag, the scripts every gate invokes, and no published dependency on a private package. |
| `barrels.test.mjs` | `@smthrs/flows` re-exports exactly the namespaces it lists, declares every package it re-exports, and every published root export points at a file that exists. |
| `public-export-maps.test.mjs` | Explicit development/publication allowlists retain reviewed entrypoints, deny internal migrations and future files, and resolve equivalently through Node's ESM and CommonJS resolvers. |
| `test-script-wiring.test.mjs` | Every workspace member with tests has a `test` script, and the pnpm workspace and the root manifest name the same members. |
| `ui-ci-tier.test.mjs` | The required PR workflow selects the apps/app typecheck, units and Playwright once each in their own Ubuntu job; the Playwright wrapper propagates failure; the real scheduler skips TypeScript when strict devkit preparation fails. |
| `reliability-workflow.test.mjs` | The scheduled `signal-state-machine` job in `reliability.yml` records its seed, preserves histories and results on failure, verifies the evidence and proves mutation sensitivity. |
| `ci-inventory.test.mjs` | The planned CI commands cover every package, app, script, eval and fault root, with a retained row per selected target and platform. |
| `cli-verbs.test.mjs` | The CLI reference indexes every canonical command, retains the compatibility pages, and documents only flags the public parser accepts. |
| `smithers-links.test.mjs` | Every smithers.sh URL a package ships reaches the built documentation, directly or through one production redirect. |
| `fault-skips.test.mjs` | No focused, parked, or inverted test in any package's `test/faults` tree, every conditional skip declared with its reason, every required gate still in the matrix — including the ones that are red — and every package carrying fault cases wired to a `faults` target, a serial fault config, and the CI step that runs them. |
| `machine-paths.test.mjs` | No tracked file under `evals/`, `scripts/`, or a package's `test/faults` tree names one machine's home directory (`/Users/<name>`, `/home/<name>`, the superuser's `root` home, or `C:\Users\<name>`). Recorded material — wave reports, archives, the authoring corpus — is exempt, because rewriting it would falsify a record. |

## Retired-suite coverage

These gates preserve the requirements that remain relevant from the retired
test suite. The table records where each surviving behavior is checked and why
obsolete checks were removed.

| Retired suite | Outcome |
| --- | --- |
| `package-and-build-contract`, `package-and-build-process-contract` | Ported into `package-contract.test.mjs`. The half that asserted a `tsup` entry-point layout, a `dist/` shape, and a bin shim went with the build system; the manifest claims survived. |
| `barrels`, `umbrella-agent-exports` | Ported into `barrels.test.mjs`. The 0.x umbrella is now a migration notice that throws, so "re-exports the agent surface" became "refuses to run". |
| `test-script-wiring-gate` | Ported into `test-script-wiring.test.mjs`. The 0.x version drove `scripts/check-smithers-test-script.mjs` against synthetic workspaces; the script is gone, so the claim is checked against the real tree. |
| `fault-skip-audit-gate`, `fault-only-todo-audit` | Ported into `fault-skips.test.mjs`. The 0.x ratchet pinned a per-file skip *count*; this one requires a declared reason instead, which is the thing a reviewer can act on. It also refuses `.fails`, which the 0.x gate had no rule about, and it pins the required gates by title. The two rules are one rule: when the product does not meet a requirement the matrix covers, the sanctioned form is a plain test that fails, kept in the matrix with its owner cited and reported as a failure in the gate line. `.fails` turns that test into a pass and deletion turns it into prose; `requiredRedGates` refuses the deletion and the `.fails` rule refuses the marking. `fault-gaps.md` beside it records the shipped limitation next to the red gate, not instead of it. |
| `effect-version-gate` | Dropped. It unit-tested `scripts/check-single-effect-version.mjs` against synthetic lockfiles. That script survived the migration and is executed against the real tree as `//scripts:effectVersion`, which is a stronger check than a fixture. |
| `version-bump-propagation` | Dropped. It tested `scripts/bump.mjs`, which is gone; version propagation is now `scripts/set-release-version.mjs` and has its own suite at `//scripts:releaseVersion`. |
| `release-tag-guard` | Dropped. `scripts/release-tag-guard.mjs` has no successor: the RC release flow is `release.yml`, whose dry-run and tag-push paths are covered by `//scripts:releaseRehearsal`. |
| `coverage-script-gate` | Dropped. It tested `scripts/coverage.mjs` and the Bun LCOV merge, neither of which exists. Coverage is vitest's, and the gate that keeps its denominator honest is `scripts/test/coverage.test.ts`. |
| `workspace-test-sharding` | Dropped. `scripts/run-workspace-tests.mjs` and the Windows shard runner are gone; the Windows lane runs `//packages/...` directly. |
| `bin-smithers-delegation`, `bin-dangling-workspace-link-hint`, `dangling-many-links` | The dangling-workspace-link diagnosis is `packages/smithers/bin/dangling-workspace-links.mjs`, driven by `packages/smithers/test/DanglingWorkspaceLinks.test.ts`, and the executable resolution order is pinned by `packages/smithers/test/Bin.test.ts`. Delegation to a locally installed CLI has no successor because `@smthrs/cli` runs `dist/esm/bin.js` or `src/bin.ts` in its own package and delegates to nothing. |

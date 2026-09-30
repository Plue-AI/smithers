# Contributing

Track actionable work in a GitHub issue and run the coding factory and CI/CD
on Smithers Cloud. The stack service alone writes the repository's linear
`mythical` stack. This repository sends work upstream through a GitHub PR the
owner merges, with one commit per item on append-only `main`. Never rewrite
`main` or push `mythical` by hand. Local work is bootstrap or repair; see
[the factory workflow](factory/README.md) and [Cloud development](docs/cloud-workspace.md).

Use the Node release in `.node-version` at the root. It is the one release CI
installs and the Cloud runner bootstraps, and fnm, nvm and asdf read that file,
so `fnm use` or `nvm use` in the checkout gives you the same Node the gates run.
Published packages support a wider range (`engines.node`, Node 26.4.0 or
later); that floor is what consumers may run, not what this workspace develops
on. Install the pinned package manager (`pnpm@11.25.0`), then
dependencies with `pnpm install`.

Before opening a pull request, run every gate:

```sh
pnpm run check
pnpm test
pnpm run lint
pnpm run circular
pnpm run browser
pnpm run test:examples
pnpm --filter @smithers/site run check:docs
pnpm docs:check
```

`pnpm test` is the one that catches the most, and it stops at the first
failing package — so a green partial run proves less than it looks like it
does. `pnpm --recursive --if-present --no-bail run test` reports every
package instead of the first casualty.

## Updating documentation

Edit main-site pages in `apps/site/src/content/docs/docs/`. Package sites
are generated from each package's `docs/` directory; edit those sources,
then run `pnpm docs:sync`. See [package docs authoring](apps/docs/shared/AUTHORING.md).

After changing CLI declarations, package API docs, or examples, run
`pnpm --filter @smithers/site run sync:docs` to refresh command help,
reference pages, examples, and the LLM bundles. For README and overview
copy, edit `apps/site/src/data/project.json` and run
`node apps/site/scripts/generate-project-copy.mjs` before syncing.

Before review, run the docs checks above, `pnpm --filter @smithers/site run build`,
and `pnpm docs:build`. Preview the main docs locally with
`pnpm --filter @smithers/site run dev` and open `/docs/`. Commit generated
content with its source changes.

TUI user docs live on the main site: the TUI tabs of `docs/learn/` and the
TUI reference in `docs/tui/`. The scripts behind their GIFs live in
`apps/tui/docs/recordings/`; `apps/tui-docs` records them, generates the
command and key pages, and serves the browser playground. See
[TUI playground and recordings](apps/tui-docs/README.md). Regeneration does not
publish the app's repository Wiki; [the wiki recipe](factory/wiki/README.md)
tracks its distinct generation, review, and Cloud publication receipts.

Cloud's gates use `.github/ci-known-red.json` with `--known-red` where declared
in `scripts/ci/cloud.sh`. A successful gate with that option means no new
unlisted failures, not that every target passed. Keep listed failures tied to
their issues and inspect the reported results. See the
[build CLI policy](packages/smithers/build/build-cli/docs/cli.md).

## Changing a root file

Some files at the repository root are generated from `PACKAGE.ts` and then
pinned by suites that deliberately re-declare rather than import them.
Importing `PACKAGE.ts` would be circular, since it imports the very packages
doing the pinning. `pnpm-workspace.yaml` is the exception: pnpm owns and may
update it, so it is hand-written and authoritative. The build graph parses its
`packages` list and keys lockfile resolution and installation on the file plus
the root and selected member manifests.

The cost is that one edit lands in several places. If you change:

| What                                          | Also update                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml` package membership      | `packages/smithers/flows/test/vitestCoverageIsolation.test.ts` (the coverage-universe policy pin); lockfile inputs are derived automatically. Nesting a package inside another has its own recipe below                                                    |
| root `package.json` scripts                   | `packages/smithers/flows/test/vitestCoverageIsolation.test.ts` (the aggregator roster)                                                                                                          |
| root `PACKAGE.ts` CI jobs, steps, or triggers | the generated `.github/workflows/ci.yml` (`pnpm exec smithers-build build '//:ci'` with `mode: "write"`), `packages/smithers/flows/test/vitestCoverageIsolation.test.ts` (source-text pins), and the hand-written `.github/workflows/release.yml`, which copies the required `test` job's toolchain and gate steps verbatim |
| `.github/workflows/release.yml`               | the same suite, plus `scripts/release-rehearsal.test.mjs` and `scripts/pack-release.test.mjs`, which compares the release workflow's steps against the generated `ci.yml`               |
| any `PACKAGE.ts` target set — adding, renaming or removing a target, or changing its declared inputs or outputs (a new test file reached by a glob counts) | `.smithers/target-index.json`, with `pnpm run target-index`. Nothing about it is hand-written: the script writes it and `smthrs lint '//:targetIndex'` drift-checks it. See “The target index” |
| the product API (`docs/api/openapi.yaml`)     | the per-tag source under `docs/api/openapi/` instead: `<tag>.yaml` holds that tag's paths and `_root.yaml` everything else. `pnpm exec smithers-build run '//:openapiBundle'` writes the bundle and `lint '//:openapiBundle'` drift-checks it; then `run '//:openapiClients'` regenerates the Go (`packages/backend/apiclient`) and TypeScript (`packages/smithers/src/internal/backend/ProductApi.ts`) clients from it and `lint '//:openapiClients'` drift-checks them |
| `CHANGELOG.md` release sections               | nothing by hand inside a `<!-- commits:… -->` block — `pnpm exec smithers-build run '//:changelog'` writes it and `lint '//:changelog'` drift-checks it. See “Cutting a release”         |

Miss one and CI reports a generated file as a hand edit, which is exactly
what it should do — it cannot tell your deliberate change from a stray one.

### The target index

`.smithers/target-index.json` carries one row per labeled target, and the
planner fills those rows from every loaded `PACKAGE.ts`. So the file is keyed
on the whole declaration set, not on the package you edited: adding a target,
renaming one, or widening a glob so it reaches a new test file all re-key it,
and none of them looks like touching a generated file.

Regenerate it with one word and commit the result:

```bash
pnpm run target-index
```

That is `smthrs target '//:targetIndex' --write`. `smthrs lint '//:targetIndex'`
is the check half, and it is what CI runs.

Running the gate by hand does the repair for you:
`bash scripts/ci/cloud.sh target-index` regenerates and then verifies when it
is not on Cloud and not under an inherited `CI`, so the file is already in your
working tree by the time the gate is green. On Cloud the same gate only checks,
because repairing there would hide the stale commit it exists to catch — which
is what happened to run 11763 (main `2722d0e5`), whose `checks` task failed on
`//:targetIndex` and nothing else, for the third time that day.

## Root graph rationale

The root `PACKAGE.ts` intentionally contains declarations only, with its
explanatory prose kept here. Nothing in that file is a command. Jobs declare
the toolchain a runner provides and the targets they invoke; `GithubCiGen`
derives checkout, installation, tool setup, and every
`pnpm exec smithers-build <verb> <pattern>` argv. A gate must therefore become a target
in the package that owns it before CI can invoke it, matching Bazel's rule that
a BUILD file has no free-form command surface.

The generated `tsconfig.json` is the root TypeScript project. The lockfile and
install are separate targets because a target cannot be keyed on a file it
also produces: `Lockfile` writes `pnpm-lock.yaml`, while `Install` consumes the
lockfile target. The hand-written `pnpm-workspace.yaml` is a planner input. Its
contents select the workspace manifests, and all of those files key both
targets, so a membership or dependency edit forces resolution before linking
`node_modules`. `PackageDefaults` applies `BuildAndCheckTypeScriptPackage` from the private `@smthrs/repo-targets` package to each
directory under `packages/`, at any of the three nesting depths, that has a
`package.json` and no BUILD file, synthesizing
the conventional `lib`, `check`, `test`, `lint`, `fmt`, and `docs` targets;
packages with a different layout carry their own BUILD file.

The CI declaration has several deliberate operational constraints:

- The `test` job aggregates build, test, lint, docs, format, and circular
  targets in one graph plan. It uses `parallelism: 2` because the heavy Vitest
  suites have finite 30-second per-test budgets that excessive concurrency on
  a four-core runner can starve.
- `actionlint` checks every workflow named by the declaration so GitHub-only
  expression-context failures surface in review, not in a scheduled run.
  `apps/server/scripts/canary/workflow-wiring.test.ts` ensures no workflow is
  omitted. The script targets include the browser contract and release
  pack-and-smoke chain; the agent eval suite and typecheck are offline and
  baseline-gated. CI also lint-checks its own generated workflow so the file
  describing the pipeline is not exempt from drift enforcement.
- The `apps-e2e` lane is separate because it boots Wrangler and a real Chrome;
  nothing under `apps/` needs jj. The Ubuntu runner's Chrome path is asserted
  because `BrowserLaunch.ts` probes that fixed candidate list. Screenshots in
  `/tmp` and launch-checklist reports under `apps/reports` are collected under
  one artifact root.
- Issue #163 requires jj on `PATH` for the real-binary suites so a missing
  binary fails loudly instead of skipping. GitHub checkout creates a Git
  repository, not a jj repository, so CI initializes colocated metadata before
  those contracts run.
- `rust-toolchain.toml` is the shared pin for the Rust jobs. The WebAssembly
  lane rebuilds `packages/smithers/flows/jj/wasm/flows_jj.wasm` without a build cache and
  requires byte-for-byte equality with the committed artifact. Its Linux host
  triple is part of that reproducibility contract; `build-wasm.mjs` refuses a
  different host explicitly rather than producing a misleading byte diff.
- The fault-injection matrix is the packages that declare a `faults` target
  with `Smithers.FaultSuite`, and the required `e2e-faults` job is
  `test '//packages/...:faults' --jobs 1` over all of them. A case injects a
  real fault into a real process and reads the result out of durable state: it
  may not stub the engine, the journal, the control plane, or a provider,
  because a suite that passes against a stub proves nothing about the product
  and this tier exists precisely to catch what unit suites cannot. Crash cases
  `SIGKILL` a real operating-system process and resume in a fresh one against a
  SQLite file on disk; the served cases spawn `smthrs serve` — the bin
  `@smthrs/cli` declares — and cross a real socket; the time-travel cases drive
  a real Jujutsu workspace. Cross-process cases speak one protocol on stdout and
  nothing else: `SMITHERS_ENGINE_HANDSHAKE=<phase>:<nonce>` before any work
  (`probe` and `execute` are distinct so an admission probe can never be
  replayed as evidence that a flow ran), then `PROBE_STATUS=ok` or
  `RESULT_STATUS=<status>`. Everything else a case observes is a file, because a
  `SIGKILL`ed process cannot rewrite one. Cases live beside the package they
  assert about, in `packages/<package>/test/faults/`, run serially from that
  package's `vitest.faults.config.ts`, and are excluded from its ordinary
  `test` target: they kill process groups and bind ports, which no unit suite
  sharing the machine survives. `jj` is required on `PATH` for the two cases
  that drive a real workspace, which is why the job's toolchain installs it, and
  they throw rather than skip when `CI` is set. What the matrix does not cover
  is `scripts/repo-contract/fault-gaps.md`, and
  `scripts/repo-contract/fault-skips.test.mjs` refuses a focused, parked, or
  inverted case and an undeclared skip.
- Bun covers only the compatibility matrix: the packages that declare a
  `bunTest` target with `Smithers.BunSuite`. Those targets are `test`-kind
  targets inside their own package, so the required `test` job
  (`ci '//packages/...'`) and the `packages` OS matrix
  (`test '//packages/...'`) already plan them and both jobs install Bun; there
  is no separate Bun job. `packages/smithers/build/targets/src/BunSuite.ts` records which
  packages must not declare it and why. The browser lane remains a standalone
  contract until a real browser-runner suite exists. macOS and Windows package
  suites are advisory until they establish a stable green history; known
  Windows path failures are not chased in that lane.

The package policy in `pnpm-workspace.yaml` is equally deliberate.
`verifyDepsBeforeRun` stays disabled because installation is an explicit graph
step, and a gate must not reinstall what it is measuring with different script
settings. Playwright lifecycle builds stay denied: the live browser checks use
a system or previously installed browser, so dependency installation must not
download one.

Packages under `packages/` follow the structure and conventions in the Effect repository. Use the Effect repository (github.com/Effect-TS/effect) as the reference when adding or changing package modules, public APIs, tests, build configuration, or package metadata.

## A PACKAGE.ts file declares targets, never commands

`PACKAGE.ts` says what the workspace has. It never says how to run it. A raw argv
in a BUILD file — a `run:` string, a bare executable name, a shell fragment — is
a gate the build system does not know about: unplanned, unkeyed, uncached, not
addressable by label, and not runnable locally by the name CI uses. It also pins
the interpreter and the package manager at the call site, so the workspace can no
longer switch either by editing one declaration.

Argv rendering belongs in target implementations. `PackageManager.install()`
renders `pnpm install --frozen-lockfile --ignore-scripts`; `Runtime.test()`
renders `node --test`; `RustToolchain.install()` renders
`rustup toolchain install`. A declaration passes the toolchain in and the
implementation asks it for the argv.

Every CI gate is therefore a target, in the package that owns it:
`scripts/PACKAGE.ts` for the operator and release scripts, `crates/*/PACKAGE.ts` for
the cargo gates, `apps/*/PACKAGE.ts` for an app's end-to-end suites, and
a package's own `PACKAGE.ts` for everything it claims about itself, including its
Bun re-run. No file declares another package's targets.
`.github/workflows/ci.yml` is
generated from those declarations: a job names what it requires and which targets
it runs, and `GithubCiGen` derives every step. Its attrs schema has no field that
would hold a command, so reintroducing one is a compile error rather than a
review conversation.

Bazel is the prior art: a `BUILD` file has no way to write a command at all,
every check is a test target, and CI is one verb over the graph. If a gate does
not fit an existing target type, add a target type; `ToolBuild` is the
deliberate escape hatch and using it is something to justify in review. The full
rule, with examples, is in
[`packages/smithers/build/docs/workspace/writing-build-files.md`](packages/smithers/build/docs/workspace/writing-build-files.md).

## How `packages/` is shaped

Packages come at three grains, and the directory tree says which is which. A
granular package sits inside the product package it is part of, and a product
package sits inside `packages/smithers`, the CLI everything ships behind:

```
packages/
  smithers/                 @smthrs/cli — the `smthrs` executable (alias `smithers`)
    control/ gateway/ mcp/ notifications/ migrate/ create-app/
    flows/                  @smthrs/flows — the engine, and what it is made of
      flow/ engine/ engine-store/ journal/ run-store/ step-cache/ plan/
      artifacts/ database/ canonical/ crypto/ keys/ capability/ kernel/
      sync/ time-travel/ core/ patterns/ jj/ sandbox/ observability/
      platform-node/ platform-bun/ platform-browser/
    agent/                  @smthrs/agent — the agent loop and its parts
      harness/ model/ memory/ registry/ plugin/ std/ fs/ chain/ scorers/
      evals/ triggers/ integrations/
    build/                  the build graph
      build-cli/ targets/ infra/
    ui/                     the UI kit
      ui-styleguide/
  testing/ errors/ smthrs-deprecation/ rpc/
```

Nesting is directories and nothing else. Every npm name, version, dist-tag,
and the published set are what they were when the tree was flat; the roster is
the 51 names `publishedPackages` restates in `scripts/pack-release.mjs`, and
only target labels move, from `//packages/canonical:test` to
`//packages/smithers/flows/canonical:test`.

The build graph already understands this. Discovery walks the whole tree, and
a declared glob is package-scoped: the walk never descends into a directory
holding a `PACKAGE.ts`, so a parent's `src/**` cannot reach a child's sources
and the child's targets own them. A child's directory must be a sibling of the
parent's `src`, never inside it.

Nothing enumerates packages by hand. Every gate and release script reads
membership through `scripts/workspace-packages.mjs`, which expands the
`pnpm-workspace.yaml` globs and returns `{ dir, name, manifestPath, manifest }`
for each member; `libraryPackages()` narrows that to the members under
`packages/`. Publication order tiebreaks on a directory's last segment, so a
move never reorders a release.

### Nesting another package

To move `packages/<child>` under `packages/<parent>`:

1. `git mv packages/<child> packages/<parent>/<child>` — the move must keep
   history, because a package's log is the reason its code looks the way it
   does.
2. In the moved `PACKAGE.ts`, set every `cwd` to the new path, and re-anchor
   any `../../PACKAGE.ts` import of the root declaration to the new depth.
   Sibling imports (`../plan/PACKAGE.ts`) survive a move that keeps the
   siblings together.
3. In the moved `package.json`, set `repository.directory` to the new path.
4. In the moved `eslint.config.js`, deepen the `../../eslint.*.js` imports to
   the new depth. Do the same for every other reference that leaves the
   package: a `new URL("../../../", import.meta.url)` naming the repository
   root, a `resolve(packageRoot, "../..")`, a `docs/` link in a README.
5. If `<parent>` is not already a parent, add `"packages/<parent>/*"` to the
   `packages:` list in `pnpm-workspace.yaml` and the identical entry to
   `workspaces` in the root `package.json`, in the same position in both.
   Membership is one wildcard under a named parent, never `packages/**` or
   `packages/*/*`: a built package writes a generated `dist/cjs/package.json`
   two levels down, and a two-wildcard pattern would enrol build output as a
   workspace member. `pnpm-workspace.yaml` records that reasoning above the
   list, and `scripts/repo-contract/test-script-wiring.test.mjs` checks the two
   lists agree.
6. Update the coverage-universe pin in
   `packages/smithers/flows/test/vitestCoverageIsolation.test.ts`, as any
   membership change does.
7. In the PARENT's `vitest.config.ts`, add `"<child>/**"` to `coverage.exclude`.
   The v8 provider reports every file executed under the vitest root whatever
   `include` says, so the child's modules would otherwise be measured against
   the parent's 100% gate as well as their own. This is the one exclusion the
   coverage conformance suite allows, and it allows it only for a pattern that
   resolves to a real package other than the one declaring it.
8. In the PARENT's `dprint.json`, add `"<child>"` to `excludes`. The child
   formats under its own config, and two configs rewriting one file is a loop.
9. Refresh both lockfiles: `pnpm install --offline`, then
   `bun install --lockfile-only`, then `pnpm install --offline`. Use
   `--lockfile-only`: a full `bun install` rewrites `node_modules` into Bun's
   layout, and the pnpm install after it reports "Already up to date" instead
   of restoring it.
10. Run `pnpm exec smithers-build ci '//packages/<parent>/...'`, which covers
    both packages, `pnpm exec smithers-build test '//scripts/...'`, and
    `pnpm exec dprint fmt` in every package whose docs quote a path that moved
    — a markdown table's padding is part of its formatting.

## Landing changes

Prepare one logical change with its issue, reviewed diff, and validation receipts.
The stack service owns its `mythical` item and upstream PR; the owner merges that
PR onto append-only `main`. Preserve unrelated edits in a shared checkout.

The legacy `pnpm commit` / `//:commit` helper still snapshots every nonignored
edit and can push directly to `main`. It does not implement the current stack
policy and is not the landing path for this repository.

Deployment is a separate Cloud operation against the landed revision. Retain
the deployment receipt and compare `/__build.json` with that revision before
claiming production is current. Follow the scoped app/server instructions for
bootstrap or repair operations.

## Working with the pinned jj fork

The Rust crates under `crates/` build against `jj-lib` from the pinned jj fork, which `crates/flows-jj/Cargo.toml` declares as a git dependency; cargo fetches it, so a plain `git clone` needs no extra step.

## Cutting a release

A release is one commit and one tag. The commit carries the version bump and
the changelog section; the tag is what publishes. Pushing a `v*` tag starts
`.github/workflows/release.yml`, which validates the tag, runs every gate,
packs the publish set declared by `scripts/pack-release.mjs`, smoke-tests the tarballs, and publishes to npm.
npm versions are immutable, so everything that can be proved before the push
is proved before the push.

"Every gate" is literal: the release workflow installs the toolchain the
required CI `test` job installs — ripgrep, bubblewrap, Go, Foundry, the
containerd image store — and then runs that job's `smithers-build` steps plus
the fault matrix, copied verbatim out of the generated `ci.yml`. It is
hand-written, so `scripts/pack-release.test.mjs` compares the two files and
fails when the copy goes stale. Bumping a toolchain pin in the root
`PACKAGE.ts` therefore means regenerating `ci.yml` and copying the changed
step into `release.yml` in the same commit.

The order is bump → changelog → commit → tag → push the tag → `release.yml`
publishes.

### 1. Rehearse

Dispatch the workflow at the version you are about to cut, with the dry run
left on. It runs every gate, packs, and smoke-tests, and publishes nothing:

```sh
gh workflow run release.yml -f releaseTag=v<version> -f dryRun=true
```

`node scripts/release-rehearsal.mjs --tag v<version>` runs the same workflow's
`run:` bodies locally, against the tree you have. The workflow pins the
supported floor, Node 26.4.0, for the gates and the smoke test, and each
`setup-node` step switches PATH to the toolchain pinned for its version, so
pass a bin directory for it:

```sh
node scripts/release-rehearsal.mjs --tag v<version> \
  --node 26.4.0=/path/to/node-26.4.0/bin
```

A version with no `--node` pin keeps the toolchain already on PATH, and the
step's own `node --version` assertion fails when that toolchain is the wrong
line. `--only` and `--skip` select steps by name; `--skip Pack --skip Build`
is the fast pass over the validation half.

### 2. Cut

```sh
node scripts/cut-release.mjs <version>
```

That sets every workspace manifest, every internal `@smthrs/*` range, and the
three sources that repeat the version as a literal
(`scripts/set-release-version.mjs`), writes the commit section into
`CHANGELOG.md` (`scripts/generate-changelog.mjs`), and then verifies both with
the same `--check` invocations `release.yml` runs. It prints the two commands
to run next and touches git not at all.

Land the prepared version and changelog through the stack's upstream PR. The
script's legacy `--commit` option commits and tags locally; it does not follow
that landing policy. Neither form pushes.

### 3. Publish the landed revision

After the owner merges the release item, the release operator tags that exact
landed commit and pushes only the tag:

```sh
git tag v<version> <landed-commit>
git push origin v<version>
```

Retain the successful release run and npm publication evidence. A pushed tag
alone does not prove publication completed.

### What the changelog generator owns

`CHANGELOG.md` is the complete, commit-level changelog. A section has two
halves, and only one of them is generated:

```md
## 1.0.0 (2026-09-03)

The narrative — written by a person, never touched by the generator.

<!-- commits:1.0.0 -->

1230 commits since [v0.35.0](…).

### 🐛 Bug fixes

- **engine:** … ([369a03babf](…))

<!-- /commits:1.0.0 -->
```

Everything between the markers is generated from `git log` over the range from
the last `v*` tag to `HEAD`, grouped by conventional-commit type, labelled with
each commit's scope, and linked to the commit. Commits of type `release` are
skipped, so the release commit a cut writes does not make the section it just
generated stale. Nothing outside the markers is rewritten, so regenerating can
never eat the narrative. The release's own `v<version>` tag never starts the
range: a tag pushed for a publish that did not complete sits on an ancestor of
every later `main` commit, and the section for that version still spans from
the previous release.

Two targets cover it:

| Target                | Verb          | What it does                                                          |
| --------------------- | ------------- | --------------------------------------------------------------------- |
| `//:changelog`        | `run`         | writes the block for the version `packages/smithers/package.json` carries |
| `//:changelog`        | `lint`        | drift-checks it                                                        |

`run`, not `build`: `Generate` declares the kinds `run` and `lint`
(`packages/smithers/build/targets/src/Compose.ts:729`), so `smithers-build
build '//:changelog'` selects nothing.

The `lint` verb runs the generator inside a scratch copy of the tree, and that
copy carries no `.git`
(`packages/smithers/build/build-cli/src/PackageTree.ts:1266`). With
no history to read, the generator re-renders the block from its own contents,
so the lint proves the block is canonically grouped, ordered, labelled, linked,
and counted — the drift a hand edit introduces — and not that it still matches
history. The gate that proves it against history is the `Release changelog
section` step in `release.yml`, which runs `--check` in a full checkout at the
tag and fails the release before anything is packed.

There is no `//:cutRelease` target, because a cut takes the version as an
argument and no `run`-verb rule in the target library accepts a per-invocation
argument: `ToolRun`'s `args` are fixed strings
(`packages/smithers/build/targets/src/ToolRun.ts:30`), and the `Shell.*` rules
take strings or `S.Flags` references, which resolve to fixed text the workspace
declares (`packages/smithers/build/targets/src/WorkspaceDeclaration.ts:201`).
The cut is an operator command, and `//scripts:releaseCut` is its gate.

## JSDoc convention

`pnpm run lint` enforces this. The rules live in [`eslint.jsdoc.js`](eslint.jsdoc.js), which every package's `eslint.config.js` spreads in.

- **Every module gets a header** — a block above the first statement, carrying prose and `@since`. It says what the module is for and why it is shaped the way it is, not what its exports are called. A blank line follows it; otherwise tsc can drop it from the `.d.ts`.
- **Every exported declaration gets prose, `@category`, and `@since`.** The prose must let a reader learn what the thing IS and when to reach for it without opening the implementation. `packages/smithers/flows/flow/src/RetryPolicy.ts` is the bar; `packages/smithers/flows/kernel/src/GrantStore.ts` is the canonical service-module shape and `packages/smithers/flows/engine-store/src/internal/AttemptProbe.ts` the internal-module one.
- **One tag per line.** `@since 0.1.0 @category models` on a single line parses as one `@since` tag whose description happens to contain the word `@category`, so the second tag silently does not exist.
- **`@category` is a lowercase noun** — `models`, `constructors`, `layers`, `services`, `errors`, `schemas`, and the few narrower ones a module already uses.
- **`@since` is `0.1.0`** for new code; nothing here has shipped. Code adapted from Effect v4 keeps the `4.0.0` it was written with, because that is the release it dates from.
- **`@private` blocks drop `@category`** and need no prose — a private export belongs to no documented category. They still carry `@since`.
- **There is no `@internal` tag.** Hiding a module is done three other ways, all of which survive a reader who ignores comments: put it under `internal/`, null its entry in the package `exports` map, and mark the declaration `@private`.
- **Re-exports are not gated.** `export { x }` and `export * as Ns from "…"` document the module they point at; their prose belongs at the definition site.

The full contributor guide lives with the rest of the documentation under [`apps/site/src/content/docs`](apps/site/src/content/docs). It covers what each gate proves, the prose rules for docs pages, the commit conventions including the `Docs:` and `Depends-on:` trailers, and the epic plan.

### Repository JSDoc gate

`pnpm test:jsdoc` tests the rule; `pnpm lint:jsdoc` lints package source exports with the root `eslint.config.js`. CI runs both. New packages inherit the root source patterns automatically; explicit exclusions for the frontend UI packages live in that config with their scope rationale. Package ESLint configs continue to use `jsdocConvention` for local lint runs.

## Developing in the cloud workspace

You can develop Smithers in its cloud workspace through the Smithers UI. In the app,
select this repository's cloud workspace, ask for one focused change in Chat, and review
the validated change in the run card. When the review is clean, land it with **Vibe this
change**. The Chat request runs the repository's registered `coding/request` flow and
the landing runs `coding/vibe`, so the gates this guide lists apply to the changes the
workspace produces.

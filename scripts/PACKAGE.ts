/**
 * Targets for the repository's operator and release scripts.
 *
 * Every gate under `scripts/` is declared here, so `smithers-build test '//scripts/...'`
 * is the whole of what CI used to spell as seven `node --test …` and
 * `node scripts/….mjs` strings. The scripts keep living beside the thing they
 * guard; what changed is that the build system now knows about them, which means
 * they are planned, addressable by label, and runnable locally by the same name
 * the pipeline uses.
 *
 * The interpreter comes from the root runtime declaration. Nothing here spells
 * `node`.
 */
import { Smithers } from "@smthrs/targets"

/**
 * Everything under `scripts/`, digested as the input of every gate here.
 *
 * Both extensions: a gate written in TypeScript is as much an input as one
 * written in `.mjs`, and a glob that saw only `.mjs` would leave an edit to it
 * out of the digest every gate here is keyed on.
 */
const sources = [
  Smithers.glob("//scripts/**/*.mjs"),
  Smithers.glob("//scripts/**/*.ts"),
  Smithers.glob("//scripts/fixtures/**/*.json")
]

/**
 * The pack directory the release rehearsal writes and the smoke check reads.
 *
 * Workspace-relative and gitignored. On CI this used to be a runner temporary
 * directory named by an environment expression, which made the two steps agree
 * only by both interpolating the same string.
 */
const packDirectory = "dist/release-packs"

/**
 * Checks the release manifest: which packages are published, in what order, and
 * with which internal ranges retargeted.
 *
 * @since 0.1.0
 * @category test
 */
const packManifest = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/pack-release.test.mjs")]),
  // Both workflows are inputs: the suite compares the release workflow's gate
  // and toolchain steps against the generated CI workflow's, so an edit to
  // either one has to re-run this gate rather than read a cached pass.
  srcs: [
    ...sources,
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//.github/workflows/release.yml")
  ],
  deps: []
})

/**
 * Checks the changelog generator: the commit-subject parse, the grouping, the
 * rendering, and that a second run over one range writes the same bytes.
 *
 * The cases drive real temporary repositories. The generator's whole input is
 * `git log`, `git describe`, and `git tag --points-at`, so a recorded log would
 * only prove that the recording agrees with itself.
 *
 * @since 1.0.0
 * @category test
 */
const changelog = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/generate-changelog.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Checks that a cut writes the version and the changelog, verifies both, and
 * tags without pushing.
 *
 * The fixture is a temporary repository holding copies of the three scripts a
 * cut spawns, so a case cannot reach this checkout's manifests: every one of
 * them resolves its repository root from its own location.
 *
 * @since 1.0.0
 * @category test
 */
const releaseCut = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/cut-release.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Checks release preparation, installed consumer boundaries and runtime floors,
 * and that the dry-run path skips publication while a tag push does not.
 *
 * The assertions read `release.yml` itself, so an edit that breaks either half
 * fails here instead of at the next release.
 *
 * @since 0.1.0
 * @category test
 */
const releaseRehearsal = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//scripts/release-rehearsal.test.mjs"),
    Smithers.file("//scripts/release-publish.test.mjs"),
    Smithers.file("//scripts/build-release.test.mjs"),
    Smithers.file("//scripts/check-api-baseline.test.mjs"),
    Smithers.file("//scripts/release-consumers.test.mjs"),
    Smithers.file("//scripts/installed-consumer-boundary.test.mjs"),
    Smithers.file("//scripts/template-replay.test.mjs"),
    Smithers.file("//scripts/release-npm-support.test.mjs"),
    Smithers.file("//scripts/release-node-support.test.mjs"),
    Smithers.file("//scripts/release-peer-ranges.test.mjs"),
    Smithers.file("//scripts/release-registry.test.mjs"),
    Smithers.file("//scripts/release-process.test.mjs"),
    Smithers.file("//scripts/release-graph.test.mjs"),
    Smithers.file("//scripts/release-gates.test.mjs"),
    Smithers.file("//scripts/runtime-node-support.test.mjs"),
    Smithers.file("//scripts/dev-compiler-isolation.test.mjs")
  ]),
  srcs: [
    ...sources,
    Smithers.file("//.pnpmfile.mjs"),
    Smithers.file("//.github/workflows/release.yml"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//packages/smithers/build/build-cli/src/CreateApp.ts"),
    Smithers.file("//packages/smithers/create-app/template/default/vitest.config.ts")
  ],
  deps: []
})

/**
 * Checks that publishing at a new version retargets the exact internal ranges
 * too, and that the tree is coherent at whatever version it currently carries.
 *
 * @since 0.1.0
 * @category test
 */
const releaseVersion = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/set-release-version.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Fails on any pin in the engine or tooling groups that `scripts/test-pins.md`
 * does not explain.
 *
 * A test the default gate never runs to a pass is only acceptable when it is
 * written down.
 *
 * @since 0.1.0
 * @category test
 */
const testPinRegister = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-test-pins.test.mjs")]),
  srcs: [...sources, Smithers.file("//scripts/test-pins.md")],
  deps: []
})

/**
 * The scheduled signal campaign's evidence check refuses a missing case, a
 * truncated history, a wrong seed and a failed result.
 *
 * @since 1.0.0
 * @category test
 */
const signalCampaign = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-signal-campaign.test.mjs")]),
  srcs: [...sources],
  deps: []
})

/**
 * The toolchain drift gate: package.json `engines` and `packageManager`,
 * flake.nix, and the generated CI workflow must agree with the runtimes and
 * package manager `.smithers/WORKSPACE.ts` declares, and every workflow,
 * script and image that names a Rust release must name the channel
 * `rust-toolchain.toml` pins. The gate reads both declarations itself, so a
 * version moves in one file.
 *
 * @since 0.1.0
 * @category test
 */
const toolchainPins = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-toolchain-pins.test.mjs")]),
  srcs: [
    ...sources,
    Smithers.file("//.smithers/WORKSPACE.ts"),
    Smithers.file("//package.json"),
    Smithers.file("//flake.nix"),
    Smithers.file("//.node-version"),
    Smithers.file("//rust-toolchain.toml"),
    Smithers.glob("//.github/workflows/*.yml"),
    Smithers.file("//PACKAGE.ts"),
    Smithers.file("//scripts/ci/cloud.sh"),
    Smithers.file("//distribution/Dockerfile"),
    Smithers.file("//apps/app/scripts/build-native.ts")
  ],
  deps: []
})

/**
 * The web bundle compatibility contract, compiled without a browser process.
 *
 * Browser support is a hard requirement met through layers: the contract entry
 * points must bundle for the browser, and the documented Node-only ones must
 * still fail, and fail only on a documented `node:` built-in. This gates both
 * halves.
 *
 * @since 0.1.0
 * @category test
 */
const webBundleContract = Smithers.NodeTest({
  summary: "Compile the web bundle and validate its exported surface; no browser process is started.",
  featured: true,
  runner: Smithers.entrypoint(Smithers.file("//scripts/browser-check.mjs")),
  // The entry points this bundles live in other packages, and a declared glob
  // may not cross a package boundary — it would expand to nothing and read as
  // a contract it is not. The gate is not cacheable, so it re-runs regardless.
  srcs: sources,
  deps: []
})

/**
 * Packs every publishable workspace package into {@link packDirectory}.
 *
 * A build target rather than a test: its product is the pack tree the smoke
 * check then installs from.
 *
 * @since 0.1.0
 * @category build
 */
const releasePack = Smithers.NodeBinary({
  entry: Smithers.file("//scripts/pack-release.mjs"),
  args: [packDirectory],
  srcs: sources,
  // Most packages use workspace default-target synthesis and therefore have
  // no PACKAGE.ts export this file can import. The selector is still a real
  // graph edge: every package `lib` settles before packing, including future
  // packages admitted under `packages/`. `lib` is the whole distribution,
  // `dist/esm` and `dist/cjs`, which is what `assertBuilt` in the packing
  // program requires; nothing here depends on a prior `pnpm run build`.
  deps: [Smithers.Target.subtree("//packages/...", "lib")]
})

/**
 * Every public package's declarations hash to the reviewed
 * `scripts/fixtures/public-api-baseline.json`.
 *
 * The same `lib` edge as {@link releasePack}, so on CI the libraries this
 * reads are the ones the pack already built, and a declaration change that
 * skips the baseline review fails on the push that made it, not at release.
 *
 * @since 1.0.0
 * @category test
 */
const apiBaseline = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-api-baseline.mjs")),
  srcs: sources,
  deps: [Smithers.Target.subtree("//packages/...", "lib")]
})

/**
 * Installs the packed artifacts into a scratch project and imports every
 * published entry point, ESM and CJS.
 *
 * The dependency edge on {@link releasePack} is what sequences the two; before
 * this target they were two shell lines in one step that agreed only by naming
 * the same environment variable.
 *
 * @since 0.1.0
 * @category test
 */
const releaseSmoke = Smithers.NodeTest({
  // See smoke-release.mjs for the measured 1110.40 s Node 24 baseline.
  // Keep this gate uncached and allow its complete installed-consumer matrix.
  timeout: "30m",
  runner: Smithers.entrypoint(Smithers.file("//scripts/smoke-release.mjs"), [packDirectory]),
  srcs: sources,
  deps: [releasePack]
})

/**
 * One `effect` version across every manifest, both lockfiles, and the install.
 *
 * Two Effect instances do not share schema internals, so a duplicate is a
 * runtime defect rather than a size problem. The release pins one supported
 * version and this target proves the tree agrees.
 *
 * @since 0.1.0
 * @category test
 */
const effectVersion = Smithers.NodeTest({
  summary: "Exactly one effect version resolves across every manifest and both lockfiles.",
  featured: true,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-single-effect-version.mjs")),
  srcs: [...sources, Smithers.file("//pnpm-lock.yaml"), Smithers.file("//bun.lock")],
  deps: []
})

/**
 * `bun.lock` records the dependency ranges the manifests declare.
 *
 * A manifest change is required to refresh both lockfiles, but only
 * `pnpm-lock.yaml` was ever proved: every CI job installs with pnpm and
 * `--frozen-lockfile` rejects a stale one on the spot, while no job runs `bun
 * install` at all. Bun still executes `apps/*`, the `//packages/...:bunTest`
 * matrix, and `evals/agent`, so a stale entry resolves a real package at the
 * wrong version on exactly those surfaces and nowhere else. `packages/smithers/agent/fs`
 * reached rc.0 still asking for `@smthrs/core@0.1.0` that way.
 *
 * The target compares rather than installs. It reads the lockfile's own
 * `workspaces` table against the manifests on disk, which is offline,
 * deterministic, and needs no Bun on the machine.
 *
 * @since 0.1.0
 * @category test
 */
const lockfileParity = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-lockfile-parity.mjs")),
  srcs: [
    ...sources,
    Smithers.file("//bun.lock"),
    Smithers.glob("//packages/*/package.json"),
    Smithers.glob("//apps/*/package.json")
  ],
  deps: []
})

/**
 * What an npm consumer of the published set actually resolves.
 *
 * pnpm settles every internal edge from one workspace-wide pin, so
 * {@link effectVersion} stays green while an npm install of the same tarballs
 * duplicates Effect or drags a test runner into a production dependency tree.
 * This packs the release manifests, resolves them with npm's own arborist, and
 * asserts a single `effect` copy and no optional peer in the default install.
 *
 * The resolution reads registry metadata, so this target needs the network and
 * is not cacheable. It re-runs regardless, which is what a gate over an
 * external resolver has to do.
 *
 * @since 0.1.0
 * @category test
 */
const npmDedupe = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-npm-dedupe.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The gate's own two claims, named one per cell.
 *
 * The script reports both through one exit code, so a regression reads as an
 * opaque failure. This suite says which claim broke and which package broke it.
 *
 * @since 0.1.0
 * @category test
 */
const npmDedupeUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-npm-dedupe.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * A scaffolded app resolves under strict peer resolution.
 *
 * `@effect/platform-node` floats `@effect/platform-node-shared` through a caret
 * range, so a resolver may select a shared adapter whose `effect` peer is the
 * next RC and conflicts with the exact `effect` a template pins. This
 * repository pins the shared adapter in its root overrides; a generated app is
 * not a workspace member and inherits nothing, so the template carries the pin
 * and this scaffolds with the real CLI and installs what it wrote under
 * `npm --strict-peer-deps` and `pnpm --strict-peer-dependencies`.
 *
 * The installs read registry metadata, so this target needs the network, and
 * the registry is an input the key cannot name: a hit means the manifests are
 * unchanged, never that the registry still resolves them. So the key catches a
 * template that drops the pin, and a cold cache catches an upstream that starts
 * floating a new adapter.
 *
 * @since 0.1.0
 * @category test
 */
const templatePeers = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-template-peers.test.mjs")]),
  srcs: [
    ...sources,
    Smithers.glob("//packages/smithers/create-app/template/*/package.json"),
    Smithers.file("//packages/smithers/create-app/package.json")
  ],
  deps: []
})

/**
 * Every import a workspace source makes is declared by that workspace.
 *
 * pnpm links the whole workspace under one `node_modules`, so an undeclared
 * import of a sibling still resolves locally and then fails for a consumer who
 * installs the tarball. This executes the rule against unpublished
 * workspace-relative imports.
 *
 * The sources it reads live in other packages, and a declared glob may not
 * cross a package boundary, so `srcs` names only this directory. The gate is
 * therefore not cacheable and re-runs regardless.
 *
 * @since 0.1.0
 * @category test
 */
const dependencyBoundaries = Smithers.NodeTest({
  summary: "No package imports cross declared workspace boundaries.",
  featured: true,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-dependency-boundaries.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The literal-blanking step of the dependency-boundaries gate.
 *
 * The gate sweeps each source for dynamic imports with string and template
 * literals blanked out. This pins that the single-pass blanking matches the
 * reduce it replaced byte for byte, and that its cost stays linear in the
 * file size rather than literals times size.
 *
 * @since 0.1.0
 * @category test
 */
const dependencyBoundariesUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-dependency-boundaries.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Internal scripts execute the Smithers working tree, never an installed copy.
 *
 * A published-CLI invocation inside this repository silently runs a release
 * build instead of the code under edit. The guard scans only positions that
 * actually spawn a process, so the documentation's own `bunx smithers-build` prose
 * stays legal.
 *
 * @since 0.1.0
 * @category test
 */
const localSmithers = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-local-smithers.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The guard's own unit suite: the violation patterns, the allowlist, and the
 * scanned execution surfaces.
 *
 * @since 0.1.0
 * @category test
 */
const localSmithersUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/check-local-smithers.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * The untrusted-report boundary for issue and pull-request triage.
 *
 * The model never receives a GitHub token; this suite holds the deterministic
 * publisher to an allowlisted schema and proves that a failed model run still
 * asks the author for the concrete evidence needed to continue.
 *
 * @since 1.0.0
 * @category test
 */
const githubTriage = Smithers.NodeTest({
  summary: "GitHub triage publishes only validated labels and useful fallback requests.",
  featured: true,
  runner: Smithers.testRunner([Smithers.file("//scripts/github-triage.test.mjs")]),
  srcs: [
    Smithers.file("//scripts/github-triage.mjs"),
    Smithers.file("//scripts/workspace-packages.mjs"),
    Smithers.file("//flows/issue-triage/flow.mdx"),
    Smithers.file("//flows/pr-triage/flow.mdx")
  ],
  deps: []
})

/**
 * Keeps the attribution inventory in the published wasm package current.
 *
 * @since 1.0.0
 * @category test
 */
const thirdPartyNotices = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/generate-third-party-notices.mjs"), ["--check"]),
  srcs: [
    Smithers.file("//scripts/generate-third-party-notices.mjs"),
    Smithers.file("//scripts/third-party-notices.template.md"),
    Smithers.file("//Cargo.toml"),
    Smithers.file("//Cargo.lock"),
    Smithers.file("//crates/flows-jj/Cargo.toml"),
    Smithers.file("//rust-toolchain.toml"),
    Smithers.file("//packages/smithers/flows/jj/THIRD_PARTY_NOTICES.md")
  ],
  deps: []
})

/**
 * Exercises generation and drift detection against a real Cargo workspace.
 *
 * @since 1.0.0
 * @category test
 */
const thirdPartyNoticesUnit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/generate-third-party-notices.test.mjs")]),
  srcs: [...sources, Smithers.file("//scripts/third-party-notices.template.md"), Smithers.file("//.github/workflows/ci.yml")],
  deps: []
})

/** Verifies immutable-artifact publication and partial-retry refusal using a fake registry. */
const releaseIntegrity = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//scripts/publish-release.test.mjs"),
    Smithers.file("//scripts/restore-release.test.mjs"),
    Smithers.file("//scripts/workspace-packages.test.mjs")
  ]),
  srcs: sources,
  deps: []
})

/** Required fast behavioral mutation tier, including both exact-byte guards. */
const mutationGate = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-mutations.mjs")),
  srcs: [...sources, Smithers.glob("//packages/smithers/gateway/src/**/*.ts"), Smithers.glob("//packages/smithers/gateway/test/**/*.ts")],
  deps: []
})

/** Deterministic scheduler and journal cost regressions, after output validation. */
const benchmarkGate = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("//scripts/bench/gate.mjs")),
  srcs: [...sources, Smithers.file("//scripts/bench/baseline.json")],
  deps: []
})

/** Real-runner sentinels and fail-closed campaign-verifier regressions. */
const tierContracts = Smithers.NodeTest({
  runner: Smithers.testRunner([
    Smithers.file("//scripts/runner-contract.test.mjs"),
    Smithers.file("//scripts/ci/coding-check.test.mjs"),
    Smithers.file("//scripts/ci/check-cache.test.mjs"),
    Smithers.file("//scripts/check-mutations.test.mjs"),
    Smithers.file("//scripts/check-soak-campaign.test.mjs"),
    Smithers.file("//scripts/benchmark-gate.test.mjs"),
    Smithers.file("//scripts/run-jj-abi-campaign.test.mjs")
  ]),
  srcs: [...sources, Smithers.file("//scripts/ci/coding-check.sh")],
  deps: []
})

/** Typecheck the repository conformance suites and their target declarations. */
const conformanceCheck = Smithers.Typecheck({
  srcs: sources,
  tsconfig: Smithers.file("tsconfig.conformance.json"),
  cwd: "scripts",
  buildMode: false,
  incremental: false,
  deps: []
})

/**
 * Repository-wide CI, publication, coverage and containment policy.
 *
 * These checks read other packages and root configuration, so they run in the
 * uncacheable scripts gate. The umbrella library owns only its own behavior.
 * One runner imports the suites to keep filesystem scans in one process.
 */
const repositoryConformance = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/test/repositoryConformance.test.ts")]),
  srcs: [
    ...sources,
    Smithers.file("//scripts/test/ci.test.ts"),
    Smithers.file("//scripts/test/publication.test.ts"),
    Smithers.file("//scripts/test/coverage.test.ts"),
    Smithers.file("//scripts/test/spawnContainment.test.ts"),
    Smithers.file("//scripts/test/workspaceInventory.test.ts"),
    Smithers.file("//scripts/test/conformanceOwnership.test.ts")
  ],
  deps: [conformanceCheck]
})

/**
 * Lints every operator script against the root config's scripts block.
 *
 * Scripts carry no public-JSDoc contract, so the block holds statement style
 * only: no semicolons, the style most of `scripts/` already used.
 *
 * @since 1.0.0
 * @category lint
 */
const lint = Smithers.EsLint({
  sources: [Smithers.glob("//scripts/**/*.mjs")],
  configs: [Smithers.file("//eslint.config.js")],
  deps: [],
  maxWarnings: 0,
  fix: false
})

const commit = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/commit.test.mjs")]),
  srcs: [Smithers.file("//scripts/commit.mjs")],
  deps: []
})

export const Package = Smithers.Package({
  targets: {
    apiBaseline,
    commit,
    conformanceCheck,
    repositoryConformance,
    mutationGate,
    benchmarkGate,
    tierContracts,
    releaseIntegrity,
    webBundleContract,
    changelog,
    dependencyBoundaries,
    dependencyBoundariesUnit,
    effectVersion,
    githubTriage,
    lint,
    localSmithers,
    localSmithersUnit,
    lockfileParity,
    npmDedupe,
    npmDedupeUnit,
    packManifest,
    releaseCut,
    releasePack,
    releaseRehearsal,
    releaseSmoke,
    releaseVersion,
    signalCampaign,
    templatePeers,
    testPinRegister,
    toolchainPins,
    thirdPartyNotices,
    thirdPartyNoticesUnit
  }
})

/**
 * Targets for the repository-contract gates.
 *
 * They live in their own directory, and their own PACKAGE.ts file, because they are
 * about the workspace rather than about any package in it: the version line,
 * the publishable surface, the barrels, and the fault matrix's own discipline.
 * `//scripts/...` is recursive, so the whole set stays under the one pattern the
 * pipeline already runs.
 *
 * The interpreter comes from the root runtime declaration. Nothing here spells
 * `node`.
 */
import { Smithers } from "@smthrs/targets"
import { Package as sitePackage } from "../../apps/site/PACKAGE.ts"

/** Every gate in this directory, digested as the input of each target. */
const sources = Smithers.glob("//scripts/repo-contract/**/*.mjs")

/**
 * One version across the release line, a declared publishable surface, and the
 * scripts every other gate invokes.
 *
 * The manifests it reads live in other packages, and a declared glob may not
 * cross a package boundary, so `srcs` names only this directory. The gate is
 * therefore not cacheable and re-runs regardless, which is correct: its subject
 * is the whole workspace.
 *
 * @since 1.0.0
 * @category test
 */
const packageContract = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/package-contract.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Explicit entrypoints preserve reviewed imports and block future source files.
 * @since 1.0.0
 * @category test
 */
const publicExportMaps = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/public-export-maps.test.mjs")]),
  srcs: [
    sources,
    Smithers.file("//scripts/public-export-map.mjs"),
    Smithers.file("//scripts/fixtures/public-export-surface.json"),
    Smithers.file("//scripts/workspace-packages.mjs"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: []
})

/**
 * The barrels re-export what they claim, checked by importing them.
 *
 * A typecheck reads the same source the declarations are generated from, so it
 * cannot catch a re-export that was never written. Loading the module can.
 *
 * @since 1.0.0
 * @category test
 */
const barrels = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/barrels.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Every workspace member with tests is reachable from the command CI runs.
 *
 * @since 1.0.0
 * @category test
 */
const testScriptWiring = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/test-script-wiring.test.mjs")]),
  srcs: [
    sources,
    Smithers.file("//scripts/release-rehearsal.mjs"),
    Smithers.file("//PACKAGE.ts"),
    Smithers.file("//scripts/PACKAGE.ts"),
    Smithers.file("//scripts/repo-contract/PACKAGE.ts"),
    Smithers.glob("//scripts/**/*.test.mjs"),
    Smithers.glob("//factory/**/*.test.ts"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-workspace.yaml")
  ],
  deps: []
})

/**
 * The apps/app required CI tier: selected once in its own job, a Playwright
 * wrapper that propagates failure, and a typecheck that propagates compiler
 * and security validation failures.
 *
 * @since 1.0.0
 * @category test
 */
const uiCiTier = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/ui-ci-tier.test.mjs")]),
  srcs: [
    sources,
    Smithers.file("//scripts/release-rehearsal.mjs"),
    Smithers.file("//.github/workflows/ci.yml"),
    Smithers.file("//apps/app/PACKAGE.ts"),
    Smithers.file("//apps/app/scripts/run-pr-e2e.mjs"),
    Smithers.file("//apps/app/package.json"),
    Smithers.file("//apps/app/tsconfig.json"),
    Smithers.file("//package.json"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: []
})

/**
 * The scheduled signal campaign records its seed, preserves its evidence and
 * verifies it.
 *
 * @since 1.0.0
 * @category test
 */
const reliabilityWorkflow = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/reliability-workflow.test.mjs")]),
  srcs: [sources, Smithers.file("//scripts/release-rehearsal.mjs"), Smithers.file("//.github/workflows/reliability.yml")],
  deps: []
})

/**
 * A release version bump retags every distribution image declaration.
 *
 * @since 1.0.0
 * @category test
 */
const distributionImageTag = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/distribution-image-tag.test.mjs")]),
  srcs: [
    sources,
    Smithers.file("//scripts/set-release-version.mjs"),
    Smithers.file("//scripts/workspace-packages.mjs"),
    Smithers.file("//packages/smithers/package.json"),
    Smithers.file("//distribution/README.md"),
    Smithers.file("//distribution/Dockerfile")
  ],
  deps: []
})

/**
 * No focused or parked test in the fault matrix, every conditional skip
 * declared with its reason, and every package that carries fault cases wired to
 * a target that runs them.
 *
 * The coverage record the suite reads is an input beside the gates themselves:
 * a required red gate names a row in `fault-gaps.md`, so editing that row has
 * to re-key this target.
 *
 * @since 1.0.0
 * @category test
 */
const faultSkips = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/fault-skips.test.mjs")]),
  srcs: [sources, Smithers.file("//scripts/repo-contract/fault-gaps.md")],
  deps: []
})

/**
 * No operator rig under `evals/`, `scripts/`, or a package's `test/faults` tree
 * names one machine's home directory.
 *
 * @since 1.0.0
 * @category test
 */
const machinePaths = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/machine-paths.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * No app tracks a run's scratch output: captured exit codes or enrollment
 * traces.
 *
 * @since 1.0.0
 * @category test
 */
const scratchArtifacts = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/scratch-artifacts.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Every smithers.sh URL shipped by a package reaches the built documentation,
 * directly or through one production redirect whose destination is real.
 *
 * The route oracle is the emitted HTML under `apps/site/dist`, so the site's
 * build is a dependency rather than a step someone ran first. The edge orders
 * the build ahead of the gate, keys the gate on the build's own key so a
 * content change re-runs it, and puts the build's declared outputs in the
 * gate's sandbox read set. It is a selector rather than an import because
 * importing `apps/site/PACKAGE.ts` would pull every documented package's
 * declaration into this file to reach one target.
 *
 * `dist` is deliberately not declared as an input: declared inputs expand at
 * plan time, and on a clean checkout the directory the build has not produced
 * yet expands to nothing, which is both a vacuous edge and no read at all.
 *
 * @since 1.0.0
 * @category test
 */
const smithersLinks = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/smithers-links.test.mjs")]),
  srcs: [sources],
  deps: [sitePackage.build]
})

/**
 * The reference indexes every canonical command, retains the compatibility
 * pages, and describes flags accepted by the public parser. The generated
 * manifest and help have their own executable drift gate.
 *
 * @since 1.0.0
 * @category test
 */
const cliVerbs = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/cli-verbs.test.mjs")]),
  srcs: [sources],
  deps: []
})
/**
 * No shipped Node composition installs an HTTP client that ignores the egress
 * proxy its environment names.
 *
 * The gate reads shipped source across `packages/`, `apps/`, `flows/` and
 * `examples/`, which a declared glob may not cross, so `srcs` names only this
 * directory and the gate re-runs regardless. That is correct here for the same
 * reason it is correct for `packageContract`: its subject is the whole
 * workspace.
 *
 * @since 1.0.0
 * @category test
 */
const egressHttpClient = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/egress-http-client.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Actual planner selection, runtime policy, sentinels and cache behavior.
 * This only plans commands; distribution outputs are not declaration inputs.
 * Keep it independent of builds so inventory can run beside a release gate.
 * Reuse metadata from identical earlier plans rather than rebuilding the
 * same native plan for each CLI selection, and host CLI invocations serially
 * in a persistent child without reloading its modules. The parent enforces
 * SIGTERM then SIGKILL deadlines. The NodeTest stays uncached.
 */
const ciInventory = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/ci-inventory.test.mjs")]),
  srcs: [sources, Smithers.file("//scripts/ci-inventory.mjs"), Smithers.file("//scripts/ci-planner.mjs")],
  deps: []
})

/**
 * Security review of the repository-contract gates: the egress and privacy
 * gates must keep failing when they should, and the gates' own child
 * processes and temporary files must not widen what a test run can touch.
 *
 * @since 1.0.0
 * @category security
 */
const securityReview = Smithers.SecurityReview({
  cwd: "scripts/repo-contract",
  include: ["*.mjs", "*.md"],
  checks: [
    {
      id: "egress-gate-coverage",
      title: "The egress gate reads every shipped source that could install a proxy-blind HTTP client",
      threat: "A contributor ships a Node host that dials origins directly past the sandbox egress proxy, letting a sandboxed run exfiltrate data, while the gate stays green.",
      lookFor: [
        "A shipped source extension (.js, .cjs, .mts, .cts, .jsx) that isSource drops, so layerUndici or makeDispatcher in it is never scanned.",
        "A skippedDirectories or skippedPaths entry that prunes a directory holding shipped, non-test source.",
        "An isComment rule that exempts a code line (for example one starting with `*` inside an expression, or code after a `/* */` on the same line).",
        "A banned spelling reachable without matching the regex, such as a renamed import or a computed property access on NodeHttpClient.",
        "The defines allowlist or install-count floor changed so the ban can pass with the replacement absent."
      ],
      paths: ["egress-http-client.test.mjs"]
    },
    {
      id: "home-path-leak-gate",
      title: "The machine-path gate catches every tracked home-directory path under evals, scripts and fault suites",
      threat: "A contributor commits an operator's username and home layout, leaking a maintainer's local identity and paths in the public repository, while the gate stays green.",
      lookFor: [
        "A homePath regex that misses a username-bearing path: the superuser's home (also under macOS's /var), a shell ~<name> home, Windows C:\\Users\\<name> at any escaping depth, or /Users/<name> followed by punctuation or the end of the line.",
        "An isRecorded exemption broader than the reports, archive and SFT-corpus directories it documents.",
        "An inventory command whose failure or empty output is treated as a pass instead of asserting status 0 and a nonempty list.",
        "A git/jj selection that reads an ancestor repository's inventory instead of this workspace's."
      ],
      paths: ["machine-paths.test.mjs", "scratch-artifacts.test.mjs"]
    },
    {
      id: "child-process-containment",
      title: "Gate child processes run fixed code with bounded time and no inherited secrets they do not need",
      threat: "A repository file or environment value controls code a gate evaluates, or a hung child survives the gate, running attacker-chosen code or holding CI runner resources.",
      lookFor: [
        "A spawn or spawnSync `--eval`/`-e` string built by interpolating file contents, package names or environment values instead of passing data on stdin or IPC.",
        "A shell: true spawn or an exec() of a string assembled from repository data.",
        "A child spawned without timeout, SIGKILL fallback or t.after cleanup.",
        "A child env built from `...process.env` that forwards cache tokens or credentials (SMITHERS_CACHE_TOKEN, NPM_TOKEN) to a stub it does not need them for.",
        "A PATH prefix pointing at a directory that is not a fresh mkdtemp owned by the test."
      ],
      paths: ["ci-inventory.test.mjs", "public-export-maps.test.mjs", "ui-ci-tier.test.mjs", "machine-paths.test.mjs", "scratch-artifacts.test.mjs"]
    },
    {
      id: "temp-file-safety",
      title: "Gates write only inside fresh temporary directories they create and remove",
      threat: "Another local user on a shared CI runner pre-plants a symlink at a predictable temp path so a gate overwrites or reads a file it should not.",
      lookFor: [
        "A writeFileSync to a predictable tmpdir() path (fixed name or pid) instead of a mkdtemp directory, such as the default smithers-ci-inventory-<pid>.json artifact.",
        "An environment-supplied output path (SMITHERS_CI_INVENTORY) written without checking it stays inside the workspace or a temp directory.",
        "rmSync(..., { recursive: true, force: true }) on a path not returned by mkdtemp in the same test.",
        "symlinkSync into a fixture that points outside the fixture root."
      ],
      paths: ["ci-inventory.test.mjs", "cli-verbs.test.mjs", "public-export-maps.test.mjs", "ui-ci-tier.test.mjs"]
    },
    {
      id: "publish-surface-gate",
      title: "The package contract keeps the published npm surface explicit and free of private code",
      threat: "A release publishes a private workspace package, an undeclared file (a .env or credentials fixture), or an unreviewed subpath to every npm user.",
      lookFor: [
        "A publishable manifest accepted without a nonempty `files` allowlist or with publishConfig.access other than public.",
        "The private-dependency check skipping dependency kinds (optionalDependencies, peerDependencies) a consumer installs.",
        "An export-map baseline entry or wildcard subpath admitted without the gate failing on a new source file.",
        "A private: true check that treats a missing or string \"true\" value as private."
      ],
      paths: ["package-contract.test.mjs", "public-export-maps.test.mjs", "barrels.test.mjs"]
    },
    {
      id: "ci-workflow-gates",
      title: "Workflow gates keep required CI jobs failing on real failures",
      threat: "A contributor edits ci.yml or reliability.yml so a required security or test job passes on failure, letting vulnerable code merge to main.",
      lookFor: [
        "An assertion that tolerates continue-on-error: true, `|| true`, or an allow-failure known-red list on a required job.",
        "A regex match on a workflow run string loose enough to accept an extra command that skips or neuters the suite.",
        "A test file excluded from every target in test-script-wiring without a stated reason.",
        "A skip or todo in the fault matrix accepted without a declared reason row in fault-gaps.md."
      ],
      paths: ["ui-ci-tier.test.mjs", "reliability-workflow.test.mjs", "test-script-wiring.test.mjs", "ci-inventory.test.mjs", "fault-skips.test.mjs", "fault-gaps.md"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { barrels, cliVerbs, distributionImageTag, egressHttpClient, faultSkips, machinePaths, packageContract, scratchArtifacts, smithersLinks, testScriptWiring, uiCiTier, reliabilityWorkflow, ciInventory, publicExportMaps, ...securityReview }
})

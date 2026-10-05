import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { ReviewDocsAgainstCode, ReviewJsdocAgainstCode } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"
import project from "./apps/site/src/data/project.json" with { type: "json" }
import { Package as modelHostPackage } from "./packages/smithers/agent/model-host/PACKAGE.ts"
import { Package as integrationsPackage } from "./packages/smithers/agent/integrations/PACKAGE.ts"
import { Package as flowsPackage } from "./packages/smithers/flows/PACKAGE.ts"
import { Package as codingFlowsPackage } from "./flows/PACKAGE.ts"

export const cacheToken = Smithers.Secret("SMITHERS_CACHE_READ_TOKEN")
export const cacheWriteToken = Smithers.Secret("SMITHERS_CACHE_WRITE_TOKEN")
export const cacheUrl = Smithers.Secret("SMITHERS_CACHE_URL")

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const rootInvariantsConfig = Smithers.file("//eslint.invariants.js")

// --- reference docs pipeline (apps/site/prompts/*.md) ---------------------
// The agent that writes generated reference pages. Declared inline because
// this workspace has no `.smithers/agents.ts`; `S.Agents.<name>` would fail
// at index time. Pages are committed, so the model only runs under
// `smithers-build target <pkg>:referenceDocs --write`, never under `ci`.
export const docsWriter = Smithers.Agent.ClaudeCode({ model: "opus" })
export const referenceStyle = Smithers.file("//apps/site/prompts/reference-style.md")
// --- end reference docs pipeline ------------------------------------------
const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")

const tsconfig = Smithers.Tsconfig({
  summary: "Regenerate and check the workspace tsconfig.json from PACKAGE.ts.",
  featured: true,
  mode: "check",
  extends: rootTsconfig,
  compilerOptions: {
    noEmit: true,
    lib: ["ES2024"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    paths: { "*": ["./*"] }
  },
  include: [
    Smithers.file("PACKAGE.ts"),
    Smithers.glob("apps/*/PACKAGE.ts"),
    Smithers.glob("crates/*/PACKAGE.ts"),
    Smithers.glob("evals/*/PACKAGE.ts"),
    Smithers.file("scripts/PACKAGE.ts"),
    Smithers.glob("scripts/*/PACKAGE.ts"),
    Smithers.file("flows/PACKAGE.ts"),
    Smithers.file("examples/PACKAGE.ts"),
    Smithers.glob("apps/docs/*/PACKAGE.ts"),
    // One entry per nesting depth, spelled out. Packages nest: a granular
    // package lives inside the product package it belongs to, so
    // `@smthrs/canonical` is `packages/smithers/flows/canonical` and
    // `@smthrs/cli` is `packages/smithers`. Three depths cover the tree, and
    // `packages/**` is deliberately not used: it would sweep in every `dist`
    // tree a build writes, which is the same reason `pnpm-workspace.yaml`
    // names one parent at a time.
    Smithers.glob("packages/*/PACKAGE.ts"),
    Smithers.glob("packages/*/*/PACKAGE.ts"),
    Smithers.glob("packages/*/*/*/PACKAGE.ts"),
  ],
  exclude: [
    Smithers.glob("**/dist/**"),
    Smithers.glob("packages/coding-agent/examples/extensions/gondolin/**")
  ]
})

// The package manager comes from `.smithers/WORKSPACE.ts`, which is where the
// workspace declares it once; the two targets name the file it writes because
// a target's output tree and declared inputs are fixed when this file is
// evaluated, before any workspace declaration has been read.
const lockfilePath = "pnpm-lock.yaml"

const lockfile = Smithers.Lockfile({
  lockfilePath,
  manifests: [workspace]
})

const nodeModules = Smithers.Install({
  lockfilePath,
  lockfile,
  // The workspace definition also keys the install on every patch file its
  // patchedDependencies names, so no patch list is kept here.
  workspaceManifest: workspace,
  // The registry, and the Playwright browser builds (with their apt
  // dependencies) the prepared environment installs for the locked release.
  destinations: [
    "registry.npmjs.org",
    "cdn.playwright.dev",
    "playwright-bkakghazbfe7grc5.z01.azurefd.net",
    "mr-z01.tm-azurefd.net",
    "deb.debian.org",
    "debian.map.fastly.net",
    "debian.map.fastlydns.net"
  ]
})

/**
 * The tool releases a prepared microVM environment installs, each pinned to
 * its linux/arm64 artifact and reviewed SHA-256. `scripts/check-toolchain-pins.mjs`
 * fails when a version here disagrees with `.node-version`, WORKSPACE.ts,
 * go.mod or rust-toolchain.toml. Domain rules match the name a connection
 * resolved through, so CDN CNAME targets are listed beside their aliases.
 *
 * @since 1.0.0
 * @category build
 */
const environmentToolchain = Smithers.Environment.Toolchain({
  downloads: {
    node: {
      version: "26.5.0",
      url: "https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-arm64.tar.xz",
      sha256: "036df0b49662ebb350eb56f1cac603699b1e9ed1e2603ee129fefda473479030"
    },
    pnpm: {
      version: "11.25.0",
      url: "https://registry.npmjs.org/pnpm/-/pnpm-11.25.0.tgz",
      sha256: "33dd0748f27e7916c4f1c8b6943461983e3453b06bbda6312a6280130b4881e5"
    },
    bun: {
      version: "1.4.1",
      url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.1/bun-linux-aarch64.zip",
      sha256: "580ce77533108dc6b10bec1721397e4f5aa44e909726da2451d483dfc5e581d6"
    },
    go: {
      version: "1.26.8",
      url: "https://go.dev/dl/go1.26.8.linux-arm64.tar.gz",
      sha256: "211ffced9dcb9633a55eac6364816ec0ddd951389a740e88fa8b3337971bdda0"
    },
    jj: {
      version: "0.39.0",
      url: "https://github.com/jj-vcs/jj/releases/download/v0.39.0/jj-v0.39.0-aarch64-unknown-linux-musl.tar.gz",
      sha256: "15bbb0199adf57929d1e3cd90ae0b47356858cbe374814769815a1fb87d5ad1d"
    },
    rg: {
      version: "14.1.1",
      url: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-aarch64-unknown-linux-gnu.tar.gz",
      sha256: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f"
    },
    fd: {
      version: "10.2.0",
      url: "https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-aarch64-unknown-linux-musl.tar.gz",
      sha256: "4e8e596646d047d904f2c5ca74b39dccc69978b6e1fb101094e534b0b59c1bb0"
    },
    jq: {
      version: "1.7.1",
      url: "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-linux-arm64",
      sha256: "4dd2d8a0661df0b22f1bb9a1f9830f06b6f3b8f7d91211a1ef5d7c4f06a8b4a5"
    },
    rustup: {
      version: "1.28.2",
      url: "https://static.rust-lang.org/rustup/archive/1.28.2/aarch64-unknown-linux-gnu/rustup-init",
      sha256: "e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c"
    }
  },
  rust: { channel: "1.98.0", components: ["clippy", "rustfmt"], targets: ["wasm32-wasip1"] },
  postgres: "18",
  destinations: [
    "nodejs.org",
    "registry.npmjs.org",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "go.dev",
    "dl.google.com",
    "static.rust-lang.org",
    "fastly-static.rust-lang.org",
    "dualstack.k.sni.global.fastly.net",
    "deb.debian.org",
    "debian.map.fastly.net",
    "debian.map.fastlydns.net",
    "www.postgresql.org",
    "www.mirrors.postgresql.org",
    "apt.postgresql.org",
    "dualstack.t.sni.global.fastly.net"
  ]
})

/**
 * The public project copy derived from one small data file: the root README,
 * the shared regions on the docs overview, and the repository manifest's
 * description. The generated files stay committed so GitHub, npm tooling, and
 * the static site all work without first running the build.
 *
 * `run` writes the files and `lint` checks them for drift. The GIFs are data
 * edges even though the renderer only writes their paths: deleting either
 * asset must break the graph instead of leaving a dead README and docs page.
 *
 * @since 1.0.0
 * @category build
 */
const projectCopySource = Smithers.file("//apps/site/src/data/project.json")
const projectCopy = Smithers.Generate({
  summary: "Regenerate and drift-check the README and shared public project copy.",
  featured: true,
  script: Smithers.file("//apps/site/scripts/generate-project-copy.mjs"),
  data: [
    projectCopySource,
    Smithers.file("//apps/site/public/images/app/home.png"),
    Smithers.file("//apps/site/public/images/build-graph.gif"),
    Smithers.file("//apps/site/public/images/build-graph-light.gif")
  ],
  changes: ["README.md", "package.json", "apps/site/src/content/docs/docs/index.mdx", "apps/site/src/content/docs/docs/developers.mdx"]
})

/**
 * Applies the canonical one-sentence description to the GitHub About panel.
 * ToolRun is an explicit run-only irreversible operation, so no build, lint,
 * test, or CI traversal can update the remote repository accidentally.
 *
 * @since 1.0.0
 * @category release
 */
const repoAbout = Smithers.ToolRun({
  command: "gh",
  args: ["repo", "edit", "smithersai/smithers", "--description", project.description],
  inputs: [projectCopySource],
  deps: [projectCopy],
  cwd: "."
})

// Explicitly snapshot every contributor's current edits. This run-only target
// is never executed by build, test, lint, or CI and never cached or replayed.
const commit = Smithers.ToolRun({
  command: "node",
  args: ["scripts/commit.mjs"],
  inputs: [Smithers.file("//scripts/commit.mjs")],
  deps: [],
  cwd: "."
})

// --- factory projection ----------------------------------------------------
// The factory is declared in .smithers/FACTORY.ts beside WORKSPACE.ts: the
// featured flows, the Dispatcher table, the GitHub policy, and the homepage.
// This target projects that declaration into .smithers/factory.json and
// .smithers/home.json, the files smithers.sh reads from the public mirror, so
// a visitor signed out sees them and a workspace without node_modules never
// evaluates FACTORY.ts for a card. The planner fills the declaration from the
// loaded file; nothing here restates it.
const factoryProjection = Smithers.FactoryProjection({
  summary: "Regenerate and drift-check .smithers/factory.json and .smithers/home.json from .smithers/FACTORY.ts.",
  featured: true
})
// --- end factory projection ------------------------------------------------

// --- target index ----------------------------------------------------------
// The declaration-derived target index smithers.sh reads from the public
// mirror to show targets beside files: one row per labeled target with its
// rule, kinds, declared inputs and outputs, labeled dependencies, and the
// declaring file, and nothing keyed on a host. The planner fills the rows
// from the loaded declarations, so their content is key material and an edit
// to any PACKAGE.ts re-keys the check. `target --write` writes the file and
// `lint` fails on drift; `smithers-build index '//...'` prints the same rows.
const targetIndex = Smithers.TargetIndex({
  summary: "Regenerate and drift-check .smithers/target-index.json, the declaration-derived target index.",
  featured: true,
  gates: [codingFlowsPackage.testCoverage]
})
// --- end target index ------------------------------------------------------

const ubuntu = "ubuntu-latest"

// One Node for every environment, named once in `.node-version` at the root:
// setup-node reads it here through `node-version-file`, `scripts/ci/cloud.sh`
// reads it to bootstrap a Cloud runner, and fnm, nvm and asdf read it on a
// developer's machine. Before this the same fact was spelled three ways and
// three different releases came out: package.json said >=22.19.0, ci.yml
// installed 22.19.0, and the Cloud bootstrap downloaded 24.21.0.
const node = Smithers.CiToolchain.Node({ versionFile: ".node-version", npmRelease: "11.16.0" })

const bun = Smithers.CiToolchain.Bun({ release: "1.4.1" })

const jj = Smithers.CiToolchain.Jj({ release: "0.39.0" })
// `@smthrs/std` proves its portable search against a real `rg`: the conformance
// suite runs both implementations and compares them. Without the binary the
// native half cannot start and the parity check, which is the point of the
// suite, is the thing that fails.
const ripgrep = Smithers.CiToolchain.Ripgrep({ release: "14.1.1" })
// Confined targets run under bubblewrap on Linux, which the hosted runner
// image does not ship. The step is a no-op on the macOS and Windows rows.
const bubblewrap = Smithers.CiToolchain.Apt({ packages: ["bubblewrap"] })
const packageSystemTools = Smithers.CiToolchain.Apt({ packages: ["bubblewrap", "openssh-server"] })
// `//packages/smithers/build/build-cli:test` drives a real `forge` and a real Go toolchain:
// it builds and tests a Foundry package and asserts `forge fmt --check` drift,
// and it builds a Go package tree. Without them six cases fail on the REQUIRED
// ubuntu row with `host binary "forge" is not present on PATH`, which is a
// missing toolchain rather than a defect.
//
// These were withdrawn once, on the theory that they displaced pnpm from PATH
// and caused ~50 `spawn pnpm ENOENT` failures. That was wrong: the failures
// persisted through two pushes with no Go and no Foundry declared, and 52 of
// the 55 are the Windows `pnpm.cmd` shim problem, on a row that is advisory.
// Foundry v1.8.1 installed cleanly on every runner when it was last declared.
const go = Smithers.CiToolchain.Go({ release: "1.26.8" })
const foundry = Smithers.CiToolchain.Foundry({ release: "v1.8.1" })
const dockerImageStore = Smithers.CiToolchain.Docker({ imageStore: "containerd" })
// The storage matrix (`packages/smithers/flows/database/scripts/test-matrix.mjs`)
// runs every SQL-backed package suite on SQLite and on a throwaway PostgreSQL
// cluster it starts with `initdb`/`pg_ctl`, and refuses when they are missing.
const postgres = Smithers.CiToolchain.Postgres({ release: "18" })

// Hosted Go adapters need a real database server; each test suite creates its
// own database on it. This target runs only in the required Linux backend job,
// not in the cross-platform package matrix.
const backendPostgres = Smithers.Docker.Service({
  image: "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  env: { POSTGRES_USER: "smithers", POSTGRES_PASSWORD: "smithers-backend-test" },
  ports: { "5432": 55435 },
  readiness: {
    exec: ["pg_isready", "-h", "127.0.0.1", "-U", "smithers", "-d", "postgres"],
    timeout: "120s"
  },
  stop: { signal: "SIGTERM", grace: "10s" }
})

// Native FFI builds with the toolchain rust-toolchain.toml pins, installed
// into a private rustup home so the declared output carries it. Only a
// trusted-process-binding build can import a source outside a guest, so its
// source import CLI test runs as a second pass.
const nativeFfi = Smithers.Shell.Build({
  shell: "mkdir -p .native-ffi; export RUSTUP_HOME=\"$PWD/.native-ffi/rustup\" CARGO_TARGET_DIR=\"$PWD/.native-ffi/target\"; rustup toolchain install && cargo clippy -p smithers-ffi --all-targets --locked -- -D warnings && cargo test -p smithers-ffi --locked && cargo test -p smithers-ffi --locked --features trusted-process-binding --test source_import_cli && cargo build -p smithers-ffi --lib --locked && touch .native-ffi/qualified",
  outDirs: ["//.native-ffi"],
  data: [
    Smithers.file("//Cargo.toml"),
    Smithers.file("//Cargo.lock"),
    Smithers.file("//rust-toolchain.toml"),
    Smithers.file("//crates/flows-jj/Cargo.toml"),
    Smithers.glob("//crates/flows-jj/src/**/*.rs"),
    Smithers.glob("//crates/smithers-ffi/**/*.rs"),
    Smithers.file("//crates/smithers-ffi/Cargo.toml")
  ],
  sandbox: { network: true },
  timeout: "30m"
})

// Fill a declared module cache on a clean runner.
const backendGoModules = Smithers.Go.ModDownload({
  mod: Smithers.file("//go.mod"),
  sum: Smithers.file("//go.sum"),
  outDirs: ["//.backend-go-modcache"],
  sandbox: { network: true },
  destinations: ["proxy.golang.org", "sum.golang.org", "storage.googleapis.com"]
})

// sqlc owns product row models; the backend suite regenerates and compiles them.
const backendSQLC = Smithers.Shell.Build({
  shell: "GOBIN=\"$PWD/.backend-sqlc\" go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.30.0",
  outDirs: ["//.backend-sqlc"],
  data: [Smithers.file("//go.mod")],
  sandbox: { network: true },
  timeout: "15m"
})

// `go test` streams megabytes of logs, so its failures rarely reach the
// output tail a failed target reports; they are repeated on stderr.
// The backup, restore and upgrade-recovery suites run the PostgreSQL programs
// on PATH (`postgres` in the go-backend job, pkgs.postgresql_18 on the Cloud
// machine); without them the suite fails instead of skipping them.
const backendGo = Smithers.Shell.Test({
  shell: "export PATH=\"$PWD/.backend-sqlc:$PATH\"; if [ -z \"${SMITHERS_POSTGRES_TEST_BIN:-}\" ]; then pg_ctl_path=$(command -v pg_ctl) || { echo 'PostgreSQL 18 programs (pg_ctl, initdb, pg_dump, psql) must be on PATH for the backend backup and restore tests' >&2; exit 1; }; export SMITHERS_POSTGRES_TEST_BIN=\"${pg_ctl_path%/*}\"; fi; export SMITHERS_FFI_LIBRARY_PATH=\"$PWD/.native-ffi/target/debug/libsmithers_ffi.so\"; export SMITHERS_WIKI_TEST_FFI=\"$SMITHERS_FFI_LIBRARY_PATH\"; export GOMODCACHE=\"$PWD/.backend-go-modcache\"; bash scripts/check-sqlc-drift.sh || exit $?; go test -run '^$' ./packages/backend/db/product || exit $?; python3 -B -m unittest scripts/test_check_go_boundaries.py packages/backend/db/product/test_adopt_unit.py || exit $?; bash scripts/check-public-backend-boundary.sh || exit $?; sh scripts/test-backend-consumer.sh || exit $?; unformatted=$(gofmt -l packages/backend apps/backend distribution docs/api) || exit $?; test -z \"$unformatted\" || { printf 'gofmt -w needed:\\n%s\\n' \"$unformatted\"; exit 1; }; go build ./packages/backend/... ./apps/backend/... ./distribution/... ./docs/api/... || exit $?; go vet ./packages/backend/... ./apps/backend/... ./distribution/... ./docs/api/... || exit $?; log=$(mktemp) || exit $?; go test -count=1 ./packages/backend/... ./apps/backend/... ./distribution/... ./docs/api/... >\"$log\" 2>&1; status=$?; cat \"$log\"; if [ $status -ne 0 ]; then printf 'go test failures:\\n' >&2; grep -E -A30 '^[[:space:]]*--- FAIL|^panic:|^FAIL' \"$log\" | head -n 400 >&2; fi; rm -f \"$log\"; exit $status",
  env: {
    GOFLAGS: "-buildvcs=false -mod=readonly",
    GOMAXPROCS: "2",
    SMITHERS_REQUIRE_DATABASE_TESTS: "1",
    GOPROXY: "off",
    // Every suite creates and drops its own databases through this server.
    SMITHERS_TEST_DATABASE_URL: "postgres://smithers:smithers-backend-test@127.0.0.1:55435/postgres?sslmode=disable"
  },
  data: [
    backendGoModules,
    backendSQLC,
    Smithers.file("//scripts/check-sqlc-drift.sh"),
    Smithers.file("//scripts/check-go-boundaries.py"),
    Smithers.file("//scripts/check-public-backend-boundary.sh"),
    Smithers.file("//scripts/test-backend-consumer.sh"),
    Smithers.file("//scripts/test_check_go_boundaries.py"),
    nativeFfi,
    modelHostPackage.lib,
    integrationsPackage.lib,
    flowsPackage.lib,
    // The bootstrap regression starts the production coding-host seat layers.
    codingFlowsPackage.codingHostInputs,
    workspace,
    Smithers.file("//pnpm-lock.yaml"),
    Smithers.glob("//apps/model-host/src/**/*.ts"),
    Smithers.file("//apps/model-host/build.mjs"),
    Smithers.file("//apps/model-host/package.json"),
    Smithers.file("//go.mod"),
    Smithers.file("//go.sum"),
    Smithers.file("//packages/rpc/contracts/app-bootstrap-v1.schema.json"),
    Smithers.glob("//packages/backend/**/*"),
    Smithers.glob("//apps/backend/**/*"),
    Smithers.glob("//distribution/**/*"),
    Smithers.glob("//docs/api/**/*")
  ],
  services: [backendPostgres],
  sandbox: { network: "loopback" },
  timeout: "30m"
})

// The product API spec is bundled from one source per tag, so changes under
// different tags never edit the same file. `run` re-bundles; `lint` fails when
// the committed docs/api/openapi.yaml is stale.
const openapiBundle = Smithers.Generate({
  summary: "Bundle docs/api/openapi.yaml from its per-tag sources and drift-check it.",
  script: Smithers.file("//scripts/openapi-bundle.mjs"),
  data: [Smithers.glob("//docs/api/openapi/*.yaml")],
  changes: ["docs/api/openapi.yaml"]
})

// The Go and TypeScript product API clients are generated from the bundle.
// `run` regenerates both; `lint` fails when either is stale.
const openapiClients = Smithers.Generate({
  summary: "Generate the Go and TypeScript product API clients from docs/api/openapi.yaml and drift-check them.",
  script: Smithers.file("//scripts/openapi-clients.mjs"),
  data: [Smithers.file("//docs/api/openapi.yaml")],
  changes: ["packages/backend/apiclient/client.gen.go", "packages/smithers/src/internal/backend/ProductApi.ts"]
})

const nativeFilesystem = [{
  package: "smithers-ffi",
  binary: "smithers-jj-export",
  toolchain: "1.98.0",
  environment: "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY",
  platforms: ["linux", "darwin", "win32"]
}] as const

// Cheap drift checks retain a verdict for every commit independently of full CI.
const driftCi = Smithers.GithubCiGen({
  workflowName: "Drift",
  output: ".github/workflows/drift.yml",
  concurrency: "commit",
  workflowDispatch: false,
  knownRed: ".github/ci-known-red.json",
  mode: "check",
  requiredJobs: ["drift"],
  jobs: [{
    id: "drift",
    name: "Per-commit drift",
    runsOn: ubuntu,
    timeoutMinutes: 10,
    toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], apt: bubblewrap }),
    steps: [
      { name: "Formatting", verb: Smithers.Verb.Lint, pattern: "//...:fmt" },
      { name: "Target index drift", verb: Smithers.Verb.Lint, pattern: "//:targetIndex" },
      { name: "OpenAPI bundle drift", verb: Smithers.Verb.Lint, pattern: "//:openapiBundle" },
      { name: "OpenAPI client drift", verb: Smithers.Verb.Lint, pattern: "//:openapiClients" },
      { name: "Documentation drift", verb: Smithers.Verb.Lint, pattern: "//scripts:docsDrift" },
      { name: "Declaration baseline", verb: Smithers.Verb.Build, pattern: "//scripts:apiBaseline" },
      { name: "Conflict markers", verb: Smithers.Verb.Lint, pattern: "//scripts:conflictMarkers" },
      { name: "Tracked file hygiene", verb: Smithers.Verb.Lint, pattern: "//scripts:trackedHygiene" },
      { name: "Generated drift workflow", verb: Smithers.Verb.Lint, pattern: "//:driftCi" }
    ]
  }]
})

const ci = Smithers.GithubCiGen({
  summary: "Regenerate and drift-check .github/workflows/ci.yml, the pipeline definition (not the run itself).",
  featured: true,
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  workflowDispatch: false,
  // Targets already red on main, each with an owner and an expiry. A step
  // fails only on a red target this list does not name, so a new regression
  // stands out from the known ones. Delete an entry in the change that fixes it.
  knownRed: ".github/ci-known-red.json",
  // Every step writes its per-label results file and each job uploads them, so
  // a check receipt reads a target's status from CI, never from the log (#3663).
  results: true,
  mode: "check",
  gates: [
    { name: "documentation parity", verb: Smithers.Verb.Docs, pattern: "//packages/...", job: "test" },
    { name: "example typecheck", verb: Smithers.Verb.Build, pattern: "//examples/...", job: "test" },
    { name: "example suite", verb: Smithers.Verb.Test, pattern: "//examples/...", job: "test" },
    { name: "shared Go backend", verb: Smithers.Verb.Test, pattern: "//:backendGo", job: "go-backend" },
    { name: "native FFI compiler and tests", verb: Smithers.Verb.Build, pattern: "//:nativeFfi", job: "rust-ffi" },
    { name: "web bundle compatibility", verb: Smithers.Verb.Test, pattern: "//scripts:webBundleContract" }
  ],
  requiredJobs: [
    "test",
    "repository",
    "scripts",
    "docs",
    "apps-e2e",
    "rust",
    "wasm-repro",
    "browser",
    "e2e-faults",
    "packages",
    "go-backend",
    "rust-ffi"
  ],
  jobs: [
    {
      id: "test",
      name: "workspace graph (coverage gates enforced)",
      runsOn: ubuntu,
      // Run 36319330660 exceeded 120 min before this split; keep the workspace budget.
      // Remote-cache hits and the remaining workspace budget are tracked in #2254.
      timeoutMinutes: 180,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        postgres,
        docker: dockerImageStore,
        workflowLint: Smithers.CiToolchain.Actionlint({
          release: "1.7.11",
          workflows: [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/release-auth.yml",
            ".github/workflows/apps-deploy.yml",
            ".github/workflows/distribution.yml",
            ".github/workflows/canary.yml",
            ".github/workflows/reliability.yml",
            ".github/workflows/native-windows.yml",
            ".github/workflows/mirror-sync.yml",
            ".github/workflows/drift.yml"
          ]
        })
      }),
      steps: [
        { name: "Examples", verb: Smithers.Verb.Ci, pattern: "//examples/..." },
        { name: "Workspace targets", verb: Smithers.Verb.Ci, pattern: "//packages/...", parallelism: 2 }
      ]
    },
    {
      // Everything the workspace graph used to run after its package step.
      // None of it reads that step's results, so it starts with the other
      // gates instead of queueing behind ~95 minutes of packages (#2361).
      id: "repository",
      name: "repository flows, apps and evals",
      runsOn: ubuntu,
      // Run 36691217680: these steps took ~24 min inside the workspace graph;
      // leave room for the package builds they no longer share with it.
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        postgres,
        docker: dockerImageStore
      }),
      steps: [
        // The registry and migrate-detector checks over flows/. `//flows/...`
        // would also select the 45-minute codingNative/codingBundle gates.
        { name: "Repository flows", verb: Smithers.Verb.Test, pattern: "//flows:pack" },
        // The one case that proves the coding host's judge tunnels through the
        // egress proxy its environment names instead of dialling the gateway
        // directly. `//flows:pack` does not reach it, and the repo-contract
        // grep beside it bans identifiers, not behaviour: a composition that
        // keeps the approved spelling and hands it an environment naming no
        // proxy passes that gate and fails this one.
        { name: "Judge egress", verb: Smithers.Verb.Test, pattern: "//flows:egress" },
        // The repository, wiki and release-content fixtures.
        // `//flows:pack` reaches none of them and neither did any other job, so
        // until these two steps existed the only thing that ran them was
        // `pnpm test` inside flows/, which no workflow invokes. The seven
        // fixtures that skip themselves without the Plue adapter and exporter
        // are deliberately not here: they are declared in the native gate,
        // where a missing prerequisite refuses instead of skipping.
        { name: "Repository flow fixtures", verb: Smithers.Verb.Test, pattern: "//flows:repository" },
        { name: "Wiki and release fixtures", verb: Smithers.Verb.Test, pattern: "//flows:fixtures" },
        // ESLint and dprint over the flows tree: `//flows:lint` and `//flows:fmt`.
        { name: "Repository flows lint", verb: Smithers.Verb.Lint, pattern: "//flows/..." },
        { name: "Public export JSDoc", verb: Smithers.Verb.Lint, pattern: "//:jsdocTree" },
        { name: "Script lint", verb: Smithers.Verb.Lint, pattern: "//scripts:lint" },
        { name: "JSDoc rule harness", verb: Smithers.Verb.Test, pattern: "//:jsdocRules" },
        { name: "Factory harness", verb: Smithers.Verb.Test, pattern: "//:factoryHarness" },
        // Every `evals/*` directory is its own workspace member now, so each
        // one's targets carry the standard `check`/`test` names and run from
        // the directory that pins their toolchain.
        {
          name: "Agent eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/agent:test"
        },
        { name: "Agent eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/agent:check" },
        // The authoring fine-tune's dataset validator. It reads the committed
        // `data/pilot-sft.jsonl` and nothing else, so it gates offline; the
        // Fireworks upload and training targets beside it are `run`-verb only
        // and never enter a `ci` graph.
        {
          name: "Authoring eval dataset (offline)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/authoring:test"
        },
        { name: "Authoring eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/authoring:check" },
        // Offline fixtures need only the workspace install. Docker and funded
        // benchmark runs remain operator commands.
        { name: "SWE-bench offline fixtures", verb: Smithers.Verb.Test, pattern: "//evals/swebench:offline", parallelism: 1 },
        { name: "SWE-bench rig typecheck", verb: Smithers.Verb.Build, pattern: "//evals/swebench:check" },
        { name: "SWE-bench rig lint", verb: Smithers.Verb.Lint, pattern: "//evals/swebench/..." },
        // Apps and repository flows have separate source roots from packages.
        // Keep the review flow and its seeded-bug eval in the required gates.
        { name: "Server typecheck and tests", verb: Smithers.Verb.Ci, pattern: "//apps/server/..." },
        { name: "Review flow", verb: Smithers.Verb.Ci, pattern: "//flows/review/..." },
        { name: "Bug worker", verb: Smithers.Verb.Ci, pattern: "//apps/bug-worker/..." },
        { name: "Project copy drift", verb: Smithers.Verb.Lint, pattern: "//:projectCopy" },
        // smithers.sh: the landing page and the Starlight docs. `astro check`
        // and `astro build` over apps/site/src/content/docs.
        { name: "Site", verb: Smithers.Verb.Ci, pattern: "//apps/site/..." },
        {
          name: "Review eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/review-seeded-bugs/..."
        },
        {
          name: "Review eval typecheck",
          verb: Smithers.Verb.Build,
          pattern: "//evals/review-seeded-bugs:check"
        },
        // The command-recommender scorer: hit@5, top-1, and coverage over the
        // server's recommendation log. Offline: it scores a checked-in
        // fixture and gates on its baseline; the live pull is operator-run.
        {
          name: "Recommend eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/recommend/..."
        },
        {
          name: "Recommend eval typecheck",
          verb: Smithers.Verb.Build,
          pattern: "//evals/recommend:check"
        },
        // The fault matrix no longer typechecks here. It used to need its own
        // step because it was its own workspace member with its own tsconfig;
        // every case now lives in the package it tests, under `test/faults`,
        // which that package's `check` already covers through the
        // `//packages/...` step above. The reason for the check is unchanged:
        // a stale fixture is deterministic and cheap to catch, and
        // `fixtures/claimChild.ts` once called the removed `Control.pause` and
        // died at runtime in every case that spawned it.
        { name: "Generated workflow drift", verb: Smithers.Verb.Lint, pattern: "//:ci" },
        // The factory projection smithers.sh serves from the public mirror:
        // the featured flows, the Dispatcher table, and the homepage,
        // declared in .smithers/FACTORY.ts, rendered over the flows/ tree,
        // checked in.
        { name: "Factory projection drift", verb: Smithers.Verb.Lint, pattern: "//:factoryProjection" },
        // The declaration-derived target index smithers.sh reads from the
        // public mirror, one row per labeled target, checked in.
        { name: "Target index drift", verb: Smithers.Verb.Lint, pattern: "//:targetIndex" }
      ]
    },
    {
      id: "scripts",
      name: "script gates",
      runsOn: ubuntu,
      // Run 36369423415: 13m18s; leave room for uncached work.
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        postgres,
        docker: dockerImageStore,
        artifacts: Smithers.CiToolchain.Artifacts({
          artifact: "ci-test-tier-evidence",
          sources: [
            { from: "/tmp/smithers-ci-inventory-*.json" },
            { from: "/tmp/smithers-mutations-*" },
            { from: "/tmp/smithers-benchmark-*" },
            { from: "/tmp/smithers-runner-*.log" },
            { from: "/tmp/smithers-runner-*.json" }
          ]
        })
      }),
      steps: [{ name: "Script gates", verb: Smithers.Verb.Test, pattern: "//scripts/..." }]
    },
    {
      // Source parity and site builds stay together in the independent docs gate.
      id: "docs",
      name: "package documentation sites",
      runsOn: ubuntu,
      // Run 36369423415: 14m19s; leave room for uncached site builds.
      timeoutMinutes: 45,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], apt: bubblewrap }),
      steps: [{ name: "Package docs sites", verb: Smithers.Verb.Ci, pattern: "//apps/docs/..." }]
    },
    {
      id: "apps-e2e",
      name: "apps e2e (Playwright T1)",
      runsOn: ubuntu,
      // Setup ~2 min, check 1, unit tests 7, conformance 1, then browserE2e ~22 min under its 30m
      // target timeout and the TUI ~10 (run 36369423415): ~43 typical, ~52 worst.
      timeoutMinutes: 70,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        artifacts: Smithers.CiToolchain.Artifacts({
          artifact: "apps-e2e-artifacts",
          sources: [
            { from: "/tmp/smithers-*.png" },
            { from: "apps/reports", as: "reports" },
            { from: "apps/app/test-results", as: "playwright-test-results" },
            { from: "apps/app/playwright-report", as: "playwright-report" }
          ]
        })
      }),
      // Fail the UI's Linux checks promptly, without waiting behind the
      // workspace graph. Each tier remains a required, separate command.
      steps: [
        { name: "UI typecheck", verb: Smithers.Verb.Build, pattern: "//apps/app:check" },
        { name: "UI unit tests", verb: Smithers.Verb.Test, pattern: "//apps/app:unitTests" },
        // The literal pin left the unit gate when `src/` became app source
        // only; it is its own lint target over `apps/app/lint/conformance`.
        { name: "UI conformance lint", verb: Smithers.Verb.Test, pattern: "//apps/app:conformance" },
        { name: "UI browser end-to-end suite", verb: Smithers.Verb.Test, pattern: "//apps/app:browserE2e" },
        // The terminal UI's typecheck, lint, format check and Bun suite. Its
        // shell-change capture runs the native helper this job installs.
        { name: "TUI typecheck, lint and tests", verb: Smithers.Verb.Ci, pattern: "//apps/tui/..." },
        // The browser and tmux tiers are exclusive, so the wildcards above omit
        // them and each runs here by label.
        { name: "TUI end-to-end suite", verb: Smithers.Verb.Test, pattern: "//apps/tui:e2eTests" }
      ]
    },
    {
      id: "rust",
      name: "rust fmt + clippy + test",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node],
        rust: Smithers.CiToolchain.Rust({})
      }),
      steps: [
        { name: "Cargo lint gates", verb: Smithers.Verb.Lint, pattern: "//crates/flows-jj/..." },
        { name: "Third-party notices", verb: Smithers.Verb.Test, pattern: "//scripts:thirdPartyNotices" },
        { name: "Cargo test suite", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:cargoTest" }
      ]
    },
    {
      id: "rust-ffi",
      name: "native FFI compiler and tests",
      runsOn: ubuntu,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node],
        jj,
        ripgrep,
        apt: bubblewrap,
        rust: Smithers.CiToolchain.Rust({ cache: false })
      }),
      steps: [{ name: "Native FFI clippy and tests", verb: Smithers.Verb.Build, pattern: "//:nativeFfi" }]
    },
    {
      id: "wasm-repro",
      name: "wasm reproducibility",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node],
        rust: Smithers.CiToolchain.Rust({ cache: false })
      }),
      steps: [
        { name: "Build-script unit tests", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:buildScript" },
        {
          name: "Rebuild and byte-compare flows_jj.wasm",
          verb: Smithers.Verb.Test,
          pattern: "//crates/flows-jj:wasmReproducibility"
        }
      ]
    },
    {
      // The fault-injection matrix: eighteen crash, restart, served-control,
      // time-travel, provider, and safety cases, plus the primitive suites
      // under them, that each inject a real fault into a real process. Until
      // this job existed the matrix ran under no gate at all.
      //
      // It is one job over every package that declares a `faults` target, not
      // one job over a directory. The matrix used to be a workspace member of
      // its own, `e2e/`, which owned every case in the repository and was the
      // only place they could live; each case now sits in the package whose
      // behaviour it asserts, and `//packages/...:faults` selects all of them.
      //
      // FaultSuite marks its target exclusive, so ordinary workspace CI and
      // package-suite wildcards omit it. The explicit matrix selects the tier;
      // the executor runs each exclusive target alone. Keep `-j 1` here to
      // state the job's serial intent, and `fileParallelism: false` in each
      // vitest.faults.config.ts to serialize cases within a target.
      //
      // Required. It was advisory while `case22 ... redacts the credential out
      // of the operator's terminal` was red by design: rc.0
      // shipped no redacting logger, so a required job would have been red on
      // every commit for a defect no commit introduced. The redaction
      // deliverable landed that logger (`@smthrs/journal`
      // `RedactedLogger`, installed by `packages/smithers/src/bin.ts` and
      // `packages/smithers/flows/src/NodeRuntime.ts`), the case is green in both
      // halves, and the matrix is 67 of 67. The durable-park defect the old
      // comment also named is a COVERAGE gap, not a red case: no case reaches
      // it (`scripts/repo-contract/fault-gaps.md`, the `03, 05, 31` row), so
      // nothing here fails for it and it cannot make this job red. A gate that
      // is green is a gate that can hold the line.
      //
      // `jj` is a real requirement here, not a convenience: cases 12 and 21
      // drive a real Jujutsu workspace and are written to throw rather than
      // skip on CI.
      id: "e2e-faults",
      name: "fault-injection matrix",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node],
        jj
      }),
      steps: [{ name: "Exclusive fault matrix", verb: Smithers.Verb.Test, pattern: "//packages/...:faults", parallelism: 1 }]
    },
    {
      id: "browser",
      // This historical job id is pinned by the release roster contract.
      // The displayed name and selected suite describe compilation, not E2E.
      name: "web bundle compatibility",
      runsOn: ubuntu,
      timeoutMinutes: 10,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node] }),
      steps: [{ name: "Web bundle compilation guard", verb: Smithers.Verb.Test, pattern: "//scripts:webBundleContract" }]
    },
    {
      // One matrix over the three platforms, replacing the two copy-pasted
      // advisory jobs `node-macos` and `node-windows` and adding a required
      // ubuntu row. The steps, the toolchain, and the timeout are declared
      // once, so a platform can never drift into running a different suite
      // than its neighbours.
      //
      // The ubuntu row re-runs package test targets the required `test` job
      // already covers: that job runs `ci '//packages/...'`, and the `ci` verb
      // aggregates Build, Test, Lint, and Docs. The two jobs run concurrently,
      // so the remote cache does not dedupe them, and ubuntu pays the package
      // suites twice per run. That cost buys a truthful `requiredJobs`: with no
      // required row, `packages` could be deleted or turned all-advisory and
      // nothing would fail. Drop the ubuntu row only together with `packages`
      // in `requiredJobs`.
      //
      // The advisory bit is per row, and it is data: `continue-on-error` reads
      // `matrix.advisory` out of the `include:` rows below, because the
      // generator's only `if:` is the cache-publish guard (unused here) and a
      // job-level `continue-on-error: true` would excuse ubuntu along with the
      // rest. ubuntu is required. macOS and
      // Windows are advisory ONLY until the matrix proves them green; promoting
      // one is flipping its boolean to `false`, and `requiredJobs` already
      // names `packages`, so at least one row must stay required.
      //
      // Windows red today (run 33441825323, job 99651619667) was the build tool
      // itself: `packageManagerEnvironment` held `process.env` to the POSIX
      // name rule, and `windows-latest` sets `ProgramFiles(x86)`, so every
      // target died in 13 s with "environment source contains a non-portable
      // name" before a single suite ran.
      id: "packages",
      name: "package suites (${{ matrix.os }})",
      matrix: [
        { os: ubuntu, advisory: false },
        { os: "macos-latest", advisory: true },
        { os: "windows-latest", advisory: true }
      ],
      // Windows ran the suites in ~48 min before twelve packages also ran on PostgreSQL (f59d673cd); 60 cut it off.
      timeoutMinutes: 90,
      toolchain: Smithers.CiToolchain.Needs({
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: packageSystemTools,
        go,
        foundry,
        postgres,
        docker: dockerImageStore
      }),
      // Match the workspace gate's bound: each suite also runs Vitest workers,
      // so host-sized package concurrency multiplies process and memory load.
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/...", parallelism: 2 }]
    },
    {
      id: "go-backend",
      name: "shared Go backend (PostgreSQL)",
      runsOn: ubuntu,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        // A box's coding host binds its checkout through smithers-jj-export (#2194).
        cargoBinaries: nativeFilesystem,
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        postgres,
        docker: dockerImageStore
      }),
      steps: [{ name: "Build and test shared backend", verb: Smithers.Verb.Test, pattern: "//:backendGo" }]
    }
  ]
})

// The two workspace-wide model reviews. They cover every package's sources
// with one wildcard rather than a hand-kept list of packages, so a new package
// is under both rubrics the day it exists. A package that wants a narrower or
// stricter review of its own declares one from the same macro in its own
// PACKAGE.ts, the way the storage packages declare `reviewTagsMigrationsAndKeys`.
const reviewDocsAgainstCode = ReviewDocsAgainstCode({
  cwd: ".",
  featured: true,
  include: [
    Smithers.glob("//packages/*/src/**"),
    Smithers.glob("//packages/*/*/src/**"),
    Smithers.glob("//packages/*/*/*/src/**")
  ],
  context: [
    Smithers.glob("//packages/*/README.md"),
    Smithers.glob("//packages/*/*/README.md"),
    Smithers.glob("//packages/*/*/*/README.md"),
    // Keep the shared context below LlmLint's 2 MiB cap. Package-level
    // reviews can opt into their full local docs; this overview selects
    // concepts plus the runtime and build API sections explicitly.
    Smithers.glob("//apps/site/src/content/docs/docs/concepts/*.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/flows.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/flow.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/plan.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/journal.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/targets.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/build.mdx"),
    Smithers.glob("//apps/site/src/content/docs/docs/reference/api/build-cli.mdx")
  ]
})

const reviewJsdocAgainstCode = ReviewJsdocAgainstCode({
  cwd: ".",
  featured: true,
  include: [
    Smithers.glob("//packages/*/src/**/*.ts"),
    Smithers.glob("//packages/*/*/src/**/*.ts"),
    Smithers.glob("//packages/*/*/*/src/**/*.ts")
  ]
})

/**
 * Lints public package sources under the repository-default JSDoc convention.
 *
 * @since 1.0.0
 * @category lint
 */
const jsdocTree = Smithers.EsLint({
  sources: [
    Smithers.glob("packages/*/src/**/*.ts"),
    Smithers.glob("packages/*/*/src/**/*.ts"),
    Smithers.glob("packages/*/*/*/src/**/*.ts")
  ],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig],
  deps: [],
  maxWarnings: 0,
  fix: false
})

/**
 * The repository's custom JSDoc rule harness: `eslint.jsdoc.js` exports the
 * module-header rule and the convention config, and this suite runs both
 * through ESLint's `Linter` against sample sources. It sits at the root
 * because the config it tests does, and `pnpm run test:jsdoc` is the operator
 * alias.
 *
 * @since 0.1.0
 * @category test
 */
const jsdocRules = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//eslint.jsdoc.test.mjs")]),
  srcs: [
    Smithers.file("//eslint.jsdoc.test.mjs"),
    Smithers.file("//eslint.jsdoc.js"),
    Smithers.file("//eslint.config.js")
  ],
  deps: []
})

/**
 * The factory flows' shared harness: workspace package identities, package
 * selection, confinement and process guards, plus the queue inventory (every
 * retained queue prompt names its issue and is queued). `factory/` has no
 * manifest of its own, so the root owns the suites; they are written against
 * `bun:test`.
 *
 * @since 1.0.0
 * @category test
 */
const factoryHarness = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testRunner([
    Smithers.file("//factory/flows/harness.test.ts"),
    Smithers.file("//factory/queue/queue.test.ts")
  ]),
  srcs: [
    Smithers.glob("//factory/flows/*.ts"),
    Smithers.glob("//factory/queue/*.md"),
    Smithers.file("//scripts/workspace-packages.mjs")
  ],
  deps: []
})

/**
 * The commit-level `CHANGELOG.md` section for the version the manifests carry.
 *
 * `Generate`'s kinds are `run` and `lint`, not `build` and `lint`, so writing
 * is `smithers-build run '//:changelog'` and drift-checking is
 * `smithers-build lint '//:changelog'`. The rule is uncacheable by
 * construction, which is what a generator reading git history needs: no cache
 * entry can outlive the commit that invalidates it.
 *
 * The declared inputs are the three files the generator reads. Its fourth
 * input is the commit range, and there is no input declaration for one. The
 * consequence is visible under `lint`: a check runs the generator against a
 * scratch copy of the tree that deliberately carries no `.git`, so the check
 * proves the block is the canonical rendering of the commits it names, not
 * that it still matches history. The gate that proves it against history is
 * the `Release changelog section` step in `.github/workflows/release.yml`,
 * which runs in a full checkout at the tag.
 *
 * @since 1.0.0
 * @category build
 */
const changelog = Smithers.Generate({
  summary: "Regenerate and drift-check the CHANGELOG.md commit section for the current version.",
  featured: true,
  script: Smithers.file("//scripts/generate-changelog.mjs"),
  data: [
    Smithers.file("//CHANGELOG.md"),
    Smithers.file("//package.json"),
    Smithers.file("//packages/smithers/package.json")
  ],
  changes: ["CHANGELOG.md"]
})

// Every nesting depth, in one brace pattern, because a declaration takes one
// glob and the marker rule already decides the rest: a directory synthesizes
// the standard targets only when it has a `package.json` and no `PACKAGE.ts`.
// The depths are spelled out rather than written `packages/**` so a build's
// `dist` tree can never be mistaken for a package.
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/{*,*/*,*/*/*}",
  macro: BuildAndCheckTypeScriptPackage
})

// Security review of the files the root owns and no nested PACKAGE.ts does:
// the GitHub workflows, the self-host distribution image, the native FFI
// crate, the factory harness, install-time hooks and patches, and the public
// `.smithers` projections. `crates/flows-jj`, `scripts`, `flows`, `examples`,
// `apps`, `evals`, and `packages` have their own reviewers.
const securityReview = Smithers.SecurityReview({
  cwd: ".",
  include: [
    "PACKAGE.ts",
    "package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".pnpmfile.mjs",
    "flake.nix",
    ".github/workflows/*.yml",
    ".github/scripts/*.sh",
    ".smithers/*.ts",
    ".smithers/*.json",
    ".smithers/workflows/*.tsx",
    "distribution/*",
    "crates/smithers-ffi/Cargo.toml",
    "crates/smithers-ffi/src/*.rs",
    "factory/flows/*.ts",
    "patches/*.patch"
  ],
  checks: [
    {
      id: "gha-untrusted-trigger-secrets",
      title: "Jobs a fork pull request or a comment can start hold no write credential",
      threat:
        "An outside contributor opens a pull request or comments on an issue and runs code that steals the cache write token, npm token, Cloudflare token, mirror token, or an OIDC review identity.",
      lookFor: [
        "SMITHERS_CACHE_WRITE_TOKEN, NPM_TOKEN, CLOUDFLARE_API_TOKEN, IDENTITY_SERVICE_TOKEN, SMITHERS_CLOUD_MIRROR_TOKEN, or CANARY_SESSION_COOKIE referenced by a job that a pull_request or issue_comment event can reach, or by a job without an `environment:` gate.",
        "A pull_request_target or workflow_run trigger that checks out or executes the pull request head.",
        "The `ci` declaration in PACKAGE.ts that generates ci.yml putting a write secret or `cache-publish` step on a job whose `if:` admits pull_request."
      ],
      paths: [".github/workflows/*.yml", "PACKAGE.ts"]
    },
    {
      id: "gha-expression-injection",
      title: "Workflow expressions never splice untrusted text into a shell script",
      threat:
        "A contributor who controls a branch name, PR title, or dispatch input runs arbitrary commands on a runner that holds repository secrets.",
      lookFor: [
        "`${{ github.event.* }}`, `${{ github.head_ref }}`, or `${{ inputs.* }}` interpolated directly inside a `run:` block instead of passed through `env:` and quoted.",
        "release.yml sourceRef, releaseTag, or candidateRunId used before the step that checks it is a full hex SHA, a v<version> tag, or reachable from origin/main.",
        "A third-party `uses:` pinned to a tag or branch instead of a 40-character commit SHA."
      ],
      paths: [".github/workflows/*.yml"]
    },
    {
      id: "release-artifact-provenance",
      title: "Only a tested candidate built from main reaches npm",
      threat:
        "A contributor or a poisoned artifact from another run publishes a malicious @smthrs package to every npm user.",
      lookFor: [
        "The candidateRunId and candidateArtifactId restore path accepting an artifact from a run that a pull_request, a fork, or a non-release workflow produced.",
        "The npm publish step reachable when dryRun is true, when sourceRef is set, or from a tag not on main.",
        "NODE_AUTH_TOKEN or id-token: write present in steps that run repository scripts or `pnpm install` without --ignore-scripts before publication."
      ],
      paths: [".github/workflows/release.yml", ".github/workflows/release-auth.yml"]
    },
    {
      id: "distribution-image-hardening",
      title: "The self-host image runs unprivileged and verifies what it downloads",
      threat:
        "A network attacker or a crafted backup gives code execution or file overwrite inside a self-hoster's Smithers container and its PostgreSQL data.",
      lookFor: [
        "A Dockerfile download (curl, cargo install --git, go mod download) without a pinned digest, SHA, or --locked, or a final stage that does not end with `USER smithers`.",
        "restore.sh extracting files.tar where a symlink entry followed by a path through it can write outside SMITHERS_DATA_ROOT, since verify_backup only rejects absolute and `..` names.",
        "SMITHERS_DATABASE_URL, which carries the database password, passed on a command line (pg_dump, psql --dbname) or printed in a `die` message.",
        "A FROM base image (rust, debian, node, golang, postgres, oven/bun) pinned by tag rather than by @sha256 digest.",
        "SMITHERS_AUTH_MODE, SMITHERS_LIB, or SMITHERS_RELEASE_FILE taken from the environment in a way that disables selfhost auth or sources an attacker-chosen script."
      ],
      paths: ["distribution/*"]
    },
    {
      id: "ffi-path-confinement",
      title: "Native file operations never follow a symlink or escape their root",
      threat:
        "A repository author or agent inside a workspace plants a symlink or races a rename so the host reads or overwrites files outside that workspace, including another tenant's checkout.",
      lookFor: [
        "A path component opened without O_NOFOLLOW or openat relative to a held directory fd in atomic_fs.rs, workspace_files.rs, workspace_local.rs, or tree_export.rs.",
        "A check-then-use sequence (symlink_metadata or canonicalize, then a separate open by path) that a concurrent rename can win.",
        "A caller-supplied relative path joined to a root without rejecting absolute paths, `..`, NUL, or Windows drive and UNC prefixes."
      ],
      paths: [
        "crates/smithers-ffi/src/atomic_fs.rs",
        "crates/smithers-ffi/src/atomic_windows_fs.rs",
        "crates/smithers-ffi/src/atomic_windows_handle.rs",
        "crates/smithers-ffi/src/file_eligibility.rs",
        "crates/smithers-ffi/src/tree_export.rs",
        "crates/smithers-ffi/src/workspace_files.rs",
        "crates/smithers-ffi/src/workspace_local.rs"
      ]
    },
    {
      id: "ffi-git-transport",
      title: "Native git and jj invocations cannot be steered by repository or request data",
      threat:
        "A repository author or a crafted source-import request runs commands on the host, leaks the credential socket's token to another origin, or fetches from an attacker's server.",
      lookFor: [
        "A git or jj Command that does not env_clear, disable hooks, pin GIT_CONFIG_GLOBAL, or restrict protocol.allow before touching a checkout.",
        "A ref, URL, or path argument that can start with '-' or contain whitespace and reaches git argv without the exact-format check source_import.rs applies to refs/smithers/workspaces/.",
        "api_base_url or git_url accepted over plain http to a non-loopback host, or http.followRedirects enabled while the credential helper is set."
      ],
      paths: [
        "crates/smithers-ffi/src/source_import.rs",
        "crates/smithers-ffi/src/source_publish.rs",
        "crates/smithers-ffi/src/source_create.rs",
        "crates/smithers-ffi/src/smithers_jj_export.rs",
        "crates/smithers-ffi/src/workspace_engine.rs",
        "crates/smithers-ffi/src/workspace_source.rs"
      ]
    },
    {
      id: "ffi-abi-memory-safety",
      title: "Every exported C function validates its pointers and never unwinds across the ABI",
      threat:
        "A caller passing a null, dangling, or oversized buffer, or input that panics, corrupts memory in the Node or Go host process that serves every workspace.",
      lookFor: [
        "An `extern \"C\"` function in lib.rs that dereferences a pointer or calls from_raw_parts or CStr::from_ptr without a null and length check.",
        "An `extern \"C\"` function whose body is not routed through the catch_unwind `execute` wrapper, or code outside that wrapper that can panic on caller input.",
        "A returned buffer freed by a different allocator or free function than the one that allocated it, or freed twice."
      ],
      paths: ["crates/smithers-ffi/src/lib.rs"]
    },
    {
      id: "factory-agent-confinement",
      title: "Factory agent runs stay inside their allowed paths and environment",
      threat:
        "Text in a package README, source file, or queue item steers a headless `claude -p` agent into editing files outside its lane or reading the maintainer's credentials.",
      lookFor: [
        "An AgentTask whose --allowedTools grants unrestricted Bash, Write, or network tools, or whose environment is process.env rather than the agentEnvironment allowlist.",
        "The unscoped `Read` tool plus a real HOME letting an injected agent read ~/.ssh, ~/.claude, or ~/.config credentials and copy them into an allowed path that later lands in a commit.",
        "makeConfinementValidator skipped, or a task treated as successful when git reports changed paths outside allowedPaths plus logDir.",
        "Package names, file names, or file contents spliced into a prompt or a `pnpm --filter` argument without the selectPackages validation."
      ],
      paths: ["factory/flows/*.ts"]
    },
    {
      id: "install-hook-supply-chain",
      title: "Install-time hooks, patches, and build allowlists add no hidden code execution",
      threat:
        "A contributor slips code into a dependency patch or pnpm hook that runs on every maintainer's machine and CI runner during install.",
      lookFor: [
        ".pnpmfile.mjs readPackage rewriting any package other than the classicCompilerTools names, or adding a dependency, script, or registry URL.",
        "A patches/*.patch hunk that adds a postinstall script, child_process or fetch call, or an eval into the patched package.",
        "pnpm-workspace.yaml allowBuilds admitting a package that has no documented need for an install script, or .npmrc adding a registry or auth line.",
        "flake.nix or the Dockerfile fetching a source without a pinned hash."
      ],
      paths: [".pnpmfile.mjs", ".npmrc", "pnpm-workspace.yaml", "patches/*.patch", "flake.nix", "distribution/Dockerfile"]
    },
    {
      id: "root-tool-targets",
      title: "Root run and shell targets execute only fixed commands with scoped secrets",
      threat:
        "A contributor who edits project.json or a Shell target runs commands on the maintainer's machine with the GitHub CLI's credentials or the cache write token.",
      lookFor: [
        "A ToolRun or Shell target whose command or args derive from repository data that a pull request can change, beyond repoAbout's description argument to `gh repo edit`.",
        "A Shell target with `sandbox: { network: true }` that also receives cacheWriteToken or another Smithers.Secret.",
        "A credential other than the documented local test database password hard-coded in an env block."
      ],
      paths: ["PACKAGE.ts"]
    },
    {
      id: "public-projection-leak",
      title: "Projections published to the public mirror carry no secrets or private infrastructure",
      threat:
        "A signed-out visitor to smithers.sh reads a token, private hostname, local filesystem path, or private repository name from the committed .smithers projections.",
      lookFor: [
        "A token, key, cookie, or Authorization value in factory.json, home.json, target-index.json, or coding-project.json.",
        "An absolute host path such as /Users/ or /home/, or a private repository or plue-only hostname, in those files.",
        "FACTORY.ts or WORKSPACE.ts naming a Secret by value instead of by Smithers.Secret, or a `github.push:main` trigger that runs a flow with write authority on unreviewed input."
      ],
      paths: [".smithers/*.json", ".smithers/*.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: {
    ...securityReview,
    backendGoModules,
    backendSQLC,
    backendGo,
    nativeFfi,
    commit,
    changelog,
    ci,
    driftCi,
    environmentToolchain,
    factoryHarness,
    factoryProjection,
    reviewDocsAgainstCode,
    jsdocRules,
    jsdocTree,
    reviewJsdocAgainstCode,
    lockfile,
    nodeModules,
    openapiBundle,
    openapiClients,
    projectCopy,
    repoAbout,
    targetIndex,
    tsconfig
  }
})

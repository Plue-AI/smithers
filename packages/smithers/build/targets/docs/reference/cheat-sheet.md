---
title: "Smithers API cheat sheet"
description: "The complete top-level Smithers API used in WORKSPACE.ts and PACKAGE.ts, shown through examples."
area: api
slug: cheat-sheet
order: 29
---

This is the consumer-facing `Smithers.*` surface used in `WORKSPACE.ts` and
`PACKAGE.ts`. Implementation actions, layers, schemas, parsers, guards, and
error classes are intentionally omitted.

## Workspace declarations

```ts
// .smithers/WORKSPACE.ts
import { Smithers as S } from "@smthrs/targets"

// Files, globs, changes, and workspace manifests
const packageJson = S.file("//package.json")
const lockfile = S.file("//pnpm-lock.yaml")
const workspaceYaml = S.file("//pnpm-workspace.yaml")
const sources = S.glob("//packages/*/src/**/*.ts", { exclude: ["**/*.test.ts"] })
const changedSources = S.gitDiff({
  base: "origin/main",
  paths: ["packages/**"],
  added: ["packages/**/*.ts"]
})
const workspacePackages = S.pnpmWorkspace("//pnpm-workspace.yaml")

// Secrets and origin-scoped HTTP secrets
const cacheRead = S.Secret("SMITHERS_CACHE_READ_TOKEN")
const cacheWrite = S.Secret("SMITHERS_CACHE_WRITE_TOKEN", {
  fallback: "development-only-value"
})
const githubToken = S.HttpSecret(S.Secret("GITHUB_TOKEN"), [
  "https://api.github.com",
  "https://uploads.github.com"
])

// Local and remote caches
const cache = S.Cache({
  directory: ".flows",
  remote: S.RemoteCache.make({
    endpoint: "https://cache.example.com",
    read: cacheRead,
    write: cacheWrite
  })
})

// Smithers Cloud (coming soon)
const smithersCloudCache = S.Cache({
  directory: ".flows",
  remote: S.RemoteCache.smithersCloud({
    repo: "acme/widgets",
    write: S.Secret("SMITHERS_CACHE_TOKEN")
  })
})

// Runtimes and their executables
const node = S.Runtime.Node({ version: ">=26.4.0" })
const nodeFromManifest = S.Runtime.Node({ manifest: packageJson })
const bun = S.Runtime.Bun({ version: ">=1.4.0" })
const runtimeExecutable = S.Runtime.bin
const oneOffNpxExecutable = S.Runtime.npx("react-scan@latest")

// Package managers and their executables
const pnpm = S.PackageManager.Pnpm({
  manifest: packageJson,
  lockfile,
  workspaces: workspaceYaml,
  version: "11.21.0",
  audit: { severity: "critical", recursive: true }
})
const yarn = S.PackageManager.Yarn({
  manifest: packageJson,
  lockfile: S.file("//yarn.lock"),
  version: "4.9.2"
})
const bunPackages = S.PackageManager.BunPackages({ runtime: bun })
const packageManagerExecutable = S.PackageManager.bin

// Installed node_modules tree
const nodeModules = S.Npm.NodeModules({
  packageJson,
  workspaces: workspaceYaml
})

// Host executables
const host = S.Host({ bins: ["git", "jj", "docker", "cargo", "go", "bash"] })
const hostGit = S.Host.bin("git")
const hostDocker = S.Host.bin("docker")

// Workspace flags become references such as flags.production
const flags = S.Flags({
  production: "--production",
  verbose: "--verbose",
  updateSnapshots: "--update"
})
const productionFlag = flags.production

// Mise and programs managed by Mise
const mise = S.Mise({ config: S.file("//.mise.toml") })
const miseZig = S.Mise.bin("zig")

// Nix environments
const nixFromFlake = S.Nix.Environment({ flake: S.file("//flake.nix") })
const nixFromFile = S.Nix.Environment({ file: S.file("//.smithers/environment.nix") })
const nixDevShell = S.Nix.DevShell({
  flake: S.file("//flake.nix"),
  lock: S.file("//flake.lock")
})
const nixNode = S.Nix.bin("node")

// Rust toolchains
const rust = S.Rust.Toolchain({
  workspace: S.file("//Cargo.toml"),
  toolchain: S.file("//rust-toolchain.toml"),
  lockfile: S.file("//Cargo.lock")
})
const rustByChannel = S.Rust.Toolchain({
  workspace: S.file("//Cargo.toml"),
  channel: "1.91"
})
const pinnedRust = S.Rust.Pinned({
  pin: S.file("//rust-toolchain.toml")
})

// Foundry and Go toolchains
const foundry = S.Foundry.Toolchain({
  config: S.file("//foundry.toml"),
  versions: mise
})
const go = S.Go.Toolchain({
  mod: S.file("//go.mod"),
  sum: S.file("//go.sum"),
  versions: mise,
  cgo: false,
  experiments: ["boringcrypto"]
})
const goExecutable = S.Go.bin

// Agents and pools
const agents = S.Agents({
  claude: S.Agent.ClaudeCode("opus"),
  codex: S.Agent.Codex({ model: "gpt-6-luna" }),
  reviewers: S.Agent.Pool(["claude", "codex"])
})
const reviewer = agents.reviewers

// Teams and ownership policy
const teams = S.Teams({
  platform: ["alice", "bob"],
  docs: ["carol"],
  security: ["dana"]
})
const owners = S.Owners.declare({
  owners: ["team:platform"],
  perFile: {
    "docs/**": ["team:docs"],
    "packages/security/**": ["team:security"]
  },
  noparent: true,
  agents: {
    default: "human-approve",
    "auto-land": ["docs/**"],
    deny: ["migrations/**"]
  },
  upstream: "review"
})

// Persistent agent memory
const memory = S.Memory.SmithersCloud({
  bank: ["acme/widgets"],
  autoInject: 8,
  init: {
    script: S.file("//scripts/init-memory.mjs"),
    secrets: [githubToken]
  }
})

// Sandbox implementations
const sandboxes = S.Sandboxes({
  none: S.Sandbox.None(),
  bubblewrap: S.Sandbox.Bubblewrap(),
  docker: S.Sandbox.Docker({ image: "node:22-bookworm" }),
  microsandbox: S.Sandbox.Microsandbox({ environment: nixFromFlake })
})

// Other repositories mounted into the workspace
const sharedRepository = S.LocalRepository("vendor/shared", { branch: "main" })

// Ordinary targets can be used as Git hooks
const preCommit = S.Shell.Test({ shell: "git diff --check" })

export default S.Workspace("acme", {
  repository: "git+https://github.com/acme/widgets.git",
  cache,
  runtime: node,
  packageManager: pnpm,
  nodeModules,
  environment: nixFromFlake,
  toolchains: [mise, rust, foundry, go],
  host,
  flags,
  agents,
  owners,
  teams,
  memory,
  sandboxes,
  repos: { shared: sharedRepository },
  gitHooks: { preCommit }
})
```

## Package declarations

```ts
import { Smithers as S } from "@smthrs/targets"

const test = S.Vitest({
  tests: [S.glob("test/**/*.test.ts")],
  sources: [S.glob("src/**/*.ts")],
  deps: [],
  config: null,
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/core"
})

export const Package = S.Package({
  defaultVisibility: "public",
  targets: { test }
})

// Apply a function you define to directories without PACKAGE.ts.
export const packageDefaults = S.PackageDefaults({
  directories: "packages/*",
  macro: ({ cwd }: { cwd: string }) => ({
    test: S.Vitest({
      tests: [S.glob("test/**/*.test.ts")],
      sources: [S.glob("src/**/*.ts")],
      deps: [],
      config: null,
      environment: "node",
      passWithNoTests: false,
      cwd
    })
  })
})
```

## Core graph and file rules

```ts
import { Smithers as S } from "@smthrs/targets"

const entry = S.file("src/index.ts")
const sources = S.glob("src/**/*.ts", { exclude: ["src/**/*.test.ts"] })
const tests = S.glob("test/**/*.test.ts")

const sourceFiles = S.Filegroup({ srcs: [entry, sources], cwd: "." })
const testFiles = S.Filegroup({ srcs: [tests], cwd: "." })

// Generate requires exactly one of emit, script, bin, or command
const generatedConstants = S.Generate({
  emit: {
    "generated/version.ts": "export const version = \"0.1.0\"\n",
    "generated/current": S.symlink("../src")
  },
  mode: "write"
})
const generatedFromScript = S.Generate({
  script: S.file("scripts/generate.mjs"),
  data: [sources],
  changes: ["generated/**"]
})
const generatedFromCommand = S.Generate({
  command: "node",
  args: ["scripts/generate.mjs"],
  data: [sources],
  changes: ["generated/**"]
})
const generatedFromBin = S.Generate({
  bin: S.NodeModule.Bin("@acme/codegen"),
  args: ["--input", "schema.json"],
  data: [S.file("schema.json")],
  changes: ["generated/**"]
})

const checks = S.Suite({ tests: [generatedConstants, generatedFromScript] })
const check = S.Alias(checks)
const sourceDigest = S.Files.digest(sourceFiles)
const sourceWithoutTests = S.Files.difference(sourceFiles, testFiles)

const goldenTest = S.Test({
  expect: sourceDigest,
  toBe: S.file("test/golden/source.digest")
})
const emptinessTest = S.Test({
  expect: S.Files.difference(sourceFiles, sourceFiles),
  toBe: "empty"
})

const writeGeneratedFiles = S.Materialize(generatedConstants)
const clean = S.Clean({
  targets: [generatedConstants],
  paths: ["dist", "coverage", ".cache"]
})
const copiedReadme = S.Copy({ from: S.file("README.md"), to: "dist/README.md" })
const literalLicense = S.Literal({ path: "dist/LICENSE", content: "MIT\n" })
const overlaidFiles = S.Overlay({
  base: sourceFiles,
  replace: { "src/config.ts": S.file("fixtures/config.production.ts") }
})
const markdownCode = S.Markdown.CodeBlocks({
  file: S.file("README.md"),
  lang: ["ts", "tsx"],
  context: [S.file("docs/context.d.ts")]
})
const importClosure = S.ImportClosure({ entries: [entry] })
const importClosureFiles = importClosure.files

const downloadedSchema = S.Fetch({
  url: "https://example.com/schema.tar.gz",
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  out: "vendor/schema.tar.gz"
})

const codeowners = S.Owners.Codeowners({ org: "acme", path: ".github/CODEOWNERS" })
const ownerTree = S.Owners.Tree({ file: "OWNERS" })

const nightly = S.Cron({
  schedule: "0 3 * * *",
  refresh: [downloadedSchema],
  run: [goldenTest]
})
```

## TypeScript, testing, linting, and documentation

`VitestCoverage` returns the shared `{ outputs }` manifest for its captured report
directory. `CoverageReport` aliases the `ToolBuild.Outputs` schema. Coverage and
watch runs default to a 1,200,000 ms timeout; set `timeoutMs` to override it.

```ts
import { Smithers as S } from "@smthrs/targets"

const entry = S.file("src/index.ts")
const sources = S.glob("src/**/*.ts", { exclude: ["src/**/*.test.ts"] })
const tests = S.glob("test/**/*.test.ts")
const tsconfigFile = S.file("tsconfig.json")
const packageJsonFile = S.file("package.json")

const tsconfig = S.Tsconfig({
  references: [],
  extends: S.file("//tsconfig.base.json"),
  compilerOptions: {
    strict: true,
    target: "ES2023",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    noEmit: true
  },
  include: ["src/**/*.ts", "test/**/*.ts"],
  exclude: ["dist", "coverage"],
  path: "tsconfig.json",
  mode: "check"
})

const lib = S.TsBuild({
  srcs: [sources],
  entries: [entry],
  deps: [],
  tsconfig: tsconfigFile,
  tool: { name: "tsup", external: ["effect"] },
  format: "dual",
  outDir: "dist",
  cwd: "."
})
const tscBuild = S.TsBuild({
  srcs: [sources],
  entries: [entry],
  deps: [],
  tsconfig: tsconfigFile,
  tool: { name: "tsc" },
  format: "esm",
  outDir: "dist/tsc"
})
const customProgramBuild = S.TsBuild({
  srcs: [sources],
  entries: [entry],
  deps: [],
  tsconfig: tsconfigFile,
  tool: { name: "program", entry: S.file("scripts/build.ts") },
  format: "esm",
  outDir: "dist/custom"
})

const dts = S.DtsBuild({
  srcs: [sources],
  entries: [entry],
  deps: [lib],
  tsconfig: tsconfigFile,
  tool: { name: "tsc", declarationMap: true },
  outDir: "dist"
})
const dtsWithTsup = S.DtsBuild({
  srcs: [sources],
  entries: [entry],
  deps: [lib],
  tsconfig: tsconfigFile,
  tool: { name: "tsup" },
  outDir: "dist/tsup"
})

const typecheck = S.Typecheck({
  srcs: [sources],
  deps: [lib],
  tsconfig: tsconfigFile,
  buildMode: false,
  incremental: false,
  cwd: "."
})

const vitest = S.Vitest({
  tests: [tests],
  sources: [sources],
  deps: [lib],
  config: S.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  coverage: true,
  timeoutMs: 1_200_000
})
const coverage = S.VitestCoverage({
  tests: [tests],
  sources: [sources],
  deps: [vitest],
  config: S.file("vitest.config.ts"),
  provider: "v8",
  reportsDirectory: "coverage",
  timeoutMs: 1_200_000,
  thresholds: {
    branches: 90,
    functions: 90,
    lines: 90,
    statements: 90
  }
})
const watch = S.VitestWatch({
  tests: [tests],
  sources: [sources],
  deps: [lib],
  config: S.file("vitest.config.ts"),
  environment: "node",
  timeoutMs: 1_200_000
})

const biome = S.BiomeCheck({
  sources: [sources],
  deps: [],
  config: S.file("biome.json"),
  lint: true,
  format: true
})
const dprint = S.Dprint({
  sources: [sources],
  deps: [],
  config: S.file("dprint.json"),
  fix: false
})
const eslint = S.EsLint({
  sources: [sources],
  deps: [],
  configs: [S.file("eslint.config.js")],
  maxWarnings: 0,
  fix: false
})
const dependencies = S.DepsLint({
  packageJson: packageJsonFile,
  sources: [sources],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["typescript"],
  ignoreBinaries: ["node"]
})
const packageLint = S.PackageLint({
  packageJson: packageJsonFile,
  artifacts: [S.glob("dist/**")],
  deps: [lib, dts],
  strict: true,
  pack: true,
  attw: true
})
const docsParity = S.DocsParity({
  readme: S.file("README.md"),
  deps: [lib],
  minimumProseCharacters: 200
})
const sortedPackageJson = S.SortPackageJson({
  manifests: [packageJsonFile],
  deps: [],
  check: true
})

const newPackage = S.NewPackage({
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: { type: "module" },
  tsconfigExtends: "../../tsconfig.base.json"
})

const lockfile = S.Lockfile({
  lockfilePath: "pnpm-lock.yaml",
  manifests: [S.pnpmWorkspace("//pnpm-workspace.yaml")],
  workspace: null,
  cwd: "."
})
const install = S.Install({
  lockfilePath: "pnpm-lock.yaml",
  lockfile,
  manifest: null,
  workspace: null,
  workspaceManifest: S.pnpmWorkspace("//pnpm-workspace.yaml")
})
const pnpmWorkspace = S.PnpmWorkspace({
  path: "pnpm-workspace.yaml",
  packages: ["packages/*", "apps/*"],
  allowBuilds: { esbuild: true },
  linkWorkspacePackages: true,
  settings: { verifyDepsBeforeRun: true },
  mode: "check"
})

const typedoc = S.TypedocDocs({
  sources: [sources],
  deps: [dts],
  tsconfig: tsconfigFile,
  config: S.file("typedoc.json"),
  entryPoints: [entry],
  outDir: "docs/api",
  plugin: []
})
const published = S.Npm.Published({ manifest: packageJsonFile })
const apiCompatibility = S.Api.Compat({
  baseline: published,
  surface: dts,
  manifest: packageJsonFile
})
const sizeBudgets = S.Size.Budgets({
  manifest: packageJsonFile,
  data: [lib]
})
```

`TsBuild.distributionLayout` owns the output directories and publish entry paths.
The `tsc` and `program` tools use format subdirectories under `outDir`.
Dual builds use declarations beside ESM; CJS-only builds use declarations beside CJS.
`PackageJson.publishFields` derives entry points from this layout during declaration expansion.
The tsup tool declares one flat output tree and does not request declarations, so it cannot serve as a `PackageJson` publish entry.

`PackageJson` expands generated-prose source globs within the declaring package, excluding nested packages.
The generation digest includes the source path listing, so adding or removing a source changes it; editing source bytes does not.
`PackageJsonCheck` always checks, even when declared with `mode: "write"` or `mode: "refresh"`.
It never writes the manifest or calls a model. Use `PackageJsonWrite` for those modes.

## Shell, tools, Node, and bundling

```ts
import { Smithers as S } from "@smthrs/targets"

const sources = S.glob("src/**/*.ts")
const tests = S.glob("test/**/*.test.ts")
const credential = S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])

// Shell rules require exactly one of bin, bun, command, or script
const shellBuild = S.Shell.Build({
  bin: S.NodeModule.Bin("vocs"),
  args: ["build"],
  data: [sources],
  outDirs: ["dist"],
  env: { NODE_ENV: "production" },
  sandbox: { network: false }
})
const shellTest = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run"],
  data: [sources, tests],
  gates: [shellBuild],
  shards: 4,
  timeout: "20m"
})
const shellRun = S.Shell.Run({
  shell: "curl -fsS -H \"authorization: token $GITHUB_TOKEN\" \"$GITHUB_API/user\"",
  env: { GITHUB_API: S.SecretOrigin("https://api.github.com") },
  secrets: [credential],
  sandbox: { network: true },
  approval: "required"
})
const shellServe = S.Shell.Serve({
  bun: "await $`${node} server.ts`",
  using: { node: S.Runtime.bin },
  data: [sources],
  readiness: {
    http: "http://localhost:4000/health",
    timeout: "90s"
  },
  health: { interval: "15s", failures: 3 },
  stop: { signal: "SIGTERM", grace: "10s" }
})
const shellDiff = S.Shell.Diff({
  bin: S.NodeModule.Bin("prettier"),
  args: ["--write", "."],
  data: [sources],
  changes: ["src/**"]
})

const dev = S.Dev({
  command: "pnpm",
  args: ["dev"],
  inputs: [sources],
  deps: [],
  cwd: ".",
  readyWhen: null
})
const toolBuild = S.ToolBuild({
  tool: "zig",
  command: "zig",
  args: ["build"],
  inputs: [S.glob("src/**/*.zig")],
  outputs: ["zig-out"],
  deps: [],
  env: {},
  cache: true
})
const toolRun = S.ToolRun({
  command: "curl",
  args: [`${S.SecretOrigin("https://api.github.com")}/rate_limit`],
  inputs: [],
  deps: [],
  env: {},
  secrets: [credential],
  expectedExitCodes: [0],
  timeoutMs: 30_000
})

const nodeTests = S.NodeTest({
  runner: S.testRunner([S.file("test/unit.test.ts"), S.file("test/integration.test.ts")]),
  srcs: [tests],
  deps: [S.Target.subtree("//packages/...", "lib")],
  env: { NODE_ENV: "test" }
})
const nodeBinary = S.NodeBinary({
  entry: S.file("src/cli.ts"),
  args: ["--help"],
  srcs: [sources],
  deps: [],
  env: {}
})

const bundler = S.Bundler.Rspack({ config: S.file("rspack.config.ts") })
const moduleGraph = bundler.resolve({
  entries: ["src/client.tsx"],
  universe: [sources]
})
const browserBundle = bundler.build({
  environment: "client",
  mode: "production",
  env: { NODE_ENV: "production" },
  graph: moduleGraph,
  outDirs: ["dist/client"]
})
```

## Agents and generated documentation

```ts
import { Smithers as S } from "@smthrs/targets"

const sources = S.glob("src/**/*.ts")
const changes = S.gitDiff({ base: "origin/main", paths: ["src/**", "test/**"] })
const credential = S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])
const tests = S.Shell.Test({ shell: "pnpm test", data: [sources] })

const agentLint = S.Agent.Lint({
  agent: S.Agents.reviewers,
  prompt: S.file("prompts/lint.md"),
  data: [changes, sources],
  fixes: ["src/**"]
})
const agentDiff = S.Agent.Diff({
  agent: S.Agents.codex,
  prompt: S.file("prompts/implement.md"),
  payload: {
    issue: S.Input.String("Issue to implement"),
    mode: S.Input.Literals(["minimal", "complete"]),
    note: S.Input.Optional(S.Input.String("Additional context"))
  },
  mcp: [S.Mcp.Http("github", "https://mcp.example.com/github")],
  data: [changes, sources],
  changes: ["src/**", "test/**"],
  gates: [tests],
  secrets: [credential],
  sandbox: { network: true },
  approval: "required",
  maxRounds: 3
})
const agentPr = S.Agent.Pr({
  agent: S.Agents.claude,
  prompt: S.file("prompts/pull-request.md"),
  data: [changes],
  changes: ["src/**", "test/**"],
  gates: [tests],
  secrets: [credential],
  sandbox: { network: true },
  approval: "required",
  maxRounds: 2
})

const llmLint = S.LlmLint({
  changes,
  include: [S.glob("src/**")],
  context: [S.glob("docs/**")],
  deps: [tests],
  prompt: "Review these changes for correctness.",
  rubric: "Report concrete bugs, unsafe behavior, and missing tests.",
  engine: "codex",
  model: "gpt-6-luna",
  batchSize: 4,
  failOn: "error"
})

const docsPage = S.Docs.Page({
  agent: S.Agents.codex,
  brief: S.file("docs/briefs/api.md"),
  prompt: S.file("prompts/write-docs.md"),
  references: [S.file("README.md")],
  inputs: [sources],
  output: "docs/api.md",
  gates: [tests],
  sandbox: { network: true },
  approval: "required",
  maxRounds: 3
})
const docsCheck = S.Docs.Check({
  stamp: S.file("docs/api.stamp"),
  output: S.file("docs/api.md"),
  inputs: [sources],
  producer: "docsPage"
})
```

## Rust, Foundry, Anvil, Go, and Docker

```ts
import { Smithers as S } from "@smthrs/targets"

const rustSources = S.glob([
  "crates/**/*.rs",
  "crates/**/Cargo.toml",
  "Cargo.toml",
  "Cargo.lock"
])
const cargoFetch = S.Cargo.Fetch({
  workspace: S.file("//Cargo.toml"),
  outFiles: ["//Cargo.lock"],
  outDirs: ["//.cargo-home"],
  sandbox: { network: true }
})
const cargoApps = S.Cargo.AppSet({
  manifests: S.glob("crates/*/Cargo.toml"),
  metadata: { aomi: { skip: true } }
})
const cargoBuild = S.Cargo.Build({
  crates: cargoApps,
  features: ["tls"],
  allFeatures: false,
  locked: true,
  offline: true,
  bins: ["widget"],
  lib: true,
  profile: "release",
  target: "x86_64-unknown-linux-gnu",
  container: "docker",
  data: [cargoFetch, rustSources],
  outDirs: ["target/release"]
})
const cargoTest = S.Cargo.Test({
  workspace: true,
  features: ["test-utils"],
  locked: true,
  offline: true,
  bins: ["widget"],
  lib: true,
  noRun: false,
  gates: [cargoBuild],
  data: [cargoFetch, rustSources]
})
const cargoNextest = S.Cargo.Nextest({
  package: "widget-core",
  features: ["test-utils"],
  locked: true,
  offline: true,
  gates: [cargoBuild],
  data: [cargoFetch, rustSources]
})
const cargoClippy = S.Cargo.Clippy({
  workspace: true,
  lib: true,
  allTargets: true,
  denyWarnings: true,
  data: [cargoFetch, rustSources]
})
const cargoFmt = S.Cargo.Fmt({
  workspace: true,
  data: [rustSources],
  changes: ["crates/**"],
  toolchain: "stable"
})
const cargoDoc = S.Cargo.Doc({
  package: "widget-core",
  data: [cargoFetch, rustSources],
  outDirs: ["target/doc"]
})
const cargoDeny = S.Cargo.Deny({
  config: S.file("//deny.toml"),
  data: [cargoFetch],
  sandbox: {}
})

const soliditySources = S.glob(["src/**/*.sol", "test/**/*.sol"])
const foundryBuild = S.Foundry.Build({
  data: [soliditySources],
  outDirs: ["out", "cache"]
})
const foundryTest = S.Foundry.Test({
  data: [soliditySources],
  gates: [foundryBuild]
})
const foundryFmt = S.Foundry.Fmt({
  data: [soliditySources],
  changes: ["src/**/*.sol", "test/**/*.sol"]
})
const anvil = S.Anvil.Fork({
  forkUrl: S.Secret("ETH_RPC_URL"),
  forkBlockNumber: 19_000_000,
  port: 8545
})

const goSources = S.glob(["**/*.go", "go.mod", "go.sum"])
const goDownload = S.Go.ModDownload({
  mod: S.file("go.mod"),
  sum: S.file("go.sum"),
  outDirs: [".cache/go-mod"],
  sandbox: { network: true }
})
const goPackages = S.Go.Packages({
  pkgs: ["./..."]
})
const goTest = S.Go.Test({
  pkgs: goPackages,
  runner: "gotestsum",
  timeout: "10m",
  parallel: "cpus",
  data: [goSources, goDownload]
})
const goBinary = S.Go.Binary({
  pkg: "./cmd/widget",
  out: "dist/widget",
  data: [goSources, goDownload],
  ldflags: ["-s", "-w"],
  stamp: {
    "main.version": S.Stamp.version,
    "main.commit": S.Stamp.commit,
    "main.commitDate": S.Stamp.commitDate,
    "main.buildTime": S.Stamp.buildTime,
    "main.versionMeta": S.Stamp.versionMeta
  }
})
const goLint = S.Go.Lint({
  config: S.file(".golangci.yml"),
  version: "v2.4.0",
  pkgs: ["./..."],
  data: [goSources, goDownload]
})
const goGenerate = S.Go.Generate({
  pkgs: goPackages,
  tools: [S.Go.run("golang.org/x/tools/cmd/stringer@v0.38.0")],
  data: [goSources, goDownload],
  changes: ["**/*.go"]
})
const goFuzz = S.Go.Fuzz({
  pkg: "./internal/parser",
  fuzz: "FuzzParser",
  time: "30s",
  parallel: 2,
  data: [goSources, goDownload]
})
const goTool = S.Go.run("golang.org/x/tools/cmd/stringer@v0.38.0")
const dockerLdflags = S.Go.ldflags({
  strip: true,
  stamp: {
    "main.version": S.Stamp.version,
    "main.commit": S.Stamp.commit
  }
})

const database = S.Docker.Service({
  image: "postgres",
  tag: "17",
  env: { POSTGRES_PASSWORD: "development" },
  ports: { "5432": 5432 },
  volumes: { "./.data/postgres": "/var/lib/postgresql/data" },
  readiness: { port: 5432 },
  health: { interval: "10s", failures: 5 },
  stop: { signal: "SIGTERM", grace: "30s" },
  init: [["psql", "-c", "CREATE DATABASE widget_test"]]
})
const dockerServe = S.Docker.Serve({
  image: "nginx",
  tag: "1.29",
  ports: { "80": 8080 },
  readiness: { http: "http://localhost:8080", timeout: "30s" },
  command: ["nginx", "-g", "daemon off;"]
})
const dockerBuild = S.Docker.Build({
  dockerfile: S.file("Dockerfile"),
  context: ".",
  platforms: ["linux/amd64", "linux/arm64"],
  buildArgs: { VERSION: S.Stamp.version },
  data: [goBinary],
  sandbox: { network: true }
})
const dockerBake = S.Docker.Bake({
  config: S.file("docker-bake.hcl"),
  target: "app",
  data: [goBinary]
})
const dockerPush = S.Docker.Push({
  image: dockerBuild,
  registry: "ghcr.io",
  name: "acme/widget",
  tags: ["latest", S.Stamp.version],
  gates: [goTest],
  sandbox: { network: true },
  approval: "required"
})
```

## Git, GitHub, repositories, publishing, and memory

```ts
import { Smithers as S } from "@smthrs/targets"

const sources = S.glob("src/**/*.ts")
const build = S.Shell.Build({
  shell: "pnpm build",
  data: [sources],
  outDirs: ["dist"]
})
const tests = S.Shell.Test({ shell: "pnpm test", data: [sources] })
const githubToken = S.HttpSecret(S.Secret("GITHUB_TOKEN"), [
  "https://api.github.com",
  "https://uploads.github.com"
])
const npmToken = S.HttpSecret(S.Secret("NPM_TOKEN"), ["https://registry.npmjs.org"])

const sharedTests = S.Repo.Target("shared", "//packages/core:test", {
  args: ["--runInBand"],
  data: [sources],
  gates: [tests],
  sandbox: { network: false }
})

const head = S.gitCommit("HEAD")
const main = S.gitCommit("origin/main")
const commit = S.Git.Commit({
  gates: [tests],
  message: S.Agents.codex,
  changes: ["src/**", "test/**"]
})
// Unsupported in this RC: declaration only; execution refuses.
const gitPr = S.Git.Pr({
  gates: [tests],
  secrets: [githubToken],
  sandbox: { network: true },
  approval: "required"
})
const oneSubmodule = S.Git.Submodule({ path: "vendor/shared" })
const allSubmodules = S.Git.Submodules({
  config: S.file("//.gitmodules"),
  paths: ["vendor/shared", "vendor/fixtures"]
})

const githubSetup = S.Github.Setup({
  cacheUrl: S.Secret("SMITHERS_CACHE_URL"),
  cacheToken: S.Secret("SMITHERS_CACHE_TOKEN")
})
const workflow = S.Github.Workflow({
  name: "CI",
  on: {
    pullRequest: true,
    pullRequestTarget: false,
    issues: { types: ["opened", "reopened"] },
    push: { branches: ["main"] },
    schedule: ["0 3 * * *"],
    release: ["published"],
    workflowDispatch: true
  },
  concurrency: {
    group: "ci-${{ github.ref }}",
    cancelInProgress: true
  },
  permissions: {
    contents: "read",
    pullRequests: "write"
  },
  env: { CI: "true" },
  environment: "production",
  condition: "github.event.pull_request.draft == false",
  jobName: "test",
  runsOn: "ubuntu-latest",
  setup: githubSetup,
  affected: true,
  run: [tests, build],
  steps: [
    { name: "Checkout", uses: "actions/checkout@v4" },
    { name: "Repository check", run: "git diff --check" }
  ]
})
const githubWorkflowFiles = S.Github.CiGen({
  workflows: [workflow],
  preserve: ["handwritten.yml"],
  changes: [".github/workflows/**"]
})
const compactCi = S.Github.Ci({
  workflows: {
    CI: {
      on: {
        pullRequest: true,
        push: ["main"],
        dispatch: true
      },
      run: [tests, build]
    }
  },
  changes: [".github/workflows/**"]
})
// Unsupported in this RC: declaration only; execution refuses.
const githubPr = S.Github.Pr({
  gates: [tests],
  secrets: [githubToken],
  sandbox: { network: true },
  approval: "required"
})
// Unsupported in this RC: declaration only; execution refuses.
const pages = S.Github.Pages({
  site: build,
  secrets: [githubToken],
  sandbox: { network: true },
  approval: "required"
})
// Unsupported in this RC: declaration only; execution refuses.
const release = S.Github.Release({
  manifest: S.file("package.json"),
  notes: S.Agents.codex,
  data: [build],
  gates: [tests],
  secrets: [githubToken],
  sandbox: { network: true },
  approval: "required"
})

const retainedMemory = S.Memory.Retain({
  source: head,
  tags: ["release", "main"]
})

const npmPack = S.Npm.Pack({
  manifest: S.file("package.json"),
  data: [build]
})
// Unsupported in this RC: declaration only; execution refuses.
const npmPublish = S.Npm.Publish({
  pack: npmPack,
  gates: [tests],
  distTag: "latest",
  provenance: true,
  secrets: [npmToken],
  sandbox: { network: true },
  approval: "required"
})
const publishedPackage = S.Npm.Published({ manifest: S.file("package.json") })
// Unsupported in this RC: declaration only; execution refuses.
const downstream = S.Npm.Downstream({
  repository: "https://github.com/acme/widget-consumer.git",
  overrides: { "@acme/widget": npmPack },
  run: ["pnpm test"],
  sandbox: { network: true }
})

const directNpmPublish = S.NpmPublish({
  packageJson: S.file("package.json"),
  artifacts: [S.glob("dist/**")],
  deps: [build],
  registry: "https://registry.npmjs.org",
  access: "public",
  provenance: true,
  tag: "latest",
  dryRun: true
})
const jsrPublish = S.JsrPublish({
  config: S.file("jsr.json"),
  sources: [sources],
  deps: [build, directNpmPublish],
  package: "@acme/widget",
  cliVersion: "0.13.4",
  allowDirty: false,
  dryRun: true
})

const changesetsVersion = S.Changesets.Version({
  config: S.file(".changeset/config.json"),
  data: [
    S.glob(".changeset/*.md"),
    S.glob(["package.json", "packages/*/package.json"]),
    S.glob(["CHANGELOG.md", "packages/*/CHANGELOG.md"]),
    S.file("pnpm-lock.yaml")
  ],
  changes: [
    "package.json",
    "packages/*/package.json",
    "CHANGELOG.md",
    "packages/*/CHANGELOG.md",
    "pnpm-lock.yaml"
  ]
})
// Unsupported in this RC: declaration only; execution refuses.
const changesetsPublish = S.Changesets.Publish({
  config: S.file(".changeset/config.json"),
  pack: npmPack,
  gates: [tests],
  secrets: [npmToken, githubToken],
  sandbox: { network: true },
  approval: "required"
})
```

## CI toolchains and workflow generation

`CiToolchain.Node` takes exactly one of `release`, an exact version the job installs, or `versionFile`, a checked-in file the setup action reads at run time. Prefer `versionFile` whenever anything outside the workflow needs the same number: `.node-version` is read by `actions/setup-node`, by fnm, nvm and asdf, and by a shell bootstrap that has no Node to parse JSON with, so one file keeps them from drifting apart.

The Cloud CI bootstrap keeps an installed Node release when its full version meets `package.json` `engines.node`. Otherwise it installs the verified release from `.node-version`.

`CiToolchain.Node` accepts an optional `npmRelease` pin. The generated job installs that npm version after setting up Node; omitting it keeps Node's bundled npm. The release tarball rehearsal requires npm 11.16.0, so its toolchain declares that pin explicitly.

`CiToolchain.Postgres` puts `initdb` and `pg_ctl` on `PATH`: PGDG `postgresql-18` on Linux and Homebrew `postgresql@18` on macOS. Windows uses the runner image's own server when it is PostgreSQL 17 or later.

`cachePackageStore` defaults to `true`. Node setup restores the pnpm store when the workspace declares pnpm. For Bun workspaces, Node setup omits the package-store cache because `actions/setup-node` does not cache Bun. Set `cachePackageStore: false` to disable package-store caching.

```ts
import { Smithers as S } from "@smthrs/targets"

const test = S.Shell.Test({ shell: "pnpm test" })
const lint = S.Shell.Test({ shell: "pnpm lint" })

const node = S.CiToolchain.Node({ versionFile: ".node-version", npmRelease: "11.16.0" })
const bun = S.CiToolchain.Bun({ release: "1.4.1" })
const ripgrep = S.CiToolchain.Ripgrep({ release: "14.1.1" })
const apt = S.CiToolchain.Apt({ packages: ["libssl-dev", "pkg-config"] })
const go = S.CiToolchain.Go({ release: "1.26.0" })
const foundry = S.CiToolchain.Foundry({ release: "v1.8.1" })
const postgres = S.CiToolchain.Postgres({ release: "18" })
const docker = S.CiToolchain.Docker({ imageStore: "containerd" })
const jj = S.CiToolchain.Jj({ release: "0.39.0" })
const rust = S.CiToolchain.Rust({
  toolchain: S.Rust.Pinned({ pin: S.file("//rust-toolchain.toml") })
})
const browser = S.CiToolchain.Browser({
  executable: "/usr/bin/google-chrome",
  reason: "the runner image ships Chrome at this path"
})
const artifacts = S.CiToolchain.Artifacts({
  artifact: "test-results",
  sources: [
    { from: "coverage" },
    { from: "test-results", as: "results" }
  ]
})
const actionlint = S.CiToolchain.Actionlint({
  release: "1.7.11",
  workflows: [".github/workflows/ci.yml"]
})

const needs = S.CiToolchain.Needs({
  runtimes: [node, bun],
  ripgrep,
  apt,
  go,
  foundry,
  postgres,
  docker,
  jj,
  rust,
  browser,
  artifacts,
  workflowLint: actionlint
})

// Nix is an alternative whole-job toolchain
const nixEnvironment = S.Nix.Environment({
  flake: S.file("//flake.nix"),
  lock: S.file("//flake.lock")
})
const nix = S.CiToolchain.Nix({
  environment: nixEnvironment,
  substituter: S.Secret("NIX_SUBSTITUTER"),
  publicKey: S.Secret("NIX_PUBLIC_KEY")
})
const nixNeeds = S.CiToolchain.Needs({ nix })

const workflows = S.GithubCiGen({
  jobs: [
    {
      id: "test",
      name: "Tests",
      runsOn: "ubuntu-latest",
      timeoutMinutes: 30,
      continueOnError: false,
      publishesToCache: true,
      toolchain: needs,
      steps: [
        {
          name: "Test",
          verb: S.Verb.Test,
          pattern: "//packages/...:test",
          parallelism: 4
        },
        {
          name: "Lint",
          verb: S.Verb.Lint,
          pattern: "//packages/...:lint",
          parallelism: 2
        }
      ]
    },
    {
      id: "matrix-test",
      name: "Platform matrix",
      matrix: [
        { os: "ubuntu-latest", advisory: false },
        { os: "macos-latest", advisory: true }
      ],
      toolchain: needs,
      steps: [
        {
          name: "Test",
          verb: S.Verb.Test,
          pattern: "//packages/...:test",
          parallelism: 2
        }
      ]
    },
    {
      id: "nix-test",
      name: "Nix tests",
      runsOn: "ubuntu-latest",
      toolchain: nixNeeds,
      steps: [
        {
          name: "Test",
          verb: S.Verb.Test,
          pattern: "//packages/...:test",
          parallelism: 1
        }
      ]
    }
  ],
  gates: [
    { name: "tests", verb: S.Verb.Test, pattern: "//packages/...", job: "test" },
    { name: "lint", verb: S.Verb.Lint, pattern: "//packages/...", job: "test" }
  ],
  requiredJobs: ["test", "matrix-test"],
  output: ".github/workflows/ci.yml",
  mode: "check"
})
```

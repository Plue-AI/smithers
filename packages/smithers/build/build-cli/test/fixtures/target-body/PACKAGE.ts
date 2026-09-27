import { Smithers as S } from "@smthrs/targets"

const runtime = S.Runtime.Node({ version: ">=26.4.0" })
const bunRuntime = S.Runtime.Bun({ version: ">=1.4.0" })
const packageManager = S.PackageManager.BunPackages({ runtime: bunRuntime })
const installManager = S.PackageManager.Pnpm({ version: "11.25.0", runtime })
const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const lockfile = S.Lockfile({ packageManager: installManager, manifests: [S.file("package.json")] })
const install = S.Install({ packageManager: installManager, lockfile })
const tsconfig = S.Tsconfig({
  path: "generated-tsconfig.json",
  compilerOptions: { target: "ES2024", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
  include: ["src/**/*.ts"],
  mode: "write"
})
const typecheck = S.Typecheck({
  packageManager,
  srcs: [S.glob("src/**/*.ts")],
  deps: [],
  tsconfig: S.file("tsconfig.json"),
  buildMode: false,
  incremental: false
})
const build = S.TsBuild({
  packageManager,
  srcs: [S.glob("src/**/*.ts")],
  entries: [S.file("src/value.ts")],
  deps: [],
  tsconfig: S.file("tsconfig.build.json"),
  tool: { name: "tsc" },
  format: "esm",
  outDir: "dist"
})
const nodeTest = S.NodeTest({
  runtime,
  runner: S.testRunner([S.file("test/node.test.mjs")]),
  srcs: [],
  deps: [S.Target.subtree("//...", "srcs")]
})
const vitest = S.Vitest({
  packageManager,
  tests: [S.glob("test/*.test.ts")],
  sources: [S.glob("src/**/*.ts")],
  deps: [],
  config: S.file("vitest.config.ts"),
  environment: "node",
  coverage: false,
  passWithNoTests: false
})
const eslint = S.EsLint({
  packageManager,
  sources: [S.glob("src/**/*.ts")],
  deps: [],
  configs: [S.file("eslint.config.js")],
  maxWarnings: 0,
  fix: false
})
const dprint = S.Dprint({
  packageManager,
  sources: [S.glob("src/**/*.ts")],
  deps: [],
  config: S.file("dprint.json"),
  fix: false
})
const docs = S.DocsParity({ readme: S.file("README.md"), deps: [], minimumProseCharacters: 20 })
const generate = S.Generate({
  bin: S.Host.bin("node"),
  args: ["-e", "require('node:fs').writeFileSync('generated.txt', 'generated\\n')"],
  changes: ["generated.txt"]
})
const node = S.CiToolchain.Node({ runtime, release: "26.4.0" })
const ci = S.GithubCiGen({
  packageManager,
  mode: "write",
  jobs: [{
    id: "test",
    runsOn: "ubuntu-latest",
    toolchain: S.CiToolchain.Needs({ runtimes: [node] }),
    steps: [{ name: "Tests", verb: S.Verb.Test, pattern: "//:nodeTest" }]
  }]
})

export const Package = S.Package({
  targets: { srcs, lockfile, install, tsconfig, typecheck, build, nodeTest, vitest, eslint, dprint, docs, generate, ci }
})

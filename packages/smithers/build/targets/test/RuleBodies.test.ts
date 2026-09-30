/**
 * The plan each rule body records, for the bodies nothing else reaches.
 *
 * A rule's `implementation` is the contract between a declaration and the
 * runtime: a package-executor rule must refuse loudly under a bare Flow
 * runtime, and a Flow-body rule must plan the exact argv its attrs describe.
 * Constructing a target proves neither, so every case here interprets the body
 * and asserts the calls and the success shape it produces.
 */
import { describe, expect, it } from "vitest"
import * as BiomeCheck from "../src/BiomeCheck.ts"
import * as Cargo from "../src/Cargo.ts"
import * as DocsParity from "../src/DocsParity.ts"
import * as Dprint from "../src/Dprint.ts"
import * as DtsBuild from "../src/DtsBuild.ts"
import * as EsLint from "../src/EsLint.ts"
import * as Exec from "../src/Exec.ts"
import * as Filegroup from "../src/Filegroup.ts"
import * as GithubTarget from "../src/GithubTarget.ts"
import * as GitTarget from "../src/GitTarget.ts"
import * as Input from "../src/Input.ts"
import * as Install from "../src/Install.ts"
import * as NodeBinary from "../src/NodeBinary.ts"
import * as NodeTest from "../src/NodeTest.ts"
import * as PackageLint from "../src/PackageLint.ts"
import * as PnpmWorkspaceFile from "../src/PnpmWorkspaceFile.ts"
import * as RustToolchain from "../src/RustToolchain.ts"
import * as Shell from "../src/Shell.ts"
import * as S from "../src/Smithers.ts"
import * as SortPackageJson from "../src/SortPackageJson.ts"
import * as Target from "../src/Target.ts"
import * as Tsconfig from "../src/Tsconfig.ts"
import * as Typecheck from "../src/Typecheck.ts"
import * as VitestCoverage from "../src/VitestCoverage.ts"
import { plannedArgv, plannedCalls, plannedValue } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

const manifest = S.file("//package.json")
const shellBuild = S.Shell.Build({ shell: "true", outDirs: ["dist"] })
const shellTest = S.Shell.Test({ shell: "true" })

describe("package-executor rules refuse under a bare Flow runtime", () => {
  const cases: ReadonlyArray<readonly [string, Target.AnyTarget]> = [
    ["Anvil.Fork", S.Anvil.Fork({ forkUrl: S.Secret("ANVIL_FORK_URL"), forkBlockNumber: "latest", port: 8545 })],
    [
      "Fetch",
      S.Fetch({
        url: "https://example.invalid/tool.tar.gz",
        sha256: "a".repeat(64),
        out: "vendor/tool.tar.gz"
      })
    ],
    ["Size.Budgets", S.Size.Budgets({ manifest })],
    [
      "Npm.Downstream",
      S.Npm.Downstream({
        repository: "https://example.invalid/repo",
        overrides: { pkg: shellBuild },
        run: ["test"]
      })
    ],
    ["Repo.Target", S.Repo.Target("child", "//pkg:test")],
    ["Git.Submodule", S.Git.Submodule({ path: "vendor/x" })],
    ["Git.Submodules", S.Git.Submodules({ config: manifest, paths: ["vendor/x"] })],
    ["Shell.Serve", S.Shell.Serve({ shell: "node server.js" })],
    ["Github.Setup", S.Github.Setup({})],
    ["Cargo.AppSet", S.Cargo.AppSet({ manifests: S.glob(["*/Cargo.toml"]) })],
    ["Cargo.Doc", S.Cargo.Doc({ workspace: true, locked: true, offline: true, data: [], outDirs: ["//target/doc"] })],
    ["Changesets.Publish", S.Changesets.Publish({ config: manifest, pack: shellBuild, gates: [shellTest] })],
    ["Go.Generate", S.Go.Generate({ pkgs: ["./..."], changes: ["**/generated.go"] })],
    ["Go.Packages", S.Go.Packages({ pkgs: ["./..."] })]
  ]

  it.each(cases)("%s plans the not-implemented action naming itself", (rule, target) => {
    expect(plannedCalls(target)).toEqual([
      { action: "smithers-build/not-implemented", payload: { target: rule } }
    ])
  })
})

describe("Typecheck", () => {
  const base = {
    packageManager,
    srcs: [Input.glob("src/**/*.ts")],
    deps: [],
    tsconfig: Input.file("tsconfig.json"),
    cwd: "packages/example"
  }

  it("checks without emitting, and asks for an incremental check only when declared", () => {
    expect(plannedArgv(Typecheck.Typecheck({ ...base, buildMode: false, incremental: false })))
      .toEqual(["pnpm", "exec", "tsc", "-p", "tsconfig.json", "--noEmit"])
    expect(plannedArgv(Typecheck.Typecheck({ ...base, buildMode: false, incremental: true })))
      .toEqual(["pnpm", "exec", "tsc", "-p", "tsconfig.json", "--noEmit", "--incremental"])
  })

  it("forces build mode to distrust stale build info unless the declaration is incremental", () => {
    expect(plannedArgv(Typecheck.Typecheck({ ...base, buildMode: true, incremental: false })))
      .toEqual(["pnpm", "exec", "tsc", "-b", "tsconfig.json", "--force"])
    expect(plannedArgv(Typecheck.Typecheck({ ...base, buildMode: true, incremental: true })))
      .toEqual(["pnpm", "exec", "tsc", "-b", "tsconfig.json"])
  })

  it("runs from the declared package directory", () => {
    const call = plannedCalls(Typecheck.Typecheck({ ...base, buildMode: false, incremental: false }))[0]
    expect(call?.payload["cwd"]).toBe("packages/example")
  })
})

describe("Dprint", () => {
  const base = {
    packageManager,
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    config: Input.file("dprint.json"),
    cwd: "packages/example"
  }

  it("checks by default and rewrites only in fix mode", () => {
    expect(plannedArgv(Dprint.Dprint({ ...base, fix: false })))
      .toEqual(["pnpm", "exec", "dprint", "check", "--config", "dprint.json"])
    expect(plannedArgv(Dprint.Dprint({ ...base, fix: true })))
      .toEqual(["pnpm", "exec", "dprint", "fmt", "--config", "dprint.json"])
  })
})

describe("EsLint", () => {
  const base = {
    packageManager,
    deps: [],
    maxWarnings: 0,
    cwd: "packages/example"
  }

  it("passes the first config, the warning budget, and every file and glob pattern", () => {
    expect(plannedArgv(EsLint.EsLint({
      ...base,
      sources: [Input.glob("src/**/*.ts"), Input.file("eslint.config.js"), Input.gitDiff()],
      configs: [Input.file("eslint.config.js"), Input.file("eslint.jsdoc.js")],
      fix: false
    }))).toEqual([
      "pnpm",
      "exec",
      "eslint",
      "--config",
      "eslint.config.js",
      "--max-warnings",
      "0",
      "src/**/*.ts",
      "eslint.config.js"
    ])
  })

  it("omits the config flag when the declaration names none, and adds --fix in fix mode", () => {
    expect(plannedArgv(EsLint.EsLint({ ...base, sources: [], configs: [], fix: true })))
      .toEqual(["pnpm", "exec", "eslint", "--max-warnings", "0", "--fix"])
  })
})

describe("DtsBuild", () => {
  const base = {
    packageManager,
    srcs: [Input.glob("src/**/*.ts")],
    entries: [Input.file("src/index.ts")],
    deps: [],
    tsconfig: Input.file("tsconfig.build.json"),
    outDir: "dist/types",
    cwd: "packages/example"
  }

  it("forces the declaration-map policy onto tsc rather than trusting the tsconfig", () => {
    expect(plannedArgv(DtsBuild.DtsBuild({ ...base, tool: { name: "tsc", declarationMap: true } })))
      .toEqual([
        "pnpm",
        "exec",
        "tsc",
        "-p",
        "tsconfig.build.json",
        "--declaration",
        "--emitDeclarationOnly",
        "--declarationMap",
        "true"
      ])
    expect(plannedArgv(DtsBuild.DtsBuild({ ...base, tool: { name: "tsc", declarationMap: false } })).at(-1))
      .toBe("false")
  })

  it("names every entry and the output directory for tsup, and captures the declared tree", () => {
    const target = DtsBuild.DtsBuild({ ...base, tool: { name: "tsup" } })
    expect(plannedArgv(target))
      .toEqual(["pnpm", "exec", "tsup", "src/index.ts", "--dts-only", "--out-dir", "dist/types"])
    const calls = plannedCalls(target)
    expect(calls.at(-1)?.action).toBe("smithers-build/capture-outputs")
    expect(calls.at(-1)?.payload).toEqual({ cwd: "packages/example", paths: ["dist/types"] })
    expect(Target.metadata(target).outputs).toEqual({ cwd: "packages/example", paths: ["dist/types"] })
  })
})

describe("Node programs", () => {
  it("NodeBinary renders a workspace-rooted entry against its own cwd and forwards the environment", () => {
    const call = plannedCalls(NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//scripts/pack.mjs"),
      args: ["--dry-run"],
      srcs: [],
      deps: [],
      env: { REGION: "us" },
      cwd: "packages/example"
    }))[0]
    expect(call?.payload["argv"]).toEqual(["node", "../../scripts/pack.mjs", "--dry-run"])
    expect(call?.payload["env"]).toEqual({ REGION: "us" })
    expect(call?.payload["timeoutMs"]).toBeUndefined()
  })

  it("NodeBinary forwards an explicit long-running deadline", () => {
    const call = plannedCalls(NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//scripts/check-api-baseline.mjs"),
      args: ["--build-declarations"],
      srcs: [],
      deps: [],
      timeout: "30m"
    }))[0]
    expect(call?.payload["timeoutMs"]).toBe(1_800_000)
  })

  it("NodeTest plans its runner the same way", () => {
    const call = plannedCalls(NodeTest.NodeTest({
      runtime,
      runner: S.entrypoint(Input.file("scripts/check.mjs")),
      srcs: [],
      deps: [],
      env: {},
      cwd: "packages/example"
    }))[0]
    expect(call?.payload["argv"]).toEqual(["node", "scripts/check.mjs"])
    expect(call?.payload["cwd"]).toBe("packages/example")
  })
})

describe("Install", () => {
  it("calls the install flow for the declared manager", () => {
    const target = Install.Install({ packageManager })
    expect(plannedCalls(target)).toEqual([
      { action: "smithers-build/install", payload: { manager: "pnpm" } }
    ])
  })

  it("keys on the lockfile, npmrc, and manifest, and on a declared workspace definition", () => {
    const attrs = Target.metadata(Install.Install({ packageManager })).attrs as Install.Attrs
    expect(Install.inputsFor(attrs).map((input) => (input as Input.File).path))
      .toEqual(["pnpm-lock.yaml", ".npmrc", "package.json", ".pnpmfile.mjs"])
    const withWorkspace = Target.metadata(
      Install.Install({ packageManager, workspaceManifest: Input.pnpmWorkspace("pnpm-workspace.yaml") })
    ).attrs as Install.Attrs
    expect(Install.inputsFor(withWorkspace)).toHaveLength(5)
  })
})

describe("success shapes a rule maps out of its runs", () => {
  it("PackageLint reports the publint run alone when attw is off", () => {
    const base = {
      packageManager,
      packageJson: Input.file("package.json"),
      artifacts: [],
      deps: [],
      cwd: "packages/example",
      strict: true,
      pack: true
    }
    const single = plannedValue(PackageLint.PackageLint({ ...base, attw: false })) as {
      readonly publint: { readonly payload: Record<string, unknown> }
      readonly attw: null
    }
    expect(single.publint.payload["argv"]).toEqual(["pnpm", "exec", "publint", "--strict"])
    expect(single.attw).toBeNull()

    const both = plannedValue(PackageLint.PackageLint({ ...base, attw: true })) as {
      readonly publint: { readonly payload: Record<string, unknown> }
      readonly attw: { readonly payload: Record<string, unknown> }
    }
    expect(both.publint.payload["argv"]).toEqual(["pnpm", "exec", "publint", "--strict"])
    expect(both.attw.payload["argv"]).toEqual(["pnpm", "exec", "attw", "--pack", "."])
  })

  it("BiomeCheck reports exactly the families the declaration enabled", () => {
    const base = {
      packageManager,
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: Input.file("biome.json"),
      cwd: "packages/example"
    }
    const argvOf = (value: unknown) =>
      value === null ? null : (value as { readonly payload: Record<string, unknown> }).payload["argv"]

    const neither = plannedValue(BiomeCheck.BiomeCheck({ ...base, lint: false, format: false }))
    expect(neither).toEqual({ check: null, format: null })

    const formatOnly = plannedValue(
      BiomeCheck.BiomeCheck({ ...base, lint: false, format: true })
    ) as Record<string, unknown>
    expect(formatOnly["check"]).toBeNull()
    expect(argvOf(formatOnly["format"])).toEqual([
      "pnpm",
      "exec",
      "biome",
      "format",
      "--config-path=biome.json",
      "src"
    ])

    const lintOnly = plannedValue(
      BiomeCheck.BiomeCheck({ ...base, lint: true, format: false })
    ) as Record<string, unknown>
    expect(argvOf(lintOnly["check"])).toEqual([
      "pnpm",
      "exec",
      "biome",
      "check",
      "--config-path=biome.json",
      "src"
    ])
    expect(lintOnly["format"]).toBeNull()

    const both = plannedValue(
      BiomeCheck.BiomeCheck({ ...base, lint: true, format: true })
    ) as Record<string, unknown>
    expect(argvOf(both["check"])).toContain("check")
    expect(argvOf(both["format"])).toContain("format")
  })

  it("VitestCoverage returns the captured output manifest after the run", () => {
    const target = VitestCoverage.VitestCoverage({
      packageManager,
      tests: [Input.glob("test/**/*.test.ts")],
      sources: [Input.glob("src/**/*.ts")],
      deps: [],
      config: null,
      provider: "v8",
      reportsDirectory: "coverage",
      thresholds: { branches: 1, functions: 2, lines: 3, statements: 4 },
      cwd: "packages/example"
    })
    const calls = plannedCalls(target)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.payload["argv"]).not.toContain("--config")
    expect(plannedValue(target)).toEqual({
      action: "smithers-build/capture-outputs",
      payload: { cwd: "packages/example", paths: ["coverage"] }
    })
  })
})

describe("SortPackageJson", () => {
  it("forces the check form under lint, so the verb that reports drift never repairs it", () => {
    const metadata = Target.metadata(SortPackageJson.SortPackageJson({
      packageManager,
      manifests: [Input.file("package.json")],
      deps: [],
      check: false,
      cwd: "."
    }))
    expect((metadata.forKind("lint").attrs as SortPackageJson.Attrs).check).toBe(true)
    expect((metadata.forKind("build").attrs as SortPackageJson.Attrs).check).toBe(false)
  })
})

describe("generated-file rules", () => {
  it("Tsconfig writes under a nested cwd through one joined path", () => {
    const call = plannedCalls(Tsconfig.Tsconfig({
      path: "tsconfig.json",
      compilerOptions: { strict: true },
      mode: "write",
      cwd: "packages/example"
    }))[0]
    expect(call?.action).toBe("smithers-build/write-file")
    expect(call?.payload["path"]).toBe("packages/example/tsconfig.json")
    expect(plannedCalls(Tsconfig.Tsconfig({ mode: "write" }))[0]?.payload["path"]).toBe("tsconfig.json")
  })

  it("PnpmWorkspace checks the checked-in file from the workspace root", () => {
    const target = PnpmWorkspaceFile.PnpmWorkspace({
      packageManager,
      packages: ["packages/*"],
      mode: "write"
    })
    expect((Target.metadata(target).forKind("lint").attrs as { mode: string }).mode).toBe("check")
    const call = plannedCalls(PnpmWorkspaceFile.PnpmWorkspace({
      packageManager,
      packages: ["packages/*"],
      mode: "check"
    }))[0]
    expect(call?.action).toBe("smithers-build/check-file")
    expect(call?.payload["path"]).toBe("pnpm-workspace.yaml")
    const nested = plannedCalls(PnpmWorkspaceFile.PnpmWorkspace({
      packageManager,
      packages: ["packages/*"],
      mode: "check",
      cwd: "packages/example"
    }))[0]
    expect(nested?.payload["path"]).toBe("packages/example/pnpm-workspace.yaml")
  })

  it("PnpmWorkspace refuses a workspace whose declared manager is not pnpm", () => {
    const bun = S.PackageManager.BunPackages({ runtime: S.Runtime.Bun({ version: ">=1.4.0" }) })
    expect(() => PnpmWorkspaceFile.PnpmWorkspace({ packageManager: bun, packages: ["packages/*"], mode: "check" }))
      .toThrow(/requires the pnpm declaration/)
    expect(() =>
      PnpmWorkspaceFile.PnpmWorkspace({
        packageManager: { name: "pnpm" },
        packages: ["packages/*"],
        mode: "check"
      } as never)
    ).toThrow(/an undeclared manager/)
  })

  it("PnpmWorkspace leaves an omitted manager to the workspace declaration", () => {
    const declared = PnpmWorkspaceFile.PnpmWorkspace({ packages: ["packages/*"], mode: "check" })
    expect([...Target.metadata(declared).workspaceAttrs]).toEqual(["packageManager"])
  })

  it("DocsParity resolves the README against the declaring package", () => {
    const call = plannedCalls(DocsParity.DocsParity({
      readme: Input.file("README.md"),
      deps: [],
      cwd: "packages/example"
    }))[0]
    expect(call?.action).toBe("smithers-build/check-docs")
    expect(call?.payload["path"]).toBe("packages/example/README.md")
  })

  it("Filegroup expands the sources it names", () => {
    const group = Filegroup.Filegroup({ srcs: [Input.glob("src/**/*.ts")], cwd: "packages/example" })
    const call = plannedCalls(group)[0]
    expect(call?.action).toBe("smithers-build/filegroup")
    expect(call?.payload["sources"]).toEqual([Input.glob("packages/example/src/**/*.ts")])
  })
})

describe("Shell bodies", () => {
  it("refuses malformed direct attrs before an executable can be planned", () => {
    expect(() => Shell.execPayload({} as never)).toThrowError(
      new Error("shell declaration names no executable")
    )
    expect(() => Shell.Build(null as never)).toThrowError(
      new Error("Shell.Build declaration is invalid: Expected object")
    )
  })

  it("runs a command through the shell and a script under the interpreter its extension names", () => {
    expect(plannedArgv(S.Shell.Run({ shell: "echo hi" }))).toEqual(["/bin/sh", "-c", "echo hi"])
    expect(plannedArgv(S.Shell.Test({ script: S.file("scripts/check.sh") })).slice(0, 1)).toEqual(["/bin/sh"])
    expect(plannedArgv(S.Shell.Diff({ script: S.file("scripts/check.mjs"), changes: ["docs/api.md"] }))[0])
      .toBe(Exec.runtimeBinToken)
  })

  it("spawns a declared runtime bin directly and any other bin under the runtime when runtimeArgs are declared", () => {
    const direct = plannedArgv(S.Shell.Run({
      bin: S.Runtime.bin,
      runtimeArgs: ["--enable-source-maps"],
      args: ["x.js"]
    }))
    expect(direct[0]).toContain("RuntimeBin")
    expect(direct.slice(1)).toEqual(["--enable-source-maps", "x.js"])
    const wrapped = plannedArgv(S.Shell.Run({ bin: S.Mise.bin("deno"), runtimeArgs: ["--flag"], args: ["x.ts"] }))
    expect(wrapped[0]).toContain("RuntimeBin")
    expect(wrapped[1]).toBe("--flag")
    expect(wrapped[2]).toContain("deno")
    expect(wrapped[3]).toBe("x.ts")
    const bare = plannedArgv(S.Shell.Run({ bin: S.Mise.bin("deno"), args: ["x.ts"] }))
    expect(bare[0]).toContain("deno")
    expect(bare.slice(1)).toEqual(["x.ts"])
  })

  it("carries the declared secrets and the build-system timeout on every shell exec", () => {
    const call = plannedCalls(S.Shell.Build({
      shell: "true",
      outDirs: ["dist"],
      secrets: [S.HttpSecret(S.Secret("TOKEN"), ["https://api.example.invalid"])]
    }))[0]
    expect(call?.payload["timeoutMs"]).toBe(30 * 60 * 1000)
    expect((call?.payload["secrets"] as ReadonlyArray<unknown>).length).toBe(1)
  })

  it("refuses a declaration that names no executable or names two", () => {
    expect(() => S.Shell.Run({} as never)).toThrow(/requires exactly one of bin, bun, shell, script.*none/)
    expect(() => S.Shell.Run({ shell: "true", bun: "await 1" } as never))
      .toThrow(/requires exactly one of bin, bun, shell, script.*bun, shell/)
    expect(() => S.Shell.Build({ shell: "true" } as never)).toThrow(/at least one outDirs or outFiles/)
  })
})

describe("attrs accessors reject a target of the wrong rule", () => {
  it("Git.Commit", () => {
    const commit = S.Git.Commit({ gates: [shellTest], message: "chore: release" })
    expect(GitTarget.commitAttrsOf(commit).message).toBe("chore: release")
    expect(GitTarget.commitAttrsOf(commit).changes).toBeUndefined()
    expect(() => GitTarget.commitAttrsOf(shellTest)).toThrow(/expected a Git.Commit target, received Shell.Test/)
  })

  it("Git.Commit declares the pathspec scope it stages", () => {
    const scoped = S.Git.Commit({
      gates: [shellTest],
      message: "chore: release",
      changes: ["src/**", "//README.md"]
    })
    expect(GitTarget.commitAttrsOf(scoped).changes).toEqual(["src/**", "//README.md"])
    // An empty scope silently degrades to sweep-only semantics downstream, so
    // the declaration is rejected outright.
    expect(() => S.Git.Commit({ gates: [], message: "chore: empty", changes: [] as never }))
      .toThrow(/Git\.Commit declaration.*is invalid/)
  })

  it("Github.CiGen", () => {
    const ci = S.Github.Ci({
      workflows: { test: { on: { push: ["main"] }, run: shellTest } },
      changes: [".github/workflows/test.yml"]
    })
    expect(GithubTarget.ciGenAttrsOf(ci).changes).toEqual([".github/workflows/test.yml"])
    expect(() => GithubTarget.ciGenAttrsOf(shellTest)).toThrow(/Github.CiGen/)
  })
})

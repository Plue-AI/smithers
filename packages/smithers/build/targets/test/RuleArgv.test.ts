/**
 * The argv each rule plans, per attr combination.
 *
 * These rules render their command inside the Flow body, so nothing before
 * this file proved that `strict` becomes `--strict` or that a `version`
 * changeset run reaches the irreversible action rather than the ordinary one.
 */
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { DepsLint } from "../src/DepsLint.ts"
import { Dev } from "../src/Dev.ts"
import * as Input from "../src/Input.ts"
import { inputsFor, Install } from "../src/Install.ts"
import { JsrPublish } from "../src/JsrPublish.ts"
import { Lockfile } from "../src/Lockfile.ts"
import { NpmPublish } from "../src/NpmPublish.ts"
import { PackageLint } from "../src/PackageLint.ts"
import * as PackageManager from "../src/PackageManager.ts"
import * as Runtime from "../src/Runtime.ts"
import { SortPackageJson } from "../src/SortPackageJson.ts"
import * as Target from "../src/Target.ts"
import { ToolRun } from "../src/ToolRun.ts"
import { TsBuild } from "../src/TsBuild.ts"
import { TypedocDocs } from "../src/TypedocDocumentation.ts"
import { Vitest } from "../src/Vitest.ts"
import { VitestCoverage } from "../src/VitestCoverage.ts"
import { VitestWatch } from "../src/VitestWatch.ts"
import { plannedArgv, plannedCalls } from "./plan.ts"
import { packageManager, runtime } from "./toolchain.ts"

describe("PackageLint", () => {
  const base = {
    packageManager,
    packageJson: Input.file("package.json"),
    artifacts: [],
    deps: [],
    cwd: "packages/example"
  }

  it("renders strict and pack as the flags publint reads", () => {
    expect(plannedArgv(PackageLint({ ...base, strict: true, pack: true, attw: false })))
      .toEqual(["pnpm", "exec", "publint", "--strict"])
    expect(plannedArgv(PackageLint({ ...base, strict: false, pack: false, attw: false })))
      .toEqual(["pnpm", "exec", "publint", "--pack", "false"])
  })

  it("plans the attw run only when the declaration asks for it", () => {
    const without = plannedCalls(PackageLint({ ...base, strict: false, pack: true, attw: false }))
    expect(without).toHaveLength(1)
    const withAttw = plannedCalls(PackageLint({ ...base, strict: false, pack: true, attw: true }))
    expect(withAttw).toHaveLength(2)
    expect(withAttw[1]?.payload["argv"]).toEqual(["pnpm", "exec", "attw", "--pack", "."])
  })
})

describe("publication rules", () => {
  it("JsrPublish runs the pinned CLI and renders allowDirty and dryRun through dlx", () => {
    const base = {
      packageManager,
      config: Input.file("jsr.json"),
      sources: [],
      deps: [],
      package: "@scope/name",
      cliVersion: "0.13.4"
    }
    expect(plannedArgv(JsrPublish({ ...base, allowDirty: false, dryRun: false })))
      .toEqual(["pnpm", "dlx", "jsr@0.13.4", "publish"])
    expect(plannedArgv(JsrPublish({ ...base, allowDirty: true, dryRun: true })))
      .toEqual(["pnpm", "dlx", "jsr@0.13.4", "publish", "--allow-dirty", "--dry-run"])
  })

  it("JsrPublish refuses a CLI pin that is not one exact release", () => {
    const base = {
      packageManager,
      config: Input.file("jsr.json"),
      sources: [],
      deps: [],
      package: "@scope/name",
      allowDirty: false
    }
    for (const cliVersion of ["latest", "^0.13.0", "0.13", "0.13.4 ", "0.13.4 && echo"]) {
      expect(() => JsrPublish({ ...base, cliVersion })).toThrow()
    }
  })

  it("JsrPublish publishes from the directory of the declared config", () => {
    const base = {
      packageManager,
      sources: [],
      deps: [],
      package: "@scope/name",
      cliVersion: "0.13.4",
      allowDirty: false
    }
    const rooted = plannedCalls(JsrPublish({ ...base, config: Input.file("//packages/x/jsr.json") }))[0]
    expect(rooted?.action).toBe("smithers-build/exec-irreversible")
    expect(rooted?.payload["cwd"]).toBe("packages/x")
    // Declared outside a PACKAGE.ts there is no package directory, so a
    // package-relative config resolves from the process working directory.
    const relative = plannedCalls(JsrPublish({ ...base, config: Input.file("dist/jsr.json") }))[0]
    expect(relative?.payload["cwd"]).toBe(NodePath.resolve("dist"))
  })

  it("NpmPublish renders the registry contract and provenance as an environment fact", () => {
    const base = {
      packageManager,
      packageJson: Input.file("package.json"),
      artifacts: [],
      deps: [],
      registry: "https://registry.npmjs.org",
      access: "public" as const,
      tag: "latest"
    }
    const dry = plannedCalls(NpmPublish({ ...base, provenance: false, dryRun: true }))[0]
    expect(dry?.action).toBe("smithers-build/exec-irreversible")
    expect(dry?.payload["argv"]).toEqual([
      "pnpm",
      "publish",
      "--registry",
      "https://registry.npmjs.org",
      "--access",
      "public",
      "--tag",
      "latest",
      "--no-git-checks",
      "--dry-run"
    ])
    // `false` is spelled out so the attr overrides a manifest or inherited
    // configuration that enables provenance; npm and pnpm 10 read the
    // npm_config_ key, pnpm 11 reads the pnpm_config_ key.
    expect(dry?.payload["env"]).toEqual({ npm_config_provenance: "false", pnpm_config_provenance: "false" })
    const live = plannedCalls(NpmPublish({ ...base, provenance: true, dryRun: false }))[0]
    expect(live?.payload["argv"]).not.toContain("--dry-run")
    expect(live?.payload["env"]).toEqual({ npm_config_provenance: "true", pnpm_config_provenance: "true" })
  })

  it("NpmPublish publishes from the directory of the declared manifest", () => {
    const base = {
      packageManager,
      artifacts: [],
      deps: [],
      registry: "https://registry.npmjs.org",
      access: "public" as const,
      provenance: false,
      tag: "latest"
    }
    const rooted = plannedCalls(NpmPublish({ ...base, packageJson: Input.file("//packages/x/package.json") }))[0]
    expect(rooted?.payload["cwd"]).toBe("packages/x")
    const root = plannedCalls(NpmPublish({ ...base, packageJson: Input.file("//package.json") }))[0]
    expect(root?.payload["cwd"]).toBe(".")
    const relative = plannedCalls(NpmPublish({ ...base, packageJson: Input.file("package.json") }))[0]
    expect(relative?.payload["cwd"]).toBe(process.cwd())
  })
})

describe("SortPackageJson", () => {
  const base = {
    packageManager,
    manifests: [Input.file("package.json")] as const,
    deps: [],
    cwd: "."
  }

  it("renders --check only in check mode and always names every manifest", () => {
    expect(plannedArgv(SortPackageJson({ ...base, check: true })))
      .toEqual(["pnpm", "exec", "sort-package-json", "--check", "package.json"])
    expect(plannedArgv(SortPackageJson({ ...base, check: false })))
      .toEqual(["pnpm", "exec", "sort-package-json", "package.json"])
  })
})

describe("Vitest rules", () => {
  const base = {
    packageManager,
    tests: [Input.glob("test/**/*.test.ts")],
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    config: Input.file("vitest.config.ts"),
    environment: "node",
    cwd: "packages/example"
  }

  it("Vitest turns coverage off unless the declaration asks for it", () => {
    expect(plannedArgv(Vitest({ ...base, coverage: false, passWithNoTests: false, timeoutMs: 1_000 })))
      .toContain("--coverage.enabled=false")
    expect(plannedArgv(Vitest({ ...base, coverage: true, passWithNoTests: true, timeoutMs: 1_000 })))
      .toContain("--passWithNoTests")
  })

  it("Vitest omits the config flag when the declaration names no config", () => {
    expect(plannedArgv(
      Vitest({ ...base, config: null, coverage: false, passWithNoTests: false, timeoutMs: 1_000 })
    )).not.toContain("--config")
  })

  it("Vitest renders the declared config as --config and forwards the timeout to the exec payload", () => {
    const call = plannedCalls(Vitest({ ...base, coverage: false, passWithNoTests: false, timeoutMs: 1_000 }))[0]
    expect(call?.payload["argv"]).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "--environment",
      "node",
      "--coverage.enabled=false"
    ])
    expect(call?.payload["cwd"]).toBe("packages/example")
    expect(call?.payload["timeoutMs"]).toBe(1_000)
  })

  it("Vitest bounds the run at twenty minutes when the declaration names no timeout", () => {
    const call = plannedCalls(Vitest({ ...base, coverage: true, passWithNoTests: false }))[0]
    expect(call?.payload["timeoutMs"]).toBe(1_200_000)
  })

  it("VitestWatch spells the watch command", () => {
    expect(plannedArgv(VitestWatch(base)))
      .toEqual(["pnpm", "exec", "vitest", "watch", "--config", "vitest.config.ts", "--environment", "node"])
  })

  it("VitestWatch omits the config flag when discovery owns configuration", () => {
    expect(plannedArgv(VitestWatch({ ...base, config: null })))
      .toEqual(["pnpm", "exec", "vitest", "watch", "--environment", "node"])
  })

  it("VitestCoverage declares the report directory it captures", () => {
    const { environment: _environment, ...coverageBase } = base
    const target = VitestCoverage({
      ...coverageBase,
      provider: "v8" as const,
      reportsDirectory: "coverage",
      thresholds: { branches: 1, functions: 2, lines: 3, statements: 4 }
    })
    expect(Target.metadata(target).outputs).toEqual({ cwd: "packages/example", paths: ["coverage"] })
    expect(plannedArgv(target)).toContain("--coverage.thresholds.branches=1")
    const calls = plannedCalls(target)
    expect(calls.at(-1)?.action).toBe("smithers-build/capture-outputs")
    expect(calls.at(-1)?.payload).toEqual({ cwd: "packages/example", paths: ["coverage"] })
  })
})

describe("TsBuild", () => {
  const base = {
    packageManager,
    srcs: [Input.glob("src/**/*.ts")],
    entries: [Input.file("src/index.ts")],
    deps: [],
    tsconfig: Input.file("tsconfig.build.json"),
    outDir: "dist",
    cwd: "packages/example"
  }

  it("runs a program tool under the manager's runtime", () => {
    const target = TsBuild({
      ...base,
      tool: { name: "program", entry: Input.file("scripts/build.mjs") },
      format: "dual"
    })
    expect(plannedArgv(target)).toEqual(["node", "scripts/build.mjs"])
    expect(Target.metadata(target).outputs?.paths).toEqual(["dist/esm", "dist/cjs"])
  })

  it("walks a workspace-rooted program back out of the package cwd", () => {
    const target = TsBuild({
      ...base,
      tool: { name: "program", entry: Input.file("//packages/repo-targets/scripts/build.mjs") },
      format: "dual"
    })
    expect(plannedArgv(target)).toEqual(["node", "../repo-targets/scripts/build.mjs"])
  })

  it("derives a single output directory for a single format", () => {
    const target = TsBuild({ ...base, tool: { name: "tsc" }, format: "esm" })
    expect(plannedArgv(target)).toEqual(["pnpm", "exec", "tsc", "-p", "tsconfig.build.json"])
    expect(Target.metadata(target).outputs?.paths).toEqual(["dist/esm"])
  })

  it.each(
    [
      ["dual", "esm,cjs"],
      ["cjs", "cjs"]
    ] as const
  )("renders a %s tsup distribution and every external", (format, renderedFormat) => {
    const target = TsBuild({
      ...base,
      tool: { name: "tsup", external: ["effect", "vitest"] },
      format
    })
    expect(plannedArgv(target)).toEqual([
      "pnpm",
      "exec",
      "tsup",
      "src/index.ts",
      "--format",
      renderedFormat,
      "--out-dir",
      "dist",
      "--external",
      "effect",
      "--external",
      "vitest"
    ])
    expect(Target.metadata(target).outputs?.paths).toEqual(["dist"])
  })

  it("refuses a tsc declaration that asks for a dual distribution", () => {
    expect(() => TsBuild({ ...base, tool: { name: "tsc" }, format: "dual" }))
      .toThrow(/tsc tool cannot produce the dual format/)
  })
})

describe("TypedocDocs", () => {
  it("renders every declared path from the workspace root", () => {
    const argv = plannedArgv(TypedocDocs({
      packageManager,
      sources: [Input.glob("//packages/example/src/**/*.ts")],
      deps: [],
      tsconfig: Input.file("//packages/example/tsconfig.json"),
      config: Input.file("//typedoc.json"),
      entryPoints: [Input.file("//packages/example/src/index.ts")],
      plugin: ["typedoc-plugin-markdown"],
      outDir: "docs/api"
    }))
    expect(argv).toEqual([
      "pnpm",
      "exec",
      "typedoc",
      "--out",
      "docs/api",
      "--tsconfig",
      "packages/example/tsconfig.json",
      "--options",
      "typedoc.json",
      "--plugin",
      "typedoc-plugin-markdown",
      "packages/example/src/index.ts"
    ])
  })

  it("omits --options when TypeDoc should discover its own configuration", () => {
    const argv = plannedArgv(TypedocDocs({
      packageManager,
      sources: [],
      deps: [],
      tsconfig: Input.file("//tsconfig.json"),
      config: null,
      entryPoints: [Input.file("//src/index.ts")],
      plugin: [],
      outDir: "docs/api"
    }))
    expect(argv).toEqual([
      "pnpm",
      "exec",
      "typedoc",
      "--out",
      "docs/api",
      "--tsconfig",
      "tsconfig.json",
      "src/index.ts"
    ])
  })
})

describe("ToolRun", () => {
  it("reaches the irreversible action and forwards the declared execution facts", () => {
    const call = plannedCalls(ToolRun({
      command: "deploy",
      args: ["--now"],
      inputs: [],
      deps: [],
      env: { REGION: "us" },
      expectedExitCodes: [0, 2],
      timeoutMs: 5_000,
      cwd: "packages/example"
    }))[0]
    expect(call?.action).toBe("smithers-build/exec-irreversible")
    expect(call?.payload["argv"]).toEqual(["deploy", "--now"])
    expect(call?.payload["cwd"]).toBe("packages/example")
    expect(call?.payload["env"]).toEqual({ REGION: "us" })
    expect(call?.payload["expectedExitCodes"]).toEqual([0, 2])
    expect(call?.payload["timeoutMs"]).toBe(5_000)
  })

  it("carries an explicit empty env and credential list for a bare declaration", () => {
    // The exec action never has to guess what "absent" means.
    const bare = plannedCalls(ToolRun({ command: "deploy", args: [], inputs: [], deps: [] }))[0]
    expect(bare?.payload["env"]).toEqual({})
    expect(bare?.payload["secrets"]).toEqual([])
    expect(bare?.payload["expectedExitCodes"]).toEqual([0])
    expect(bare?.payload["cwd"]).toBe(".")
  })

  it("omits the timeout when the declaration names none", () => {
    const call = plannedCalls(ToolRun({ command: "deploy", args: [], inputs: [], deps: [] }))[0]
    expect(call?.payload).not.toHaveProperty("timeoutMs")
  })
})

describe("Dev", () => {
  it("refuses a readiness marker the shared exec action cannot honour", () => {
    expect(() =>
      Dev({
        command: "vite",
        args: [],
        inputs: [],
        deps: [],
        cwd: "packages/example",
        readyWhen: "listening on" as never
      })
    ).toThrow(/declaration is invalid/)
  })

  it("plans the command with its arguments", () => {
    expect(plannedArgv(
      Dev({ command: "vite", args: ["--host"], inputs: [], deps: [], cwd: "packages/example", readyWhen: null })
    )).toEqual(["vite", "--host"])
  })
})

describe("Lockfile", () => {
  const bun = PackageManager.BunPackages({ runtime: Runtime.Bun({ version: ">=1.4.0" }) })

  it("plans a resolve-only run: unfrozen, lockfile-only, no lifecycle scripts, no linking", () => {
    // `--frozen-lockfile` would refuse the regeneration this target exists
    // for, and a plain `install` would link a tree the target never declared.
    expect(plannedArgv(Lockfile({ packageManager })))
      .toEqual(["pnpm", "install", "--lockfile-only", "--ignore-scripts"])
    expect(plannedArgv(Lockfile({ packageManager: bun })))
      .toEqual(["bun", "install", "--lockfile-only", "--ignore-scripts"])
  })

  it("runs from the declared directory and captures the file the manager wrote", () => {
    const calls = plannedCalls(Lockfile({ packageManager, cwd: "packages/example" }))
    expect(calls).toHaveLength(2)
    expect(calls[0]?.action).toBe("smithers-build/exec")
    expect(calls[0]?.payload["cwd"]).toBe("packages/example")
    expect(calls[1]).toEqual({
      action: "smithers-build/capture-outputs",
      payload: { cwd: "packages/example", paths: ["pnpm-lock.yaml"] }
    })
  })

  it("captures the declared lockfilePath instead of the manager's conventional file", () => {
    const calls = plannedCalls(Lockfile({ packageManager, lockfilePath: "lock/pnpm-lock.yaml" }))
    expect(calls.at(-1)?.payload).toEqual({ cwd: ".", paths: ["lock/pnpm-lock.yaml"] })
  })

  it("leaves the manager to the workspace when the declaration names its lockfile", () => {
    // The documented PACKAGE.ts spelling: no manager, only the file it expects.
    const metadata = Target.metadata(Lockfile({ lockfilePath: "pnpm-lock.yaml" }))
    expect(metadata.workspaceAttrs).toEqual(["packageManager"])
    expect(metadata.outputs).toEqual({ cwd: ".", paths: ["pnpm-lock.yaml"] })
    expect(metadata.inputs).toEqual([{ _tag: "Glob", pattern: "packages/*/package.json", exclude: [] }])
    expect(metadata.cacheable).toBe(false)
  })
})

describe("Install", () => {
  it("leaves the manager to the workspace when the declaration names its lockfile", () => {
    // The documented PACKAGE.ts spelling: no manager, only the file it reads.
    const target = Install({ lockfilePath: "bun.lock" })
    const metadata = Target.metadata(target)
    expect(metadata.workspaceAttrs).toEqual(["packageManager"])
    expect(metadata.kinds).toEqual(["run"])
    expect(metadata.cacheable).toBe(false)
    expect(metadata.outputs).toBeUndefined()
    expect(metadata.inputs.map((input) => (input as Input.File).path))
      .toEqual(["bun.lock", ".npmrc", "package.json", ".pnpmfile.mjs"])
    expect(inputsFor(metadata.attrs as Parameters<typeof inputsFor>[0]).map((input) => (input as Input.File).path))
      .toEqual(["bun.lock", ".npmrc", "package.json", ".pnpmfile.mjs"])
  })

  it("prefers the declared lockfilePath over the manager's conventional file", () => {
    const metadata = Target.metadata(Install({ packageManager, lockfilePath: "lock/pnpm-lock.yaml" }))
    expect(metadata.inputs.map((input) => (input as Input.File).path))
      .toEqual(["lock/pnpm-lock.yaml", ".npmrc", "package.json", ".pnpmfile.mjs"])
  })
})

describe("DepsLint", () => {
  const base = {
    packageManager,
    runtime,
    packageJson: Input.file("package.json"),
    sources: [Input.glob("src/**/*.ts")],
    deps: [],
    cwd: "packages/example"
  }

  it("names two distinct knip configurations two distinct files", () => {
    const first = DepsLint({
      ...base,
      tool: "knip",
      ignoreDependencies: ["1l5mye7pkjasynhmvjd12q9lys"],
      ignoreBinaries: []
    })
    const second = DepsLint({
      ...base,
      tool: "knip",
      ignoreDependencies: ["1b2nxn1476zv21nyiwb91okomls"],
      ignoreBinaries: []
    })
    const configOf = (target: Target.AnyTarget) => {
      const argv = plannedCalls(target)[0]?.payload["argv"] as ReadonlyArray<string>
      return argv.at(-2)
    }
    expect(configOf(first)).not.toBe(configOf(second))
  })

  it("runs knip under its own discovery when nothing is ignored", () => {
    const target = DepsLint({ ...base, tool: "knip", ignoreDependencies: [], ignoreBinaries: [] })
    expect(plannedArgv(target)).toEqual(["pnpm", "exec", "knip", "--dependencies"])
  })

  it("forwards both ignore lists to depcheck as one option", () => {
    const target = DepsLint({
      ...base,
      tool: "depcheck",
      ignoreDependencies: ["a"],
      ignoreBinaries: ["b"]
    })
    expect(plannedArgv(target)).toEqual(["pnpm", "exec", "depcheck", "--ignores=a,b"])
  })

  it("runs depcheck without an empty ignores option", () => {
    const target = DepsLint({
      ...base,
      tool: "depcheck",
      ignoreDependencies: [],
      ignoreBinaries: []
    })
    expect(plannedArgv(target)).toEqual(["pnpm", "exec", "depcheck"])
  })

  it("writes exactly the declared knip ignore category", () => {
    const target = DepsLint({
      ...base,
      tool: "knip",
      ignoreDependencies: ["optional-package"],
      ignoreBinaries: []
    })
    const argv = plannedCalls(target)[0]?.payload["argv"] as ReadonlyArray<string>
    expect(JSON.parse(argv.at(-1) ?? "null")).toEqual({ ignoreDependencies: ["optional-package"] })

    const binaries = DepsLint({
      ...base,
      tool: "knip",
      ignoreDependencies: [],
      ignoreBinaries: ["optional-binary"]
    })
    const binaryArgv = plannedCalls(binaries)[0]?.payload["argv"] as ReadonlyArray<string>
    expect(JSON.parse(binaryArgv.at(-1) ?? "null")).toEqual({ ignoreBinaries: ["optional-binary"] })
  })
})

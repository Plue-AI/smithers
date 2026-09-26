/**
 * Workspace toolchain inheritance through real package planning and execution.
 * The private manager only probes its version or records a tsc invocation; no
 * installed dependency tree or external package manager is modified.
 */
import * as ChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import { serve as serveCli } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporary: Array<string> = []
const originalPath = process.env["PATH"]
afterEach(async () => {
  if (originalPath === undefined) delete process.env["PATH"]
  else process.env["PATH"] = originalPath
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const manifestText = (manager = "11.25.0", description = "first"): string =>
  JSON.stringify({
    name: "workspace-toolchain-execution",
    private: true,
    type: "module",
    engines: { node: ">=26.4.0" },
    packageManager: `pnpm@${manager}`,
    description
  })

const fixture = async (runtime: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smthrs-toolchain-execution-")))
  temporary.push(root)
  await write(root, "package.json", manifestText())
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n")
  await write(root, "pnpm-workspace.yaml", "packages:\n  - .\nverifyDepsBeforeRun: false\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("toolchain-execution", {
  repository: "git+https://example.invalid/toolchain-execution.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: ${runtime},
  packageManager: S.PackageManager.Pnpm({ manifest, lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: manifest }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const check = S.Typecheck({
  srcs: [S.file("value.ts")], deps: [], tsconfig: S.file("tsconfig.json"),
  buildMode: false, incremental: false
})
export const Package = S.Package({ targets: { check } })
`
  )
  await write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true }, files: ["value.ts"] }))
  await write(root, "value.ts", "export const value: number = 1\n")
  await write(
    root,
    "node_modules/.bin/pnpm",
    `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(Path.join(root, "manager-invocations.jsonl"))}, JSON.stringify(args) + "\\n")
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("11.25.0\\n")
} else if (JSON.stringify(args.filter((arg) => arg !== "--config.verifyDepsBeforeRun=false")) === JSON.stringify(["exec", "tsc", "-p", "tsconfig.json", "--noEmit"])) {
  process.stdout.write("WORKSPACE_TYPECHECK_EXECUTED\\n")
} else {
  process.stderr.write("unexpected manager invocation: " + JSON.stringify(args) + "\\n")
  process.exitCode = 91
}
`
  )
  await Fs.chmod(Path.join(root, "node_modules/.bin/pnpm"), 0o755)
  process.env["PATH"] = [Path.join(root, "node_modules/.bin"), Path.dirname(process.execPath), originalPath ?? ""]
    .join(Path.delimiter)
  return root
}

/** The real Incur entry point and package executor, with standard error and standard output read as one log. */
const serve = async (
  root: string,
  args: ReadonlyArray<string> = ["build", "//:check", "--no-cache", "--jobs", "1"]
): Promise<{ readonly code: number; readonly output: string }> => {
  const { exitCode, output, logs } = await serveCli(root, args)
  return { code: exitCode, output: logs + output }
}

describe("manifest toolchain execution", () => {
  it.skipIf(process.platform === "win32").each([
    ["manifest Node", "S.Runtime.Node({ manifest })"],
    ["exact Node", "exact"],
    ["classic Node floor", "S.Runtime.Node({ version: \">=26.4.0\" })"]
  ])("executes Typecheck with %s and manifest-derived pnpm", async (_, declaration) => {
    // A Bun test host reports a compatibility process.versions.node value;
    // the workspace Node declaration must identify the actual selected Node.
    const runtime = declaration === "exact"
      ? `S.Runtime.Node({ version: ${
        JSON.stringify(
          ChildProcess.execFileSync("node", ["--version"], {
            encoding: "utf8",
            timeout: 5_000,
            env: {
              ...process.env,
              PATH: [Path.dirname(process.execPath), originalPath ?? ""].join(Path.delimiter)
            }
          }).trim().replace(/^v/, "")
        )
      } })`
      : declaration
    const root = await fixture(runtime)
    const result = await serve(root)
    expect(result.code, result.output).toBe(0)
    expect(result.output).toContain("WORKSPACE_TYPECHECK_EXECUTED")
    expect(result.output).toContain("//:check  ran")
    const invocations = (await Fs.readFile(Path.join(root, "manager-invocations.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as ReadonlyArray<string>)
    const versionProbe = invocations.findIndex((args) => args.length === 1 && args[0] === "--version")
    expect(versionProbe).toBeGreaterThanOrEqual(0)
    expect(invocations.findIndex((args) => args.includes("tsc"))).toBeGreaterThan(versionProbe)
    expect(invocations.filter((args) => args.includes("tsc"))).toEqual([
      ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"]
    ])
  })

  it("keys a separate runtime manifest edit and a manager requirement change without reloading declarations", async () => {
    const root = await fixture("S.Runtime.Node({ manifest: S.file(\"//config/runtime.json\") })")
    const runtimeText = JSON.stringify({ engines: { node: ">=26.4.0" }, description: "first" })
    await write(root, "config/runtime.json", runtimeText)
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
    const plan = () =>
      PackageExec.plan({
        index,
        cacheDirectory: ".flows",
        patterns: ["//:check"],
        verb: "build"
      })
    const before = (await plan()).nodes.get("//:check")!
    expect(before.refusal).toBeUndefined()
    // This file is declared only by the workspace runtime, not the target's
    // srcs or package manager. Equal resolved requirements still need the
    // exact bytes read during resolution in the target's key.
    await write(root, "config/runtime.json", runtimeText.replace("first", "second"))
    const bytesChanged = (await plan()).nodes.get("//:check")!
    expect(bytesChanged.refusal).toBeUndefined()
    expect(bytesChanged.keyPreview).not.toBe(before.keyPreview)
    await write(root, "package.json", manifestText("11.21.0"))
    const requirementChanged = (await plan()).nodes.get("//:check")!
    expect(requirementChanged.refusal).toBeUndefined()
    expect(requirementChanged.keyPreview).not.toBe(bytesChanged.keyPreview)
    await write(root, "config/runtime.json", runtimeText)
    await write(root, "package.json", manifestText())
    expect((await plan()).nodes.get("//:check")?.keyPreview).toBe(before.keyPreview)
  })
})

const privateExecutable = (version: string, marker: string): string =>
  `#!${process.execPath}
const args = process.argv.slice(2)
if (JSON.stringify(args) === '["--version"]') process.stdout.write(${JSON.stringify(version + "\n")})
else if (JSON.stringify(args) === '["--probe"]') process.stdout.write(${JSON.stringify(marker + "\n")})
else { process.stderr.write("unexpected private tool argv"); process.exitCode = 91 }
`

/** A real Generate target needs a Git baseline for its declared output write set. */
const nativeFixture = async (options: {
  readonly reference: "Runtime" | "PackageManager"
  readonly runtime?: "node" | "bun"
  readonly runtimeVersion?: string
  readonly managerVersion?: string
}): Promise<string> => {
  const root = await fixture("S.Runtime.Node({ manifest })")
  const runtime = Path.join(root, "node_modules/.bin/selected-runtime")
  const manager = Path.join(root, "node_modules/.bin/selected-manager")
  for (
    const [file, version, marker] of [
      [runtime, options.runtimeVersion ?? "1.4.1", "DECLARED_RUNTIME"],
      [manager, options.managerVersion ?? "11.25.0", "DECLARED_MANAGER"],
      [Path.join(root, "node_modules/.bin/pnpm"), "11.25.0", "AMBIENT_MANAGER"]
    ] as const
  ) {
    await Fs.writeFile(file, privateExecutable(version, marker), { mode: 0o755 })
  }
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
${
      options.runtime === undefined
        ? ""
        : `const runtime = S.Runtime.${options.runtime === "node" ? "Node" : "Bun"}({
  version: ${JSON.stringify(options.runtime === "node" ? ">=26.4.0" : ">=1.4.0")},
  executable: ${JSON.stringify(runtime)}
})`
    }
export const Workspace = S.Workspace("native-toolchain", {
  repository: "git+https://example.invalid/native-toolchain.git",
  cache: S.Cache({directory: ".flows"}),
  ${
      options.runtime === undefined
        ? "toolchains: [S.Rust.Toolchain({workspace: S.file(\"//Cargo.toml\"), channel: \"stable\"})],"
        : `runtime,
  packageManager: S.PackageManager.Pnpm({version: "11.25.0", runtime, executable: ${JSON.stringify(manager)}}),
  nodeModules: S.Npm.NodeModules({packageJson: S.file("//package.json")}),`
    }
  sandboxes: S.Sandboxes({default: S.Sandbox.None()})
})

`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({targets: {
  generate: S.Generate({bin: S.${options.reference}.bin, args: ["--probe"], stdout: "observed.txt"})
}})
`
  )
  await write(root, "Cargo.toml", "[workspace]\nmembers = []\n")
  await write(root, ".gitignore", ".flows/\nnode_modules/\n")
  for (
    const args of [
      ["init", "-q", "-b", "main"],
      ["add", "-A"],
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "user.name=Fixture",
        "commit",
        "-qm",
        "fixture"
      ]
    ]
  ) ChildProcess.execFileSync("git", args, { cwd: root, timeout: 10_000, stdio: "pipe" })
  return root
}

describe.skipIf(process.platform === "win32")("native workspace binary references", () => {
  it.each(
    [
      ["Runtime", "DECLARED_RUNTIME"],
      ["PackageManager", "DECLARED_MANAGER"]
    ] as const
  )("runs the custom %s executable instead of a host default", async (reference, marker) => {
    const root = await nativeFixture({ reference, runtime: "bun" })
    const result = await serve(root, ["run", "//:generate", "--no-cache", "--jobs", "1"])
    expect(result.code, result.output).toBe(0)
    expect(await Fs.readFile(Path.join(root, "observed.txt"), "utf8")).toBe(marker + "\n")
    expect(result.output).not.toContain("AMBIENT_MANAGER")
  })

  it("refuses Runtime.bin when the workspace declares no JavaScript runtime", async () => {
    const root = await nativeFixture({ reference: "Runtime" })
    const result = await serve(root, ["run", "//:generate", "--no-cache", "--jobs", "1"])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toMatch(/no.*runtime|runtime.*not declared|declare.*runtime/i)
    await expect(Fs.stat(Path.join(root, "observed.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses manifest pnpm without a workspace runtime before even probing the manager", async () => {
    const root = await nativeFixture({ reference: "PackageManager", runtime: "bun" })
    const trace = Path.join(root, "node_modules/undeclared-runtime-manager-invoked")
    await Fs.writeFile(
      Path.join(root, "node_modules/.bin/pnpm"),
      privateExecutable("10.0.0", "UNDECLARED_RUNTIME_MANAGER").replace(
        "const args =",
        `require("node:fs").writeFileSync(${JSON.stringify(trace)}, "invoked")\nconst args =`
      ),
      { mode: 0o755 }
    )
    await write(
      root,
      "WORKSPACE.ts",
      `import { Smithers as S } from "@smthrs/targets"
const manifest = S.file("//package.json")
export const Workspace = S.Workspace("missing-runtime", {
  repository: "git+https://example.invalid/missing-runtime.git",
  cache: S.Cache({directory: ".flows"}),
  packageManager: S.PackageManager.Pnpm({manifest, lockfile: S.file("//pnpm-lock.yaml")}),
  nodeModules: S.Npm.NodeModules({packageJson: manifest}),
  sandboxes: S.Sandboxes({default: S.Sandbox.None()})
})
`
    )
    const result = await serve(root, ["run", "//:generate", "--no-cache", "--jobs", "1"])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain("Workspace runtime, packageManager, and nodeModules must be declared together")
    await expect(Fs.stat(trace)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(Fs.stat(Path.join(root, "observed.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(
    [
      ["Node", { reference: "Runtime", runtime: "node", runtimeVersion: "20.0.0" }],
      ["Bun", { reference: "Runtime", runtime: "bun", runtimeVersion: "1.3.0" }],
      ["pnpm", { reference: "PackageManager", runtime: "bun", managerVersion: "10.0.0" }]
    ] as const
  )("refuses a mismatched %s before executing the Generate body", async (_, options) => {
    const root = await nativeFixture(options)
    const result = await serve(root, ["run", "//:generate", "--no-cache", "--jobs", "1"])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain("workspace declares")
    expect(result.output).toContain(
      ` runs ${"runtimeVersion" in options ? options.runtimeVersion : options.managerVersion}`
    )
    expect(result.output).not.toContain("DECLARED_RUNTIME")
    expect(result.output).not.toContain("DECLARED_MANAGER")
    await expect(Fs.stat(Path.join(root, "observed.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

const oneShotSpec = "@fixture/private-tool@4.5.6"
const oneShotArgs = ["--probe", "literal spaced value"]

/** Every possible launcher is private and refuses unknown argv before doing work. */
const oneShotFixture = async (runtime: "node" | "bun", runtimeArgs: ReadonlyArray<string> = []): Promise<string> => {
  const root = await nativeFixture({
    reference: "Runtime",
    runtime,
    runtimeVersion: runtime === "node" ? "26.4.0" : "1.4.1"
  })
  const launcher = Path.join(root, "node_modules/private-npm/bin/npx-cli.js")
  // Observational fixture traces are not Generate outputs. Keep them in the
  // already excluded workspace cache so its write-set audit remains intact.
  const trace = Path.join(root, ".flows/one-shot-invocations.jsonl")
  await Fs.mkdir(Path.dirname(trace), { recursive: true })
  await write(
    root,
    "node_modules/private-npm/bin/npx-cli.js",
    `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({tool: "launcher", args}) + "\\n")
if (JSON.stringify(args) === '["--version"]') process.stdout.write("11.16.0\\n")
else if (JSON.stringify(args) === ${
      JSON.stringify(JSON.stringify([oneShotSpec, ...oneShotArgs]))
    }) process.stdout.write("PRIVATE_ONE_SHOT_EXECUTED\\n")
else { process.stderr.write("private npx refused missing spec or unexpected argv: " + JSON.stringify(args)); process.exitCode = 91 }
`
  )
  await Fs.chmod(launcher, 0o755)
  await Fs.symlink(launcher, Path.join(root, "node_modules/.bin/npx"))
  await write(
    root,
    "node_modules/.bin/selected-runtime",
    `#!${process.execPath}
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({tool: "runtime", args}) + "\\n")
const executionArgs = args[0] === "--private-runtime-option" ? args.slice(1) : args
if (JSON.stringify(args) === '["--version"]') process.stdout.write(${
      JSON.stringify(runtime === "node" ? "26.4.0\n" : "1.4.1\n")
    })
else if (${JSON.stringify(runtime)} === "node" && executionArgs[0] === ${JSON.stringify(launcher)}) {
  const child = require("node:child_process").spawnSync(${
      JSON.stringify(process.execPath)
    }, executionArgs, {stdio: "inherit", timeout: 5000})
  process.exitCode = child.status ?? 92
} else if (${JSON.stringify(runtime)} === "bun" && JSON.stringify(executionArgs) === ${
      JSON.stringify(JSON.stringify(["x", "--bun", oneShotSpec, ...oneShotArgs]))
    }) process.stdout.write("PRIVATE_ONE_SHOT_EXECUTED\\n")
else { process.stderr.write("private runtime refused unexpected argv: " + JSON.stringify(args)); process.exitCode = 93 }
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const bin = S.Runtime.npx(${JSON.stringify(oneShotSpec)})
const args = ${JSON.stringify(oneShotArgs)}
export const Package = S.Package({targets: {
  generate: S.Generate({bin, args, stdout: "observed.txt"}),
  run: S.Shell.Run({bin, args, runtimeArgs: ${JSON.stringify(runtimeArgs)}})
}})
`
  )
  return root
}

describe.skipIf(process.platform === "win32")("one-shot workspace runtime references", () => {
  it.each(
    [
      ["node", "generate", []],
      ["node", "run", []],
      ["bun", "generate", []],
      ["bun", "run", []],
      ["node", "run", ["--private-runtime-option"]],
      ["bun", "run", ["--private-runtime-option"]]
    ] as const
  )(
    "forwards spec and user args through the selected %s runtime for %s with runtime args %j",
    async (runtime, target, runtimeArgs) => {
      const root = await oneShotFixture(runtime, runtimeArgs)
      const result = await serve(root, ["run", `//:${target}`, "--no-cache", "--jobs", "1"])
      expect(result.code, result.output).toBe(0)
      if (target === "generate") {
        expect(await Fs.readFile(Path.join(root, "observed.txt"), "utf8")).toBe("PRIVATE_ONE_SHOT_EXECUTED\n")
      } else expect(result.output).toContain("PRIVATE_ONE_SHOT_EXECUTED")
      const invocations = (await Fs.readFile(Path.join(root, ".flows/one-shot-invocations.jsonl"), "utf8"))
        .trim().split("\n").map((line) =>
          JSON.parse(line) as { readonly tool: string; readonly args: ReadonlyArray<string> }
        )
      const expected = runtime === "node"
        ? [...runtimeArgs, Path.join(root, "node_modules/private-npm/bin/npx-cli.js"), oneShotSpec, ...oneShotArgs]
        : [...runtimeArgs, "x", "--bun", oneShotSpec, ...oneShotArgs]
      expect(invocations.filter((entry) => entry.tool === "runtime" && entry.args.includes(oneShotSpec))).toEqual([
        { tool: "runtime", args: expected }
      ])
      expect(
        invocations.some((entry) =>
          entry.tool === "runtime" && entry.args.length === 1 && entry.args[0] === "--version"
        )
      )
        .toBe(true)
      if (runtime === "node") {
        expect(invocations.some((entry) =>
          entry.tool === "runtime" &&
          JSON.stringify(entry.args) ===
            JSON.stringify([Path.join(root, "node_modules/private-npm/bin/npx-cli.js"), "--version"])
        )).toBe(true)
        expect(
          invocations.some((entry) => entry.tool === "launcher" && JSON.stringify(entry.args) === "[\"--version\"]")
        ).toBe(true)
        expect(invocations.filter((entry) => entry.tool === "launcher" && entry.args[0] !== "--version")).toEqual([
          { tool: "launcher", args: [oneShotSpec, ...oneShotArgs] }
        ])
      } else expect(invocations.some((entry) => entry.tool === "launcher")).toBe(false)
    }
  )

  it("probes Node and its launcher independently while sharing identical probes across targets", async () => {
    const root = await oneShotFixture("node")
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
    const plan = await PackageExec.plan({ index, cacheDirectory: ".flows", patterns: ["//..."], verb: "run" })
    for (const target of ["//:generate", "//:run"]) {
      expect(plan.nodes.get(target)?.refusal).toBeUndefined()
      expect(plan.nodes.get(target)?.keyPreview).toBeTypeOf("string")
    }
    const invocations = (await Fs.readFile(Path.join(root, ".flows/one-shot-invocations.jsonl"), "utf8"))
      .trim().split("\n").map((line) =>
        JSON.parse(line) as { readonly tool: string; readonly args: ReadonlyArray<string> }
      )
    expect(invocations.filter((entry) => entry.tool === "runtime")).toEqual([
      { tool: "runtime", args: ["--version"] },
      { tool: "runtime", args: [Path.join(root, "node_modules/private-npm/bin/npx-cli.js"), "--version"] }
    ])
    expect(invocations.filter((entry) => entry.tool === "launcher")).toEqual([
      { tool: "launcher", args: ["--version"] }
    ])
  })

  it("invalidates cached output when an unchanged launcher reports a changed imported implementation version", async () => {
    const root = await oneShotFixture("node")
    const launcher = Path.join(root, "node_modules/private-npm/bin/npx-cli.js")
    await Fs.writeFile(
      launcher,
      `#!${process.execPath}\nrequire("../lib/implementation.cjs").main(process.argv.slice(2))\n`
    )
    const setImplementation = async (version: string) => {
      await write(root, "node_modules/private-npm/package.json", JSON.stringify({ private: true, version }))
      await write(
        root,
        "node_modules/private-npm/lib/implementation.cjs",
        `
// Private implementation ${version}; this package is never fetched.
const fs = require("node:fs")
const version = require("../package.json").version
exports.main = (args) => {
  if (JSON.stringify(args) === '["--version"]') process.stdout.write(version + "\\n")
  else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify([oneShotSpec, ...oneShotArgs]))}) {
    fs.mkdirSync("dist", {recursive: true})
    fs.writeFileSync("dist/observed.txt", version + "\\n")
    process.stdout.write("PRIVATE_IMPORTED_IMPLEMENTATION_" + version + "\\n")
  } else { process.stderr.write("private implementation refused unexpected argv"); process.exitCode = 91 }
}
`
      )
    }
    await setImplementation("11.16.0")
    await write(root, ".gitignore", ".flows/\nnode_modules/\ndist/\n")
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({targets: {
  build: S.Shell.Build({
    bin: S.Runtime.npx(${JSON.stringify(oneShotSpec)}), args: ${JSON.stringify(oneShotArgs)},
    data: [S.file("value.ts")], outFiles: ["dist/observed.txt"]
  })
}})
`
    )
    const stablePaths = [
      "WORKSPACE.ts",
      "PACKAGE.ts",
      "package.json",
      "value.ts",
      "node_modules/.bin/selected-runtime",
      "node_modules/private-npm/bin/npx-cli.js"
    ]
    const stableBytes = await Promise.all(stablePaths.map((path) => Fs.readFile(Path.join(root, path), "utf8")))
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
    const plan = async () => {
      const target =
        (await PackageExec.plan({ index, cacheDirectory: ".flows", patterns: ["//:build"], verb: "build" }))
          .nodes.get("//:build")!
      expect(target.refusal).toBeUndefined()
      expect(target.cacheable).toBe(true)
      return target.keyPreview
    }
    const args = ["build", "//:build", "--jobs", "1"]
    const before = await plan()
    const first = await serve(root, args)
    expect(first.code, first.output).toBe(0)
    expect(first.output).toContain("PRIVATE_IMPORTED_IMPLEMENTATION_11.16.0")
    const warm = await serve(root, args)
    expect(warm.code, warm.output).toBe(0)
    expect(warm.output).toContain("//:build  hit")
    expect(warm.output).not.toContain("PRIVATE_IMPORTED_IMPLEMENTATION_")

    await setImplementation("11.17.0")
    expect(await Promise.all(stablePaths.map((path) => Fs.readFile(Path.join(root, path), "utf8"))))
      .toEqual(stableBytes)
    expect(await plan()).not.toBe(before)
    // A removed output forces restoration if the old cache key aliases. The
    // correct plan executes the new implementation and writes its new value.
    await Fs.rm(Path.join(root, "dist/observed.txt"))
    const changed = await serve(root, args)
    expect(changed.code, changed.output).toBe(0)
    expect(changed.output).toContain("//:build  ran")
    expect(changed.output).toContain("PRIVATE_IMPORTED_IMPLEMENTATION_11.17.0")
    expect(await Fs.readFile(Path.join(root, "dist/observed.txt"), "utf8")).toBe("11.17.0\n")
    const changedWarm = await serve(root, args)
    expect(changedWarm.code, changedWarm.output).toBe(0)
    expect(changedWarm.output).toContain("//:build  hit")
    expect(changedWarm.output).not.toContain("PRIVATE_IMPORTED_IMPLEMENTATION_")
  })

  it("keys changed launcher bytes even when the npx path and reported version stay the same", async () => {
    const root = await oneShotFixture("node")
    const launcher = Path.join(root, "node_modules/private-npm/bin/npx-cli.js")
    const original = await Fs.readFile(launcher, "utf8")
    const index = PackageIndex.make(await PackageLoader.load(await PackageDiscovery.discover(root)))
    const plan = async () => {
      const node = (await PackageExec.plan({ index, cacheDirectory: ".flows", patterns: ["//:generate"], verb: "run" }))
        .nodes.get("//:generate")!
      expect(node.refusal).toBeUndefined()
      return node.keyPreview
    }
    const before = await plan()
    await Fs.writeFile(launcher, original + "\n// Different private launcher implementation bytes.\n")
    expect(await plan()).not.toBe(before)
    await Fs.writeFile(launcher, original)
    expect(await plan()).toBe(before)
  })

  it("refuses a one-shot reference in a path-only using slot before running the template", async () => {
    const root = await oneShotFixture("bun")
    await Fs.writeFile(Path.join(root, "node_modules/.bin/bun"), privateExecutable("1.4.1", "TEMPLATE_RAN"), {
      mode: 0o755
    })
    await write(
      root,
      "PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({targets: {
  run: S.Shell.Run({bun: "console.log('TEMPLATE_RAN')", using: {tool: S.Runtime.npx(${JSON.stringify(oneShotSpec)})}})
}})
`
    )
    const result = await serve(root, ["run", "//:run", "--no-cache", "--jobs", "1"])
    expect(result.code, result.output).toBe(1)
    expect(result.output).toContain("Runtime.npx references must be used as bin, not in using")
    expect(result.output).not.toContain("TEMPLATE_RAN")
  })
})

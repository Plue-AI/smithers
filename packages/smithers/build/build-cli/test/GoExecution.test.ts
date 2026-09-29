import { Smithers as S } from "@smthrs/targets"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"
import * as PackageTree from "../src/PackageTree.ts"
import { serve } from "./helpers/ServeCli.ts"
import { write } from "./helpers/WriteFile.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () =>
  Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
)
// Probe from a module with the fixture's minimum version so an older launcher
// can still select a compatible toolchain through GOTOOLCHAIN.
const goPath = PackageTree.findOnPath("go")
const hasGo = await (async () => {
  if (goPath === undefined) return false
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-probe-"))
  try {
    await write(root, "go.mod", "module example.test/probe\n\ngo 1.26.0\n")
    const probe = await PackageTree.probeVersion(goPath, { args: ["version"], cwd: root })
    const version = /go version go(\d+)\.(\d+)/.exec(probe.output)
    return probe.exitCode === 0 && version !== null &&
      (Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= 26))
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
})()

// Use an installed older launcher; the test never installs a toolchain or
// relies on a download while the target is running in its closed sandbox.
const olderGo = await (async (): Promise<string | undefined> => {
  const candidates = [goPath, NodePath.join(Os.homedir(), "go/pkg/mod/golang.org/toolchain@v0.0.1-go1.24.6." +
    `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}/bin/go`)]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    try {
      const version = NodeChildProcess.execFileSync(candidate, ["version"], {
        encoding: "utf8",
        env: { ...process.env, GOTOOLCHAIN: "local" }
      })
      if (/go version go1\.(?:[0-9]|1[0-9]|2[0-5])\./.test(version)) return candidate
    } catch { /* This launcher is not installed. */ }
  }
  return undefined
})()

/**
 * Plans against only the named host tools, regardless of optional tools
 * installed on the host. `stubs` writes extra executables into the same
 * directory, so a refusal case and its positive control differ by the presence
 * of one optional tool and nothing else.
 */
const withBarePath = async <A>(
  tools: ReadonlyArray<string>,
  body: (bin: string) => Promise<A>,
  stubs: Readonly<Record<string, string>> = {}
): Promise<A> => {
  const bin = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-bin-")))
  temporaryDirectories.push(bin)
  for (const tool of tools) {
    const found = PackageTree.findOnPath(tool)
    if (found === undefined) throw new Error(`Missing fixture tool: ${tool}`)
    await Fs.symlink(found, NodePath.join(bin, tool))
  }
  for (const [name, script] of Object.entries(stubs)) {
    await Fs.writeFile(NodePath.join(bin, name), script, { mode: 0o755 })
  }
  const previous = process.env["PATH"]
  process.env["PATH"] = bin
  try {
    return await body(bin)
  } finally {
    if (previous === undefined) delete process.env["PATH"]
    else process.env["PATH"] = previous
  }
}

const packageWithoutSandbox = (source: string): string =>
  source.replaceAll("sandbox: { network: true }", "sandbox: \"none\"")

const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-exec-")))
  temporaryDirectories.push(root)
  await write(root, "go.mod", "module example.test/fixture\n\ngo 1.26.0\n")
  await write(root, "go.sum", "")
  await write(root, "flake.nix", "{}\n")
  await write(root, "flake.lock", "{}\n")
  await write(root, "lib/lib.go", "package lib\nfunc Value() string { return \"ok\" }\n")
  await write(
    root,
    "lib/lib_test.go",
    "package lib\nimport \"testing\"\nfunc TestValue(t *testing.T) { if Value() != \"ok\" { t.Fatal(Value()) } }\nfunc FuzzValue(f *testing.F) { f.Add(\"x\"); f.Fuzz(func(t *testing.T, s string) {}) }\n"
  )
  await write(
    root,
    "cmd/app/main.go",
    "package main\nimport (\"fmt\"; \"example.test/fixture/lib\")\nvar Version = \"unset\"\nfunc main() { fmt.Println(lib.Value(), Version) }\n"
  )
  await write(
    root,
    "gen/gen.go",
    "package gen\n//go:generate sh -c \"printf 'package gen\\nconst Generated = true\\n' > generated.go\"\n"
  )
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const nix = S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") })
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: nix, cgo: false })
export const Workspace = S.Workspace("fixture", { repository: "git+https://example.test/fixture.git", cache: S.Cache({ directory: ".flows" }), toolchains: [nix, go], host: S.Host({ bins: ["smthrs-absent-generator"] }) })
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const all = S.Go.Packages({ pkgs: ["./..."] })
const test = S.Go.Test({ pkgs: ["./lib"] })
const fetch = S.Go.ModDownload({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), outDirs: ["//.gomodcache"], sandbox: { network: true } })
const binary = S.Go.Binary({ pkg: "./cmd/app", out: "//build/app", stamp: { "main.Version": S.Stamp.version } })
const smoke = S.Shell.Test({ bin: binary })
const generate = S.Go.Generate({ pkgs: ["./gen"], changes: ["gen/generated.go"] })
const fuzz = S.Go.Fuzz({ pkg: "./lib", fuzz: "FuzzValue", time: "1x", parallel: 1 })
const generateMissingTool = S.Go.Generate({ pkgs: ["./gen"], tools: [S.Host.bin("smthrs-absent-generator")], changes: ["gen/generated.go"] })
const nixRefusal = S.Shell.Test({ bin: S.Nix.bin("hurl"), args: ["--version"] })
export const Package = S.Package({ targets: { all, binary, fetch, fuzz, generate, generateMissingTool, nixRefusal, smoke, test } })
`
  )
  NodeChildProcess.execFileSync("git", ["-C", root, "init", "-q"])
  NodeChildProcess.execFileSync("git", ["-C", root, "add", "-A"])
  NodeChildProcess.execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.email=t@t.t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  ])
  NodeChildProcess.execFileSync("git", ["-C", root, "tag", "v1.2.3"])
  return root
}

describe.runIf(olderGo !== undefined)("Go selected SDK execution", () => {
  it("builds with the already selected SDK rather than the older Go launcher", async () => {
    const root = await fixture()
    const selected = JSON.parse(NodeChildProcess.execFileSync(olderGo!, ["env", "-json", "GOROOT", "GOTOOLDIR"], {
      cwd: root,
      encoding: "utf8"
    })) as { GOROOT: string; GOTOOLDIR: string }
    const sdkGo = NodePath.join(selected.GOROOT, "bin/go")
    expect(selected.GOROOT).not.toBe(NodePath.dirname(NodePath.dirname(olderGo!)))
    expect(await Fs.stat(sdkGo)).toBeDefined()
    const control = await serve(await fixture(), ["build", "//:binary"], {
      environment: {
        ...process.env,
        PATH: `${NodePath.dirname(sdkGo)}${NodePath.delimiter}${process.env.PATH ?? ""}`
      }
    })
    expect(control.exitCode, control.logs).toBe(0)
    expect(control.logs).toContain("//:binary  ran")
    const environment = {
      ...process.env,
      PATH: `${NodePath.dirname(olderGo!)}${NodePath.delimiter}${process.env.PATH ?? ""}`
    }
    const launched = await serve(root, ["build", "//:binary"], { environment })
    expect(launched.exitCode, launched.logs).toBe(0)
    expect(launched.logs).toContain("//:binary  ran")
  }, 120_000)
})

describe.runIf(hasGo)("Go package execution", () => {
  it("loads, plans without NotImplemented, executes tests/build/tool edge/stamps, and hits", async () => {
    const root = await fixture()
    const query = await serve(root, ["query", "//..."])
    expect(query.exitCode).toBe(0)
    const plan = await serve(root, ["//:binary", "--plan"])
    expect(plan.exitCode).toBe(0)
    expect(plan.output).not.toContain("NotImplemented")
    const tested = await serve(root, ["//:test"])
    expect(tested.exitCode).toBe(0)
    const smoke = await serve(root, ["//:smoke"])
    expect(smoke.exitCode).toBe(0)
    expect(smoke.logs).toContain("//:binary  ran")
    expect(NodeChildProcess.execFileSync(NodePath.join(root, "build/app"), { encoding: "utf8" })).toContain("ok v1.2.3")
    const hit = await serve(root, ["//:smoke"])
    expect(hit.exitCode).toBe(0)
    expect(hit.logs).toContain("//:binary  hit")
    expect(hit.logs).toContain("//:smoke  hit")
  }, 120_000)

  it("runs Generate/Fuzz and gives Nix's typed host refusal", async () => {
    const root = await fixture()
    const generated = await serve(root, ["//:generate", "--write"])
    expect(generated.exitCode).toBe(0)
    expect(await Fs.readFile(NodePath.join(root, "gen/generated.go"), "utf8")).toContain("Generated")
    expect((await serve(root, ["//:fuzz"])).exitCode).toBe(0)
    const nix = await withBarePath(["go", "git", "sh", "node"], () => serve(root, ["//:nixRefusal", "--plan"]))
    expect(nix.output).toContain("host binary \\\"nix\\\" is not present on PATH")
  }, 120_000)

  // The positive control for the refusal above: the same fixture and the same
  // bare PATH, differing only by a `nix` on it, resolves the bin through
  // `nix develop` instead of refusing. Without it the refusal assertion would
  // still hold for a rule that always refused.
  it("resolves a Nix bin through the dev shell when nix is present", async () => {
    const root = await fixture()
    const planned = await withBarePath(
      ["go", "git", "sh", "node"],
      async (bin) => ({ bin, ...await serve(root, ["//:nixRefusal", "--plan"]) }),
      {
        nix:
          // `nix develop --command which hurl` answers with a real executable.
          // The bare PATH holds no `dirname`, so the stub trims $0 in the shell.
          "#!/bin/sh\nprintf '%s\\n' \"${0%/*}/sh\"\n"
      }
    )
    expect(planned.output).not.toContain("is not present on PATH")
    expect(planned.output).toContain(`${planned.bin}/sh`)
  }, 120_000)

  it("resolves a Go.Generate generator tool, so an absent one refuses by name", async () => {
    const root = await fixture()
    const plan = await serve(root, ["//:generateMissingTool", "--plan"])
    expect(plan.output).toContain("smthrs-absent-generator")
    expect(plan.output).toContain("refusal")
  }, 120_000)

  it("keys on the Go import closure only", async () => {
    const root = await fixture()
    expect((await serve(root, ["//:test"])).exitCode).toBe(0)
    await write(root, "outside.txt", "outside\n")
    expect((await serve(root, ["//:test"])).logs).toContain("//:test  hit")
    await write(
      root,
      "lib/lib.go",
      "package lib\n// changed inside the closure\nfunc Value() string { return \"ok\" }\n"
    )
    const changed = await serve(root, ["//:test"])
    expect(changed.logs).toContain("//:test  ran")
  }, 120_000)

  it.each(["Go.Test", "Go.Fuzz"])("%s keys and admits test-only import dependencies", async (rule) => {
    const root = await fixture()
    await write(
      root,
      "go.mod",
      "module example.test/fixture\n\ngo 1.26.0\n\nrequire example.test/helper v0.0.0\nreplace example.test/helper => ./replacement\n"
    )
    await write(root, "internalhelper/helper.go", "package internalhelper\nconst Want = 1\n")
    await write(root, "externalhelper/helper.go", "package externalhelper\nconst Want = 1\n")
    await write(root, "replacement/go.mod", "module example.test/helper\n\ngo 1.26.0\n")
    await write(root, "replacement/helper.go", "package helper\nconst Want = 1\n")
    await write(
      root,
      "lib/imports_test.go",
      `package lib
import ("testing"; "example.test/fixture/internalhelper")
func TestInternalImport(t *testing.T) { if internalhelper.Want < 1 { t.Fatal(internalhelper.Want) } }
`
    )
    await write(
      root,
      "lib/external_test.go",
      `package lib_test
import ("testing"; "example.test/fixture/externalhelper"; "example.test/helper")
func TestExternalImport(t *testing.T) { if externalhelper.Want < 1 || helper.Want < 1 { t.Fatal("invalid helper") } }
`
    )
    const workspace = S.Workspace("closure", {
      repository: "git+https://example.test/fixture.git",
      cache: S.Cache({ directory: ".flows" }),
      toolchains: [S.Go.Toolchain({
        mod: S.file("//go.mod"),
        sum: S.file("//go.sum"),
        versions: S.Nix.DevShell({ flake: S.file("//flake.nix"), lock: S.file("//flake.lock") }),
        cgo: false
      })]
    })
    const attrs = rule === "Go.Test" ? { pkgs: ["./lib"] } : { pkg: "./lib", fuzz: "FuzzValue", time: "1x" }
    const plan = () => GoExec.planRule(rule, attrs, { root, packagePath: "", workspace }, PackageTree.findOnPath("go")!)
    let previous = await plan()
    const helpers = ["internalhelper/helper.go", "externalhelper/helper.go", "replacement/helper.go"]
    expect(previous.readSet).toEqual(expect.arrayContaining(helpers))
    expect(previous.closureIdentity).toMatchObject({
      files: expect.arrayContaining(helpers.map((path) => [path, expect.any(String)]))
    })
    // Test variants repeat source rows; only one digest and read permission belongs to each file.
    expect(previous.readSet.filter((path) => path === "lib/lib.go")).toHaveLength(1)
    for (const helper of helpers) {
      await Fs.appendFile(NodePath.join(root, helper), "// changed test-only input\n")
      const changed = await plan()
      expect(changed.closureIdentity).not.toEqual(previous.closureIdentity)
      previous = changed
    }
  }, 120_000)

  it("removes a partial module archive when tar fails", async () => {
    const root = await fixture()
    await write(root, "PACKAGE.ts", packageWithoutSandbox(await Fs.readFile(NodePath.join(root, "PACKAGE.ts"), "utf8")))
    const tar = NodePath.join(root, "fake-tar")
    await Fs.writeFile(
      tar,
      "#!/bin/sh\nif [ \"$1\" = \"-cf\" ]; then printf partial > \"$2\"; echo archive-failed >&2; exit 1; fi\necho fixture-tar\n",
      { mode: 0o755 }
    )
    const findOnPath = PackageTree.findOnPath
    const find = vi.spyOn(PackageTree, "findOnPath").mockImplementation((name) =>
      name === "tar" ? tar : findOnPath(name)
    )
    let result: Awaited<ReturnType<typeof serve>>
    try {
      result = await serve(root, ["//:fetch"])
    } finally {
      find.mockRestore()
    }
    expect(result.exitCode).toBe(1)
    expect(result.logs).toContain("archive-failed")
    expect(await Fs.readdir(NodePath.join(root, ".flows/tmp"))).toEqual([])
  }, 120_000)

  it("removes a module archive when capturing its blob fails", async () => {
    const root = await fixture()
    await write(root, "PACKAGE.ts", packageWithoutSandbox(await Fs.readFile(NodePath.join(root, "PACKAGE.ts"), "utf8")))
    const captureFile = PackageTree.captureFile
    let capturedArchive = false
    const capture = vi.spyOn(PackageTree, "captureFile").mockImplementation(async (...args) => {
      if (args[2].startsWith(".flows/tmp/go-mod-")) {
        expect((await Fs.stat(NodePath.join(root, args[2]))).size).toBeGreaterThan(0)
        capturedArchive = true
        throw new Error("fixture capture failure")
      }
      return captureFile(...args)
    })
    try {
      const result = await serve(root, ["//:fetch"])
      expect(capturedArchive, result.output + result.logs).toBe(true)
      expect(result.exitCode).toBe(1)
      expect(result.logs).toContain("fixture capture failure")
      expect(await Fs.readdir(NodePath.join(root, ".flows/tmp"))).toEqual([])
    } finally {
      capture.mockRestore()
    }
  }, 120_000)

  it("captures the module cache as one tar blob and restores it on a hit", async () => {
    const root = await fixture()
    await write(root, "PACKAGE.ts", packageWithoutSandbox(await Fs.readFile(NodePath.join(root, "PACKAGE.ts"), "utf8")))
    expect((await serve(root, ["//:fetch"])).logs).toContain("//:fetch  ran")
    expect(await Fs.readdir(NodePath.join(root, ".flows/tmp"))).toEqual([])
    await Fs.rm(NodePath.join(root, ".gomodcache"), { recursive: true, force: true })
    const second = await serve(root, ["//:fetch"])
    expect(second.logs).toContain("//:fetch  hit")
    expect(await Fs.readdir(NodePath.join(root, ".flows/tmp"))).toEqual([])
    await expect(Fs.stat(NodePath.join(root, ".gomodcache"))).resolves.toMatchObject({})
  }, 120_000)
})

// A module whose sources only compile when the toolchain layer's
// GOEXPERIMENT is on, which is tapes' `experiments: ["jsonv2"]` reduced to
// one package. `go list` resolves build constraints, so planning fails
// unless the toolchain environment reaches it.
const experimentFixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-exp-")))
  temporaryDirectories.push(root)
  await write(root, "go.mod", "module example.test/experiment\n\ngo 1.26.0\n")
  await write(root, "go.sum", "")
  await write(
    root,
    "jsonpkg/jsonpkg.go",
    "package jsonpkg\n\nimport \"encoding/json/v2\"\n\nfunc Marshal(value any) ([]byte, error) { return json.Marshal(value) }\n"
  )
  await write(
    root,
    "jsonpkg/jsonpkg_test.go",
    "package jsonpkg\n\nimport \"testing\"\n\nfunc TestMarshal(t *testing.T) {\n\tif _, err := Marshal(map[string]int{\"a\": 1}); err != nil { t.Fatal(err) }\n}\n"
  )
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: S.Nix.DevShell({ flake: S.file("//go.mod"), lock: S.file("//go.sum") }), experiments: ["jsonv2"] })
export const Workspace = S.Workspace("experiment", { repository: "git+https://example.test/experiment.git", cache: S.Cache({ directory: ".flows" }), toolchains: [go] })
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const test = S.Go.Test({ pkgs: ["./jsonpkg"] })
const capped = S.Go.Test({ pkgs: ["./jsonpkg"], parallel: 2 })
const perCpu = S.Go.Test({ pkgs: ["./jsonpkg"], parallel: "cpus" })
const viaGotestsum = S.Go.Test({ pkgs: ["./jsonpkg"], runner: "gotestsum" })
export const Package = S.Package({ targets: { capped, perCpu, test, viaGotestsum } })
`
  )
  return root
}

/** A module whose one package is compiled from Go, C, and a C header through cgo. */
const cgoFixture = async (): Promise<string> => {
  const compiler = process.platform === "darwin"
    ? NodeChildProcess.execFileSync("xcrun", ["--find", "clang"], { encoding: "utf8" }).trim()
    : undefined
  const sdkRoot = process.platform === "darwin"
    ? NodeChildProcess.execFileSync("xcrun", ["--show-sdk-path"], { encoding: "utf8" }).trim()
    : undefined
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-go-cgo-")))
  temporaryDirectories.push(root)
  await write(root, "go.mod", "module example.test/cgo\n\ngo 1.26.0\n")
  await write(root, "go.sum", "")
  await write(
    root,
    "native/native.go",
    "package main\n\n/*\n#include \"value.h\"\n*/\nimport \"C\"\n\n" +
      "func main() { if C.native_value() != 7 { panic(\"unexpected native value\") } }\n"
  )
  await write(root, "native/value.h", "int native_value(void);\n")
  await write(root, "native/value.c", "#include \"value.h\"\n\nint native_value(void) { return 7; }\n")
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const go = S.Go.Toolchain({ mod: S.file("//go.mod"), sum: S.file("//go.sum"), versions: S.Nix.DevShell({ flake: S.file("//go.mod"), lock: S.file("//go.sum") }), cgo: true })
export const Workspace = S.Workspace("cgo", { repository: "git+https://example.test/cgo.git", cache: S.Cache({ directory: ".flows" }), toolchains: [go] })
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const binary = S.Go.Binary({ pkg: "./native", out: "//build/native${process.platform === "win32" ? ".exe" : ""}"${
      compiler ? `, env: { CC: ${JSON.stringify(compiler)}, SDKROOT: ${JSON.stringify(sdkRoot)} }` : ""
    } })
const test = S.Shell.Test({ bin: binary })
export const Package = S.Package({ targets: { binary, test } })
`
  )
  return root
}

/** cgo needs a host C compiler; a runner without one cannot build the fixture at all. */
const hasCCompiler = PackageTree.findOnPath("cc") !== undefined || PackageTree.findOnPath("clang") !== undefined

describe.runIf(hasGo)("Go native compiler inputs", () => {
  /**
   * `GoListRow` stopped at the Go and embed collections, so a `.c`, `.h`, or
   * `.s` file a cgo package compiles was absent from the closure. Editing one
   * left the target key unchanged and the cache served a binary built from the
   * previous sources — the one defect class this package otherwise refuses.
   * `go list` is the oracle: every collection it reports is keyed.
   */
  it.skipIf(!hasCCompiler)("re-keys when a C source or header a cgo package compiles changes", async () => {
    const root = await cgoFixture()
    // Each sandbox starts with a cold Go cache. A small executable checks the
    // native result without rebuilding the testing package three times.
    const check = async (): Promise<string> => {
      const result = await serve(root, ["//:test"])
      expect(result.exitCode, result.output + result.logs).toBe(0)
      return result.logs
    }
    expect(await check()).toContain("//:binary  ran")
    expect(await check()).toContain("//:binary  hit")

    await write(
      root,
      "native/value.c",
      "#include \"value.h\"\n\n/* edited */\nint native_value(void) { return 7; }\n"
    )
    expect(await check()).toContain("//:binary  ran")

    await write(root, "native/value.h", "/* edited */\nint native_value(void);\n")
    expect(await check()).toContain("//:binary  ran")

    // A file the compiler never reads still leaves the key alone.
    await write(root, "outside.txt", "outside\n")
    expect(await check()).toContain("//:binary  hit")
  }, 180_000)
})

describe.runIf(hasGo)("Go toolchain environment", () => {
  /**
   * The confinement admitted the directories the SDK's executables sit in --
   * `$GOROOT/bin` and `$GOTOOLDIR` -- and nothing else of the SDK. `go build`
   * compiles the standard library from `$GOROOT/src` and reads `$GOROOT/lib`
   * and `$GOROOT/go.env`, so every Go target failed with
   * `package <path>: cannot find package`. It was invisible on a host whose Go
   * lives under a broad runtime grant (`/usr`, `/opt/homebrew`, `/nix/store`)
   * and fatal on one where it does not, which is every GitHub runner: the SDK
   * sits in the hosted tool cache. The SDK is one installed tree, and the whole
   * of it is the toolchain's read.
   */
  it("admits the whole selected SDK, not just the directories its executables sit in", async () => {
    const root = await fixture()
    const goPath = PackageTree.findOnPath("go")!
    const probe = await PackageTree.probeVersion(goPath, { cwd: root, args: ["env", "-json", "GOROOT"] })
    const { GOROOT } = JSON.parse(probe.output) as { readonly GOROOT: string }
    const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
    const planned = await PackageExec.plan({
      index: PackageIndex.make(loaded),
      patterns: ["//:test"],
      cacheDirectory: ".flows",
      verb: "auto"
    })
    const reads = planned.nodes.get("//:test")?.externalReads
    expect(reads).toContain(GOROOT)
    // The grant is the SDK, not its parent: a sibling installation stays out.
    expect(reads).not.toContain(NodePath.dirname(GOROOT))
  }, 120_000)

  it("gives the toolchain's GOEXPERIMENT to plan-time go list, so a jsonv2 module plans and runs", async () => {
    const root = await experimentFixture()
    const plan = await serve(root, ["//:test", "--plan"])
    expect(plan.output + plan.logs).not.toContain("build constraints exclude all Go files")
    expect(plan.output).not.toContain("refusal")
    expect(plan.exitCode).toBe(0)
    const ran = await serve(root, ["//:test"])
    expect(ran.exitCode).toBe(0)
  }, 180_000)

  it("passes a numeric parallel through and leaves \"cpus\" to go's own default", async () => {
    const root = await experimentFixture()
    expect((await serve(root, ["//:capped", "--plan"])).output).toContain("-parallel=2")
    expect((await serve(root, ["//:perCpu", "--plan"])).output).not.toContain("-parallel")
  }, 180_000)

  it("refuses by name when the declared runner is absent instead of running plain go test", async () => {
    const root = await experimentFixture()
    const plan = await withBarePath(["go", "git", "sh", "node"], () => serve(root, ["//:viaGotestsum", "--plan"]))
    expect(plan.output).toContain("host binary \\\"gotestsum\\\" is not present on PATH")
    expect(plan.output).not.toContain("go,test")
  }, 180_000)

  // The positive control for the refusal above: with `gotestsum` on the same
  // bare PATH the runner reaches the argv, so the refusal reports the tool's
  // absence rather than a rule that never runs one.
  it("runs the declared runner when it is present on PATH", async () => {
    const root = await experimentFixture()
    const planned = await withBarePath(
      ["go", "git", "sh", "node"],
      async (bin) => ({ bin, ...await serve(root, ["//:viaGotestsum", "--plan"]) }),
      { gotestsum: "#!/bin/sh\nexec go test \"$@\"\n" }
    )
    expect(planned.output).not.toContain("is not present on PATH")
    expect(planned.output).toContain(`${planned.bin}/gotestsum`)
  }, 180_000)

  it("probes the toolchain with `go version`, so GOTOOLCHAIN's resolved version is identity", async () => {
    const goPath = PackageTree.findOnPath("go")!
    const probe = await PackageTree.probeVersion(goPath, { args: ["version"] })
    expect(probe.exitCode).toBe(0)
    expect(probe.output).toContain("go version go")
    // The bare --version probe is a usage error and reports no version at all.
    const flag = await PackageTree.probeVersion(goPath)
    expect(flag.output).not.toContain("go version go")
  })
})

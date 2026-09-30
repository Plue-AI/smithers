/**
 * Go and Nix planning through scripted `go`, `nix` and `gotestsum`
 * executables on PATH: every failing probe becomes a refusal or a rejected
 * plan that names the command, and each rule's argv, environment and key
 * closure follow the declaration.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import * as GoExec from "../src/GoExec.ts"

const roots: Array<string> = []
afterAll(async () => {
  await Promise.all(roots.map((root) => Fs.rm(root, { recursive: true, force: true })))
})

const baseWorkspace = S.Workspace("go-failures", {
  repository: "git+https://example.invalid/go-failures.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})

const goToolchain = {
  _tag: "GoToolchain",
  mod: S.file("//mod/go.mod"),
  sum: S.file("//mod/go.sum"),
  versions: { _tag: "Mise", config: S.file("//mise.toml") },
  cgo: false,
  experiments: ["jsonv2", "synctest"]
}
const withToolchains = (...toolchains: ReadonlyArray<unknown>) =>
  ({ ...baseWorkspace, toolchains }) as unknown as GoExec.Context["workspace"]

interface Host {
  readonly root: string
  readonly bin: string
  readonly stub: string
  readonly log: string
  readonly context: GoExec.Context
  readonly set: (name: string, text: string) => Promise<void>
  readonly calls: () => Promise<ReadonlyArray<string>>
}

let host: Host

/**
 * A workspace plus `go`/`nix` stand-ins. Each answer is a file under `stub/`
 * so a test changes one probe's output or exit status without a new script.
 */
const makeHost = async (): Promise<Host> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-go-exec-")))
  roots.push(root)
  const bin = NodePath.join(root, ".bin")
  const stub = NodePath.join(root, ".stub")
  const log = NodePath.join(stub, "calls.log")
  await Fs.mkdir(bin)
  await Fs.mkdir(stub)
  const answer = (name: string) =>
    `cat ${JSON.stringify(NodePath.join(stub, `${name}.out`))} 2>/dev/null; ` +
    `cat ${JSON.stringify(NodePath.join(stub, `${name}.err`))} >&2 2>/dev/null; ` +
    `exit $(cat ${JSON.stringify(NodePath.join(stub, `${name}.exit`))} 2>/dev/null || echo 0)`
  await Fs.writeFile(
    NodePath.join(bin, "go"),
    [
      "#!/bin/sh",
      `echo "go $* GOEXPERIMENT=$GOEXPERIMENT CGO_ENABLED=$CGO_ENABLED GOOS=$GOOS" >> ${JSON.stringify(log)}`,
      "case \"$1\" in",
      "  version) echo 'go version go1.26.0 stub/host' ;;",
      `  env) ${answer("env")} ;;`,
      "  list)",
      "    case \"$*\" in",
      `      *-deps*) ${answer("deps")} ;;`,
      `      *right*) ${answer("right")} ;;`,
      `      *) ${answer("list")} ;;`,
      "    esac ;;",
      "esac",
      ""
    ].join("\n"),
    { mode: 0o755 }
  )
  const context: GoExec.Context = {
    root,
    packagePath: "pkg",
    workspace: withToolchains(),
    environment: { PATH: `${bin}:/usr/bin:/bin`, HOME: root }
  }
  return {
    root,
    bin,
    stub,
    log,
    context,
    set: (name, text) => Fs.writeFile(NodePath.join(stub, name), text),
    calls: async () => (await Fs.readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== "")
  }
}

/** A selected SDK with its compiler tools, answered by `go env -json`. */
const sdk = async (): Promise<{ readonly goroot: string; readonly tooldir: string }> => {
  const goroot = NodePath.join(host.root, ".sdk")
  const tooldir = NodePath.join(goroot, "pkg/tool/stub")
  await Fs.mkdir(NodePath.join(goroot, "bin"), { recursive: true })
  await Fs.mkdir(NodePath.join(tooldir, "subdir"), { recursive: true })
  for (const file of ["bin/gofmt", "bin/go", "pkg/tool/stub/link", "pkg/tool/stub/compile"]) {
    await Fs.writeFile(NodePath.join(goroot, file), "bytes")
  }
  await host.set("env.out", JSON.stringify({ GOROOT: goroot, GOTOOLDIR: tooldir }))
  return { goroot, tooldir }
}

beforeEach(async () => {
  host = await makeHost()
})

describe.skipIf(process.platform === "win32")("resolveGo", () => {
  it("refuses a host without go on PATH", async () => {
    expect(await GoExec.resolveGo({ ...host.context, environment: { PATH: host.stub } })).toEqual({
      ok: false,
      refusal: "host binary \"go\" is not present on PATH",
      identity: { tag: "GoBin", absent: true }
    })
  })

  it.each([
    ["a failing go env", "{}", "2"],
    ["unparseable go env output", "not json", "0"],
    ["a go env without GOTOOLDIR", JSON.stringify({ GOROOT: "/sdk" }), "0"],
    ["a go env with a non-string GOROOT", JSON.stringify({ GOROOT: 1, GOTOOLDIR: "/t" }), "0"]
  ])("refuses %s", async (_name, output, exit) => {
    await host.set("env.out", output)
    await host.set("env.exit", exit)
    const resolved = await GoExec.resolveGo(host.context)
    expect(resolved).toMatchObject({
      ok: false,
      refusal: "go env could not identify GOROOT and GOTOOLDIR",
      identity: { tag: "GoBin", path: NodePath.join(host.bin, "go"), probe: { exitCode: 0 } }
    })
  })

  it("runs the selected SDK's go and keys the module and version authorities", async () => {
    const { goroot, tooldir } = await sdk()
    await Fs.mkdir(NodePath.join(host.root, "mod"))
    await Fs.writeFile(NodePath.join(host.root, "mod/go.mod"), "module example.test\n")
    await Fs.writeFile(NodePath.join(host.root, "mod/go.sum"), "")
    await Fs.writeFile(NodePath.join(host.root, "mise.toml"), "[tools]\ngo = \"1.26\"\n")
    const resolved = await GoExec.resolveGo({ ...host.context, workspace: withToolchains(goToolchain) })
    expect(resolved).toMatchObject({
      ok: true,
      path: NodePath.join(goroot, "bin/go"),
      sdkRoot: goroot,
      executables: [
        NodePath.join(host.bin, "go"),
        NodePath.join(goroot, "bin/go"),
        NodePath.join(goroot, "bin/gofmt"),
        NodePath.join(tooldir, "compile"),
        NodePath.join(tooldir, "link")
      ],
      identity: {
        tag: "GoBin",
        cwd: "mod",
        authorities: [
          { path: "mod/go.mod", digest: expect.any(String) },
          { path: "mod/go.sum", digest: expect.any(String) },
          { path: "mise.toml", digest: expect.any(String) }
        ]
      }
    })
    // The probes run in the module directory under the toolchain's settings.
    expect(await host.calls()).toEqual([
      "go version GOEXPERIMENT=jsonv2,synctest CGO_ENABLED=0 GOOS=",
      "go env -json GOROOT GOTOOLDIR GOEXPERIMENT=jsonv2,synctest CGO_ENABLED=0 GOOS="
    ])
  })
})

describe.skipIf(process.platform === "win32")("resolveNix", () => {
  const writeNix = async (script: string) => {
    await Fs.writeFile(NodePath.join(host.bin, "nix"), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  }

  it("answers from a resolved Nix environment's own PATH", async () => {
    const nix = { path: [host.bin], hash: "closure-hash", inputs: ["flake.lock"] } as never
    expect(await GoExec.resolveNix("go", { ...host.context, nix })).toEqual({
      ok: true,
      path: NodePath.join(host.bin, "go"),
      identity: {
        tag: "NixBin",
        name: "go",
        path: NodePath.join(host.bin, "go"),
        authority: { closure: "closure-hash", inputs: ["flake.lock"] }
      }
    })
    expect(await GoExec.resolveNix("protoc", { ...host.context, nix })).toEqual({
      ok: false,
      refusal: "the declared Nix environment provides no \"protoc\"",
      identity: {
        tag: "NixBin",
        name: "protoc",
        absent: true,
        authority: { closure: "closure-hash", inputs: ["flake.lock"] }
      }
    })
  })

  it("refuses a host without nix and still keys the declared dev shell", async () => {
    await Fs.writeFile(NodePath.join(host.root, "flake.nix"), "{}")
    await Fs.writeFile(NodePath.join(host.root, "flake.lock"), "{}")
    const workspace = withToolchains({
      _tag: "NixDevShell",
      flake: S.file("//flake.nix"),
      lock: S.file("//flake.lock")
    })
    const resolved = await GoExec.resolveNix("protoc", { ...host.context, workspace })
    expect(resolved).toEqual({
      ok: false,
      refusal: "host binary \"nix\" is not present on PATH (required by S.Nix.bin(\"protoc\"))",
      identity: {
        tag: "NixBin",
        name: "protoc",
        absent: true,
        authority: [
          { path: "flake.nix", digest: expect.any(String) },
          { path: "flake.lock", digest: expect.any(String) }
        ]
      }
    })
  })

  it("resolves the dev shell's tool path", async () => {
    await writeNix("[ \"$*\" = 'develop --command which protoc' ] && echo /nix/store/abc/bin/protoc")
    expect(await GoExec.resolveNix("protoc", host.context)).toEqual({
      ok: true,
      path: "/nix/store/abc/bin/protoc",
      identity: {
        tag: "NixBin",
        name: "protoc",
        nix: NodePath.join(host.bin, "nix"),
        path: "/nix/store/abc/bin/protoc",
        authority: []
      }
    })
  })

  it.each([
    ["an empty which answer", "exit 0", "which returned no path"],
    [
      "a failing dev shell with its stderr",
      "echo 'error: flake has no devShell' >&2; exit 1",
      "error: flake has no devShell"
    ],
    ["a failing dev shell without stderr", "exit 3", "Command failed"]
  ])("refuses %s", async (_name, script, detail) => {
    await writeNix(script)
    const resolved = await GoExec.resolveNix("protoc", host.context)
    expect(resolved.ok).toBe(false)
    expect((resolved as { readonly refusal: string }).refusal).toMatch(
      /^Nix dev shell does not provide "protoc": Error: /
    )
    expect((resolved as { readonly refusal: string }).refusal).toContain(detail)
  })

  it("refuses a dev shell that outlives the probe deadline", async () => {
    await writeNix("exec sleep 5")
    const resolved = await GoExec.resolveNix("protoc", { ...host.context, timeoutMs: 100 })
    expect((resolved as { readonly refusal: string }).refusal).toContain("failed: timed out after 100ms")
  })

  it("refuses a cancelled dev shell probe", async () => {
    await writeNix("exec sleep 5")
    const resolved = await GoExec.resolveNix("protoc", { ...host.context, signal: AbortSignal.abort() })
    expect((resolved as { readonly refusal: string }).refusal).toMatch(/^Nix dev shell does not provide "protoc": /)
  })
})

const goPath = () => NodePath.join(host.bin, "go")

/** Writes an in-tree package and makes `go list -deps` report it. */
const listPackage = async (files: Record<string, string>, extra: Record<string, unknown> = {}) => {
  for (const [name, text] of Object.entries(files)) {
    await Fs.mkdir(NodePath.dirname(NodePath.join(host.root, "pkg/lib", name)), { recursive: true })
    await Fs.writeFile(NodePath.join(host.root, "pkg/lib", name), text)
  }
  await host.set("list.out", JSON.stringify({ ImportPath: "example.test/pkg/lib" }))
  await host.set(
    "deps.out",
    [
      JSON.stringify({ ImportPath: "fmt", Dir: "/goroot/src/fmt", Standard: true, GoFiles: ["print.go"] }),
      JSON.stringify({ ImportPath: "no/dir" }),
      JSON.stringify({
        ImportPath: "example.test/pkg/lib",
        Dir: NodePath.join(host.root, "pkg/lib"),
        GoFiles: Object.keys(files).filter((name) => name.endsWith(".go")),
        ...extra
      })
    ].join("\n")
  )
}

describe.skipIf(process.platform === "win32")("planRule failures and argv", () => {
  it("rejects a plan whose go list fails, naming the command and its stderr", async () => {
    await host.set("list.err", "pattern ./missing: directory not found")
    await host.set("list.exit", "1")
    await expect(GoExec.planRule("Go.Packages", { pkgs: ["./missing"] }, host.context, goPath())).rejects.toThrow(
      `${goPath()} list -json ./pkg/missing failed: pattern ./missing: directory not found`
    )
  })

  it("rejects a go list that outlives the probe deadline", async () => {
    await Fs.writeFile(NodePath.join(host.bin, "slow-go"), "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 })
    await expect(
      GoExec.planRule(
        "Go.Packages",
        { pkgs: ["./..."] },
        { ...host.context, timeoutMs: 100 },
        NodePath.join(host.bin, "slow-go")
      )
    ).rejects.toThrow("failed: timed out after 100ms")
  })

  it("rejects malformed go list JSON", async () => {
    await host.set("list.out", "{\"ImportPath\": }")
    await expect(GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, host.context, goPath())).rejects.toThrow(
      SyntaxError
    )
  })

  it("keys every in-tree compiler input and replacement files by module path, skipping the standard library", async () => {
    const replacement = NodePath.join(await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "go-replace-"))))
    roots.push(replacement)
    await Fs.writeFile(NodePath.join(replacement, "dep.go"), "package dep\n")
    await Fs.mkdir(NodePath.join(host.root, "mod"))
    await listPackage({ "lib.go": "package lib\n", "asm.s": "TEXT", "c/h.h": "int x;" }, {
      SFiles: ["asm.s"],
      HFiles: ["c/h.h"],
      EmbedFiles: ["missing-from-tree/../lib.go"]
    })
    await host.set(
      "deps.out",
      `${await Fs.readFile(NodePath.join(host.stub, "deps.out"), "utf8")}\n${
        JSON.stringify({
          ImportPath: "example.test/dep",
          Dir: replacement,
          Module: { Path: "example.test/dep", Replace: { Path: "../dep", Dir: replacement } },
          GoFiles: ["dep.go", "../escape.go"]
        })
      }\n${JSON.stringify({ ImportPath: "cache/mod", Dir: "/elsewhere/mod", GoFiles: ["m.go"] })}`
    )
    const planned = await GoExec.planRule(
      "Go.Packages",
      { pkgs: ["./lib", "//other"], cgo: true, goos: "linux", goarch: "arm64", env: { CUSTOM: "1" } },
      { ...host.context, workspace: withToolchains(goToolchain) },
      goPath()
    )
    expect(planned.readSet).toEqual(["mod/go.mod", "mod/go.sum", "pkg/lib/asm.s", "pkg/lib/c/h.h", "pkg/lib/lib.go"])
    expect(planned.closureIdentity).toEqual({
      packages: ["example.test/pkg/lib"],
      files: [
        ["pkg/lib/asm.s", expect.stringMatching(/^[0-9a-f]{64}$/)],
        ["pkg/lib/c/h.h", expect.stringMatching(/^[0-9a-f]{64}$/)],
        ["pkg/lib/lib.go", expect.stringMatching(/^[0-9a-f]{64}$/)],
        ["replace:../dep/dep.go", expect.stringMatching(/^[0-9a-f]{64}$/)]
      ]
    })
    expect(planned.env).toEqual({
      CUSTOM: "1",
      CGO_ENABLED: "1",
      GOEXPERIMENT: "jsonv2,synctest",
      GOOS: "linux",
      GOARCH: "arm64"
    })
    const calls = await host.calls()
    expect(calls[0]).toBe("go list -json ./pkg/lib ./other GOEXPERIMENT=jsonv2,synctest CGO_ENABLED=1 GOOS=linux")
    expect(calls[1]).toMatch(/^go list -deps -json example.test\/pkg\/lib /)
  })

  it("selects the left packages a files difference leaves after the right", async () => {
    await listPackage({ "lib.go": "package lib\n" })
    await host.set(
      "list.out",
      [{ ImportPath: "a" }, { ImportPath: "b" }, {}].map((row) => JSON.stringify(row)).join("\n")
    )
    await host.set("right.out", JSON.stringify({ ImportPath: "b" }))
    const packages = Target.metadata(S.Go.Packages({ pkgs: ["./right"] })).attrs as {
      readonly pkgs: ReadonlyArray<string>
    }
    expect(packages.pkgs).toEqual(["./right"])
    const planned = await GoExec.planRule(
      "Go.Generate",
      {
        pkgs: { _tag: "FilesDifference", left: ["./..."], right: S.Go.Packages({ pkgs: ["./right"] }) },
        changes: ["gen.go"]
      },
      host.context,
      goPath()
    )
    expect(planned.argv).toEqual([goPath(), "generate", "a"])
    expect(planned.writeSet).toEqual(["pkg/gen.go"])
  })

  it("selects nothing for a selection that is neither patterns nor a package target", async () => {
    await host.set("deps.out", "")
    const planned = await GoExec.planRule(
      "Go.Packages",
      { pkgs: { _tag: "TargetFiles", target: 1 } },
      host.context,
      goPath()
    )
    expect(planned.closureIdentity).toEqual({ packages: [], files: [] })
  })

  it("refuses a gotestsum runner that is not on PATH", async () => {
    await listPackage({ "lib.go": "package lib\n" })
    const planned = await GoExec.planRule(
      "Go.Test",
      { pkgs: ["./lib"], runner: "gotestsum" },
      { ...host.context, environment: { PATH: host.stub } },
      goPath()
    )
    expect(planned).toEqual({
      refusal: "host binary \"gotestsum\" is not present on PATH (required by S.Go.Test({ runner: \"gotestsum\" }))",
      env: {},
      outDirs: [],
      writeSet: [],
      readSet: []
    })
  })

  it("renders go test flags and the test closure", async () => {
    await listPackage({ "lib.go": "package lib\n", "lib_test.go": "package lib\n" }, { TestGoFiles: ["lib_test.go"] })
    const planned = await GoExec.planRule(
      "Go.Test",
      { pkgs: ["./lib"], timeout: "30s", parallel: 4 },
      host.context,
      goPath()
    )
    expect(planned.argv).toEqual([goPath(), "test", "-timeout", "30s", "-parallel=4", "example.test/pkg/lib"])
    expect(planned.readSet).toEqual(["pkg/lib/lib.go", "pkg/lib/lib_test.go"])
    expect((await host.calls())[1]).toMatch(/^go list -deps -test -json /)
  })

  it("renders a binary with ldflags and stamps, and a fuzz run", async () => {
    await listPackage({ "lib.go": "package main\n" })
    const binary = await GoExec.planRule(
      "Go.Binary",
      { pkg: "./cmd", out: "bin/app", ldflags: ["-s"], stamp: { "main.version": { _tag: "Stamp", name: "version" } } },
      host.context,
      goPath()
    )
    expect(binary.argv).toEqual([
      goPath(),
      "build",
      "-buildvcs=false",
      "-o",
      "pkg/bin/app",
      "-ldflags",
      expect.stringMatching(/^-s -X main\.version=\{smthrs:stamp:[A-Za-z0-9_-]+\}$/),
      "./pkg/cmd"
    ])
    expect(binary.outDirs).toEqual(["pkg/bin"])
    const plain = await GoExec.planRule("Go.Binary", { pkg: "//cmd", out: "app" }, host.context, goPath())
    expect(plain.argv).toEqual([goPath(), "build", "-buildvcs=false", "-o", "pkg/app", "./cmd"])
    const fuzz = await GoExec.planRule(
      "Go.Fuzz",
      { pkg: "./lib", fuzz: "FuzzParse", time: "10s", parallel: 2 },
      host.context,
      goPath()
    )
    expect(fuzz.argv).toEqual([
      goPath(),
      "test",
      "./pkg/lib",
      "-run=^$",
      "-fuzz=FuzzParse",
      "-fuzztime=10s",
      "-parallel=2"
    ])
    const serial = await GoExec.planRule("Go.Fuzz", { pkg: "./lib", fuzz: "F", time: "1s" }, host.context, goPath())
    expect(serial.argv).toEqual([goPath(), "test", "./pkg/lib", "-run=^$", "-fuzz=F", "-fuzztime=1s"])
  })

  it("plans module download, lint and offline runs without go list", async () => {
    const download = await GoExec.planRule("Go.ModDownload", { outDirs: ["cache"] }, host.context, goPath())
    expect(download).toEqual({
      argv: [goPath(), "mod", "download"],
      env: { GOMODCACHE: "pkg/cache" },
      outDirs: ["pkg/cache"],
      writeSet: [],
      readSet: []
    })
    expect((await GoExec.planRule("Go.ModDownload", { outDirs: [] }, host.context, goPath())).env).toEqual({
      GOMODCACHE: ".gomodcache"
    })
    const lint = await GoExec.planRule(
      "Go.Lint",
      { pkgs: ["./..."], config: S.file(".golangci.yml"), version: "v2.1.0", changes: ["fixed.go"] },
      { ...host.context, workspace: withToolchains(goToolchain) },
      goPath()
    )
    expect(lint).toMatchObject({
      argv: [
        goPath(),
        "run",
        "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.1.0",
        "run",
        "--config",
        "pkg/.golangci.yml",
        "--fix",
        "./pkg/..."
      ],
      writeSet: ["pkg/fixed.go"],
      readSet: ["mod/go.mod", "mod/go.sum", "pkg/.golangci.yml"]
    })
    const check = await GoExec.planRule(
      "Go.Lint",
      { pkgs: ["./..."], config: S.file(".golangci.yml"), version: "v2" },
      host.context,
      goPath()
    )
    expect(check.argv).not.toContain("--fix")
    const fetch = S.Go.ModDownload({
      mod: S.file("//mod/go.mod"),
      sum: S.file("//mod/go.sum"),
      outDirs: [".gomodcache/fixture"]
    })
    const offline = await GoExec.planRule(
      "Go.Unknown",
      { offline: true, data: ["not a target", fetch] },
      host.context,
      goPath()
    )
    expect(offline).toEqual({
      env: { GOPROXY: "off", GOFLAGS: "-mod=readonly", GOMODCACHE: ".gomodcache/fixture" },
      outDirs: [],
      writeSet: [],
      readSet: []
    })
    expect((await GoExec.planRule("Go.Unknown", { offline: true }, host.context, goPath())).env).toEqual({
      GOPROXY: "off",
      GOFLAGS: "-mod=readonly"
    })
    expect(await host.calls()).toEqual([])
  })
})

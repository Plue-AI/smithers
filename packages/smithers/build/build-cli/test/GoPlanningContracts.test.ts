import { Smithers as S } from "@smthrs/targets"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as GoExec from "../src/GoExec.ts"
import * as PackageTree from "../src/PackageTree.ts"

const workspace = S.Workspace("go-contracts", {
  repository: "git+https://example.invalid/go-contracts.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: S.file("//package.json"), lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") })
})
const context: GoExec.Context = {
  root: Os.tmpdir(),
  packagePath: "pkg",
  workspace,
  environment: { PATH: "/selected/bin" }
}
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>()
  return { ...actual, execFile: vi.fn(actual.execFile) }
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("Go planning contracts", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])(
    "rejects invalid probe timeout %s before process dispatch",
    async (timeoutMs) => {
      const spawn = vi.mocked(NodeChildProcess.execFile)
      await expect(GoExec.planRule("Go.Packages", { pkgs: ["./..."] }, { ...context, timeoutMs }, process.execPath))
        .rejects.toThrow("Go probe timeoutMs must be positive and finite")
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it("accepts a valid selected SDK and inventories its compiler executables", async () => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "go-sdk-contract-"))
    try {
      const sdkRoot = NodePath.join(root, "sdk")
      const toolDir = NodePath.join(sdkRoot, "pkg", "tool", "test-host")
      const go = NodePath.join(root, "launcher", "go")
      await Fs.mkdir(NodePath.dirname(go), { recursive: true })
      await Fs.mkdir(NodePath.join(sdkRoot, "bin"), { recursive: true })
      await Fs.mkdir(toolDir, { recursive: true })
      await Fs.mkdir(NodePath.join(toolDir, "not-an-executable-directory"))
      for (
        const file of [
          go,
          NodePath.join(sdkRoot, "bin", "go"),
          NodePath.join(toolDir, "link"),
          NodePath.join(toolDir, "compile")
        ]
      ) {
        await Fs.writeFile(file, "fixture executable bytes")
      }
      vi.spyOn(PackageTree, "findOnPath").mockReturnValue(go)
      vi.spyOn(PackageTree, "probeVersion")
        .mockResolvedValueOnce({ exitCode: 0, output: "go version go1.26.8 test/host" })
        .mockResolvedValueOnce({ exitCode: 0, output: JSON.stringify({ GOROOT: sdkRoot, GOTOOLDIR: toolDir }) })
      expect(await GoExec.resolveGo({ ...context, root })).toEqual({
        ok: true,
        path: go,
        sdkRoot,
        executables: [
          go,
          NodePath.join(sdkRoot, "bin", "go"),
          NodePath.join(toolDir, "compile"),
          NodePath.join(toolDir, "link")
        ],
        identity: {
          tag: "GoBin",
          path: go,
          cwd: "",
          probe: { exitCode: 0, output: "go version go1.26.8 test/host" },
          authorities: []
        }
      })
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each(
    [
      ["malformed JSON", "{", 0],
      ["null", "null", 0],
      ["array", "[]", 0],
      ["scalar", "42", 0],
      ["missing GOROOT", "{\"GOTOOLDIR\":\"/sdk/tools\"}", 0],
      ["numeric GOROOT", "{\"GOROOT\":42,\"GOTOOLDIR\":\"/sdk/tools\"}", 0],
      ["missing GOTOOLDIR", "{\"GOROOT\":\"/sdk\"}", 0],
      ["null GOTOOLDIR", "{\"GOROOT\":\"/sdk\",\"GOTOOLDIR\":null}", 0],
      ["failed command with valid JSON", "{\"GOROOT\":\"/sdk\",\"GOTOOLDIR\":\"/sdk/tools\"}", 1]
    ] as const
  )("refuses SDK identification from %s", async (_name, output, exitCode) => {
    vi.spyOn(PackageTree, "findOnPath").mockReturnValue("/selected/bin/go")
    const probe = vi.spyOn(PackageTree, "probeVersion")
      .mockResolvedValueOnce({ exitCode: 0, output: "go version go1.26.8 test/host" })
      .mockResolvedValueOnce({ exitCode, output })
    expect(await GoExec.resolveGo(context)).toEqual({
      ok: false,
      refusal: "go env could not identify GOROOT and GOTOOLDIR",
      identity: {
        tag: "GoBin",
        path: "/selected/bin/go",
        probe: { exitCode: 0, output: "go version go1.26.8 test/host" },
        selected: { exitCode, output }
      }
    })
    expect(probe).toHaveBeenNthCalledWith(1, "/selected/bin/go", {
      cwd: context.root,
      args: ["version"],
      environment: { PATH: "/selected/bin" }
    })
    expect(probe).toHaveBeenNthCalledWith(2, "/selected/bin/go", {
      cwd: context.root,
      args: ["env", "-json", "GOROOT", "GOTOOLDIR"],
      environment: { PATH: "/selected/bin" }
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it.each(
    [
      [[], ["pkg/lint.yml"], []],
      [["generated.go", "//shared/generated.go"], ["pkg/lint.yml"], ["pkg/generated.go", "shared/generated.go"]]
    ] as const
  )("plans lint with declared changes %j", async (changes, readSet, writeSet) => {
    const attrs = {
      pkgs: ["./...", "//shared/...", "example.org/module"],
      config: S.file("lint.yml"),
      version: "2.4.0",
      changes,
      env: { CUSTOM: "kept" },
      cgo: false,
      goos: "linux",
      goarch: "arm64"
    }
    const planned = await GoExec.planRule("Go.Lint", attrs, context, "/selected/bin/go")
    expect(planned).toEqual({
      argv: [
        "/selected/bin/go",
        "run",
        "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@2.4.0",
        "run",
        "--config",
        "pkg/lint.yml",
        ...(changes.length === 0 ? [] : ["--fix"]),
        "./pkg/...",
        "./shared/...",
        "example.org/module"
      ],
      env: { CUSTOM: "kept", CGO_ENABLED: "0", GOOS: "linux", GOARCH: "arm64" },
      outDirs: [],
      readSet,
      writeSet
    })
    expect(changes).toEqual(writeSet.length === 0 ? [] : ["generated.go", "//shared/generated.go"])
  })

  it("uses the declared module fetch cache only for an offline plan", async () => {
    const download = S.Go.ModDownload({
      mod: S.file("//go.mod"),
      sum: S.file("//go.sum"),
      outDirs: ["//cache/modules"]
    })
    const attrs = {
      pkgs: ["./..."],
      config: S.file("lint.yml"),
      version: "2.4.0",
      data: [download],
      env: { CUSTOM: "kept", GOFLAGS: "-tags=custom" }
    }
    const online = await GoExec.planRule("Go.Lint", attrs, context, "/selected/bin/go")
    const offline = await GoExec.planRule("Go.Lint", { ...attrs, offline: true }, context, "/selected/bin/go")
    expect(online.env).toEqual({ CUSTOM: "kept", GOFLAGS: "-tags=custom" })
    // targets/docs/guides/go.md specifies the offline GOFLAGS=-mod=readonly override.
    expect(offline.env).toEqual({
      CUSTOM: "kept",
      GOFLAGS: "-mod=readonly",
      GOPROXY: "off",
      GOMODCACHE: "cache/modules"
    })
    expect(offline.argv).toEqual(online.argv)
    expect(offline.readSet).toEqual(["pkg/lint.yml"])
  })
})

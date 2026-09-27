/**
 * `smthrs tui`: choosing the process that runs the TUI.
 *
 * A fake machine pins each branch of the choice: `SMITHERS_TUI_BIN`, a
 * compiled platform package, Bun, Node >= 26.4 with FFI, and the refusal. A
 * fake executable records the argument vector it received and exits with a
 * chosen status, so the spawning cases pin what the TUI is started with and
 * that its status becomes the command's, without starting a renderer.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Tui from "../src/commands/Tui.ts"

const staged: Array<string> = []

afterEach(() => {
  for (const root of staged.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** An installed `@smthrs/cli` under `<root>/node_modules`, with its bundle. */
const stage = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-tui-")))
  staged.push(root)
  const packageRoot = join(root, "node_modules/@smthrs/cli")
  const bundle = join(packageRoot, "dist/tui/main.js")
  mkdirSync(dirname(bundle), { recursive: true })
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@smthrs/cli" }))
  writeFileSync(bundle, "")
  const log = join(root, "argv.json")
  return { root, packageRoot: pathToFileURL(`${packageRoot}/`), bundle, log }
}

/** An executable that records its arguments and exits with `FAKE_STATUS`. */
const fake = (path: string, log: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${
      JSON.stringify(log)
    }, JSON.stringify(process.argv.slice(2)))\nif (process.env.FAKE_SIGNAL) process.kill(process.pid, process.env.FAKE_SIGNAL)\nelse process.exit(Number(process.env.FAKE_STATUS ?? 0))\n`
  )
  chmodSync(path, 0o755)
  return path
}

/** A compiled platform package `name` installed beside the CLI. */
const platformPackage = (root: string, name: string, log: string): string => {
  const directory = join(root, "node_modules", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name }))
  return fake(join(directory, "bin", "smithers-tui"), log)
}

const machine = (overrides: Partial<Tui.Host> = {}): Tui.Host => ({
  ...Tui.host,
  platform: "darwin",
  arch: "arm64",
  execPath: "/opt/node/bin/node",
  versions: { node: "26.4.0" },
  musl: () => false,
  avx2: () => true,
  ...overrides
})

describe("smthrs tui runtime choice", () => {
  it("runs this Node >= 26.4 on the bundle with FFI enabled and its warning silenced", () => {
    const { packageRoot, bundle } = stage()
    for (const node of ["26.4.0", "26.10.0", "27.0.0"]) {
      expect(Tui.launch({}, packageRoot, machine({ versions: { node } }))).toEqual({
        command: "/opt/node/bin/node",
        args: ["--experimental-ffi", "--disable-warning=ExperimentalWarning", bundle],
        runtime: "node"
      })
    }
  })

  it("refuses a Node older than 26.4 with a typed error naming Node, Bun, and the platform package", () => {
    const { packageRoot } = stage()
    for (const node of ["26.3.9", "24.18.0"]) {
      const refused = Tui.launch({}, packageRoot, machine({ versions: { node } }))
      expect(refused).toBeInstanceOf(CliError.UnsupportedError)
      expect((refused as CliError.UnsupportedError).message).toBe(
        `smthrs tui needs Node >= 26.4 or Bun; this is Node ${node}. Upgrade Node, or set SMITHERS_BUN to a Bun ` +
          `executable, or install "@smthrs/tui-darwin-arm64".`
      )
    }
  })

  it("prefers Bun named by SMITHERS_BUN, or the Bun this CLI already runs on, over Node", () => {
    const { packageRoot, bundle } = stage()
    expect(Tui.launch({ SMITHERS_BUN: "/opt/bun" }, packageRoot, machine({ versions: { node: "20.0.0" } })))
      .toEqual({ command: "/opt/bun", args: [bundle], runtime: "bun" })
    expect(
      Tui.launch({}, packageRoot, machine({ execPath: "/opt/bun/bin/bun", versions: { node: "24.3.0", bun: "1.4.0" } }))
    ).toEqual({ command: "/opt/bun/bin/bun", args: [bundle], runtime: "bun" })
  })

  it("prefers an installed compiled platform package over Bun and Node, and SMITHERS_TUI_BIN over both", () => {
    const { root, packageRoot, log } = stage()
    const binary = platformPackage(root, "@smthrs/tui-darwin-arm64", log)
    const here = machine({ versions: { node: "26.10.0", bun: "1.4.0" } })
    expect(Tui.launch({ SMITHERS_BUN: "/opt/bun" }, packageRoot, here)).toEqual({
      command: binary,
      args: [],
      runtime: "binary"
    })
    expect(Tui.launch({ SMITHERS_TUI_BIN: "/opt/tui" }, packageRoot, here)).toEqual({
      command: "/opt/tui",
      args: [],
      runtime: "binary"
    })
  })

  it("falls back across libc and CPU-baseline builds in opencode's order", () => {
    const linux = (arch: string, musl: boolean, avx2: boolean) =>
      Tui.binaryPackages(machine({ platform: "linux", arch, musl: () => musl, avx2: () => avx2 }))
    expect(linux("x64", false, true)).toEqual([
      "@smthrs/tui-linux-x64",
      "@smthrs/tui-linux-x64-baseline",
      "@smthrs/tui-linux-x64-musl",
      "@smthrs/tui-linux-x64-baseline-musl"
    ])
    expect(linux("x64", true, false)).toEqual([
      "@smthrs/tui-linux-x64-baseline-musl",
      "@smthrs/tui-linux-x64-musl",
      "@smthrs/tui-linux-x64-baseline",
      "@smthrs/tui-linux-x64"
    ])
    expect(linux("arm64", true, false)).toEqual(["@smthrs/tui-linux-arm64-musl", "@smthrs/tui-linux-arm64"])
    expect(Tui.binaryPackages(machine({ arch: "x64", avx2: () => false }))).toEqual([
      "@smthrs/tui-darwin-x64-baseline",
      "@smthrs/tui-darwin-x64"
    ])
    expect(Tui.binaryPackages(machine({ platform: "win32", arch: "x64" }))).toEqual([])
  })

  it("picks the first installed candidate: a musl machine runs the glibc build when only it is installed", () => {
    const { root, packageRoot, log } = stage()
    const binary = platformPackage(root, "@smthrs/tui-linux-arm64", log)
    const musl = machine({ platform: "linux", arch: "arm64", musl: () => true })
    expect(Tui.launch({}, packageRoot, musl)).toMatchObject({ command: binary, runtime: "binary" })
  })

  it("in a checkout, skips compiled binaries; Bun runs the source and Node the bundle", () => {
    const workspace = new URL("../", import.meta.url)
    const here = machine({ packageDirectory: () => "/installed/tui", exists: () => true })
    expect(Tui.checkout(workspace)).toBe(true)
    expect(Tui.launch({ SMITHERS_BUN: "/opt/bun" }, workspace, here)).toMatchObject({
      runtime: "bun",
      args: [expect.stringMatching(/apps\/tui\/src\/main\.tsx$/)]
    })
    expect(Tui.launch({}, workspace, here)).toMatchObject({
      runtime: "node",
      args: [
        "--experimental-ffi",
        "--disable-warning=ExperimentalWarning",
        expect.stringMatching(/dist\/tui\/main\.js$/)
      ]
    })
  })
})

describe("smthrs tui", () => {
  it("starts the compiled binary with the TUI's own flags and returns its status", async () => {
    const { root, packageRoot, log } = stage()
    platformPackage(root, "@smthrs/tui-darwin-arm64", log)
    const status = await Tui.run(
      {
        directory: "repo",
        model: "openai:gpt-6-sol",
        continue: true,
        resume: false,
        print: "hi",
        approve: "deny",
        budgetTokens: "5000"
      },
      { ...process.env, FAKE_STATUS: "7" },
      packageRoot,
      machine()
    )
    expect(status).toBe(7)
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      "--model",
      "openai:gpt-6-sol",
      "--continue",
      "--print",
      "hi",
      "--approve",
      "deny",
      "--budget-tokens",
      "5000",
      "repo"
    ])
  })

  it("starts Bun on the bundle", async () => {
    const { root, packageRoot, bundle, log } = stage()
    const bun = fake(join(root, "bun"), log)
    expect(await Tui.run({ print: "hi" }, { SMITHERS_BUN: bun }, packageRoot, machine())).toBe(0)
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([bundle, "--print", "hi"])
  })

  it("reports a TUI killed by a signal as 128 plus the signal number", async () => {
    const { root, packageRoot, log } = stage()
    const bun = fake(join(root, "bun"), log)
    expect(await Tui.run({}, { SMITHERS_BUN: bun, FAKE_SIGNAL: "SIGTERM" }, packageRoot, machine())).toBe(143)
  })

  it("names Bun when SMITHERS_BUN does not exist", async () => {
    const { root, packageRoot } = stage()
    await expect(Tui.run({}, { SMITHERS_BUN: join(root, "missing-bun") }, packageRoot, machine())).rejects
      .toMatchObject({
        _tag: "/cli/UnsupportedError",
        message: expect.stringContaining("could not start Bun")
      })
  })

  it("refuses an installation without the TUI bundle", async () => {
    const { root, packageRoot, bundle } = stage()
    rmSync(bundle)
    await expect(Tui.run({}, { SMITHERS_BUN: fake(join(root, "bun"), join(root, "log")) }, packageRoot, machine()))
      .rejects.toMatchObject({ _tag: "/cli/UnsupportedError", message: expect.stringContaining(bundle) })
    await expect(Tui.run({}, {}, packageRoot, machine())).rejects.toBeInstanceOf(CliError.UnsupportedError)
  })

  it("refuses a too-old Node before starting anything", async () => {
    const { packageRoot } = stage()
    await expect(Tui.run({}, {}, packageRoot, machine({ versions: { node: "24.18.0" } }))).rejects.toMatchObject({
      _tag: "/cli/UnsupportedError",
      message: expect.stringContaining("Node >= 26.4 or Bun")
    })
  })
})

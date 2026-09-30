/** Relocated public exports and actual shipped bundles use the corrected native bytes. */
import { beforeAll, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import * as Session from "../src/session.ts"
import { key, Tui } from "./tmux.ts"

const app = resolve(import.meta.dir, "..")
const cli = resolve(app, "../../packages/smithers")
const vendor = join(cli, "vendor/opentui-native")
const target = `${process.platform}-${process.arch}${
  process.platform === "linux" && process.env.OPENTUI_LIBC === "musl" ? "-musl" : ""
}`
const manifest = JSON.parse(readFileSync(join(vendor, "manifest.json"), "utf8")) as {
  targets: Record<string, { file: string; sha256: string }>
}
const artifact = manifest.targets[target]
if (artifact === undefined) throw new Error(`No native packaging fixture for ${target}`)
const nativeFile = join(vendor, target, artifact.file)
const node = Bun.which("node")!
const bun = process.execPath
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const run = (runtime: "node" | "bun", args: string[], cwd: string, env = process.env) =>
  spawnSync(runtime === "node" ? node : bun, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  })

beforeAll(() => {
  const nodeBuild = run("node", [join(cli, "scripts/build-tui.mjs")], cli)
  expect(nodeBuild.status, nodeBuild.stderr).toBe(0)
  const compiledBuild = run("bun", [join(cli, "scripts/build-tui-binaries.mjs"), "--single"], cli)
  expect(compiledBuild.status, compiledBuild.stderr).toBe(0)
}, 180_000)

const installation = (root: string, dependencies: boolean) => {
  const directory = join(root, "installation")
  const modules = join(directory, "node_modules")
  const installed = join(modules, "@smthrs/cli")
  mkdirSync(installed, { recursive: true })
  cpSync(join(cli, "package.json"), join(installed, "package.json"))
  // A deployment fixture carries only the host artifact. Neither checkout
  // native packages nor a source-tree path can repair a missing shipped file.
  const shippedVendor = join(installed, "vendor/opentui-native")
  mkdirSync(shippedVendor, { recursive: true })
  for (const entry of readdirSync(vendor, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(join(vendor, entry.name), join(shippedVendor, entry.name))
  }
  cpSync(join(vendor, target), join(shippedVendor, target), { recursive: true })
  if (dependencies) {
    for (const entry of readdirSync(join(cli, "node_modules"))) {
      if (entry.startsWith(".")) continue
      const from = join(cli, "node_modules", entry)
      if (entry.startsWith("@")) {
        mkdirSync(join(modules, entry), { recursive: true })
        for (const child of readdirSync(from)) {
          if (entry === "@smthrs" && child === "cli") continue
          symlinkSync(realpathSync(join(from, child)), join(modules, entry, child))
        }
      } else symlinkSync(realpathSync(from), join(modules, entry))
    }
    cpSync(join(cli, "dist/tui"), join(directory, "tui"), { recursive: true })
  }
  return { directory, installed, library: join(installed, "vendor/opentui-native", target, artifact.file) }
}
const probe =
  `import nativePath from "@smthrs/cli/tui-native"; import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; console.log(JSON.stringify({path:nativePath,sha256:createHash("sha256").update(readFileSync(nativePath)).digest("hex")}));`

for (const runtime of ["node", "bun"] as const) {
  it(`${runtime} relocated native export selects shipped bytes, refuses absence, and recovers`, () => {
    const root = mkdtempSync(join(tmpdir(), "tui-native-package-"))
    try {
      const install = installation(root, false)
      const script = join(install.directory, "probe.mjs")
      writeFileSync(script, probe)
      const loaded = run(runtime, [script], install.directory)
      expect(loaded.status, loaded.stderr).toBe(0)
      const value = JSON.parse(loaded.stdout)
      expect(realpathSync(value.path)).toBe(realpathSync(install.library))
      expect(value.sha256).toBe(artifact.sha256)
      rmSync(install.library)
      const refused = run(runtime, [script], install.directory)
      expect(refused.status).not.toBe(0)
      expect(refused.stdout).toBe("")
      expect(refused.stderr).toContain(artifact.file)
      cpSync(nativeFile, install.library)
      const recovered = run(runtime, [script], install.directory)
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(JSON.parse(recovered.stdout).sha256).toBe(artifact.sha256)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 45_000)

  it(`${runtime} bundled help and print work when the terminal native artifact is absent`, () => {
    const root = mkdtempSync(join(tmpdir(), "tui-native-headless-"))
    try {
      const install = installation(root, true)
      rmSync(install.library)
      const probeFile = join(install.directory, "probe.mjs")
      writeFileSync(probeFile, probe)
      expect(run(runtime, [probeFile], install.directory).status).not.toBe(0)
      const entry = join(install.directory, "tui/main.js")
      const prefix = runtime === "node" ? ["--experimental-ffi", "--disable-warning=ExperimentalWarning"] : []
      const help = run(runtime, [...prefix, entry, "--help"], install.directory)
      expect(help.status, help.stderr).toBe(0)
      expect(help.stdout).toContain("--print")
      const project = join(root, "project")
      mkdirSync(project)
      const answer = run(runtime, [...prefix, entry, project, "--print", "hello"], install.directory, {
        ...process.env,
        SMITHERS_TUI_REPLAY: join(app, "test/fixtures/pong.jsonl"),
        SMITHERS_TUI_SESSION_DIR: join(root, "sessions")
      })
      expect(answer.status, answer.stderr).toBe(0)
      expect(answer.stdout.trim()).toBe("pong")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
}

it("compiled shipped TUI embeds one corrected library and preserves selected Unicode text", async () => {
  const executable = readFileSync(join(cli, `out/tui-binaries/tui-${target}/bin/smithers-tui`))
  const corrected = readFileSync(nativeFile)
  expect(hash(corrected)).toBe(artifact.sha256)
  let copies = 0
  for (let offset = 0;;) {
    const next = executable.indexOf(corrected, offset)
    if (next === -1) break
    copies++
    offset = next + corrected.length
  }
  expect(copies).toBe(1)
  // The upstream platform package is an optional dependency of @opentui/core,
  // so it resolves beside that package's install, not from this app's manifest.
  const core = createRequire(createRequire(join(app, "package.json")).resolve("@opentui/core"))
  const originalPath = join(dirname(core.resolve(`@opentui/core-${target}`)), artifact.file)
  const original = readFileSync(originalPath)
  expect(hash(original)).not.toBe(artifact.sha256)
  expect(executable.indexOf(original)).toBe(-1)
  const root = mkdtempSync(join(tmpdir(), "tui-native-compiled-"))
  let tui: Tui | undefined
  try {
    const relocated = join(root, "smithers-tui")
    cpSync(join(cli, `out/tui-binaries/tui-${target}/bin/smithers-tui`), relocated)
    const project = join(root, "project")
    const sessions = join(root, "sessions")
    mkdirSync(project)
    tui = await Tui.start({
      cwd: project,
      command: `${relocated} ${project}`,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SMITHERS_TUI_REPLAY: join(app, "test/fixtures/pong.jsonl"),
        SMITHERS_TUI_SESSION_DIR: sessions
      }
    })
    await tui.until((screen) => /↑\S+ ↓\S+/.test(screen), 20_000, "compiled first draw")
    await tui.press("?😀e\u0301x\x1b[D\x1b[1;2Da\u0308")
    await tui.until(
      (screen) => screen.normalize("NFC").includes("?😀a\u0308x".normalize("NFC")),
      5_000,
      "compiled selected draft"
    )
    await tui.press(key.enter)
    const prompts = () =>
      readdirSync(sessions, { recursive: true })
        .filter((path) => String(path).endsWith(".jsonl"))
        .flatMap((path) => Session.load(join(sessions, String(path))))
        .flatMap((record) => record.type === "user" ? [record.text] : [])
    await tui.until(() => prompts().length === 1, 5_000, "compiled prompt saved")
    expect(prompts()).toEqual(["?😀a\u0308x"])
  } finally {
    await tui?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 45_000)

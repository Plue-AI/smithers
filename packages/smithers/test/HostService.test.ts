import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Host from "../src/internal/backend/HostService.ts"

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-host-")); roots.push(root)
  const bundle = join(root, "bundle & <dir>")
  mkdirSync(join(bundle, "bin"), { recursive: true })
  const files = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"].map((path) => {
    // Unit-only bytes, never used as a launcher or a repository process.
    writeFileSync(join(bundle, path), path, { mode: 0o755 })
    return { path, sha256: createHash("sha256").update(path).digest("hex"), stage: "fixture", mode: 0o755 }
  })
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files }))
  let running = false
  const calls: string[][] = []
  const system = {
    agentsDir: join(root, "LaunchAgents"), domain: "gui/501",
    launchctl: (args: ReadonlyArray<string>) => {
      calls.push([...args])
      if (args[0] === "print") return { status: running ? 0 : 113, stdout: "", stderr: "" }
      if (args[0] === "bootstrap") running = true
      if (args[0] === "bootout") running = false
      return { status: 0, stdout: "", stderr: "" }
    }
  } satisfies Host.Launchd
  return { root, bundle, files, system, calls, options: { bundle, stateDir: join(root, "state"), home: root } }
}

describe("restored launchd service", () => {
  it("refuses root before any launchctl invocation", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0)
    expect(() => Host.launchd()).toThrow("unprivileged macOS login session")
  })
  it("escapes every plist value type and parses with macOS plutil", () => {
    const text = Host.plist({ A: 'x<&>"', B: 3, C: true, D: false, E: ["1", "2"], F: { G: "h" } })
    expect(text).toContain("<string>x&lt;&amp;&gt;&quot;</string>")
    expect(text).toContain("<integer>3</integer>")
    expect(text).toContain("<true/>"); expect(text).toContain("<false/>")
    if (process.platform === "darwin") {
      const f = fixture(), file = join(f.root, "parse.plist")
      writeFileSync(file, text)
      expect(spawnSync("/usr/bin/plutil", ["-lint", file]).status).toBe(0)
    }
  })
  it("runs the absolute bundled launcher at login without shell tools or privileged fields", () => {
    const f = fixture(), text = Host.hostPlist(f.options), file = join(f.root, "parse.plist")
    writeFileSync(file, text)
    const parsed = JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout)
    expect(parsed).toEqual({
      Label: "sh.smithers.host", ProgramArguments: [join(f.bundle, "bin/smithers-server"), "--setup-handoff=socket"],
      WorkingDirectory: f.options.stateDir,
      EnvironmentVariables: { HOME: f.root, PATH: `${f.bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
      RunAtLoad: true, KeepAlive: true, ThrottleInterval: 5, ExitTimeOut: 30, ProcessType: "Standard",
      StandardOutPath: join(f.root, "state/logs/host.log"), StandardErrorPath: join(f.root, "state/logs/host.log")
    })
  })
  it("starts once, keeps an unchanged agent, then reloads a changed bundle once", () => {
    const f = fixture()
    expect(Host.install(f.options, f.system)).toBe("installed")
    expect(Host.install(f.options, f.system)).toBe("unchanged")
    const other = fixture()
    expect(Host.install({ ...f.options, bundle: other.bundle }, f.system)).toBe("reloaded")
    expect(f.calls.filter((args) => args[0] !== "print")).toEqual([
      ["bootstrap", "gui/501", join(f.root, "LaunchAgents/sh.smithers.host.plist")],
      ["bootout", "gui/501/sh.smithers.host"],
      ["bootstrap", "gui/501", join(f.root, "LaunchAgents/sh.smithers.host.plist")]
    ])
    expect(Host.installedBundle(f.system)).toBe(other.bundle)
    expect(Host.stop(f.system)).toEqual({ state: "stopped" })
    expect(existsSync(f.options.stateDir)).toBe(true)
    expect(existsSync(Host.plistFile(f.system))).toBe(false)
    Host.stop(f.system)
  })
  it.each(["hash", "extra", "traversal", "duplicate", "missing", "symlink", "not executable", "empty"])("refuses %s before plist or launchctl mutations", (kind) => {
    const f = fixture()
    if (kind === "hash") writeFileSync(join(f.bundle, "bin/msb"), "changed")
    if (kind === "extra") writeFileSync(join(f.bundle, "extra"), "undeclared")
    if (kind === "traversal") f.files[0]!.path = "../escape"
    if (kind === "duplicate") f.files.push(f.files[0]!)
    if (kind === "missing") rmSync(join(f.bundle, "bin/msb"))
    if (kind === "symlink") {
      rmSync(join(f.bundle, "bin/msb")); writeFileSync(join(f.root, "outside"), "bin/msb")
      symlinkSync(join(f.root, "outside"), join(f.bundle, "bin/msb"))
    }
    if (kind === "not executable") chmodSync(join(f.bundle, "bin/msb"), 0o644)
    if (kind === "empty") f.files.splice(0)
    writeFileSync(join(f.bundle, "manifest.json"), JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files: f.files }))
    expect(() => Host.install(f.options, f.system)).toThrow()
    expect(f.calls).toEqual([])
    expect(existsSync(f.system.agentsDir)).toBe(false)
  })
  it.each(["version", "platform", "revision", "mode", "stage", "symlink"])("verifies landed manifest %s metadata before touching launchd", (kind) => {
    const f = fixture(), path = join(f.bundle, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"))
    if (["version", "platform", "revision"].includes(kind)) manifest[kind] = "invalid"
    else if (kind === "mode") manifest.files[0].mode = 0o644
    else if (kind === "stage") delete manifest.files[0].stage
    else manifest.files[0].symlink = "other"
    writeFileSync(path, JSON.stringify(manifest))
    expect(() => Host.install(f.options, f.system)).toThrow()
    expect(f.calls).toEqual([])
  })
  it("does not replace the plist when bootout fails", () => {
    const f = fixture(); Host.install(f.options, f.system)
    const before = readFileSync(Host.plistFile(f.system), "utf8")
    f.system.launchctl = (args) => ({ status: args[0] === "print" ? 0 : 5, stdout: "", stderr: "refused" })
    const other = fixture()
    expect(() => Host.install({ ...f.options, bundle: other.bundle }, f.system)).toThrow("bootout failed")
    expect(readFileSync(Host.plistFile(f.system), "utf8")).toBe(before)
    expect(() => Host.stop(f.system)).toThrow("bootout failed")
  })
  it("reports bootstrap failure and permits the next unloaded retry", () => {
    const f = fixture(), launch = f.system.launchctl
    f.system.launchctl = (args) => args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "refused" } : launch(args)
    expect(() => Host.install(f.options, f.system)).toThrow("bootstrap failed")
    f.system.launchctl = launch
    expect(Host.install(f.options, f.system)).toBe("installed")
  })
  it("runs bundled doctor with the required state root and no shell credentials", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync
    Host.doctor("/bundle", "/state", run)
    expect(run).toHaveBeenCalledWith("/bundle/bin/smithers-backend", ["microvm", "doctor"], {
      encoding: "utf8", timeout: 30000,
      env: { HOME: homedir(), PATH: "/bundle/bin:/usr/bin:/bin", SMITHERS_DATA_ROOT: "/state" }
    })
    const failed = vi.fn(() => ({ status: 1, stdout: "", stderr: "private diagnostic" })) as unknown as typeof spawnSync
    expect(() => Host.doctor("/bundle", "/state", failed)).toThrow("Bundled microVM doctor failed: /bundle")
  })
  it("resolves explicit bundle paths and refuses a missing default naming both choices", () => {
    expect(Host.resolveBundle(".")).toBe(process.cwd())
    if (!existsSync("/opt/homebrew/opt/smithers/libexec/manifest.json")) expect(() => Host.resolveBundle()).toThrow("--bundle <dir>")
  })
  it("waits for real readiness and refuses an expired readiness deadline", async () => {
    let calls = 0
    await Host.waitReady(async () => ++calls === 2, 1000)
    expect(calls).toBe(2)
    await expect(Host.waitReady(async () => false, 1)).rejects.toThrow("readiness failed")
  })
})

describe("private setup handoff", () => {
  it.each([
    [200, { setup_urls: ["http://localhost:4000/setup?token=fixture-secret"] }, "setup_ready", 0],
    [401, { error: "setup_closed" }, "setup_closed", 3],
    [503, { error: "setup_mint_failed" }, "setup_mint_failed", 4],
    [401, { error: "unrelated" }, "invalid", 1],
    [200, { setup_urls: [] }, "invalid", 1],
    [200, { setup_urls: ["http://localhost:4000/setup?token=x\nforged"] }, "invalid", 1],
    [200, { setup_urls: ["file:///setup?token=x"] }, "invalid", 1],
    [200, { setup_urls: ["http://localhost:4000/setup?token=x"], extra: true }, "invalid", 1]
  ])("maps HTTP %s %j without treating transport failures as owner state", async (status, body, code, exitCode) => {
    const f = fixture(); mkdirSync(join(f.root, "run"))
    const socket = join(f.root, "run/host.sock")
    const server = createServer((req, res) => {
      expect(req.url).toBe("/setup-urls"); expect(req.method).toBe("GET")
      res.writeHead(status); res.end(JSON.stringify(body))
    })
    await new Promise<void>((done) => server.listen(socket, done)); chmodSync(socket, 0o600)
    try {
      if (code === "invalid") await expect(Host.setupURLs(f.root)).rejects.toThrow("Invalid setup handoff response")
      else expect(await Host.setupURLs(f.root)).toMatchObject({ code, exitCode })
    } finally { await new Promise<void>((done) => server.close(() => done())) }
  })
  it("rejects a missing, regular or insecure socket", async () => {
    const f = fixture(); mkdirSync(join(f.root, "run"))
    await expect(Host.setupURLs(f.root)).rejects.toThrow()
    const socket = join(f.root, "run/host.sock"); writeFileSync(socket, "", { mode: 0o600 })
    await expect(Host.setupURLs(f.root)).rejects.toThrow("mode 0600")
  })
})

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as Host from "../src/internal/backend/HostService.ts"

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-host-"))
  roots.push(root)
  const bundle = join(root, "bundle & <dir>")
  mkdirSync(join(bundle, "bin"), { recursive: true })
  const files = ["bin/smithers-server", "bin/smithers-backend", "bin/msb"].map((path) => {
    // Unit-only bytes, never used as a launcher or a repository process.
    writeFileSync(join(bundle, path), path, { mode: 0o755 })
    return { path, sha256: createHash("sha256").update(path).digest("hex"), stage: "fixture", mode: 0o755 }
  })
  writeFileSync(
    join(bundle, "manifest.json"),
    JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files })
  )
  let running = false
  const calls: string[][] = []
  const system = {
    agentsDir: join(root, "LaunchAgents"),
    domain: "gui/501",
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
  it.each(["still loaded", "cannot observe launcher"])(
    "refuses replacement when %s without rewriting the plist",
    async (failure) => {
      const f = fixture(), other = fixture()
      await Host.install(f.options, f.system)
      const before = readFileSync(Host.plistFile(f.system), "utf8")
      f.calls.splice(0)
      f.system.launchctl = (args) => {
        f.calls.push([...args])
        return { status: 0, stdout: failure === "cannot observe launcher" ? "pid = 123" : "", stderr: "" }
      }
      if (failure === "still loaded") vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_000)
      else {vi.spyOn(process, "kill").mockImplementation(() => {
          throw Object.assign(new Error("cannot observe launcher"), { code: "EPERM" })
        })}
      await expect(Host.install({ ...f.options, bundle: other.bundle }, f.system)).rejects.toThrow(
        failure === "still loaded" ? "did not stop" : "cannot observe launcher"
      )
      expect(readFileSync(Host.plistFile(f.system), "utf8")).toBe(before)
      expect(f.calls.some((args) => args[0] === "bootstrap")).toBe(false)
    }
  )
  it.each(["replacement", "stop"])("waits for the old launcher to exit before %s completes", async (action) => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on(\"SIGTERM\",()=>setTimeout(()=>process.exit(0),150));console.log(\"ready\");setInterval(()=>{},1000)"
    ])
    const exited = new Promise<void>((done) => child.once("exit", () => done()))
    await new Promise<void>((done) => child.stdout!.once("data", () => done()))
    const f = fixture(), other = fixture()
    await Host.install(f.options, f.system)
    const launch = f.system.launchctl
    f.system.launchctl = (args) => {
      if (args[0] === "print") return { ...launch(args), stdout: `pid = ${child.pid}` }
      if (args[0] === "bootout") child.kill("SIGTERM")
      if (args[0] === "bootstrap" && child.exitCode === null) {
        return { status: 5, stdout: "", stderr: "old job is stopping" }
      }
      return launch(args)
    }
    try {
      if (action === "stop") expect(await Host.stop(f.system)).toEqual({ state: "stopped" })
      else expect(await Host.install({ ...f.options, bundle: other.bundle }, f.system)).toBe("reloaded")
      expect(child.exitCode).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM")
      await exited
    }
  })
  it("refuses root before any launchctl invocation", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0)
    expect(() => Host.launchd()).toThrow("unprivileged macOS login session")
  })
  it("escapes every plist value type and parses with macOS plutil", () => {
    const text = Host.plist({ A: "x<&>\"", B: 3, C: true, D: false, E: ["1", "2"], F: { G: "h" } })
    expect(text).toContain("<string>x&lt;&amp;&gt;&quot;</string>")
    expect(text).toContain("<integer>3</integer>")
    expect(text).toContain("<true/>")
    expect(text).toContain("<false/>")
    if (process.platform === "darwin") {
      const f = fixture(), file = join(f.root, "parse.plist")
      writeFileSync(file, text)
      expect(spawnSync("/usr/bin/plutil", ["-lint", file]).status).toBe(0)
    }
  })
  it("runs the absolute bundled launcher at login without shell tools or privileged fields", () => {
    const f = fixture(), text = Host.hostPlist(f.options), file = join(f.root, "parse.plist")
    writeFileSync(file, text)
    const parsed = JSON.parse(
      spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }).stdout
    )
    expect(parsed).toEqual({
      Label: "sh.smithers.host",
      ProgramArguments: [join(f.bundle, "bin/smithers-server"), "--setup-handoff=socket"],
      WorkingDirectory: f.options.stateDir,
      EnvironmentVariables: { HOME: f.root, PATH: `${f.bundle}/bin:/usr/bin:/bin:/usr/sbin:/sbin` },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 5,
      ExitTimeOut: 30,
      ProcessType: "Standard",
      StandardOutPath: join(f.root, "state/logs/host.log"),
      StandardErrorPath: join(f.root, "state/logs/host.log")
    })
  })
  it("starts once, keeps an unchanged agent, then reloads a changed bundle once", async () => {
    const f = fixture()
    expect(await Host.install(f.options, f.system)).toBe("installed")
    expect(await Host.install(f.options, f.system)).toBe("unchanged")
    const other = fixture()
    expect(await Host.install({ ...f.options, bundle: other.bundle }, f.system)).toBe("reloaded")
    expect(f.calls.filter((args) => args[0] !== "print")).toEqual([
      ["bootstrap", "gui/501", join(f.root, "LaunchAgents/sh.smithers.host.plist")],
      ["bootout", "gui/501/sh.smithers.host"],
      ["bootstrap", "gui/501", join(f.root, "LaunchAgents/sh.smithers.host.plist")]
    ])
    expect(Host.installedBundle(f.system)).toBe(other.bundle)
    expect(await Host.stop(f.system)).toEqual({ state: "stopped" })
    expect(existsSync(f.options.stateDir)).toBe(true)
    expect(existsSync(Host.plistFile(f.system))).toBe(false)
    await Host.stop(f.system)
  })
  it.each(["hash", "extra", "traversal", "duplicate", "missing", "symlink", "not executable", "empty"])(
    "refuses %s before plist or launchctl mutations",
    async (kind) => {
      const f = fixture()
      if (kind === "hash") writeFileSync(join(f.bundle, "bin/msb"), "changed")
      if (kind === "extra") writeFileSync(join(f.bundle, "extra"), "undeclared")
      if (kind === "traversal") f.files[0]!.path = "../escape"
      if (kind === "duplicate") f.files.push(f.files[0]!)
      if (kind === "missing") rmSync(join(f.bundle, "bin/msb"))
      if (kind === "symlink") {
        rmSync(join(f.bundle, "bin/msb"))
        writeFileSync(join(f.root, "outside"), "bin/msb")
        symlinkSync(join(f.root, "outside"), join(f.bundle, "bin/msb"))
      }
      if (kind === "not executable") chmodSync(join(f.bundle, "bin/msb"), 0o644)
      if (kind === "empty") f.files.splice(0)
      writeFileSync(
        join(f.bundle, "manifest.json"),
        JSON.stringify({ version: 1, platform: "darwin-arm64", revision: "a".repeat(40), files: f.files })
      )
      await expect(Host.install(f.options, f.system)).rejects.toThrow()
      expect(f.calls).toEqual([])
      expect(existsSync(f.system.agentsDir)).toBe(false)
    }
  )
  it.each(["version", "platform", "revision", "mode", "stage", "symlink"])(
    "verifies landed manifest %s metadata before touching launchd",
    async (kind) => {
      const f = fixture(), path = join(f.bundle, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"))
      if (["version", "platform", "revision"].includes(kind)) manifest[kind] = "invalid"
      else if (kind === "mode") manifest.files[0].mode = 0o644
      else if (kind === "stage") delete manifest.files[0].stage
      else manifest.files[0].symlink = "other"
      writeFileSync(path, JSON.stringify(manifest))
      await expect(Host.install(f.options, f.system)).rejects.toThrow()
      expect(f.calls).toEqual([])
    }
  )
  it("does not replace the plist when bootout fails", async () => {
    const f = fixture()
    await Host.install(f.options, f.system)
    const before = readFileSync(Host.plistFile(f.system), "utf8")
    f.system.launchctl = (args) => ({ status: args[0] === "print" ? 0 : 5, stdout: "", stderr: "refused" })
    const other = fixture()
    await expect(Host.install({ ...f.options, bundle: other.bundle }, f.system)).rejects.toThrow("bootout failed")
    expect(readFileSync(Host.plistFile(f.system), "utf8")).toBe(before)
    await expect(Host.stop(f.system)).rejects.toThrow("bootout failed")
  })
  it("reports bootstrap failure and permits the next unloaded retry", async () => {
    const f = fixture(), launch = f.system.launchctl
    f.system.launchctl = (args) => args[0] === "bootstrap" ? { status: 5, stdout: "", stderr: "refused" } : launch(args)
    await expect(Host.install(f.options, f.system)).rejects.toThrow("bootstrap failed")
    f.system.launchctl = launch
    expect(await Host.install(f.options, f.system)).toBe("installed")
  })
  it("runs bundled doctor with the required state root and no shell credentials", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) as unknown as typeof spawnSync
    Host.doctor("/bundle", "/state", run)
    expect(run).toHaveBeenCalledWith("/bundle/bin/smithers-backend", ["microvm", "doctor"], {
      encoding: "utf8",
      timeout: 30000,
      env: { HOME: homedir(), PATH: "/bundle/bin:/usr/bin:/bin", SMITHERS_DATA_ROOT: "/state" }
    })
    const failed = vi.fn(() => ({ status: 1, stdout: "", stderr: "private diagnostic" })) as unknown as typeof spawnSync
    expect(() => Host.doctor("/bundle", "/state", failed)).toThrow("Bundled microVM doctor failed: /bundle")
  })
  it("resolves explicit bundle paths and refuses a missing default naming both choices", () => {
    expect(Host.resolveBundle(".")).toBe(process.cwd())
    if (!existsSync("/opt/homebrew/opt/smithers/libexec/manifest.json")) {
      expect(() => Host.resolveBundle()).toThrow("--bundle <dir>")
    }
  })
  it("waits for real readiness and refuses an expired readiness deadline", async () => {
    let calls = 0
    await Host.waitReady(async () => ++calls === 2, 1000)
    expect(calls).toBe(2)
    await expect(Host.waitReady(async () => false, 1)).rejects.toThrow("readiness failed")
  })
  it("keeps waiting while a first boot's migrations advance, and not when they stall", async () => {
    // Five 250 ms polls, each a new step, outlast a 400 ms deadline.
    let calls = 0
    await Host.waitReady(async () => ++calls > 5 || JSON.stringify(["migrating", calls, 116]), 400)
    expect(calls).toBe(6)
    calls = 0
    await expect(Host.waitReady(async () => (++calls, JSON.stringify(["migrating", 1, 116])), 400))
      .rejects.toThrow("readiness failed")
    expect(calls).toBeLessThan(5)
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
    const f = fixture()
    mkdirSync(join(f.root, "run"))
    const socket = join(f.root, "run/host.sock")
    const server = createServer((req, res) => {
      expect(req.url).toBe("/setup-urls")
      expect(req.method).toBe("GET")
      res.writeHead(status)
      res.end(JSON.stringify(body))
    })
    await new Promise<void>((done) => server.listen(socket, done))
    chmodSync(socket, 0o600)
    try {
      if (code === "invalid") await expect(Host.setupURLs(f.root)).rejects.toThrow("Invalid setup handoff response")
      else expect(await Host.setupURLs(f.root)).toMatchObject({ code, exitCode })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
  it("rejects a missing, regular or insecure socket", async () => {
    const f = fixture()
    mkdirSync(join(f.root, "run"))
    await expect(Host.setupURLs(f.root)).rejects.toThrow()
    const socket = join(f.root, "run/host.sock")
    writeFileSync(socket, "", { mode: 0o600 })
    await expect(Host.setupURLs(f.root)).rejects.toThrow("mode 0600")
  })
})

it("passes explicit network settings to the existing bundled launcher", () => {
 const text = Host.hostPlist({bundle:"/bundle", stateDir:"/state", home:"/home", bind:"0.0.0.0", origins:["http://lan-a:4000", "https://box.example"]})
 expect(text).toContain("<string>--bind</string>")
 expect(text).toContain("<string>0.0.0.0</string>")
 expect(text).toContain("<string>http://lan-a:4000</string>")
 expect(text).toContain("<string>https://box.example</string>")
 expect(text.match(/<string>--origin<\/string>/g)).toHaveLength(2)
})

it("refuses invalid serving flags before host service effects", () => {
 for (const address of [
  {bind:"invalid"}, {bind:"0.0.0.0:4001"},
  {origins:["/relative"]}, {origins:["http://box?"]}, {origins:["http://box#"]}, {origins:["ftp://box"]}, {origins:["http://box/path"]},
  {origins:["http://box", "https://box"]},
  {origins:["https://localhost:4000"]}, {origins:["https://127.0.0.1:4000"]}, {origins:["https://[::1]:4000"]}
 ]) expect(() => Host.validateAddress(address)).toThrow();
 expect(() => Host.validateAddress({bind:"0.0.0.0",origins:["http://lan-a:4000", "https://box.example"]})).not.toThrow();
 expect(() => Host.validateAddress({bind:"[::]:4000"})).not.toThrow();
})


describe("install telemetry over HTTP", () => {
  it.each([200, 401, 404, 503])("probes GET /api/install with HTTP %s and omits unavailable telemetry", async (code) => {
    const server = createServer((req, res) => {
      expect(req.method).toBe("GET"); expect(req.url).toBe("/api/install"); expect(req.headers.authorization).toBe("Bearer fixture-person")
      res.writeHead(code, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ capacity: 2, this_mac: { memory_gb: 32, perf_cores: 10, capacity: 3, limit: { fix: "private" } }, github_app: { configured: true, installed: false, install_url: "secret" }, setup_urls: ["secret"] }))
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address() as { port: number }
      expect(await Host.installTelemetry(`http://127.0.0.1:${address.port}/api/install`, "fixture-person")).toEqual(code === 200 ? {
        capacity: 2, this_mac: { memory_gb: 32, perf_cores: 10, capacity: 3 }, github_app: { configured: true, installed: false }
      } : undefined)
    } finally { await new Promise<void>((done) => server.close(() => done())) }
  })
  it.each([
    ["memory", "needs 14 GiB of memory"],
    ["cores", "needs 2 performance cores"],
    ["disk", "free 12 GiB on the state volume"]
  ])("shows the zero-capacity %s fix from the authenticated install response", async (term, fix) => {
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-person")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ capacity: 0, this_mac: { capacity: 0, limit: { term, fix, secret: "omitted" } }, setup_urls: ["secret"] }))
    })
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
    try {
      const address = server.address() as { port: number }
      expect(await Host.installTelemetry(`http://127.0.0.1:${address.port}/api/install`, "fixture-person")).toEqual({ capacity: 0, this_mac: { capacity: 0, limit: { term, fix } } })
    } finally { await new Promise<void>(done => server.close(() => done())) }
  })
  it("omits malformed and unreachable telemetry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("invalid"))
    expect(await Host.installTelemetry()).toBeUndefined()
    vi.mocked(fetch).mockRejectedValue(new Error("offline"))
    expect(await Host.installTelemetry()).toBeUndefined()
  })
})

/** Reference-host service qualification. Requires a real T-INS-01 bundle; no fake launcher. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

const bundle = process.env.SMITHERS_HOST_TEST_BUNDLE
const required = process.env.SMITHERS_REQUIRE_HOST_SERVICE_TESTS === "1"
const enabled = process.platform === "darwin" && process.getuid?.() !== 0 && !!bundle
it.skipIf(!enabled && !required)("C-INS-06 real CLI, launchd and bundled launcher", async () => {
  expect(process.platform, "C-INS-06 requires macOS").toBe("darwin")
  expect(process.getuid?.(), "C-INS-06 requires an unprivileged login session").not.toBe(0)
  expect(bundle, "Set SMITHERS_HOST_TEST_BUNDLE to a bundle built at the commit under test").toBeTruthy()
  const domain = `gui/${process.getuid!()}`
  const launchctl = (...args: string[]) => spawnSync("/bin/launchctl", args, { encoding: "utf8" })
  // Never replace an operator's running install during qualification.
  expect(launchctl("print", `${domain}/sh.smithers.host`).status, "Stop the existing host service first").not.toBe(0)
  const home = mkdtempSync("/tmp/ins08-i-")
  const state = join(home, "Library/Application Support/Smithers")
  // A private bundle prefix prevents the crash probe from selecting another lane’s process.
  const ownedBundle = join(home, "initial-bundle")
  const cli = join(ownedBundle, "bin/smthrs")
  const receipt = resolve("../../.artifacts/checks/C-INS-06", new Date().toISOString().replaceAll(":", "-"))
  mkdirSync(receipt, { recursive: true })
  const transcripts: unknown[] = []
  const redact = (text: string) => text.replace(/([?&]token=)[^\s"&]+/g, "$1[REDACTED]")
  const run = (...args: string[]) => {
    const began = Date.now()
    const result = spawnSync(cli, ["host", ...args], {
      encoding: "utf8", timeout: 90_000,
      // No shell-derived SMITHERS settings reach the service.
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", XDG_DATA_HOME: join(home, ".local/share") }
    })
    transcripts.push({ args, status: result.status, duration_ms: Date.now() - began,
      stdout: redact(result.stdout), stderr: redact(result.stderr) })
    return result
  }
  const backendPID = () => {
    const listed = spawnSync("/bin/ps", ["-axo", "pid=,uid=,command="], { encoding: "utf8" }).stdout
    const processes = listed.split("\n").filter((line) => line.includes(ownedBundle + "/") && !line.includes("host start"))
    expect(processes.length).toBeGreaterThanOrEqual(2)
    for (const line of processes) expect(Number(line.trim().split(/\s+/)[1])).toBe(process.getuid!())
    transcripts.push({ processes: processes.map((line) => line.trim()) })
    const backend = processes.find((line) => line.includes("bin/smithers-backend"))
    expect(backend).toBeDefined()
    return Number(backend!.trim().split(/\s+/)[0])
  }
  const tokens: string[] = []
  const tokenOf = (output: string) => {
    const data = JSON.parse(output)
    expect(data.code).toBe("setup_ready")
    expect(data.setup_urls[0]).toMatch(/^http:\/\/localhost:4000\/setup\?token=.+/)
    const token = new URL(data.setup_urls[0]).searchParams.get("token")!
    tokens.push(token)
    return token
  }
  try {
    cpSync(resolve(bundle!), ownedBundle, { recursive: true, verbatimSymlinks: true })
    expect(existsSync(cli), "Qualification uses the CLI shipped in the bundle").toBe(true)
    const started = run("start", "--bundle", ownedBundle, "--json")
    expect(started.status, started.stderr).toBe(0)
    const firstToken = tokenOf(started.stdout), pid = backendPID()
    const socket = statSync(join(state, "run/host.sock"))
    expect(socket.isSocket()).toBe(true); expect(socket.mode & 0o777).toBe(0o600); expect(socket.uid).toBe(process.getuid!())
    expect(existsSync(join(state, "run/setup-urls.json"))).toBe(false)
    const repeated = run("start", "--bundle", ownedBundle, "--json")
    expect(repeated.status).toBe(0); expect(tokenOf(repeated.stdout)).toBe(firstToken); expect(backendPID()).toBe(pid)
    expect(run("status", "--json").status).toBe(0)
    const plist = readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")
    expect(plist).toContain("<string>--setup-handoff=socket</string>")
    writeFileSync(join(receipt, "host.plist"), plist)
    // Re-read the private-prefix process immediately before signalling it.
    expect(backendPID()).toBe(pid)
    process.kill(pid, "SIGKILL")
    await new Promise((done) => setTimeout(done, 1000))
    const restarted = run("start", "--bundle", ownedBundle, "--json")
    expect(restarted.status, restarted.stderr).toBe(0)
    expect(tokenOf(restarted.stdout)).not.toBe(firstToken); expect(backendPID()).not.toBe(pid)
    expect(run("stop").status).toBe(0)
    expect(existsSync(state)).toBe(true)
    expect(launchctl("print", `${domain}/sh.smithers.host`).status).not.toBe(0)
    const other = join(home, "relocated-bundle")
    cpSync(ownedBundle, other, { recursive: true, verbatimSymlinks: true })
    expect(run("start", "--bundle", other, "--json").status).toBe(0)
    const before = readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")
    expect(before).toContain(`${other}/bin/smithers-server`)
    const broken = join(home, "broken-bundle"); cpSync(other, broken, { recursive: true, verbatimSymlinks: true })
    const msb = join(broken, "bin/msb"); chmodSync(msb, 0o755); writeFileSync(msb, "tampered")
    expect(run("start", "--bundle", broken).status).not.toBe(0)
    expect(readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")).toBe(before)
    for (const token of tokens) {
      expect(readFileSync(join(state, "logs/host.log"), "utf8")).not.toContain(token)
      expect(readFileSync(join(state, "logs/host.log"), "utf8")).not.toContain(encodeURIComponent(token))
    }
    writeFileSync(join(receipt, "launchctl-print.txt"), launchctl("print", `${domain}/sh.smithers.host`).stdout)
    renameSync(other, other + ".moved")
    const missing = run("status")
    expect(missing.status).not.toBe(0)
    expect(missing.stdout + missing.stderr).toContain(other)
    writeFileSync(join(receipt, "bundle-revision.txt"), JSON.parse(readFileSync(join(ownedBundle, "manifest.json"), "utf8")).revision + "\n")
    writeFileSync(join(receipt, "manifest.sha256"), createHash("sha256").update(readFileSync(join(bundle!, "manifest.json"))).digest("hex"))
    writeFileSync(join(receipt, "limitations.json"), JSON.stringify({ not_run: ["login after reboot", "owner claim", "real msb disabled refusal", "all PostgreSQL/flow-host UID evidence"] }))
  } finally {
    if (existsSync(cli)) run("stop")
    writeFileSync(join(receipt, "transcript.json"), JSON.stringify(transcripts, null, 2))
    // Retain failed state privately for diagnosis; no setup token evidence is saved.
    if (!existsSync(join(receipt, "limitations.json"))) writeFileSync(join(receipt, "failed-state-path.txt"), home)
    else rmSync(home, { recursive: true, force: true })
  }
}, 300_000)

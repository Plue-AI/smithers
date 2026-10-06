/** Reference-host service qualification. Requires a real T-INS-01 bundle; no fake launcher. */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"

// Reuse the isolation check's tested process parser rather than matching bundle
// paths, which can select another user's install and omit PostgreSQL workers.
const { descendants } = await import(
  new URL("../../../scripts/checks/host-process-sampler.mjs", import.meta.url).href
) as {
  descendants: (text: string, rootPid: number) => Array<{ pid: number; uid: number; command: string }>
}

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
  const cli = join(resolve(bundle!), "bin/smthrs")
  expect(existsSync(cli), "Qualification requires the CLI shipped in the built bundle").toBe(true)
  // Production isolation refuses writable shared ancestors such as /tmp.
  // Keep this private home in the worktree, with a short Unix-socket path.
  const home = mkdtempSync(resolve("../../.i-"))
  const state = join(home, "Library/Application Support/Smithers")
  const ownedBundle = join(home, "initial-bundle")
  const cli = join(ownedBundle, "bin/smthrs")
  const receipt = resolve("../../.artifacts/checks/C-INS-06", new Date().toISOString().replaceAll(":", "-"))
  mkdirSync(receipt, { recursive: true })
  const transcripts: unknown[] = []
  let servicePIDs: number[] = []
  const observations: unknown[] = []
  const run = (...args: string[]) => {
    const began = Date.now()
    const result = spawnSync(cli, ["host", ...args], {
      encoding: "utf8",
      timeout: 90_000,
      // No shell-derived SMITHERS settings reach the service.
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", XDG_DATA_HOME: join(home, ".local/share") }
    })
    transcripts.push({
      args,
      status: result.status,
      duration_ms: Date.now() - began,
      stdout: (result.stdout ?? "").replace(/([?&]token=)[^\s"&]+/g, "$1[REDACTED]"),
      stderr: (result.stderr ?? result.error?.message ?? "").replace(/([?&]token=)[^\s"&]+/g, "$1[REDACTED]")
    })
    return result
  }
  const backendPID = () => {
    const service = launchctl("print", `${domain}/sh.smithers.host`)
    expect(service.status).toBe(0)
    const launcher = Number(service.stdout.match(/\bpid = (\d+)/)?.[1])
    expect(launcher).toBeGreaterThan(0)
    const listed = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,uid=,command="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    })
    expect(listed.status, listed.error?.message).toBe(0)
    const processes = descendants(listed.stdout, launcher)
    servicePIDs = processes.map((row) => row.pid)
    observations.push({ at: new Date().toISOString(), launcher, processes })
    expect(processes.length).toBeGreaterThanOrEqual(2)
    for (const row of processes) expect(row.uid).toBe(process.getuid!())
    expect(processes.some((row) => row.command.includes("/postgres"))).toBe(true)
    const backend = processes.find((row) => row.command.includes("bin/smithers-backend"))
    expect(backend).toBeDefined()
    return backend!.pid
  }
  const tokens: string[] = []
  const tokenOf = (output: string) => {
    const data = JSON.parse(output)
    expect(Object.keys(data)).toEqual(["setup_urls"])
    const url = new URL(data.setup_urls[0])
    expect(url.origin).toBe("http://localhost:4000")
    expect(url.pathname).toBe("/setup")
    const token = url.searchParams.get("token")!
    expect(!!token).toBe(true)
    tokens.push(token)
    return token
  }
  try {
    cpSync(resolve(bundle!), ownedBundle, { recursive: true, verbatimSymlinks: true })
    expect(existsSync(cli), "Qualification uses the CLI shipped in the bundle").toBe(true)
    const started = run("start", "--bundle", ownedBundle, "--json")
    const startedAt = Date.now()
    expect(started.status, started.stderr).toBe(0)
    expect(Date.now() - startedAt, "first start must print setup URLs within 60 seconds").toBeLessThanOrEqual(60_000)
    const firstToken = tokenOf(started.stdout), pid = backendPID()
    const socket = statSync(join(state, "run/host.sock"))
    expect(socket.isSocket()).toBe(true)
    expect(socket.mode & 0o777).toBe(0o600)
    expect(socket.uid).toBe(process.getuid!())
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
    // Observe launchd recovery before invoking start: start could otherwise
    // bootstrap an unloaded job and conceal a broken crash-restart contract.
    const deadline = Date.now() + 30_000
    let recovered = false
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 1000))
      try {
        const response = await fetch("http://127.0.0.1:4000/readyz", { signal: AbortSignal.timeout(1000) })
        if (response.status === 200) {
          recovered = true
          break
        }
      } catch { /* The service is still restarting. */ }
    }
    expect(recovered, "launchd must restore readiness within 30 seconds without host start").toBe(true)
    const restarted = run("start", "--bundle", ownedBundle, "--json")
    expect(restarted.status, restarted.stderr).toBe(0)
    expect(createHash("sha256").update(tokenOf(restarted.stdout)).digest("hex"))
      .not.toBe(createHash("sha256").update(firstToken).digest("hex"))
    expect(backendPID()).not.toBe(pid)
    expect(run("stop").status).toBe(0)
    const remaining = spawnSync("/bin/ps", ["-p", servicePIDs.join(","), "-o", "pid="], { encoding: "utf8" }).stdout
      .trim()
    expect(remaining, "stop must remove the launcher, backend and PostgreSQL descendants").toBe("")
    expect(existsSync(state)).toBe(true)
    expect(launchctl("print", `${domain}/sh.smithers.host`).status).not.toBe(0)
    const resumed = run("start", "--bundle", resolve(bundle!))
    expect(resumed.status, resumed.stderr).toBe(0)
    tokenOf(resumed.stdout)
    const resumedPID = backendPID()
    const other = join(home, "relocated-bundle")
    cpSync(ownedBundle, other, { recursive: true, verbatimSymlinks: true })
    const relocated = run("start", "--bundle", other)
    expect(relocated.status, relocated.stderr).toBe(0)
    tokenOf(relocated.stdout)
    expect(backendPID()).not.toBe(resumedPID)
    const before = readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")
    expect(before).toContain(`${other}/bin/smithers-server`)
    const broken = join(home, "broken-bundle")
    cpSync(other, broken, { recursive: true, verbatimSymlinks: true })
    const msb = join(broken, "bin/msb")
    chmodSync(msb, 0o755)
    writeFileSync(msb, "tampered")
    expect(run("start", "--bundle", broken).status).not.toBe(0)
    expect(readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")).toBe(before)
    for (const token of tokens) {
      const log = readFileSync(join(state, "logs/host.log"), "utf8")
      expect(log.includes(token), "service log contains a setup token").toBe(false)
      expect(log.includes(encodeURIComponent(token)), "service log contains an encoded setup token").toBe(false)
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
    writeFileSync(join(receipt, "process-uids.json"), JSON.stringify(observations, null, 2))
    // Retain failed state privately for diagnosis; no setup token evidence is saved.
    if (!existsSync(join(receipt, "limitations.json"))) writeFileSync(join(receipt, "failed-state-path.txt"), home)
    else rmSync(home, { recursive: true, force: true })
  }
}, 300_000)

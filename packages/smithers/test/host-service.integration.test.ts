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
import { request } from "node:http"
import { networkInterfaces } from "node:os"
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
it.skipIf(!enabled && !required)(
  "C-INS-06 / C-INS-03 real CLI, launchd, bundled launcher and public origin",
  async () => {
    expect(process.platform, "C-INS-06 requires macOS").toBe("darwin")
    expect(process.getuid?.(), "C-INS-06 requires an unprivileged login session").not.toBe(0)
    expect(bundle, "Set SMITHERS_HOST_TEST_BUNDLE to a bundle built at the commit under test").toBeTruthy()
    const domain = `gui/${process.getuid!()}`
    const launchctl = (...args: string[]) => spawnSync("/bin/launchctl", args, { encoding: "utf8" })
    // Never replace an operator's running install during qualification.
    expect(launchctl("print", `${domain}/sh.smithers.host`).status, "Stop the existing host service first").not.toBe(0)
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
    const expectations = JSON.parse(readFileSync(new URL("./fixtures/host-service-r4.json", import.meta.url), "utf8"))
    const lanAddress = Object.values(networkInterfaces()).flat().find((address) =>
      address?.family === "IPv4" && !address.internal
    )?.address
    expect(lanAddress, "C-INS-03 requires a non-loopback interface").toBeTruthy()
    // Reach the actual network listener, without DNS or a loopback proxy. Host
    // is the literal public origin configured through the shipped CLI below.
    const lanRequest = (path: string, cookie = "", host = "lan-a:4000") =>
      new Promise<{
        status: number
        body: string
        cookies: string[]
        location: string | undefined
      }>((resolve, reject) => {
        const req = request({
          hostname: lanAddress,
          localAddress: lanAddress,
          port: 4000,
          path,
          headers: { Host: host, Cookie: cookie },
          timeout: 5000
        }, (res) => {
          let body = ""
          res.setEncoding("utf8")
          res.on("data", (chunk) => {
            body += chunk
          })
          res.on("error", reject)
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body,
              cookies: res.headers["set-cookie"] ?? [],
              location: res.headers.location
            }))
        })
        req.on("timeout", () => req.destroy(new Error("Public listener request timed out")))
        req.on("error", reject)
        req.end()
      })
    const publicSettings = async () => {
      const response = await lanRequest("/api/install", setupCookie)
      expect(response.status).toBe(200)
      const status = JSON.parse(response.body)
      expect(status.address).toEqual({ listen: "network", bind: "0.0.0.0:4000", origins: ["http://lan-a:4000"] })
      expect(status.ssh_host).toBe("lan-a")
      expect(status.ssh_line).toBe("ssh -p 2222 <branch>@lan-a")
      expect(status.github.signed_in).toBe(false)
      return status.address
    }
    const tokens: string[] = []
    let setupCookie = ""
    const setupSteps = async () => {
      const response = await fetch("http://localhost:4000/api/install", {
        headers: { Cookie: setupCookie },
        signal: AbortSignal.timeout(5000)
      })
      expect(response.status).toBe(expectations.install_status)
      const status = await response.json() as { steps: Array<{ id: string; status: string }> }
      expect(Array.isArray(status.steps)).toBe(true)
      expect(status.steps.length).toBeGreaterThan(0)
      return status.steps
    }
    const tokenOf = (output: string) => {
      const data = JSON.parse(output)
      expect(Object.keys(data)).toEqual(["setup_urls"])
      const url = new URL(data.setup_urls[0])
      expect(url.origin).toBe(expectations.setup_origin)
      expect(url.pathname).toBe(expectations.setup_path)
      const token = url.searchParams.get("token")!
      expect(!!token).toBe(true)
      expect(data.setup_urls.map((value: string) => new URL(value).origin)).toEqual([
        "http://localhost:4000",
        "http://lan-a:4000"
      ])
      for (const value of data.setup_urls) {
        const publicURL = new URL(value)
        expect(publicURL.pathname).toBe("/setup")
        expect(publicURL.searchParams.get("token")).toBe(token)
      }
      tokens.push(token)
      return token
    }
    try {
      cpSync(resolve(bundle!), ownedBundle, { recursive: true, verbatimSymlinks: true })
      expect(existsSync(cli), "Qualification uses the CLI shipped in the bundle").toBe(true)
      const startedAt = Date.now()
      const started = run(
        "start",
        "--bind",
        "0.0.0.0",
        "--origin",
        "http://lan-a:4000",
        "--bundle",
        ownedBundle,
        "--json"
      )
      expect(started.status, started.stderr).toBe(0)
      expect(Date.now() - startedAt, "first start must print setup URLs within 60 seconds").toBeLessThanOrEqual(
        expectations.first_start_limit_ms
      )
      const firstToken = tokenOf(started.stdout), pid = backendPID()
      expect((await lanRequest("/api/install")).status).toBe(403)
      const unknown = await lanRequest("/api/install", "", "evil.example")
      expect(unknown.status).toBe(421)
      expect(JSON.parse(unknown.body)).toEqual({ class: "user", code: "unknown_origin", message: "unknown_origin" })
      expect((await lanRequest("/api/install", "", "localhost:4000")).status).toBe(421)
      const exchange = await lanRequest(`/setup?token=${encodeURIComponent(firstToken)}`)
      expect(exchange.status).toBe(expectations.exchange_status)
      expect(exchange.location).toBe(expectations.exchange_location)
      const cookie = exchange.cookies.find((cookie) => cookie.startsWith(expectations.setup_cookie + "=")) ?? ""
      expect(cookie).toMatch(/; HttpOnly/i)
      expect(cookie).toMatch(/; SameSite=Lax/i)
      expect(cookie).toMatch(/; Path=\//i)
      expect(cookie).not.toMatch(/; (Secure|Domain=)/i)
      setupCookie = cookie.split(";")[0] ?? ""
      expect(setupCookie).not.toBe("")
      const initialAddress = await publicSettings()
      expect(backendPID()).toBe(pid)
      const initialPlist = readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")
      expect(initialPlist).toContain("<string>--bind</string>")
      expect(initialPlist).toContain("<string>0.0.0.0</string>")
      expect(initialPlist).toContain("<string>--origin</string>")
      expect(initialPlist).toContain("<string>http://lan-a:4000</string>")
      writeFileSync(join(receipt, "public-origin.plist"), initialPlist)
      const beforeRestartSteps = await setupSteps()
      const socket = statSync(join(state, "run/host.sock"))
      expect(socket.isSocket()).toBe(true)
      expect(socket.mode & 0o777).toBe(expectations.socket_mode)
      expect(socket.uid).toBe(process.getuid!())
      expect(existsSync(join(state, "run/setup-urls.json"))).toBe(false)
      const repeated = run(
        "start",
        "--bind",
        "0.0.0.0",
        "--origin",
        "http://lan-a:4000",
        "--bundle",
        ownedBundle,
        "--json"
      )
      expect(repeated.status).toBe(0)
      expect(tokenOf(repeated.stdout)).toBe(firstToken)
      expect(backendPID()).toBe(pid)
      expect(run("status", "--json").status).toBe(0)
      const plist = readFileSync(join(home, "Library/LaunchAgents/sh.smithers.host.plist"), "utf8")
      expect(plist).toContain("<string>--setup-handoff=socket</string>")
      writeFileSync(join(receipt, "host.plist"), plist)
      // Re-read the private-prefix process immediately before signalling it.
      expect(backendPID()).toBe(pid)
      process.kill(pid, "SIGKILL")
      // Observe launchd recovery before invoking start: start could otherwise
      // bootstrap an unloaded job and conceal a broken crash-restart contract.
      const deadline = Date.now() + expectations.restart_limit_ms
      let recovered = false
      while (Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 1000))
        try {
          const response = await fetch("http://127.0.0.1:4000/readyz", { signal: AbortSignal.timeout(1000) })
          if (response.status === 200 && backendPID() !== pid) {
            recovered = true
            break
          }
        } catch { /* The service is still restarting. */ }
      }
      expect(recovered, "launchd must restore readiness within 30 seconds without host start").toBe(true)
      const restarted = run(
        "start",
        "--bind",
        "0.0.0.0",
        "--origin",
        "http://lan-a:4000",
        "--bundle",
        ownedBundle,
        "--json"
      )
      expect(restarted.status, restarted.stderr).toBe(0)
      expect(createHash("sha256").update(tokenOf(restarted.stdout)).digest("hex"))
        .not.toBe(createHash("sha256").update(firstToken).digest("hex"))
      expect(backendPID()).not.toBe(pid)
      expect(await setupSteps()).toEqual(beforeRestartSteps)
      expect(await publicSettings()).toEqual(initialAddress)
      expect(run("stop").status).toBe(0)
      const remaining = spawnSync("/bin/ps", ["-p", servicePIDs.join(","), "-o", "pid="], { encoding: "utf8" }).stdout
        .trim()
      expect(remaining, "stop must remove the launcher, backend and PostgreSQL descendants").toBe("")
      expect(existsSync(state)).toBe(true)
      expect(launchctl("print", `${domain}/sh.smithers.host`).status).not.toBe(0)
      const resumed = run("start", "--bundle", resolve(bundle!))
      expect(resumed.status, resumed.stderr).toBe(0)
      tokenOf(resumed.stdout)
      expect(await setupSteps()).toEqual(beforeRestartSteps)
      expect(await publicSettings()).toEqual(initialAddress)
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
      writeFileSync(
        join(receipt, "bundle-revision.txt"),
        JSON.parse(readFileSync(join(ownedBundle, "manifest.json"), "utf8")).revision + "\n"
      )
      writeFileSync(
        join(receipt, "manifest.sha256"),
        createHash("sha256").update(readFileSync(join(bundle!, "manifest.json"))).digest("hex")
      )
      writeFileSync(
        join(receipt, "restart-session.json"),
        JSON.stringify(
          {
            crash_restart_session_retained: true,
            stop_start_session_retained: true,
            steps: beforeRestartSteps
          },
          null,
          2
        )
      )
      writeFileSync(
        join(receipt, "public-origin.json"),
        JSON.stringify(
          {
            check: "C-INS-03",
            address: initialAddress,
            peer: lanAddress,
            unauthenticated_status: 403,
            setup_status: 200,
            unknown_host_status: 421,
            loopback_host_from_network_status: 421,
            persisted_after_crash_and_stop: true
          },
          null,
          2
        )
      )
      writeFileSync(
        join(receipt, "limitations.json"),
        JSON.stringify({
          not_run: [
            "login after reboot",
            "owner claim",
            "real msb disabled refusal",
            "all PostgreSQL/flow-host UID evidence"
          ]
        })
      )
    } finally {
      if (existsSync(cli)) run("stop")
      writeFileSync(join(receipt, "transcript.json"), JSON.stringify(transcripts, null, 2))
      writeFileSync(join(receipt, "process-uids.json"), JSON.stringify(observations, null, 2))
      // Retain failed state privately for diagnosis; no setup token evidence is saved.
      if (!existsSync(join(receipt, "limitations.json"))) writeFileSync(join(receipt, "failed-state-path.txt"), home)
      else rmSync(home, { recursive: true, force: true })
    }
  },
  300_000
)

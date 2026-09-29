import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { READINESS_DEADLINE_MS, parseMatrixConfig, probeMode } from "./matrix"
import { sourceRevision } from "../../../scripts/mode-matrix/source-revision"

const appDir = resolve(import.meta.dirname, "../../..")
const revision = "a".repeat(40)
const deployed = "b".repeat(40)
const deadlineMs = 200
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

const temporary = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-readiness-deadline-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const cloudBootstrap = {
  apiVersion: 1, host: "cloud", version: "test", buildSha: deployed,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: true }),
  authFlow: "native-handoff", sandbox: null
}

/** A real loopback origin. `stall` routes begin a JSON body and never finish it; `hang` routes never send headers. */
const loopback = (routes: Readonly<Record<string, "stall" | "hang" | unknown>>) => {
  const requests: string[] = []
  const aborted: string[] = []
  const timers = new Set<ReturnType<typeof setInterval>>()
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url)
      requests.push(pathname)
      request.signal.addEventListener("abort", () => aborted.push(pathname), { once: true })
      const route = routes[pathname]
      if (route === "hang") return new Promise<Response>(() => undefined)
      if (route === "stall") {
        let timer: ReturnType<typeof setInterval> | undefined
        return new Response(new ReadableStream<string>({
          start(controller) {
            controller.enqueue("{\"apiVersion\":1,")
            timer = setInterval(() => controller.enqueue(" "), 20)
            timers.add(timer)
          },
          cancel() { if (timer) { clearInterval(timer); timers.delete(timer) } }
        }), { headers: { "content-type": "application/json" } })
      }
      if (route === undefined) return Response.json({ code: "route_not_found" }, { status: 404 })
      return Response.json(route)
    }
  })
  cleanups.push(() => { for (const timer of timers) clearInterval(timer); server.stop(true) })
  return { origin: `http://127.0.0.1:${server.port}`, requests, aborted }
}

const receipt = (mode: "web-plue" | "local-own", origin: string, receiptRevision: string) => {
  const path = join(temporary(), "receipt.json")
  writeFileSync(path, JSON.stringify({
    mode, revision: receiptRevision, origin, endpoint: origin, ready: true,
    startedRoles: mode === "web-plue" ? ["web"] : ["local-ui", "app", "postgres"],
    freshLaunch: true, restarted: mode === "local-own", dataPreserved: mode === "local-own",
    ...(mode === "local-own" ? { persistenceProof: { database: { before: "db", after: "db" }, dataVolume: { before: "vol", after: "vol" } } } : {}),
    observedAt: "2026-09-21T00:00:00.000Z"
  }))
  return path
}

const webPlue = (origin: string) => ({
  mode: "web-plue", origin, endpoint: origin, auth: { kind: "browser-profile", environment: "PROFILE" },
  executionReceipt: receipt("web-plue", origin, deployed)
})

const timedOut = `readiness timed out after ${deadlineMs} ms`

describe("mode readiness deadline", () => {
  test("the default deadline is finite", () => {
    expect(Number.isSafeInteger(READINESS_DEADLINE_MS)).toBe(true)
    expect(READINESS_DEADLINE_MS).toBeGreaterThan(0)
  })

  test("an unterminated bootstrap body fails readiness and aborts the request", async () => {
    const server = loopback({ "/api/bootstrap": "stall" })
    const config = parseMatrixConfig({ revision, modes: [webPlue(server.origin)] }).modes[0]!
    const started = performance.now()
    const result = await probeMode(config, revision, { PROFILE: "configured" }, fetch, deadlineMs)
    expect(performance.now() - started).toBeLessThan(deadlineMs + 2_000)
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain(timedOut)
    expect(result.bootstrapSHA256).toBeUndefined()
    expect(server.requests).toEqual(["/api/bootstrap"])
    await Bun.sleep(50)
    expect(server.aborted).toEqual(["/api/bootstrap"])
  })

  test("bootstrap headers that never arrive fail readiness", async () => {
    const server = loopback({ "/api/bootstrap": "hang" })
    const config = parseMatrixConfig({ revision, modes: [webPlue(server.origin)] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, fetch, deadlineMs)
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain(timedOut)
  })

  test("the deadline covers the selfhost health request after a good bootstrap", async () => {
    const server = loopback({
      "/api/bootstrap": { apiVersion: 1, host: "local", version: "test", buildSha: revision,
        capabilities: localCapabilities({ identity: true, cloud: true, agent: true }), authFlow: "credentials", sandbox: null },
      "/api/health": "hang"
    })
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-own", origin: server.origin, endpoint: server.origin, auth: { kind: "owner-session", environment: "OWNER" },
      executionReceipt: receipt("local-own", server.origin, revision)
    }] }).modes[0]!
    const result = await probeMode(config, revision, { OWNER: "configured" }, fetch, deadlineMs)
    expect(result.status).toBe("failed")
    expect(result.reasons).toEqual([timedOut])
    expect(result.buildSha).toBe(revision)
    expect(server.requests).toEqual(["/api/bootstrap", "/api/health"])
  })

  test("a fetcher that ignores the abort signal is still bounded", async () => {
    const config = parseMatrixConfig({ revision, modes: [webPlue("https://example.test")] }).modes[0]!
    let signal: AbortSignal | undefined
    const result = await probeMode(config, revision, { PROFILE: "configured" }, async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    }, deadlineMs)
    expect(signal?.aborted).toBe(true)
    expect(result.reasons).toContain(timedOut)
  })

  test("a request that fails before the deadline keeps its own failure", async () => {
    const config = parseMatrixConfig({ revision, modes: [webPlue("https://example.test")] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, async () => { throw new Error("connection refused") }, deadlineMs)
    expect(result.reasons).toContain("readiness request failed: connection refused")
    expect(result.reasons).not.toContain(timedOut)
  })

  test("a fast origin passes well inside the deadline", async () => {
    const server = loopback({ "/api/bootstrap": cloudBootstrap })
    const config = parseMatrixConfig({ revision, modes: [webPlue(server.origin)] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, fetch, deadlineMs)
    expect(result.reasons).toEqual([])
    expect(result.status).toBe("passed")
  })
})

const checkout = await sourceRevision(resolve(appDir, "../..")).catch(() => undefined)

describe("mode matrix CLI readiness deadline", () => {
  // Asynchronous, so the loopback origin in this process keeps serving while the CLI probes it.
  const cli = async (args: readonly string[]) => {
    const child = Bun.spawn(["bun", "scripts/run-mode-matrix.ts", ...args], {
      cwd: appDir, env: { ...process.env, PROFILE: "configured" }, stdout: "pipe", stderr: "pipe", timeout: 60_000
    })
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { stderr, exitCode }
  }

  test("rejects a readiness timeout that is not a positive integer", async () => {
    for (const value of ["0", "-5", "1.5", "soon"]) {
      const run = await cli(["audit", "--readiness-timeout-ms", value, "--report", join(temporary(), "report.json")])
      expect(run.exitCode).not.toBe(0)
      expect(run.stderr).toContain("--readiness-timeout-ms requires a positive integer")
    }
  })

  // The CLI refuses to audit an unidentifiable (dirty) checkout, so this runs on a clean tree, as in CI.
  test.skipIf(checkout === undefined)("a stalled mode is reported as a timeout and the audit continues", async () => {
    const server = loopback({ "/api/bootstrap": "stall" })
    const root = temporary()
    const configPath = join(root, "matrix.json")
    const reportPath = join(root, "report.json")
    writeFileSync(configPath, JSON.stringify({ revision: checkout, modes: [webPlue(server.origin)] }))
    const run = await cli(["audit", "--config", configPath, "--modes", "web-plue,local-plue", "--report", reportPath, "--readiness-timeout-ms", String(deadlineMs)])
    expect(run.exitCode).toBe(1)
    expect(existsSync(reportPath)).toBe(true)
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { readiness: Array<{ mode: string; status: string; reasons: string[] }> }
    expect(report.readiness.map(({ mode }) => mode)).toEqual(["web-plue", "local-plue"])
    expect(report.readiness[0]).toMatchObject({ mode: "web-plue", status: "failed" })
    expect(report.readiness[0]!.reasons).toContain(timedOut)
    expect(report.readiness[1]!.reasons).toContain("configuration for local-plue is unavailable")
  })
})

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import * as Failure from "../src/internal/Failure.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const serve = async (handle: (req: IncomingMessage, res: ServerResponse) => void = () => {}) => {
  const home = await mkdtemp(join(tmpdir(), "smithers-backend-availability-"))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  const server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing server address")
  const close = async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  cleanup.push(close)
  const environment = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    SMITHERS_API_ORIGIN: `http://127.0.0.1:${address.port}`,
    SMITHERS_TOKEN: "availability-session-secret",
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
  }
  return { home, close, environment }
}

describe("designed backend availability units over real TCP", () => {
  it("keeps a refused-loopback transport cause behind the actionable availability sentence", async () => {
    const fixture = await serve()
    await fixture.close()
    const client = new Client({ environment: fixture.environment })
    const failure = await client.response("GET", "/api/user/repos").catch((error: unknown) => error)
    expect(failure).toMatchObject({
      fault: "infra",
      code: "backend_unavailable",
      message: "Cannot reach Smithers API. Check api_origin and your connection"
    })
    expect(Failure.operatorSentence(failure)).not.toMatch(/fetch failed|ECONNREFUSED/)
    expect(Failure.operatorDetail(failure)).toContain("ECONNREFUSED")
    expect(client.redact(Failure.operatorDetail(failure))).not.toContain("availability-session-secret")
  })
  it("classifies an actual unresolved HTTP request deadline and preserves its cause", async () => {
    // Only shorten the120s wall deadline; HTTP, socket and AbortSignal timeout
    // behavior are real. The public process cancellation tests use no override.
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const clock = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout(25))
    const fixture = await serve()
    const client = new Client({ environment: fixture.environment })
    const failure = await client.response("GET", "/api/user/repos").catch((error: unknown) => error)
    expect(clock).toHaveBeenCalledWith(120_000)
    expect(failure).toMatchObject({
      fault: "infra",
      code: "backend_timed_out",
      message: "Smithers API timed out. Check api_origin and your connection"
    })
    expect(Failure.operatorDetail(failure)).toContain("TimeoutError")
    expect(Failure.operatorSentence(failure)).not.toContain("TimeoutError")
  })
  it("keeps explicit request cancellation distinct from infrastructure failure", async () => {
    let received!: () => void
    const ready = new Promise<void>((resolve) => received = resolve)
    const fixture = await serve(() => received())
    const controller = new AbortController()
    const client = new Client({ environment: fixture.environment, signal: controller.signal })
    const running = client.response("GET", "/api/user/repos").catch((error: unknown) => error)
    await ready
    controller.abort(new Error("explicit cancellation"))
    const failure = await running
    expect(failure).toMatchObject({ fault: "user", code: "cancelled", message: "API request cancelled" })
    expect(Failure.operatorDetail(failure)).toContain("explicit cancellation")
  })
})

describe("actual CLI backend availability", () => {
  const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
  it("reports refused TCP with stable code and concise connection guidance", async () => {
    const fixture = await serve()
    await fixture.close()
    const result = await new Promise<{ code: number | null; output: string; error: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", executable, "repo", "list", "--format=json"], {
        cwd: fixture.home,
        env: fixture.environment,
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"]
      })
      let output = "", error = ""
      child.stdout.on("data", (chunk) => output += chunk)
      child.stderr.on("data", (chunk) => error += chunk)
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, output, error }))
    })
    expect(result.code, result.output + result.error).toBe(1)
    expect(JSON.parse(result.output)).toMatchObject({
      code: "backend_unavailable",
      message: "Cannot reach Smithers API. Check api_origin and your connection"
    })
    expect(result.output + result.error).not.toMatch(
      /availability-session-secret|ECONNREFUSED|fetch failed|command_failed/
    )
  }, 90_000)
  it.each(["SIGINT", "SIGTERM"] as const)(
    "preserves%s exit semantics while real HTTP remains unresolved",
    async (signal) => {
      let received!: () => void
      const ready = new Promise<void>((resolve) => received = resolve)
      const fixture = await serve((req) => {
        expect(new URL(req.url!, "http://fixture").pathname).toBe("/api/user/repos")
        received()
      })
      const child = spawn(process.execPath, ["--no-warnings", executable, "repo", "list", "--format=json"], {
        cwd: fixture.home,
        env: fixture.environment,
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"]
      })
      let output = ""
      child.stdout.on("data", (chunk) => output += chunk)
      child.stderr.on("data", (chunk) => output += chunk)
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code, signal) => resolve({ code, signal }))
      })
      try {
        await ready
        child.kill(signal)
        expect(await exited).toEqual({ code: signal === "SIGINT" ? 130 : 143, signal: null })
        expect(output).not.toContain("availability-session-secret")
        expect(output).not.toContain("backend_unavailable")
      } finally {
        child.kill("SIGKILL")
      }
    },
    90_000
  )
})

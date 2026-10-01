import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { CLIENT_ERROR_BODY_MAX_BYTES, CLIENT_ERRORS_PATH, createClientErrorReporter } from "./ClientErrors"
import { CLIENT_ERROR_MAX_BODY, startLocalServer } from "../../bun/server"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

/** Real local HTTP ingest; no remote telemetry service or user credentials. */
const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-client-errors-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, "index.html"), "<!doctype html>")
  const logs: string[] = []
  const host = await startLocalServer({
    port: 0, distDir: directory, stateDir: directory, home: directory,
    cloudMode: "offline", log: line => logs.push(line)
  })
  cleanup.push(() => host.stop())
  const call = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (!headers.has(LOCAL_SESSION_HEADER)) headers.set(LOCAL_SESSION_HEADER, host.sessionToken)
    return fetch(`${host.origin}${path}`, { ...init, headers })
  }
  const post = (body: string, headers?: HeadersInit) => call(CLIENT_ERRORS_PATH, { method: "POST", headers, body })
  return { host, call, post, reports: () => logs.filter(line => line.startsWith("client-error: ")) }
}

describe("browser reporter → local telemetry ingest", () => {
  test("the real reporter posts both error kinds and the host redacts credentials", async () => {
    const f = await fixture()
    const accepted: Promise<Response>[] = []
    const reporter = createClientErrorReporter({
      pathname: () => "/private/repository",
      now: () => new Date("2026-09-21T12:00:00Z"),
      fetchImpl: (path, init) => {
        const pending = f.call(path, init)
        accepted.push(pending)
        return pending
      }
    })
    reporter.report("error", new TypeError("Authorization: Bearer abcdef0123456789token"))
    reporter.report("unhandledrejection", "fetch https://api.example.test/items?key=live_c4p4b1l1ty failed")
    expect(reporter.reported()).toBe(2)
    expect((await Promise.all(accepted)).map(response => response.status)).toEqual([202, 202])
    const reports = f.reports()
    expect(reports).toHaveLength(2)
    expect(reports[0]).toContain('"kind":"error"')
    expect(reports[0]).toContain('"type":"TypeError"')
    expect(reports[0]).toContain('"at":"2026-09-21T12:00:00.000Z"')
    expect(reports[1]).toContain('"kind":"unhandledrejection"')
    for (const line of reports) {
      expect(line).not.toContain("abcdef0123456789token")
      expect(line).not.toContain("live_c4p4b1l1ty")
    }
  })

  test("reporting returns while delivery waits and unrelated requests remain usable", async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const accepted: Promise<Response>[] = []
    const reporter = createClientErrorReporter({
      fetchImpl: (path, init) => {
        const pending = gate.then(() => f.call(path, init))
        accepted.push(pending)
        return pending
      }
    })
    expect(reporter.report("error", new Error("bounded diagnostic"))).toBeUndefined()
    expect(reporter.reported()).toBe(1)
    expect(f.reports()).toEqual([])
    expect((await f.call("/api/not-a-route")).status).toBe(404)
    release()
    expect((await accepted[0]!).status).toBe(202)
    expect(f.reports()).toHaveLength(1)
  })

  test("the serialized reporter bound fits the host cap and oversized bodies are rejected", async () => {
    const f = await fixture()
    expect(CLIENT_ERROR_BODY_MAX_BYTES).toBe(CLIENT_ERROR_MAX_BODY)
    const accepted: Promise<Response>[] = []
    const reporter = createClientErrorReporter({
      pathname: () => "界".repeat(3000),
      fetchImpl: (path, init) => {
        expect(new TextEncoder().encode(String(init.body)).byteLength).toBeLessThanOrEqual(CLIENT_ERROR_MAX_BODY)
        const pending = f.call(path, init)
        accepted.push(pending)
        return pending
      }
    })
    const error = new Error("界".repeat(3000))
    error.stack = "\u0000".repeat(20_000)
    reporter.report("error", error)
    expect((await accepted[0]!).status).toBe(202)
    expect((await f.post("x".repeat(CLIENT_ERROR_MAX_BODY + 1))).status).toBe(413)
    // The host measures UTF-8 bytes, not the string's character count.
    expect((await f.post("界".repeat(Math.floor(CLIENT_ERROR_MAX_BODY / 3) + 1))).status).toBe(413)
    expect(f.reports()).toHaveLength(1)
  })

  test("missing capabilities, cross-origin writes and unsupported methods never log reports", async () => {
    const f = await fixture()
    expect((await fetch(`${f.host.origin}${CLIENT_ERRORS_PATH}`, { method: "POST", body: "{}" })).status).toBe(401)
    expect((await f.post("{}", { [LOCAL_SESSION_HEADER]: "wrong" })).status).toBe(401)
    expect((await f.post("{}", { origin: "https://elsewhere.test" })).status).toBe(403)
    expect((await f.call(CLIENT_ERRORS_PATH)).status).toBe(405)
    expect(f.reports()).toEqual([])
  })
})

/**
 * OTLP export from real `smthrs` processes to an in-process collector.
 *
 * Each case starts the actual executable with the standard OpenTelemetry
 * environment and reads what arrives at a local HTTP collector, so the
 * assertion is about the wire, not about which layer a handler was given.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const processBudget = { timeout: 240_000 }

interface Export {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: any
}

const exports: Array<Export> = []
const collector = createServer((request, response) => {
  const chunks: Array<Buffer> = []
  request.on("data", (chunk: Buffer) => chunks.push(chunk))
  request.on("end", () => {
    exports.push({
      path: request.url ?? "",
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    })
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
})
let endpoint = ""

beforeAll(async () => {
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve))
  endpoint = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => collector.close(() => resolve())))

const environment = (cwd: string, otel: Record<string, string>): NodeJS.ProcessEnv => ({
  HOME: cwd,
  PATH: process.env.PATH,
  CI: "1",
  SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
  ...otel
})

/** Runs the executable to completion without blocking the collector's loop. */
const smthrs = (cwd: string, otel: Record<string, string>, ...args: ReadonlyArray<string>) =>
  new Promise<{ readonly status: number | null; readonly output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "--import", scriptedHost, executable, ...args], {
      cwd,
      env: environment(cwd, otel),
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    child.stdout.on("data", (chunk) => output += chunk)
    child.stderr.on("data", (chunk) => output += chunk)
    child.once("close", (status) => resolve({ status, output }))
  })

const spansOf = (received: ReadonlyArray<Export>) =>
  received.filter((entry) => entry.path === "/v1/traces").flatMap((entry) =>
    entry.body.resourceSpans.flatMap((resource: any) =>
      resource.scopeSpans.flatMap((scope: any) =>
        scope.spans.map((span: any) => ({ span, resource: resource.resource }))
      )
    )
  )

const serviceName = (resource: any): unknown =>
  resource.attributes.find((attribute: any) => attribute.key === "service.name")?.value.stringValue

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })

const inDirectory = async (use: (cwd: string) => Promise<void>) => {
  const cwd = mkdtempSync(join(tmpdir(), "smithers-otlp-export-"))
  try {
    await use(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("OTLP export from smthrs", processBudget, () => {
  it("sends a command's spans to OTEL_EXPORTER_OTLP_ENDPOINT with OTEL_EXPORTER_OTLP_HEADERS", async () => {
    await inDirectory(async (cwd) => {
      exports.length = 0
      const result = await smthrs(
        cwd,
        {
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          OTEL_EXPORTER_OTLP_HEADERS: "x-collector-tenant=smithers%20e2e"
        },
        "ps",
        "--json"
      )
      expect(result.status, result.output).toBe(0)
      const traces = exports.filter((entry) => entry.path === "/v1/traces")
      expect(traces.length).toBeGreaterThan(0)
      for (const entry of exports) expect(entry.headers["x-collector-tenant"]).toBe("smithers e2e")
      const spans = spansOf(exports)
      expect(spans.length).toBeGreaterThan(0)
      for (const { resource } of spans) expect(serviceName(resource)).toBe("smthrs")
      expect(spans.every(({ span }) => /^[0-9a-f]{32}$/.test(span.traceId))).toBe(true)
    })
  })

  it("installs no exporter when the endpoint is unset", async () => {
    await inDirectory(async (cwd) => {
      exports.length = 0
      // Headers alone name no collector.
      const result = await smthrs(cwd, { OTEL_EXPORTER_OTLP_HEADERS: `x-collector=${endpoint}` }, "ps", "--json")
      expect(result.status, result.output).toBe(0)
      expect(exports).toEqual([])
    })
  })

  it("exports the served host's spans and flushes them on shutdown", async () => {
    await inDirectory(async (cwd) => {
      exports.length = 0
      const port = await freePort()
      const child = spawn(process.execPath, [
        "--no-warnings",
        "--import",
        scriptedHost,
        executable,
        "serve",
        "--port",
        `${port}`
      ], {
        cwd,
        env: environment(cwd, { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }),
        stdio: ["ignore", "pipe", "pipe"]
      })
      let output = ""
      child.stdout.on("data", (chunk) => output += chunk)
      child.stderr.on("data", (chunk) => output += chunk)
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
      try {
        let ready = false
        for (let attempt = 0; attempt < 240 && !ready; attempt++) {
          if (child.exitCode !== null) throw new Error(`host exited: ${child.exitCode}\n${output}`)
          try {
            ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok
          } catch { /* still starting */ }
          if (!ready) await new Promise((resolve) => setTimeout(resolve, 500))
        }
        expect(ready, output).toBe(true)
      } finally {
        child.kill("SIGTERM")
        await closed
      }
      const spans = spansOf(exports)
      expect(spans.length, output).toBeGreaterThan(0)
      for (const { resource } of spans) expect(serviceName(resource)).toBe("smthrs")
    })
  })
})

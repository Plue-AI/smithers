/** Real bundled CommonJS-to-ESM loading, including the proxy Pool path (#2952). */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { build } from "esbuild"
import { execFile } from "node:child_process"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { type AddressInfo, connect } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { Duplex } from "node:stream"
const packageRoot = resolve(import.meta.dirname, "..")
let directory: string
let bundled: string

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "egress-esm-bundle-"))
  symlinkSync(join(packageRoot, "node_modules"), join(directory, "node_modules"), "dir")
  bundled = join(directory, "main.mjs")
  const built = await build({
    entryPoints: { main: join(import.meta.dirname, "fixtures/egress-bundled.ts") },
    outdir: directory,
    bundle: true,
    splitting: true,
    format: "esm",
    outExtension: { ".js": ".mjs" },
    platform: "node",
    target: "esnext",
    external: [
      "effect",
      "effect/*",
      "@effect/platform-node",
      "@effect/platform-node/*",
      "@effect/platform-node-shared",
      "@effect/platform-node-shared/*"
    ],
    banner: { js: "import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url);" },
    metafile: true
  })
  // The regression requires the real CJS package in an ESM chunk, not Node's
  // synthetic named exports from an external import or a substituted namespace.
  expect(Object.keys(built.metafile!.inputs).some((file) => file.endsWith("undici/index.js"))).toBe(true)
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

const run = async (input: {
  readonly environment: Record<string, string>
  readonly urls: ReadonlyArray<string>
  readonly destination?: { readonly origin: string; readonly addresses: ReadonlyArray<string> }
  readonly headers?: Record<string, string>
  readonly timeoutMs?: number
}, beforeExit: () => Promise<void>) => {
  // A Bun invocation still runs the emitted program through the selected Node.
  const result = await new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    const child = execFile("node", [bundled, JSON.stringify(input)], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error !== null) reject(error)
      else resolve({ stdout, stderr })
    })
    let output = ""
    let checking = false
    child.stdout!.on("data", (chunk: string) => {
      output += chunk
      if (checking || !output.includes("\n")) return
      checking = true
      void (async () => {
        expect(child.exitCode).toBeNull()
        await beforeExit()
        expect(child.exitCode).toBeNull()
        child.stdin!.end("release\n")
      })().catch((error) => {
        child.kill("SIGKILL")
        reject(error)
      })
    })
  })
  expect(result.stderr).toBe("")
  return JSON.parse(result.stdout) as ReadonlyArray<{ outcome: string; status?: number; text?: string; tag?: string }>
}

const listener = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const requests: Array<{ path: string; headers: IncomingMessage["headers"] }> = []
  const tunnels: Array<{ authority: string; host: string | undefined }> = []
  const sockets = new Set<Duplex>()
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, headers: request.headers })
    handle(request, response)
  })
  const track = (socket: Duplex) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  server.on("connection", track)
  server.on("connect", (request, socket, head) => {
    tunnels.push({ authority: request.url!, host: request.headers.host })
    const target = new URL(`http://${request.url}`)
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    track(upstream)
    socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
    upstream.on("error", () => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    tunnels,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

const drained = async (sockets: Set<Duplex>) => {
  const deadline = Date.now() + 1000
  while (sockets.size > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(sockets.size).toBe(0)
}

describe("Node executes the bundled egress client", () => {
  it("acquires a dispatcher, receives a direct body and releases its keepalive socket at scope exit", async () => {
    const origin = await listener((_, response) => response.end("direct body"))
    try {
      expect(await run({ environment: {}, urls: [`${origin.url}/direct`] }, () => drained(origin.sockets))).toEqual([
        { outcome: "success", status: 200, text: "direct body" }
      ])
      expect(origin.requests.map((request) => request.path)).toEqual(["/direct"])
      await drained(origin.sockets)
    } finally {
      await origin.close()
    }
  })

  it("uses the environment proxy for an unresolvable host", async () => {
    const proxy = await listener((_, response) => response.end("proxy body"))
    try {
      expect(
        await run(
          { environment: { HTTP_PROXY: proxy.url }, urls: ["http://remote.invalid/ordinary"] },
          () => drained(proxy.sockets)
        )
      ).toEqual([
        { outcome: "success", status: 200, text: "proxy body" }
      ])
      expect(proxy.requests.map((request) => request.path)).toEqual(["http://remote.invalid/ordinary"])
      expect(proxy.tunnels).toEqual([])
      await drained(proxy.sockets)
    } finally {
      await proxy.close()
    }
  })

  it("uses a real Pool to tunnel to the pinned address, retains Host, strips transport headers and drains the body", async () => {
    const origin = await listener((_, response) => {
      response.write("first ")
      setTimeout(() => response.end("last"), 20)
    })
    const proxy = await listener((_, response) => response.writeHead(502).end())
    const authority = `127.0.0.1:${origin.port}`
    const named = `http://pinned.invalid:${origin.port}`
    try {
      expect(
        await run({
          environment: { HTTP_PROXY: proxy.url },
          urls: [`${named}/pinned`],
          destination: { origin: named, addresses: ["127.0.0.1"] },
          headers: { host: "wrong.invalid", "proxy-authorization": "caller-secret", "x-preserved": "yes" }
        }, async () => {
          await drained(origin.sockets)
          await drained(proxy.sockets)
        })
      ).toEqual([{ outcome: "success", status: 200, text: "first last" }])
      expect(proxy.tunnels).toEqual([{ authority, host: authority }])
      expect(proxy.requests).toEqual([])
      expect(origin.requests).toHaveLength(1)
      expect(origin.requests[0]!.path).toBe("/pinned")
      expect(origin.requests[0]!.headers.host).toBe(`pinned.invalid:${origin.port}`)
      expect(origin.requests[0]!.headers["proxy-authorization"]).toBeUndefined()
      expect(origin.requests[0]!.headers["x-preserved"]).toBe("yes")
      await drained(origin.sockets)
      await drained(proxy.sockets)
    } finally {
      await proxy.close()
      await origin.close()
    }
  })

  it("destroys a timed-out pinned tunnel and opens a fresh tunnel for recovery", async () => {
    const origin = await listener((request, response) => {
      if (request.url === "/ok") response.end("recovered")
    })
    const proxy = await listener((_, response) => response.writeHead(502).end())
    const named = `http://recover.invalid:${origin.port}`
    const authority = `127.0.0.1:${origin.port}`
    try {
      const outcomes = await run({
        environment: { HTTP_PROXY: proxy.url },
        urls: [`${named}/never`, `${named}/ok`],
        destination: { origin: named, addresses: ["127.0.0.1"] },
        timeoutMs: 250
      }, async () => {
        await drained(origin.sockets)
        await drained(proxy.sockets)
      })
      expect(outcomes[0]).toEqual({ outcome: "failure", tag: "TimeoutError" })
      expect(outcomes[1]).toEqual({ outcome: "success", status: 200, text: "recovered" })
      expect(origin.requests.map((request) => request.path)).toEqual(["/never", "/ok"])
      expect(proxy.tunnels).toEqual([{ authority, host: authority }, { authority, host: authority }])
      await drained(origin.sockets)
      await drained(proxy.sockets)
    } finally {
      await proxy.close()
      await origin.close()
    }
  })
})

import { afterEach, beforeEach, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// electrobun downloads Hutch with node:https. A Cloud guest reaches the network
// only through its egress proxy, so `electrobun prepare` must go through
// HTTPS_PROXY and fail closed when the proxy refuses (#3007).
const script = resolve(import.meta.dir, "ensure-devkit.mjs")
const electrobun = resolve(import.meta.dir, "..", "node_modules", "electrobun")
const PREPARE_TIMEOUT = 60_000
let root = ""
let app = ""

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ensure-devkit-"))
  app = join(root, "app")
  mkdirSync(join(app, "scripts"), { recursive: true })
  mkdirSync(join(app, "node_modules"))
  mkdirSync(join(root, "home"))
  copyFileSync(script, join(app, "scripts", "ensure-devkit.mjs"))
  symlinkSync(electrobun, join(app, "node_modules", "electrobun"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A proxy that records every CONNECT target and refuses it. */
const refusingProxy = async (): Promise<{ server: Server; port: number; targets: Array<string> }> => {
  const targets: Array<string> = []
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const [method = "", target = ""] = chunk.toString("latin1").split(" ", 2)
      targets.push(`${method} ${target}`)
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
    })
  })
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("proxy has no port")
  return { server, port: address.port, targets }
}

const prepare = async (proxy: string) => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    HUTCH_HOME: join(root, "hutch"),
    HTTPS_PROXY: proxy,
    https_proxy: proxy
  }
  const child = Bun.spawn(["node", join(app, "scripts", "ensure-devkit.mjs")], {
    cwd: app,
    env,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exitCode, stderr }
}

test("electrobun prepare fetches Hutch through HTTPS_PROXY", async () => {
  const proxy = await refusingProxy()
  try {
    const { exitCode, stderr } = await prepare(`http://127.0.0.1:${proxy.port}`)
    expect(exitCode).toBe(1)
    expect(stderr).toContain("ensure-devkit: electrobun prepare exited 1")
    expect(proxy.targets).toContain("CONNECT github.com:443")
    expect(proxy.targets.every((target) => target.startsWith("CONNECT "))).toBe(true)
    expect(existsSync(join(app, ".hutch", "devkit"))).toBe(false)
  } finally {
    proxy.server.close()
  }
}, PREPARE_TIMEOUT)

test("electrobun prepare fails closed when the proxy is unreachable", async () => {
  const proxy = await refusingProxy()
  const port = proxy.port
  await new Promise((closed) => proxy.server.close(closed))
  const { exitCode, stderr } = await prepare(`http://127.0.0.1:${port}`)
  expect(exitCode).toBe(1)
  expect(stderr).toContain("ECONNREFUSED")
  expect(stderr).toContain("ensure-devkit: electrobun prepare exited 1")
  expect(existsSync(join(app, ".hutch", "devkit"))).toBe(false)
}, PREPARE_TIMEOUT)

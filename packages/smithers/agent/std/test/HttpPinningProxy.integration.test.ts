import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { type AddressInfo, connect, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as tls from "node:tls"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import * as EgressHttpClient from "../../../flows/platform-node/src/EgressHttpClient.ts"
import * as Fetch from "../src/Fetch.ts"
import { ResolveHost } from "../src/internal/HttpNetwork.ts"

const servers: Array<Server> = []
const sockets = new Set<Socket>()
const listen = async (server: Server): Promise<number> => {
  servers.push(server)
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

const grants = (...origins: ReadonlyArray<string>) =>
  GrantStore.layer({
    attended: false,
    rules: [
      new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
      ...origins.map((origin) =>
        new Rule({
          effect: "allow",
          pattern: new CapabilityPattern({ action: "net:private", resource: origin })
        })
      )
    ]
  }).pipe(Layer.provide(Workspace.layer("/workspace")))

const run = (
  url: string,
  environment: Record<string, string>,
  addresses: ReadonlyArray<string>,
  allowed = false,
  headers?: Record<string, string>
) =>
  Fetch.run({ url, timeout: 2, ...(headers === undefined ? {} : { headers }) }).pipe(
    Effect.provideService(ResolveHost, () => Effect.succeed(addresses)),
    Effect.provide(EgressHttpClient.layer(environment)),
    Effect.provide(grants(...(allowed ? [new URL(url).origin] : [])))
  )

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

const proxy = async (tunnel: boolean) => {
  const seen: Array<string> = []
  const server = createServer((_request, response) => response.writeHead(500).end())
  server.on("connect", (request, socket, head) => {
    seen.push(request.url!)
    if (!tunnel) return socket.destroy()
    const target = new URL(`http://${request.url}`)
    const upstream = connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    sockets.add(upstream)
    upstream.on("close", () => sockets.delete(upstream))
    upstream.on("error", () => socket.destroy())
    socket.on("error", () => upstream.destroy())
    socket.on("close", () => upstream.destroy())
  })
  return { url: `http://127.0.0.1:${await listen(server)}`, seen }
}

describe("web pinning through the configured proxy", () => {
  it.each(["http", "https"])("%s CONNECT contains only the approved public IP", async (scheme) => {
    const gateway = await proxy(false)
    const result = await Effect.runPromise(Effect.exit(run(
      `${scheme}://rebound.invalid:8443/resource`,
      { HTTP_PROXY: gateway.url, HTTPS_PROXY: gateway.url },
      ["93.184.216.34"]
    )))
    expect(Exit.isFailure(result)).toBe(true)
    expect(gateway.seen).toEqual(["93.184.216.34:8443"])
  })

  it.each(["socks", "socks5"])("refuses %s proxy routing before connecting", async (scheme) => {
    const gateway = await proxy(false)
    const result = await Effect.runPromise(Effect.exit(run(
      "http://rebound.invalid/resource",
      { HTTP_PROXY: gateway.url.replace("http:", `${scheme}:`) },
      ["93.184.216.34"]
    )))
    expect(failureOf(result)).toMatchObject({ code: "request_failed" })
    expect(gateway.seen).toEqual([])
  })

  it("carries an explicitly granted HTTP destination through an IP tunnel with its original Host", async () => {
    const hosts: Array<string | undefined> = []
    const port = await listen(createServer((request, response) => {
      hosts.push(request.headers.host)
      response.end("pinned")
    }))
    const gateway = await proxy(true)
    const result = await Effect.runPromise(run(
      `http://private.invalid:${port}/resource`,
      { HTTP_PROXY: gateway.url },
      ["127.0.0.1"],
      true
    ))
    expect(result.body).toBe("pinned")
    expect(gateway.seen).toEqual([`127.0.0.1:${port}`])
    expect(hosts).toEqual([`private.invalid:${port}`])
  })

  it("selects NO_PROXY by the original hostname", async () => {
    const port = await listen(createServer((_request, response) => response.end("direct")))
    const gateway = await proxy(false)
    const result = await Effect.runPromise(run(
      `http://private.invalid:${port}/resource`,
      { HTTP_PROXY: gateway.url, NO_PROXY: "private.invalid" },
      ["127.0.0.1"],
      true
    ))
    expect(result.body).toBe("direct")
    expect(gateway.seen).toEqual([])
  })

  it("fails closed on an unsupported fetch transport before it reaches a granted private server", async () => {
    let hits = 0
    const port = await listen(createServer((_request, response) => {
      hits++
      response.end("unsafe")
    }))
    const origin = `http://127.0.0.1:${port}`
    const exit = await Effect.runPromise(Effect.exit(
      Fetch.run({ url: origin }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(grants(origin))
      )
    ))
    expect(failureOf(exit)).toMatchObject({ code: "unsupported" })
    expect(hits).toBe(0)
  })

  it("keeps ordinary local model HTTP requests working without a web destination", async () => {
    const port = await listen(createServer((_request, response) => response.end("model")))
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* KernelHttpClient.HttpClient
        return yield* (yield* client.get(`http://127.0.0.1:${port}`)).text
      }).pipe(Effect.provide(EgressHttpClient.layer({})))
    )
    expect(result).toBe("model")
  })
})

// Trust only this local test CA in the isolated worker, preserving verification.
// Bun's TLS API is exercised by running this same suite with bun --bun vitest.
describe("pinned HTTPS identity", () => {
  let directory: string
  let key: Buffer
  let cert: Buffer
  let trusted: ReadonlyArray<string>
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "smithers-pin-tls-"))
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=private.invalid",
      "-addext",
      "subjectAltName=DNS:private.invalid",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem")
    ], { stdio: "ignore" })
    key = readFileSync(join(directory, "key.pem"))
    cert = readFileSync(join(directory, "cert.pem"))
    trusted = tls.getCACertificates()
    tls.setDefaultCACertificates([...trusted, cert.toString()])
  })
  afterAll(() => {
    if (trusted !== undefined) tls.setDefaultCACertificates(trusted)
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  })

  it.each([false, true])("verifies hostname and preserves Host/SNI (proxy=%s)", async (proxied) => {
    const hosts: Array<string | undefined> = []
    const names: Array<string | false | null> = []
    const server = createHttpsServer({ key, cert }, (request, response) => {
      hosts.push(request.headers.host)
      names.push((request.socket as tls.TLSSocket).servername)
      response.end("secure")
    })
    const port = await listen(server)
    const gateway = await proxy(true)
    const environment = proxied ? { HTTPS_PROXY: gateway.url } : {}
    const result = await Effect.runPromise(run(
      `https://private.invalid:${port}/`,
      environment,
      ["127.0.0.1"],
      true,
      { host: "wrong.invalid" }
    ))
    expect(result.body).toBe("secure")
    expect(hosts).toEqual([`private.invalid:${port}`])
    expect(names).toEqual(["private.invalid"])
    expect(gateway.seen).toEqual(proxied ? [`127.0.0.1:${port}`] : [])
    const refused = await Effect.runPromise(Effect.exit(run(
      `https://wrong.invalid:${port}/`,
      environment,
      ["127.0.0.1"],
      true,
      { host: "private.invalid" }
    )))
    expect(failureOf(refused)).toMatchObject({ code: "request_failed" })
    expect(hosts).toHaveLength(1)
  })
})

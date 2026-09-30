/**
 * The client a Node process should use reaches an origin the way its
 * environment says to, and the evidence is what the proxy was asked for.
 *
 * "The request failed" proves nothing here: a request that bypasses the proxy
 * and dies at a default-deny firewall fails too, and that is exactly the defect
 * this constructor exists to close (a judge inside a microsandbox dialling
 * `ai-gateway.vercel.sh` directly, every completion coming back unjudged). So
 * each case asserts what the proxy saw, and the unproxied case asserts the
 * origin itself was reached with the proxy left untouched.
 *
 * Nothing here leaves the loopback interface.
 */
import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import { Destination } from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect } from "effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { connect, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import * as EgressHttpClient from "../src/EgressHttpClient.ts"

interface Listener {
  readonly url: string
  readonly host: string
  readonly port: number
  /** Every request line and tunnel this listener was asked for, in order. */
  readonly seen: ReadonlyArray<string>
  readonly connections: ReadonlyArray<Promise<void>>
  readonly close: () => Promise<void>
}

/** A loopback HTTP listener that records what it was asked for.
 *
 * It answers plain requests with `handle`, and records a `CONNECT` without
 * carrying it: an `https` origin behind an `http` proxy is a tunnel, so being
 * asked to open one is the whole evidence that the proxy was consulted.
 * `address` is the loopback name to bind, `127.0.0.1` unless a case needs the
 * IPv6 one. */
const listen = async (
  handle: (request: IncomingMessage, response: ServerResponse) => void = (_, response) => response.writeHead(204).end(),
  address: "127.0.0.1" | "::1" = "127.0.0.1"
): Promise<Listener> => {
  const seen: Array<string> = []
  const sockets = new Set<Duplex>()
  const connections: Array<Promise<void>> = []
  const server: Server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    handle(request, response)
  })
  server.on("connect", (request, socket) => {
    seen.push(`CONNECT ${request.url}`)
    socket.destroy()
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    connections.push(new Promise<void>((resolve) => socket.once("close", () => resolve())))
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, address, resolve))
  const { port } = server.address() as AddressInfo
  const host = address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`
  return {
    url: `http://${host}`,
    host,
    port,
    seen,
    connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

/** One request through the client the supplied environment selects. */
const reach = (environment: Readonly<Record<string, string | undefined>>, url: string) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url))).pipe(
      Effect.provide(EgressHttpClient.layer(environment))
    )
  )

describe("the outbound client a Node process should use", () => {
  it("opens the tunnel through the proxy the lowercase variables name", async () => {
    const proxy = await listen()
    try {
      const answered = await reach(
        { http_proxy: proxy.url, https_proxy: proxy.url, no_proxy: "" },
        "https://origin.invalid/judge"
      )
      expect([...proxy.seen]).toEqual(["CONNECT origin.invalid:443"])
      // The tunnel is refused on purpose; reaching the proxy is the assertion.
      expect(answered._tag).toBe("Failure")
    } finally {
      await proxy.close()
    }
  })

  it("opens the tunnel through the proxy the uppercase variables name", async () => {
    const proxy = await listen()
    try {
      // What a microsandbox guest holds: HTTP_PROXY/HTTPS_PROXY/NO_PROXY only.
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "" },
        "https://origin.invalid/judge"
      )
      expect([...proxy.seen]).toEqual(["CONNECT origin.invalid:443"])
      expect(answered._tag).toBe("Failure")
    } finally {
      await proxy.close()
    }
  })

  it("carries an excluded origin itself when NO_PROXY names it", async () => {
    const proxy = await listen()
    const origin = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "127.0.0.1" },
        `${origin.url}/direct`
      )
      expect([...origin.seen]).toEqual(["GET /direct"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("carries loopback itself although the environment names a proxy and no exclusion", async () => {
    // Undici proxies every origin when NO_PROXY is empty, loopback included.
    // That is the configuration a corporate laptop or a local Charles/mitmproxy
    // leaves behind, and `smthrs --remote http://127.0.0.1:3000` has to reach
    // the server this machine is running, not the proxy on the way out of it.
    const proxy = await listen()
    const origin = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
        `${origin.url}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("carries `localhost` itself too, and still proxies the origin an exclusion does not name", async () => {
    const proxy = await listen()
    const origin = await listen()
    try {
      const local = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "origin.invalid" },
        `http://localhost:${origin.port}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(local._tag).toBe("Success")
      // The same agent still sends everything else out through the proxy: the
      // loopback exemption adds to the environment's exclusions, never replaces
      // them, and never turns the proxy off.
      const remote = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "origin.invalid" },
        "https://gateway.invalid/judge"
      )
      expect([...proxy.seen]).toEqual(["CONNECT gateway.invalid:443"])
      expect(remote._tag).toBe("Failure")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("carries `[::1]` itself, the third loopback name", async () => {
    const proxy = await listen()
    const origin = await listen(undefined, "::1")
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
        `${origin.url}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("exempts the three names only: another loopback address goes through the proxy", async () => {
    // The exemption is by name, the way Undici matches every NO_PROXY entry,
    // never by what the address is. `127.0.0.2` is loopback on the wire and
    // still an origin like any other here, so the proxy is asked to carry it.
    const proxy = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url },
        "http://127.0.0.2:1/rpc"
      )
      expect([...proxy.seen]).toEqual(["GET http://127.0.0.2:1/rpc"])
      expect(answered._tag).toBe("Success")
    } finally {
      await proxy.close()
    }
  })

  it("leaves a wildcard exclusion alone, which already names every origin", async () => {
    const proxy = await listen()
    const origin = await listen()
    try {
      const answered = await reach(
        { HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "*" },
        `${origin.url}/rpc`
      )
      expect([...origin.seen]).toEqual(["GET /rpc"])
      expect([...proxy.seen]).toEqual([])
      expect(answered._tag).toBe("Success")
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("is the plain Undici pool when the environment names no proxy", async () => {
    const origin = await listen()
    try {
      const answered = await reach({}, `${origin.url}/direct`)
      expect([...origin.seen]).toEqual(["GET /direct"])
      expect(answered._tag).toBe("Success")
      if (answered._tag !== "Success") throw new Error("expected the direct request to answer")
      expect(answered.success.status).toBe(204)
    } finally {
      await origin.close()
    }
  })
})

const pinnedReach = (
  environment: Readonly<Record<string, string | undefined>>,
  url: string,
  destination: { readonly origin: string; readonly addresses: ReadonlyArray<string> },
  headers: Record<string, string> = {},
  timeout: "5 seconds" | "100 millis" = "5 seconds"
) =>
  Effect.runPromise(
    Effect.result(Effect.flatMap(HttpClient.HttpClient, (client) =>
      client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
        Effect.timeout(timeout)
      ))).pipe(
        Effect.provideService(Destination, destination),
        Effect.provide(EgressHttpClient.layer(environment))
      )
  )

const closesPromptly = async (closed: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pinned connection did not close within one second")), 1000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("authorized destination connections", () => {
  it("refuses mismatched origins, empty snapshots, and non-IP addresses before connecting", async () => {
    const origin = await listen()
    try {
      for (
        const destination of [
          { origin: "http://other.invalid", addresses: ["127.0.0.1"] },
          { origin: origin.url, addresses: [] },
          { origin: origin.url, addresses: ["localhost"] }
        ]
      ) {
        const result = await pinnedReach({}, origin.url, destination)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "HttpClientError",
            reason: { _tag: "TransportError", description: "Invalid pinned HTTP destination" }
          })
        }
      }
      expect(origin.seen).toEqual([])
    } finally {
      await origin.close()
    }
  })

  it("refuses SOCKS proxies even when loopback would bypass them", async () => {
    const origin = await listen()
    try {
      for (
        const environment of [
          { http_proxy: "socks5://127.0.0.1:1" },
          { HTTPS_PROXY: "socks://127.0.0.1:1" }
        ]
      ) {
        const result = await pinnedReach(environment, origin.url, {
          origin: origin.url,
          addresses: ["127.0.0.1"]
        })
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            _tag: "HttpClientError",
            reason: { _tag: "TransportError", description: "Pinned HTTP requests require HTTP or HTTPS proxies" }
          })
        }
      }
      expect(origin.seen).toEqual([])
    } finally {
      await origin.close()
    }
  })

  it("refuses a pinned request once the live environment names an unparsable proxy", async () => {
    // NodeHost hands this client `process.env`, which the process may change
    // after the shared pool was built from it. The pinned route reads the
    // record per request, so a proxy that no longer parses is a typed refusal.
    const proxy = await listen()
    const origin = await listen()
    try {
      const environment: Record<string, string | undefined> = { HTTP_PROXY: proxy.url }
      const result = await Effect.runPromise(
        Effect.result(Effect.flatMap(HttpClient.HttpClient, (client) => {
          environment.HTTP_PROXY = "http://[unterminated"
          return client.get(`${origin.url}/pinned`)
        })).pipe(
          Effect.provideService(Destination, { origin: origin.url, addresses: ["127.0.0.1"] }),
          Effect.provide(EgressHttpClient.layer(environment))
        )
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure).toMatchObject({
          _tag: "HttpClientError",
          reason: { _tag: "TransportError", description: "Pinned HTTP requests require HTTP or HTTPS proxies" }
        })
      }
      expect(origin.seen).toEqual([])
      expect(proxy.seen).toEqual([])
    } finally {
      await origin.close()
      await proxy.close()
    }
  })

  it("answers a requested address family from the approved snapshot, and refuses one it lacks", async () => {
    // Node asks the lookup for one family when the connect options name one.
    // This client's options name none, so the case adds `family` to the pinned
    // agent's connect options: the answer is still an approved address, and a
    // family the snapshot lacks is refused rather than widened.
    const undici = (await import("undici/index.js")).default
    const Original = undici.EnvHttpProxyAgent
    let family: 4 | 6 = 4
    undici.EnvHttpProxyAgent = class extends Original {
      constructor(options: ConstructorParameters<typeof Original>[0]) {
        const connect = options?.connect
        super(
          connect === undefined || typeof connect === "function"
            ? options
            : { ...options, connect: { ...connect, family } as typeof connect }
        )
      }
    }
    const origin = await listen((_, response) => response.end("v4"))
    try {
      const url = `http://families.invalid:${origin.port}`
      // The first approved address is IPv6, where nothing listens.
      const chosen = await pinnedReach({}, `${url}/v4`, { origin: url, addresses: ["::1", "127.0.0.1"] })
      expect(chosen._tag).toBe("Success")
      if (chosen._tag === "Success") expect(await Effect.runPromise(chosen.success.text)).toBe("v4")
      family = 6
      const refused = await pinnedReach({}, `${url}/v6`, { origin: url, addresses: ["127.0.0.1"] })
      expect(refused._tag).toBe("Failure")
      if (refused._tag === "Failure") {
        expect(refused.failure).toMatchObject({
          _tag: "HttpClientError",
          reason: {
            _tag: "TransportError",
            cause: {
              _tag: "@smthrs/platform-node/EgressAddressError",
              code: "no_approved_address",
              message: "No approved address for family"
            }
          }
        })
      }
      expect(origin.seen).toEqual(["GET /v4"])
    } finally {
      undici.EnvHttpProxyAgent = Original
      await origin.close()
    }
  })

  it("uses the approved IP for an unresolvable hostname and strips caller transport headers", async () => {
    let received: IncomingMessage["headers"] = {}
    const origin = await listen((request, response) => {
      received = request.headers
      response.end("approved")
    })
    try {
      const url = `http://unresolvable.invalid:${origin.port}`
      const result = await pinnedReach({}, `${url}/pinned`, { origin: url, addresses: ["127.0.0.1"] }, {
        host: "attacker.invalid",
        "proxy-authorization": "secret",
        connection: "close",
        "transfer-encoding": "chunked",
        "content-length": "999",
        "x-preserved": "yes"
      })
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") expect(await Effect.runPromise(result.success.text)).toBe("approved")
      expect(origin.seen).toEqual(["GET /pinned"])
      expect(received.host).toBe(`unresolvable.invalid:${origin.port}`)
      expect(received["proxy-authorization"]).toBeUndefined()
      expect(received.connection).not.toBe("close")
      expect(received["transfer-encoding"]).toBeUndefined()
      expect(received["content-length"]).toBeUndefined()
      expect(received["x-preserved"]).toBe("yes")
    } finally {
      await origin.close()
    }
  })

  it("falls back across approved address families on a direct connection", async () => {
    const origin = await listen((_, response) => response.end("fallback"))
    const previous = getDefaultAutoSelectFamily()
    try {
      setDefaultAutoSelectFamily(true)
      const url = `http://multiple-addresses.invalid:${origin.port}`
      const result = await pinnedReach({}, url, { origin: url, addresses: ["::1", "127.0.0.1"] })
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") expect(await Effect.runPromise(result.success.text)).toBe("fallback")
      expect(origin.seen).toEqual(["GET /"])
    } finally {
      setDefaultAutoSelectFamily(previous)
      await origin.close()
    }
  })

  it("allows the body to drain before closing the pinned connection", async () => {
    let finish: (() => void) | undefined
    const origin = await listen((_, response) => {
      response.writeHead(200)
      response.write("first ")
      finish = () => response.end("last")
    })
    try {
      const url = `http://stream.invalid:${origin.port}`
      const result = await pinnedReach({}, url, { origin: url, addresses: ["127.0.0.1"] })
      expect(result._tag).toBe("Success")
      if (result._tag !== "Success") throw new Error("expected streaming response")
      expect(origin.connections).toHaveLength(1)
      finish!()
      expect(await Effect.runPromise(result.success.text)).toBe("first last")
      await closesPromptly(origin.connections[0]!)
      expect(origin.seen).toEqual(["GET /"])
    } finally {
      await origin.close()
    }
  })

  it("pins a connection when Node uses a single-address lookup", async () => {
    const origin = await listen()
    const previous = getDefaultAutoSelectFamily()
    try {
      setDefaultAutoSelectFamily(false)
      const url = `http://single-address.invalid:${origin.port}`
      const result = await pinnedReach({}, `${url}/single`, { origin: url, addresses: ["127.0.0.1"] })
      expect(result._tag).toBe("Success")
      expect(origin.seen).toEqual(["GET /single"])
    } finally {
      setDefaultAutoSelectFamily(previous)
      await origin.close()
    }
  })

  it("uses IP authorities and default ports for refused HTTP and HTTPS tunnels", async () => {
    const proxy = await listen()
    try {
      for (
        const [url, address, authority] of [
          ["http://remote.invalid", "127.0.0.1", "127.0.0.1:80"],
          ["https://remote.invalid", "::1", "[::1]:443"]
        ] as const
      ) {
        const result = await pinnedReach({ http_proxy: proxy.url, https_proxy: proxy.url }, url, {
          origin: url,
          addresses: [address]
        })
        expect(result._tag).toBe("Failure")
        expect(proxy.seen.at(-1)).toBe(`CONNECT ${authority}`)
      }
      expect(proxy.seen).toHaveLength(2)
    } finally {
      await proxy.close()
    }
  })

  it.each([{ addresses: ["127.0.0.1"] }, { addresses: ["::1", "127.0.0.1"] }])(
    "selects the proxy by hostname and tunnels to the first approved IP in $addresses",
    async ({ addresses }) => {
      const origin = await listen((_, response) => response.end("tunnel body"), addresses[0]! as "127.0.0.1" | "::1")
      const seen: Array<string> = []
      const sockets = new Set<Duplex>()
      const proxy = createServer()
      proxy.on("connection", (socket) => {
        sockets.add(socket)
        socket.on("close", () => sockets.delete(socket))
      })
      proxy.on("connect", (request, socket, head) => {
        seen.push(`${request.url} ${request.headers.host}`)
        const target = new URL(`http://${request.url}`)
        const upstream = connect(Number(target.port), target.hostname.replace(/^\[|\]$/g, ""), () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
          upstream.write(head)
          socket.pipe(upstream).pipe(socket)
        })
        socket.on("error", () => upstream.destroy())
        socket.on("close", () => upstream.destroy())
        upstream.on("error", () => socket.destroy())
      })
      await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
      try {
        const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
        const url = `http://remote.invalid:${origin.port}`
        const result = await pinnedReach({ HTTP_PROXY: proxyUrl }, `${url}/through`, {
          origin: url,
          addresses
        })
        expect(result._tag).toBe("Success")
        if (result._tag === "Success") expect(await Effect.runPromise(result.success.text)).toBe("tunnel body")
        expect(seen).toEqual([`${origin.host} ${origin.host}`])
        expect(origin.seen).toEqual(["GET /through"])
      } finally {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
        await origin.close()
      }
    }
  )

  it("destroys a failed pinned connection and permits a later request", async () => {
    const origin = await listen((request, response) => {
      if (request.url !== "/fail") response.end("recovered")
    })
    try {
      const url = `http://recovery.invalid:${origin.port}`
      const destination = { origin: url, addresses: ["127.0.0.1"] }
      expect((await pinnedReach({}, `${url}/fail`, destination, {}, "100 millis"))._tag).toBe("Failure")
      expect(origin.seen).toEqual(["GET /fail"])
      expect(origin.connections).toHaveLength(1)
      await closesPromptly(origin.connections[0]!)
      const result = await pinnedReach({}, `${url}/ok`, destination)
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") expect(await Effect.runPromise(result.success.text)).toBe("recovered")
      expect(origin.seen).toEqual(["GET /fail", "GET /ok"])
    } finally {
      await origin.close()
    }
  })
})

describe("pinned agent ownership under interruption", () => {
  it("destroys a pinned agent interrupted after construction and before its request", async () => {
    const undici = (await import("undici/index.js")).default
    const Original = undici.EnvHttpProxyAgent
    const origin = await listen()
    const agents: Array<InstanceType<typeof Original>> = []
    let fiber: Fiber.Fiber<unknown, unknown> | undefined
    // The shared pool is the first agent; the second is the request's pinned one.
    undici.EnvHttpProxyAgent = class extends Original {
      constructor(options: ConstructorParameters<typeof Original>[0]) {
        super(options)
        agents.push(this)
        if (agents.length === 2) fiber!.interruptUnsafe()
      }
    }
    try {
      const url = `http://interrupted.invalid:${origin.port}`
      fiber = Effect.runFork(
        Effect.flatMap(HttpClient.HttpClient, (client) => client.get(url)).pipe(
          Effect.provideService(Destination, { origin: url, addresses: ["127.0.0.1"] }),
          Effect.provide(EgressHttpClient.layer({}))
        )
      )
      const exit = await Effect.runPromise(Fiber.await(fiber))
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(agents).toHaveLength(2)
      // Undici exposes `destroyed` at runtime but omits it from its declarations.
      expect(agents.map((agent) => (agent as unknown as { readonly destroyed: boolean }).destroyed)).toEqual([
        true,
        true
      ])
      expect(origin.seen).toEqual([])
    } finally {
      undici.EnvHttpProxyAgent = Original
      await origin.close()
    }
  })
})

describe("pinned agent release after a response", () => {
  it("destroys a pinned agent whose close fails, closing its connection", async () => {
    // Undici's close rejects only an agent that is already destroyed, which
    // nothing does before a successful exit. If one fails anyway, the agent is
    // destroyed rather than left holding its connection, and the rejection is
    // handled rather than escaping as an unhandled one.
    const undici = (await import("undici/index.js")).default
    const Original = undici.EnvHttpProxyAgent
    const agents: Array<InstanceType<typeof Original>> = []
    undici.EnvHttpProxyAgent = class extends Original {
      constructor(options: ConstructorParameters<typeof Original>[0]) {
        super(options)
        agents.push(this)
      }
      override close(_callback?: () => void): Promise<void> {
        return Promise.reject(new Error("close refused"))
      }
    }
    const origin = await listen()
    try {
      const url = `http://close-refused.invalid:${origin.port}`
      const result = await pinnedReach({}, url, { origin: url, addresses: ["127.0.0.1"] })
      expect(result._tag).toBe("Success")
      if (result._tag === "Success") expect(result.success.status).toBe(204)
      expect(origin.connections).toHaveLength(1)
      await closesPromptly(origin.connections[0]!)
      // The shared pool is the first agent; the second is the request's pinned one.
      expect(agents).toHaveLength(2)
      expect((agents[1] as unknown as { readonly destroyed: boolean }).destroyed).toBe(true)
      expect(origin.seen).toEqual(["GET /"])
    } finally {
      undici.EnvHttpProxyAgent = Original
      await origin.close()
    }
  })
})

describe("replaceable transports", () => {
  it("replaces the pool and makes the previous client unusable", async () => {
    const origin = await listen()
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const transport = yield* EgressHttpClient.rebuildableTransport(EgressHttpClient.dispatcher({}))
        expect((yield* transport.client.get(origin.url)).status).toBe(204)
        const replacement = yield* transport.rebuild
        expect(replacement).not.toBe(transport.client)
        expect((yield* Effect.result(transport.client.get(origin.url)))._tag).toBe("Failure")
        expect((yield* replacement.get(origin.url)).status).toBe(204)
      })))
      expect(origin.seen).toEqual(["GET /", "GET /"])
    } finally {
      await origin.close()
    }
  })

  it("keeps the working client when replacement decoration fails and releases the failed pool", async () => {
    const origin = await listen()
    let acquired = 0
    const released: Array<number> = []
    const acquire = Effect.gen(function*() {
      const id = ++acquired
      const pool = yield* EgressHttpClient.dispatcher({})
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          released.push(id)
        })
      )
      return pool
    })
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const transport = yield* EgressHttpClient.rebuildableTransport(
          acquire,
          (client) => acquired === 2 ? Effect.die("replacement middleware unavailable") : Effect.succeed(client)
        )
        expect((yield* transport.client.get(origin.url)).status).toBe(204)
        expect((yield* Effect.exit(transport.rebuild))._tag).toBe("Failure")
        expect(released).toEqual([2])
        expect((yield* transport.client.get(origin.url)).status).toBe(204)
        const replacement = yield* transport.rebuild
        expect(released).toEqual([2, 1])
        expect((yield* replacement.get(origin.url)).status).toBe(204)
      })))
      expect(released).toEqual([2, 1, 3])
      expect(origin.seen).toEqual(["GET /", "GET /", "GET /"])
    } finally {
      await origin.close()
    }
  })

  it("retains the grant store and proxy policy after rebuilding", async () => {
    const proxy = await listen()
    try {
      await Effect.runPromise(
        Effect.scoped(Effect.gen(function*() {
          const grants = yield* GrantStore.make({
            attended: false,
            rules: [
              new Rule({
                effect: "allow",
                pattern: new CapabilityPattern({ action: "net:get", resource: "http://model.invalid" })
              })
            ]
          }).pipe(Effect.provide(Workspace.layerNoop))
          const transport = yield* EgressHttpClient.guardedTransport({ HTTP_PROXY: proxy.url }).pipe(
            Effect.provideService(GrantStore.GrantStore, grants)
          )
          for (const iteration of [0, 1]) {
            const client = iteration === 0 ? transport.client : yield* transport.rebuild
            const denied = yield* Effect.result(client.get("http://unapproved.invalid/deny"))
            expect(denied._tag).toBe("Failure")
            if (denied._tag === "Failure") {
              expect(denied.failure.reason._tag).toBe("TransportError")
              expect(denied.failure.reason.cause).toMatchObject({
                code: "permission_required",
                capability: { action: "net:get", resource: "http://unapproved.invalid" }
              })
            }
            expect((yield* client.get("http://model.invalid/allowed")).status).toBe(204)
          }
        })).pipe(Effect.provideService(GrantStore.GrantStore, GrantStore.makeNoop))
      )
      expect(proxy.seen).toEqual(["GET http://model.invalid/allowed", "GET http://model.invalid/allowed"])
    } finally {
      await proxy.close()
    }
  })
})

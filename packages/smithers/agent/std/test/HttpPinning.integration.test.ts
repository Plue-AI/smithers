import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import dns from "node:dns"
import { createServer, type RequestListener, type Server } from "node:http"
import { syncBuiltinESMExports } from "node:module"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as EgressHttpClient from "../../../flows/platform-node/src/EgressHttpClient.ts"
import * as Fetch from "../src/Fetch.ts"
import { ResolveHost } from "../src/internal/HttpNetwork.ts"

const servers: Array<Server> = []

const listen = async (handler: RequestListener): Promise<number> => {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return (server.address() as AddressInfo).port
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      })
    )
  )
})

const grants = (...privateOrigins: ReadonlyArray<string>) =>
  GrantStore.layer({
    attended: false,
    rules: [
      new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:get", resource: "*" }) }),
      ...privateOrigins.map((origin) =>
        new Rule({ effect: "allow", pattern: new CapabilityPattern({ action: "net:private", resource: origin }) })
      )
    ]
  }).pipe(Layer.provide(Workspace.layer("/workspace")))

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined

/** Give the transport a deterministic second DNS answer without changing the preflight resolver. */
const withLoopbackDns = async <A>(run: () => Promise<A>): Promise<A> => {
  const original = dns.lookup
  dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
    if (!hostname.endsWith(".pinning.invalid")) {
      return (original as (...args: Array<unknown>) => unknown)(hostname, options, callback)
    }
    const complete = typeof options === "function" ? options : callback
    if (typeof complete !== "function") throw new Error("expected a DNS callback")
    queueMicrotask(() => {
      if (typeof options === "object" && options !== null && "all" in options && options.all === true) {
        complete(null, [{ address: "127.0.0.1", family: 4 }])
      } else {
        complete(null, "127.0.0.1", 4)
      }
    })
  }) as typeof dns.lookup
  syncBuiltinESMExports()
  try {
    return await run()
  } finally {
    dns.lookup = original
    syncBuiltinESMExports()
  }
}

const run = (
  url: string,
  resolve: (hostname: string) => Effect.Effect<ReadonlyArray<string>>,
  privateOrigins: ReadonlyArray<string> = []
) =>
  Fetch.run({ url, timeout: 1 }).pipe(
    Effect.provideService(ResolveHost, resolve),
    Effect.provide(EgressHttpClient.layer({})),
    Effect.provide(grants(...privateOrigins))
  )

describe("Fetch.run destination pinning with real sockets", () => {
  it("does not dial loopback when preflight authorized a public DNS answer", async () => {
    let hits = 0
    const port = await listen((_request, response) => {
      hits++
      response.writeHead(200).end("rebound")
    })
    const url = `http://public.pinning.invalid:${port}/rebound`
    await withLoopbackDns(async () => {
      // Show that an ordinary second DNS lookup reaches this listener.
      const unpinned = NodeHttpClient.layerUndiciNoDispatcher.pipe(Layer.provide(
        Layer.effect(NodeHttpClient.Dispatcher, EgressHttpClient.dispatcher({}))
      ))
      const ordinary = await Effect.runPromise(
        Fetch.run({ url }).pipe(
          Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"])),
          Effect.updateService(KernelHttpClient.HttpClient, KernelHttpClient.withDestinationPinning),
          Effect.provide(unpinned),
          Effect.provide(grants())
        )
      )
      expect(ordinary.body).toBe("rebound")
      expect(hits).toBe(1)

      const exit = await Effect.runPromise(Effect.exit(
        run(url, () => Effect.succeed(["93.184.216.34"]))
      ))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(hits).toBe(1)
    })
  })

  it("reaches a private DNS answer only with an origin grant and preserves the hostname Host", async () => {
    const hosts: Array<string | undefined> = []
    const port = await listen((request, response) => {
      hosts.push(request.headers.host)
      response.writeHead(200).end("private ok")
    })
    const origin = `http://private.pinning.invalid:${port}`
    await withLoopbackDns(async () => {
      const denied = await Effect.runPromise(Effect.exit(run(`${origin}/data`, () => Effect.succeed(["127.0.0.1"]))))
      expect(failureOf(denied)).toMatchObject({ code: "permission_denied" })
      expect(hosts).toEqual([])
      const allowed = await Effect.runPromise(run(`${origin}/data`, () => Effect.succeed(["127.0.0.1"]), [origin]))
      expect(allowed.body).toBe("private ok")
      expect(hosts).toEqual([`private.pinning.invalid:${port}`])
    })
  })

  it("revalidates a redirect before opening the second socket", async () => {
    let targetHits = 0
    const targetPort = await listen((_request, response) => {
      targetHits++
      response.writeHead(200).end("secret")
    })
    const target = `http://target.pinning.invalid:${targetPort}`
    let startHits = 0
    const startPort = await listen((_request, response) => {
      startHits++
      response.writeHead(302, { location: `${target}/secret` }).end()
    })
    const start = `http://start.pinning.invalid:${startPort}`
    const exit = await withLoopbackDns(() =>
      Effect.runPromise(Effect.exit(run(
        `${start}/begin`,
        () => Effect.succeed(["127.0.0.1"]),
        [start]
      )))
    )
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied" })
    expect(startHits).toBe(1)
    expect(targetHits).toBe(0)
  })

  it("checks a retry with a fresh DNS answer and no stale private authorization", async () => {
    let hits = 0
    const port = await listen((_request, response) => {
      hits++
      response.writeHead(200).end("unexpected")
    })
    const url = `http://retry.pinning.invalid:${port}/data`
    let resolutions = 0
    const resolve = () => Effect.sync(() => ++resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"])
    const exit = await withLoopbackDns(() =>
      Effect.runPromise(Effect.exit(
        Effect.flatMap(Effect.exit(run(url, resolve)), () => run(url, resolve))
      ))
    )
    expect(resolutions).toBe(2)
    expect(failureOf(exit)).toMatchObject({ code: "permission_denied" })
    expect(hits).toBe(0)
  })

  it("does not reuse an earlier private connection for a new public snapshot", async () => {
    let hits = 0
    const port = await listen((_request, response) => {
      hits++
      response.end("private")
    })
    const origin = `http://pooled.pinning.invalid:${port}`
    await withLoopbackDns(() =>
      Effect.runPromise(
        Effect.gen(function*() {
          const first = yield* Fetch.run({ url: origin }).pipe(
            Effect.provideService(ResolveHost, () => Effect.succeed(["127.0.0.1"]))
          )
          expect(first.body).toBe("private")
          const second = yield* Effect.exit(
            Fetch.run({ url: origin, timeout: 0.1 }).pipe(
              Effect.provideService(ResolveHost, () => Effect.succeed(["93.184.216.34"]))
            )
          )
          expect(Exit.isFailure(second)).toBe(true)
        }).pipe(Effect.provide(EgressHttpClient.layer({})), Effect.provide(grants(origin)))
      )
    )
    expect(hits).toBe(1)
  })

  it.each([false, true])(
    "interrupts an authorized request and closes its socket (body started=%s)",
    async (bodyStarted) => {
      let peerClosed = false
      let markStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const port = await listen((request, response) => {
        if (bodyStarted) response.write("partial")
        request.socket.once("close", () => {
          peerClosed = true
        })
        markStarted?.()
      })
      const origin = `http://cancel.pinning.invalid:${port}`
      const exit = await withLoopbackDns(() =>
        Effect.runPromise(Effect.gen(function*() {
          const fiber = yield* run(`${origin}/wait`, () => Effect.succeed(["127.0.0.1"]), [origin]).pipe(
            Effect.forkChild
          )
          yield* Effect.promise(() => started)
          yield* Fiber.interrupt(fiber)
          return yield* Fiber.await(fiber)
        }))
      )
      expect(Exit.isFailure(exit)).toBe(true)
      await vi.waitFor(() => expect(peerClosed).toBe(true))
    }
  )
})

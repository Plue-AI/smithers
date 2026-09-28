import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { PermissionRequired, Rule } from "@smthrs/capability/Permission"
import { Effect, Layer, Option } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as EffectHttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import { Buffer } from "node:buffer"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import * as GrantStore from "../src/GrantStore.ts"
import * as HttpClient from "../src/HttpClient.ts"
import * as Workspace from "../src/Workspace.ts"

interface RunningServer {
  readonly host: string
  readonly url: string
}

interface Hit {
  readonly body: string
  readonly method: string
  readonly url: string
}

const servers = new Set<Server>()

const listen = async (
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void
): Promise<RunningServer> => {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once("error", onError)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not expose a TCP address")
  }
  const host = `127.0.0.1:${address.port}`
  return { host, url: `http://${host}` }
}

afterEach(async () => {
  await Promise.all([...servers].map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error))
      server.closeAllConnections()
    })
  ))
  servers.clear()
})

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

const record = async (request: IncomingMessage, hits: Array<Hit>): Promise<void> => {
  hits.push({
    body: await bodyOf(request),
    method: request.method ?? "",
    url: request.url ?? ""
  })
}

const allow = (
  action: CapabilityPattern["action"],
  resource: string
): CapabilityPattern => new CapabilityPattern({ action, resource })

const runGuarded = <A, E>(
  effect: Effect.Effect<A, E, EffectHttpClient.HttpClient>,
  patterns: ReadonlyArray<CapabilityPattern>,
  raw: Layer.Layer<EffectHttpClient.HttpClient> = NodeHttpClient.layerUndici
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const store = yield* GrantStore.make({
        attended: false,
        rules: patterns.map((pattern) => new Rule({ effect: "allow", pattern }))
      })
      return yield* effect.pipe(
        Effect.provide(HttpClient.layer),
        Effect.provide(raw),
        Effect.provideService(GrantStore.GrantStore, store)
      )
    })
  ).pipe(Effect.provide(Workspace.layer("/workspace")))

const requestOutcome = (url: string) =>
  Effect.gen(function*() {
    const client = yield* EffectHttpClient.HttpClient
    return yield* Effect.result(client.get(url))
  })

describe("HttpClient real redirect isolation", () => {
  it.effect("blocks an ungranted redirect host before the second socket and guards both granted hops", () =>
    Effect.gen(function*() {
      const firstHits: Array<Hit> = []
      const secondHits: Array<Hit> = []
      const second = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, secondHits)
          response.writeHead(200).end("second")
        })
      )
      const first = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, firstHits)
          response.writeHead(302, { location: `${second.url}/target` }).end()
        })
      )

      const denied = yield* runGuarded(requestOutcome(`${first.url}/start`), [allow("net:get", first.url)])
      expect(denied._tag).toBe("Failure")
      if (denied._tag !== "Failure") throw new Error("expected redirect denial")
      const permission = Option.getOrThrow(HttpClient.fromHttpClientError(denied.failure))
      expect(permission).toBeInstanceOf(PermissionRequired)
      expect(permission).toMatchObject({
        code: "permission_required",
        capability: { action: "net:get", resource: second.url }
      })
      expect(firstHits).toHaveLength(1)
      expect(secondHits).toHaveLength(0)

      const allowed = yield* runGuarded(requestOutcome(`${first.url}/start`), [
        allow("net:get", first.url),
        allow("net:get", second.url)
      ])
      expect(allowed._tag).toBe("Success")
      expect(firstHits).toHaveLength(2)
      expect(secondHits).toHaveLength(1)
    }))

  it.effect("turns a 303 POST into a separately authorized GET", () =>
    Effect.gen(function*() {
      const hits: Array<Hit> = []
      const server = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, hits)
          if (request.url === "/start") {
            response.writeHead(303, { location: "/target" }).end()
          } else {
            response.writeHead(200).end("done")
          }
        })
      )
      const request = HttpClientRequest.post(`${server.url}/start`).pipe(
        HttpClientRequest.bodyText("payload")
      )

      const response = yield* runGuarded(
        Effect.gen(function*() {
          const client = yield* EffectHttpClient.HttpClient
          return yield* client.execute(request)
        }),
        [allow("net:post", server.url), allow("net:get", server.url)]
      )

      expect(response.status).toBe(200)
      expect(hits).toEqual([
        { method: "POST", url: "/start", body: "payload" },
        { method: "GET", url: "/target", body: "" }
      ])
    }))

  it.effect.each([307, 308] as const)(
    "retains POST method and body across a %s redirect",
    (status) =>
      Effect.gen(function*() {
        const hits: Array<Hit> = []
        const server = yield* Effect.promise(() =>
          listen(async (request, response) => {
            await record(request, hits)
            if (request.url === "/start") {
              response.writeHead(status, { location: "/target" }).end()
            } else {
              response.writeHead(200).end("done")
            }
          })
        )
        const request = HttpClientRequest.post(`${server.url}/start`).pipe(
          HttpClientRequest.bodyText(`payload-${status}`)
        )

        const response = yield* runGuarded(
          Effect.gen(function*() {
            const client = yield* EffectHttpClient.HttpClient
            return yield* client.execute(request)
          }),
          [allow("net:post", server.url)]
        )

        expect(response.status).toBe(200)
        expect(hits).toEqual([
          { method: "POST", url: "/start", body: `payload-${status}` },
          { method: "POST", url: "/target", body: `payload-${status}` }
        ])
      })
  )

  it.effect("resolves a relative Location against the guarded response URL", () =>
    Effect.gen(function*() {
      const hits: Array<Hit> = []
      const server = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, hits)
          if (request.url === "/directory/start") {
            response.writeHead(302, { location: "next" }).end()
          } else {
            response.writeHead(200).end("done")
          }
        })
      )

      const outcome = yield* runGuarded(
        requestOutcome(`${server.url}/directory/start`),
        [allow("net:get", server.url)]
      )

      expect(outcome._tag).toBe("Success")
      expect(hits.map((hit) => hit.url)).toEqual(["/directory/start", "/directory/next"])
    }))

  it.effect("stops a redirect loop at the default ten-hop limit", () =>
    Effect.gen(function*() {
      const hits: Array<Hit> = []
      const server = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, hits)
          response.writeHead(302, { location: "/loop" }).end()
        })
      )

      const outcome = yield* runGuarded(requestOutcome(`${server.url}/loop`), [allow("net:get", server.url)])

      expect(outcome._tag).toBe("Success")
      if (outcome._tag !== "Success") throw new Error("expected bounded redirect response")
      expect(outcome.success.status).toBe(302)
      expect(hits).toHaveLength(11)
    }))

  it.effect("keeps redirect isolation over a fetch client that would auto-follow", () =>
    Effect.gen(function*() {
      // Plain `FetchHttpClient.layer` follows redirects by default. The guard
      // forces `redirect: "manual"` below itself, so composing it over that
      // layer cannot hand the second origin a request without a grant check.
      const firstHits: Array<Hit> = []
      const secondHits: Array<Hit> = []
      const second = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, secondHits)
          response.writeHead(200).end("second")
        })
      )
      const first = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, firstHits)
          response.writeHead(302, { location: `${second.url}/target` }).end()
        })
      )
      const outcome = yield* runGuarded(
        requestOutcome(`${first.url}/start`),
        [allow("net:get", first.url)],
        FetchHttpClient.layer
      )
      expect(outcome._tag).toBe("Failure")
      if (outcome._tag !== "Failure") throw new Error("auto-follow bypassed the redirect guard")
      expect(Option.getOrThrow(HttpClient.fromHttpClientError(outcome.failure))).toMatchObject({
        capability: { resource: second.url }
      })
      expect(firstHits).toHaveLength(1)
      expect(secondHits).toHaveLength(0)
    }))

  it.effect("follows through a fetch host whose private RequestInit is manual", () =>
    Effect.gen(function*() {
      const hits: Array<Hit> = []
      const server = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, hits)
          if (request.url === "/start") {
            response.writeHead(302, { location: "/final" }).end()
          } else {
            response.writeHead(200).end("done")
          }
        })
      )
      const raw = FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "manual" }))
      )
      const outcome = yield* runGuarded(requestOutcome(`${server.url}/start`), [allow("net:get", server.url)], raw)
      expect(outcome._tag).toBe("Success")
      if (outcome._tag !== "Success") throw new Error("expected followed response")
      expect(outcome.success.status).toBe(200)
      expect(outcome.success.request.url).toBe(`${server.url}/final`)
      expect(hits.map((hit) => hit.url)).toEqual(["/start", "/final"])
    }))

  it.effect("honors a caller's manual redirect policy over a real fetch host", () =>
    Effect.gen(function*() {
      const firstHits: Array<Hit> = []
      const secondHits: Array<Hit> = []
      const second = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, secondHits)
          response.writeHead(200).end("second")
        })
      )
      const first = yield* Effect.promise(() =>
        listen(async (request, response) => {
          await record(request, firstHits)
          response.writeHead(302, { location: `${second.url}/target` }).end()
        })
      )
      const manual = requestOutcome(`${first.url}/start`).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual", credentials: "omit" })
      )
      const outcome = yield* runGuarded(manual, [allow("net:get", first.url)], FetchHttpClient.layer)
      expect(outcome._tag).toBe("Success")
      if (outcome._tag !== "Success") throw new Error("expected first-hop response")
      expect(outcome.success.status).toBe(302)
      expect(outcome.success.request.url).toBe(`${first.url}/start`)
      expect(firstHits).toEqual([{ method: "GET", url: "/start", body: "" }])
      expect(secondHits).toEqual([])
    }))
})

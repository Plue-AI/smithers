import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import { Otlp } from "../src/index.ts"

interface Received {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

const listen = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      const address = server.address()
      if (address === null || typeof address === "string") return reject(new Error("Expected TCP address"))
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })

const signals = ["/v1/logs", "/v1/metrics", "/v1/traces"]
const produceSignals = Effect.gen(function*() {
  yield* Effect.void.pipe(Effect.withSpan("redirect-secret-span"))
  yield* Effect.logInfo("redirect-secret-log")
  yield* Metric.update(Metric.counter("redirect_secret_metric"), 1)
})

describe("OTLP fetch redirect confinement", () => {
  for (const wiring of ["layerFetch", "layer", "layer-inner-options"] as const) {
    for (const status of [302, 307, 308]) {
      for (const origin of ["same", "cross"] as const) {
        it(`${wiring} refuses ${status} ${origin}-origin redirects for every signal`, async () => {
          const initial: Array<Received> = []
          const forwarded: Array<Received> = []
          const fetchOptions: Array<RequestInit> = []
          const receiver = createServer(async (request, response) => {
            let body = ""
            for await (const chunk of request) body += String(chunk)
            forwarded.push({ path: request.url!, headers: request.headers, body })
            response.writeHead(200).end("{}")
          })
          const receiverUrl = await listen(receiver)
          const collector = createServer(async (request, response) => {
            let body = ""
            for await (const chunk of request) body += String(chunk)
            const received = { path: request.url!, headers: request.headers, body }
            if (request.url!.startsWith("/redirected")) {
              forwarded.push(received)
              response.writeHead(200).end("{}")
            } else {
              initial.push(received)
              response.writeHead(status, {
                location: origin === "same"
                  ? `/redirected${request.url}`
                  : `${receiverUrl}/redirected${request.url}`
              }).end()
            }
          })
          try {
            const collectorUrl = await listen(collector)
            const options = {
              baseUrl: collectorUrl,
              headers: { "x-api-key": "synthetic-private-ingest-key" },
              exportInterval: "1 hour" as const,
              shutdownTimeout: "1 second" as const
            }
            const layer = wiring === "layerFetch"
              ? Otlp.layerFetch(options)
              : Otlp.layer(options).pipe(Layer.provide(
                wiring === "layer-inner-options"
                  ? FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, {
                    redirect: "follow",
                    credentials: "include",
                    cache: "no-store",
                    referrerPolicy: "no-referrer"
                  })))
                  : FetchHttpClient.layer
              ))
            // Delegate to native fetch so the test exercises actual redirect behavior.
            const fetch: typeof globalThis.fetch = (input, init) => {
              fetchOptions.push(init ?? {})
              return globalThis.fetch(input, init)
            }
            const exporting = produceSignals.pipe(
              Effect.provide(layer),
              Effect.provideService(FetchHttpClient.Fetch, fetch),
              Effect.provideService(Metric.MetricRegistry, new Map())
            )
            await Effect.runPromise(
              status === 307 || wiring === "layer-inner-options" ? exporting : exporting.pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {
                  redirect: "follow",
                  credentials: "omit",
                  cache: "no-store",
                  referrerPolicy: "no-referrer"
                })
              )
            )
            expect([...new Set(initial.map((request) => request.path))].sort()).toEqual(signals)
            for (const request of initial) {
              expect(request.headers["x-api-key"]).toBe("synthetic-private-ingest-key")
              expect(JSON.parse(request.body)).toBeTypeOf("object")
            }
            expect(initial.find((request) => request.path === "/v1/logs")!.body).toContain("redirect-secret-log")
            expect(initial.find((request) => request.path === "/v1/traces")!.body).toContain("redirect-secret-span")
            expect(initial.find((request) => request.path === "/v1/metrics")!.body).toContain("redirect_secret_metric")
            expect(forwarded).toEqual([])
            expect(fetchOptions.length).toBeGreaterThanOrEqual(3)
            for (const init of fetchOptions) {
              expect(init.redirect).toBe("manual")
              if (wiring === "layer-inner-options") {
                // Inner transport options are outside the export effect's ambient context.
                expect(init.credentials).toBeUndefined()
                expect(init.cache).toBeUndefined()
                expect(init.referrerPolicy).toBeUndefined()
              } else if (status !== 307) {
                expect(init.credentials).toBe("omit")
                expect(init.cache).toBe("no-store")
                expect(init.referrerPolicy).toBe("no-referrer")
              }
            }
          } finally {
            await Promise.all([close(collector), close(receiver)])
          }
        }, 15_000)
      }
    }
  }
})

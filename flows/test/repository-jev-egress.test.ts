/** The coding host judges inside a default-deny microsandbox. Egress is an
 * HTTP proxy the guest environment names through `HTTP_PROXY`/`HTTPS_PROXY`,
 * never a transparent one, and that proxy is what substitutes the platform
 * credential: the guest holds only the placeholder
 * `AI_GATEWAY_API_KEY=AI_GATEWAY_API_KEY` and iron-proxy swaps the real value
 * into `authorization` on the way to `ai-gateway.vercel.sh`.
 *
 * `flows/coding/serve.ts:82-87` builds a proxy-aware client for exactly this
 * reason. This test asserts the judge production installs — the
 * `platform.evaluator ?? evaluatorLayer(process.env)` of
 * `flows/coding/host.ts:183` — reaches the gateway the same way. A judge that
 * dials the gateway directly is dropped by the firewall and every completion
 * comes back unjudged, so the evidence has to be that the proxy was asked to
 * open the tunnel, not merely that the call failed: a direct dial fails too. */
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { test } from "node:test"
import { platform } from "../../packages/smithers/src/internal/NodeControlHost.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"

interface Proxy {
  /** What the guest environment names as its egress proxy. */
  readonly url: string
  /** Every request line this proxy was asked to carry, in order. */
  readonly seen: ReadonlyArray<string>
  readonly close: () => Promise<void>
}

/** An HTTP proxy that records what it is asked for and carries nothing.
 *
 * An `https` origin behind an `http` proxy is a `CONNECT` tunnel, so the proxy
 * never sees the request line — being asked to open the tunnel to the gateway
 * is the whole evidence that the proxy was consulted at all. */
const listen = async (): Promise<Proxy> => {
  const seen: Array<string> = []
  const sockets = new Set<Duplex>()
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.writeHead(502).end()
  })
  server.on("connect", (request, socket) => {
    seen.push(`CONNECT ${request.url}`)
    socket.destroy()
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  }
}

test("the host's judge reaches the gateway through the proxy the environment names", async () => {
  assert.equal(
    platform.evaluator,
    undefined,
    "the Node platform names no judge, so coding/host.ts builds this one from the environment"
  )
  const proxy = await listen()
  try {
    // What a microsandbox guest actually holds: the placeholder key the proxy
    // replaces, and the proxy that replaces it.
    const environment = {
      AI_GATEWAY_API_KEY: "AI_GATEWAY_API_KEY",
      HTTP_PROXY: proxy.url,
      HTTPS_PROXY: proxy.url,
      NO_PROXY: ""
    }
    const answered = await Effect.runPromise(Effect.result(
      Effect.flatMap(Evaluator.Evaluator, (evaluator) =>
        evaluator.evaluate({
          state: { rule: "Every exported constant carries a unit in its name", hunk: "+const timeout = 5" },
          questions: { violates: new Evaluator.BooleanQuestion({ instructions: "Does this hunk violate the rule?" }) }
        })).pipe(Effect.provide(evaluatorLayer(environment)))
    ))
    assert.equal(answered._tag, "Failure", "the refusing proxy cannot produce a model answer")
    if (answered._tag === "Failure") assert.equal(answered.failure.code, "unreachable")
    assert.deepEqual(
      [...proxy.seen],
      Array.from({ length: Evaluator.defaultAttempts }, () => "CONNECT ai-gateway.vercel.sh:443"),
      `every bounded retry asked the proxy for the gateway and nothing else; it answered ${JSON.stringify(answered)}`
    )
  } finally {
    await proxy.close()
  }
})

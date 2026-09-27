/** Subscription judgments must use the sandbox's configured egress proxy. */
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
 * never sees the request line — being asked to open the tunnel to the subscription pool
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

test("the host's judge reaches the subscription pool through the configured proxy", async () => {
  assert.equal(
    platform.evaluator,
    undefined,
    "the Node platform names no judge, so coding/host.ts builds this one from the environment"
  )
  const proxy = await listen()
  try {
    const environment = {
      SMITHERS_ACCOUNT_POOL_URL: "https://pool.example.test",
      SMITHERS_ACCOUNT_POOL_KEY: "fixture-host",
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
      CODEX_HOME: "/nonexistent",
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
    assert.ok(proxy.seen.length > 0, "the subscription pool must be reached through the proxy")
    assert.ok(proxy.seen.every((request) => request === "CONNECT pool.example.test:443"))
  } finally {
    await proxy.close()
  }
})

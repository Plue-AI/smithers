import { Effect } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { modelTransport } from "../release-support/runtime.ts"

let redirected = 0
const server = createServer((request, response) => {
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/secret" }).end()
  } else if (request.url === "/secret") {
    redirected++
    response.end("must not be followed")
  } else {
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: first\n\n")
    setTimeout(() => response.end("data: second\n\n"), 10)
  }
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
try {
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const transport = yield* modelTransport
    const first = yield* transport.client.get(url)
    assert.equal(yield* first.text, "data: first\n\ndata: second\n\n")
    const client = yield* transport.rebuild
    assert.equal(client === transport.client, typeof (globalThis as { Bun?: unknown }).Bun !== "undefined")
    const second = yield* client.get(url)
    assert.equal(yield* second.text, "data: first\n\ndata: second\n\n")
    const redirect = yield* client.get(`${url}/redirect`)
    assert.equal(redirect.status, 302)
    assert.equal(redirected, 0)
    yield* redirect.text
  })))
  console.log(JSON.stringify({ streamed: true, rebuilt: true, redirects: redirected, scopeClosed: true }))
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

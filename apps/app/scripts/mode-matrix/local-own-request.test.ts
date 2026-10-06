import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { localOwnRequest } from "./local-own"

test("local install setup uses the public host while connecting to its private backend", async () => {
  const observed: { host?: string; authorization?: string; body?: string } = {}
  const server = createServer(async (request, response) => {
    observed.host = request.headers["x-forwarded-host"] as string
    observed.authorization = request.headers.authorization
    let body = ""
    for await (const chunk of request) body += chunk
    observed.body = body
    if (observed.host !== "127.0.0.1:49001") {
      response.writeHead(421).end('{"code":"unknown_origin"}')
      return
    }
    response.setHeader("Content-Type", "application/json")
    response.end('{"created":true}')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  const backend = `http://127.0.0.1:${address.port}`
  try {
    expect(await localOwnRequest(backend, "http://127.0.0.1:49001", "/api/user/repos", {
      method: "POST", headers: { authorization: "token fixture", "content-type": "application/json" }, body: '{"name":"fixture"}'
    })).toEqual({ created: true })
    expect(observed).toEqual({ host: "127.0.0.1:49001", authorization: "token fixture", body: '{"name":"fixture"}' })
    await expect(localOwnRequest(backend, "http://127.0.0.1:49002", "/api/user/repos")).rejects.toThrow("421")
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

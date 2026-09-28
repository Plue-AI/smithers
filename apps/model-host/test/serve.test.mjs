/**
 * Drives the bundled `smithers-model-host serve` executable over real HTTP:
 * the loopback and configuration guards, the Node request adapter's body
 * limit, bearer and grant refusals, client-disconnect cancellation of the
 * provider call, and graceful shutdown.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, request } from "node:http"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

const PROTOCOL = "smithers.chat-model-host/v1"
const TOKEN = "host-token"
const MAX_BODY_BYTES = 2 * 1024 * 1024

const directory = mkdtempSync(join(tmpdir(), "smithers-model-host-test-"))
const bundle = join(directory, "smithers.mjs")
const children = new Set()

before(() => {
  const built = spawnSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url)), bundle], {
    encoding: "utf8"
  })
  assert.equal(built.status, 0, built.stderr)
})

after(() => {
  for (const child of children) child.kill("SIGKILL")
  rmSync(directory, { recursive: true, force: true })
})

const hostEnv = (overrides = {}) => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("SMITHERS_")) delete env[key]
  return {
    ...env,
    SMITHERS_CHAT_HOST_TOKEN: TOKEN,
    SMITHERS_CHAT_CALLBACK_URL: "http://127.0.0.1:9",
    SMITHERS_CHAT_MODEL: "{}",
    ...overrides
  }
}

const run = (args, env) => {
  const child = spawn(process.execPath, [bundle, ...args], { env, stdio: ["ignore", "pipe", "pipe"] })
  children.add(child)
  child.on("exit", () => children.delete(child))
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal, stdout, stderr }))
  return { child, exited, stdout: () => stdout }
}

const launch = async (env = hostEnv()) => {
  const host = run(["serve", "--port", "0"], env)
  const identity = await new Promise((resolve, reject) => {
    host.child.stdout.on("data", () => {
      const line = host.stdout().split("\n")[0]
      if (host.stdout().includes("\n")) resolve(JSON.parse(line))
    })
    host.exited.then((result) => reject(new Error(`model host exited early: ${result.stderr}`)))
  })
  return { ...host, identity }
}

const send = (port, { method = "POST", path = "/v1/chat/turn", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path, headers }, async (response) => {
      let text = ""
      for await (const chunk of response) text += chunk
      resolve({ status: response.statusCode, text })
    })
    outgoing.on("error", reject)
    outgoing.end(body)
  })

const listen = async (handler) => {
  const server = createServer(handler)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const grantFor = (callbackOrigin) => ({
  turnId: "turn",
  ownerId: 1,
  runId: "run",
  legId: "leg",
  generation: 1,
  token: "producer_capability_producer_capability_1234",
  cursor: { version: 1, runId: "run", legId: "leg", batch: 0, position: 0, hash: "a".repeat(64) },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  request: { runId: "run", instructions: "answer", messages: [{ role: "user", content: "hi" }] },
  producerBaseUrl: `${callbackOrigin}/`
})

test("refuses to start off loopback or with incomplete configuration", async () => {
  const cases = [
    [["serve", "--host", "0.0.0.0"], hostEnv(), "must bind loopback"],
    [["serve", "--port", "70000"], hostEnv(), "Invalid port"],
    [["listen"], hostEnv(), "Expected serve command"],
    [["serve"], hostEnv({ SMITHERS_CHAT_HOST_TOKEN: "" }), "configuration is incomplete"],
    [["serve"], hostEnv({ SMITHERS_CHAT_MODEL: "not json" }), "SMITHERS_CHAT_MODEL must be JSON"],
    [["serve"], hostEnv({ SMITHERS_CHAT_MAX_TOKENS: "0" }), "SMITHERS_CHAT_MAX_TOKENS is invalid"]
  ]
  const results = await Promise.all(cases.map(([args, env]) => run(args, env).exited))
  for (const [index, result] of results.entries()) {
    const [args, , message] = cases[index]
    assert.notEqual(result.code, 0, `${args.join(" ")} must fail`)
    assert.equal(result.stdout, "", `${message}: the host must not announce a listener`)
    assert.match(result.stderr, new RegExp(message))
  }
})

test("answers health and refuses unknown routes, wrong methods and bad bearers", async (t) => {
  const host = await launch()
  t.after(() => host.child.kill("SIGKILL"))
  const { port } = host.identity
  assert.deepEqual(host.identity, { protocol: PROTOCOL, host: "127.0.0.1", port })

  const health = await send(port, { method: "GET", path: "/health" })
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.text), { protocol: PROTOCOL })
  assert.equal((await send(port, { method: "POST", path: "/health", body: "{}" })).status, 404)
  assert.equal((await send(port, { method: "GET", path: "/unknown" })).status, 404)
  assert.equal((await send(port, { method: "GET" })).status, 405)
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }]) {
    const refused = await send(port, { headers, body: "{}" })
    assert.equal(refused.status, 401)
    assert.deepEqual(JSON.parse(refused.text), { status: "error", code: "forbidden" })
  }
})

test("refuses malformed and expired grants as invalid requests", async (t) => {
  const host = await launch()
  t.after(() => host.child.kill("SIGKILL"))
  const expired = { ...grantFor("http://127.0.0.1:9"), expiresAt: new Date(Date.now() - 1_000).toISOString() }
  const foreign = grantFor("http://127.0.0.1:10")
  for (const body of ["not json", "", JSON.stringify(expired), JSON.stringify(foreign)]) {
    const refused = await send(host.identity.port, { headers: { authorization: `Bearer ${TOKEN}` }, body })
    assert.equal(refused.status, 400, body)
    assert.deepEqual(JSON.parse(refused.text), { status: "error", code: "request_invalid" })
  }
})

test("refuses an oversized body as an invalid request, declared or chunked", async (t) => {
  const host = await launch()
  t.after(() => host.child.kill("SIGKILL"))
  const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, 0x20)
  for (const framing of [{ "content-length": String(oversized.byteLength) }, { "transfer-encoding": "chunked" }]) {
    const refused = await send(host.identity.port, {
      headers: { authorization: `Bearer ${TOKEN}`, ...framing },
      body: oversized
    })
    assert.equal(refused.status, 413, JSON.stringify(framing))
    assert.deepEqual(JSON.parse(refused.text), { status: "error", code: "request_invalid" })
  }
  const health = await send(host.identity.port, { method: "GET", path: "/health" })
  assert.equal(health.status, 200, "an oversized request must not take the host down")
})

test("cancels the provider call when the caller disconnects mid-turn", async (t) => {
  let providerStarted
  const providerReached = new Promise((resolve) => (providerStarted = resolve))
  let providerClosed
  const providerAborted = new Promise((resolve) => (providerClosed = resolve))
  const provider = await listen((incoming, outgoing) => {
    outgoing.on("close", () => providerClosed(incoming.url))
    incoming.resume()
    providerStarted(incoming.headers.authorization)
  })
  const callbacks = []
  const callback = await listen((incoming, outgoing) => {
    callbacks.push(new URL(incoming.url, callback.origin).pathname)
    incoming.resume()
    outgoing.writeHead(204).end()
  })
  t.after(() => {
    provider.server.closeAllConnections()
    provider.server.close()
    callback.server.close()
  })
  const host = await launch(hostEnv({
    SMITHERS_CHAT_CALLBACK_URL: callback.origin,
    SMITHERS_CHAT_MODEL: JSON.stringify({
      protocol: "openai-chat",
      baseUrl: provider.origin,
      modelId: "fixture",
      credential: "FIXTURE"
    }),
    SMITHERS_MODEL_KEY_FIXTURE: "provider-key",
    SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: provider.origin
  }))
  t.after(() => host.child.kill("SIGKILL"))

  const turn = request({
    host: "127.0.0.1",
    port: host.identity.port,
    method: "POST",
    path: "/v1/chat/turn",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
  })
  turn.on("error", () => {})
  turn.end(JSON.stringify(grantFor(callback.origin)))
  assert.equal(await providerReached, "Bearer provider-key")
  assert.deepEqual(callbacks, ["/internal/chat/provider-started"])
  turn.destroy()

  const aborted = await Promise.race([
    providerAborted,
    new Promise((resolve) => setTimeout(() => resolve(undefined), 5_000))
  ])
  assert.equal(aborted, "/v1/chat/completions", "the disconnect must abort the in-flight provider request")
})

test("routes by the request path, never by the Host header", async (t) => {
  const host = await launch()
  t.after(() => host.child.kill("SIGKILL"))
  for (const forged of ["elsewhere/unknown?", "a b"]) {
    const health = await send(host.identity.port, { method: "GET", path: "/health", headers: { host: forged } })
    assert.equal(health.status, 200, forged)
    assert.deepEqual(JSON.parse(health.text), { protocol: PROTOCOL })
  }
  const turn = await send(host.identity.port, {
    headers: { host: "127.0.0.1/v1/model/test?", authorization: `Bearer ${TOKEN}` },
    body: "not json"
  })
  assert.equal(turn.status, 400)
  assert.deepEqual(JSON.parse(turn.text), { status: "error", code: "request_invalid" }, "the turn route answered")
})

test("drops a caller that stalls its headers or its body", async (t) => {
  const host = await launch()
  t.after(() => host.child.kill("SIGKILL"))
  const stall = (bytes) =>
    new Promise((resolve) => {
      const socket = connect(host.identity.port, "127.0.0.1", () => socket.write(bytes))
      const started = Date.now()
      socket.on("error", () => {})
      socket.resume()
      socket.once("close", () => resolve(Date.now() - started))
      setTimeout(() => {
        socket.destroy()
        resolve(Infinity)
      }, 20_000).unref()
    })
  const [headers, body] = await Promise.all([
    stall("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n"),
    stall(`POST /v1/chat/turn HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 100\r\n\r\n{`)
  ])
  assert.ok(headers < 10_000, `a stalled header block held the socket ${headers} ms`)
  assert.ok(body < 15_000, `a stalled body held the socket ${body} ms`)
})

test("stops cleanly on SIGTERM", async () => {
  const host = await launch()
  host.child.kill("SIGTERM")
  const result = await host.exited
  assert.equal(result.code, 0, result.stderr)
})

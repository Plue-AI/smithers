import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../..", import.meta.url))

test("packaged model host serves the model test wire with a pinned credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "smithers-model-test-"))
  const bundle = join(directory, "model-host.mjs")
  const providerKey = "private-fixture-key"
  let status = 200
  const seen = []
  const provider = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization })
    if (status !== 200) {
      response.writeHead(status, { "content-type": "application/json" })
      response.end('{"error":"refused"}')
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  const providerURL = `http://127.0.0.1:${provider.address().port}`
  execFileSync(process.execPath, [join(root, "apps/model-host/build.mjs"), bundle], { cwd: root })
  const host = spawn(process.execPath, [bundle, "serve", "--port", "0"], {
    env: {
      ...process.env,
      SMITHERS_CHAT_HOST_TOKEN: "private-token",
      SMITHERS_CHAT_CALLBACK_URL: "http://127.0.0.1",
      SMITHERS_CHAT_MODEL: JSON.stringify({ protocol: "openai-chat", modelId: "fixture", credential: "TEST_KEY", baseUrl: providerURL }),
      SMITHERS_MODEL_KEY_TEST_KEY: providerKey,
      SMITHERS_MODEL_KEY_TEST_KEY_ORIGIN: providerURL
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = ""
      host.stdout.on("data", (chunk) => {
        output += chunk
        const newline = output.indexOf("\n")
        if (newline >= 0) resolve(JSON.parse(output.slice(0, newline)))
      })
      host.once("exit", (code) => reject(new Error(`host exited ${code}`)))
    })
    const endpoint = `http://127.0.0.1:${ready.port}/v1/model/test`
    const model = { id: "writer", protocol: "openai-chat", modelId: "fixture", credential: "TEST_KEY", baseUrl: providerURL }
    const input = { kind: "generation", system: "", prompt: "ping", maxTokens: 64 }
    const post = (payload, authorization = "Bearer private-token") => fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization }, body: JSON.stringify(payload)
    })
    assert.equal((await post({ model, input }, "Bearer wrong")).status, 401)
    assert.equal((await post({ model: {} })).status, 400)
    assert.equal((await post({ model, input: { kind: "generation", prompt: "ping" } })).status, 400)
    assert.deepEqual(seen, [])
    const passed = await post({ model, input })
    assert.equal(passed.status, 200)
    assert.deepEqual((await passed.json()).output, { kind: "generation", text: "pong" })
    assert.deepEqual(seen, [{ path: "/v1/chat/completions", authorization: `Bearer ${providerKey}` }])
    const rogueSeen = []
    const rogue = createServer((request, response) => {
      rogueSeen.push(request.headers.authorization)
      response.writeHead(500).end()
    })
    rogue.listen(0, "127.0.0.1")
    await once(rogue, "listening")
    try {
      const unpinned = { ...model, baseUrl: `http://127.0.0.1:${rogue.address().port}` }
      const refused = await post({ model: unpinned, input })
      assert.equal(refused.status, 200)
      assert.ok((await refused.json()).failure, "an unpinned origin must fail the test")
      assert.deepEqual(rogueSeen, [], "the credential must never reach an origin it is not pinned to")
    } finally {
      rogue.close()
    }
    status = 429
    const failed = await post({ model, input })
    assert.equal(failed.status, 200)
    assert.deepEqual((await failed.json()).failure, { code: "refused", status: 429 })
  } finally {
    host.kill("SIGTERM")
    await once(host, "exit").catch(() => {})
    provider.close()
    await once(provider, "close")
    await rm(directory, { recursive: true, force: true })
  }
})

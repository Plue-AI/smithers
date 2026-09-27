import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildProductHost } from "../librarian/build.mjs"
// Staged bytes are validated as staged; otherwise the fixture builds the host it
// executes, so acceptance never depends on an untracked artifact from an earlier run.
const staged = process.env.SMITHERS_PRODUCT_HOST_ARTIFACT
const built = staged === undefined ? await mkdtemp(join(tmpdir(), "product-host-artifact-")) : undefined
const artifact = staged === undefined ? join(built, "smithers.mjs") : resolve(staged)
const digest = staged === undefined ? await buildProductHost(artifact) : undefined
const artifactDigest = createHash("sha256").update(await readFile(artifact)).digest("hex")
const runtime = process.env.SMITHERS_PRODUCT_HOST_RUNTIME ?? process.execPath
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()

test("standalone product gateway serves an empty catalog over authenticated RPC and survives restart", { timeout: 180_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "product-gateway-"))
  const stateRoot = await mkdtemp(join(tmpdir(), "product-gateway-state-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  if (built !== undefined) {
    t.after(() => rm(built, { recursive: true, force: true }))
    assert.ok((await readFile(`${artifact}.sha256`, "utf8")).startsWith(`${digest}  `), "the host sidecar must record the built bytes")
  }
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.invalid")
  await writeFile(join(root, "README.md"), "# Fixture\n")
  git(root, "add", "."); git(root, "commit", "-m", "Fixture")
  const sourceHead = git(root, "rev-parse", "HEAD")
  const portServer = createServer(); await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve))
  const port = portServer.address().port; await new Promise(resolve => portServer.close(resolve))
  const base = `http://127.0.0.1:${port}`
  let child, logs = ""
  const stop = async () => { if (child?.exitCode === null) { const stopped = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await stopped } }
  t.after(stop)
  const start = async () => {
    child = spawn(runtime, [artifact, "serve", "--root", root, "--state-dir", stateRoot, "--port", String(port)], { cwd: root,
      env: { ...process.env, SMITHERS_API_KEY: "fixture", SMITHERS_GATEWAY_ID: "11111111-1111-4111-8111-111111111111",
        SMITHERS_OWNER_GENERATION: "7", SMITHERS_SOURCE_REVISION: sourceHead,
        SMITHERS_FLOW_ARTIFACT_SHA256: artifactDigest,
        SMITHERS_REPO: "fixture/demo" }, stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", data => { logs += data }); child.stderr.on("data", data => { logs += data })
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error(logs)
      const health = await fetch(`${base}/health`).then(r => r.ok ? r.json() : undefined).catch(() => undefined)
      if (health) { assert.equal(health.protocolVersion, "1"); assert.deepEqual(health.capabilities, ["flow-runtime-bridge/v1"])
        assert.deepEqual(health.runtimeBridge, { protocol: "smithers.flow-runtime/v1", runtimeArtifactDigest: artifactDigest,
          sourceRevision: sourceHead, ownerGeneration: 7 }); return }
      await pause(100)
    }
    throw new Error(`Host did not listen: ${logs}`)
  }
  const productFlows = async () => (await rpc("List", { _tag: "flows" })).items.map(item => item.flowId).filter(id => !id.startsWith("system/"))
  const rpc = async (tag, payload) => {
    const response = await fetch(`${base}/${tag.startsWith("Projection.") ? "projections" : "rpc"}`, {
      method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/ndjson" },
      body: JSON.stringify({ _tag: "Request", id: 1, tag, payload, headers: [] }) + "\n" })
    const text = await response.text()
    const result = text.trim().split("\n").map(JSON.parse).find(line => line._tag === "Exit")
    assert.equal(result?.exit._tag, "Success", text)
    return result.exit.value
  }
  const bridge = async (path, payload) => {
    const response = await fetch(`${base}/runtime/v1/${path}`, { method: "POST",
      headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify(payload) })
    return { status: response.status, body: await response.json() }
  }
  await start()
  const unauthorized = await fetch(`${base}/rpc`, { method: "POST", headers: { "content-type": "application/ndjson" },
    body: JSON.stringify({ _tag: "Request", id: 1, tag: "List", payload: { _tag: "flows" }, headers: [] }) + "\n" })
  assert.match(await unauthorized.text(), /Unauthorized|unauthorized/)
  // The product catalog is empty: target-repository modules never register here.
  assert.deepEqual(await productFlows(), [])
  const bridgeRequest = { protocol: "smithers.flow-runtime/v1", operation: "launch", applicationRequestId: "product-host-bridge",
    ownerGeneration: 7, attempt: 1, runtimeArtifactDigest: artifactDigest, sourceRevision: sourceHead,
    flowId: "librarian/history", payload: { repo: "fixture/demo" } }
  const refused = await bridge("command", bridgeRequest)
  assert.equal(refused.body.protocol, "smithers.flow-runtime/v1")
  assert.equal(refused.body.ok, false, JSON.stringify(refused.body))
  const incompatible = await bridge("command", { ...bridgeRequest, protocol: "smithers.flow-runtime/v2" })
  assert.equal(incompatible.status, 400)
  await stop(); await start()
  assert.deepEqual(await productFlows(), [])
  assert.ok((await readFile(join(stateRoot, ".flows", "control.db"))).length > 0)
  await assert.rejects(readFile(join(root, ".flows", "control.db")), { code: "ENOENT" })
})

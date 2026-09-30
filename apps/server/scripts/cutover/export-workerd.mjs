import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const require = createRequire(import.meta.url)
const wrangler = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = await import(wrangler.resolve("miniflare"))
let input = ""
for await (const chunk of process.stdin) input += chunk
const { legacy, seedLegacy, helper, wrapper, entry, retired = false, legacyMime = "application/javascript+module" } = JSON.parse(input)
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicJwk = pair.publicKey.export({ format: "jwk" })
const token = "integration-test-token".repeat(3), migrationId = randomUUID(), sourceVersion = randomUUID()
const originalVaultKey = Buffer.alloc(32, 7).toString("base64")
const names = { MODEL_VAULTS: "AccountModelVault", CLIENT_ERRORS: "ClientErrorLog", GATEWAY_SESSIONS: "GatewaySessionRegistry", RECOMMEND_LOG: "RecommendLog", TURN_CANCELS: "TurnCancelRegistry", TURN_LIMITS: "TurnRateLimiter" }
const state = mkdtempSync(join(tmpdir(), "smithers-export-workerd-"))
const options = (source, wrapped = true) => convertV4MiniflareOptions({
  modules: [ ...(wrapped ? [{ type: "ESModule", path: "sealed-export-entry.js", contents: wrapper }] : []),
    { type: ["application/javascript+module", "text/javascript+module"].includes(legacyMime) ? "ESModule" : "CommonJS", path: entry, contents: source }, { type: "ESModule", path: "sealed-export-helper.js", contents: helper } ],
  modulesRoot: "/", compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
  durableObjects: Object.fromEntries(Object.entries(names).map(([name, className]) => [name, { className, useSQLite: true }])),
  durableObjectsPersist: state,
  bindings: { SMITHERS_EXPORT_TOKEN: token, SMITHERS_EXPORT_RECIPIENT: JSON.stringify(publicJwk),
    SMITHERS_EXPORT_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(), SMITHERS_EXPORT_SOURCE_REVISION: "a".repeat(40), SMITHERS_EXPORT_SOURCE_VERSION: sourceVersion, MODEL_VAULT_KEY: originalVaultKey }
})
const runtime = new Miniflare(options(seedLegacy ?? legacy))
try {
  let namespace = await runtime.getDurableObjectNamespace("MODEL_VAULTS")
  const id = namespace.idFromName("integration-test-owner")
  const idString = id.toString()
  let stub = namespace.get(id)
  const command = { op: "write", login: "integration-test-owner", id: randomUUID(), action: "enroll", name: "ANTHROPIC_API_KEY", origin: "https://api.anthropic.com", sealed: { nonce: "AAAAAAAAAAAAAAAA", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAA" } }
  const write = await stub.fetch("https://vault.internal/vault", { method: "POST", body: JSON.stringify(command) })
  assert.equal(write.status, 200, "original vault write remains available")
  const read = async () => {
    const response = await stub.fetch("https://vault.internal/vault", { method: "POST", body: JSON.stringify({ op: "read", login: command.login }) })
    return { status: response.status, body: await response.text() }
  }
  await runtime.setOptions(options(legacy, false))
  namespace = await runtime.getDurableObjectNamespace("MODEL_VAULTS")
  stub = namespace.get(namespace.idFromString(idString))
  const before = await read()
  if (retired) assert.equal(before.status, 410, "current production has retired hosted enrollment")
  await runtime.setOptions(options(legacy))
  namespace = await runtime.getDurableObjectNamespace("MODEL_VAULTS")
  stub = namespace.get(namespace.idFromString(idString))
  const body = JSON.stringify({ migrationId, binding: "MODEL_VAULTS", objectId: idString })
  const denied = await runtime.dispatchFetch("https://canary.smithers.sh/__maintenance/state-export", { method: "POST", body })
  assert.equal(denied.status, 404)
  const exported = await runtime.dispatchFetch("https://canary.smithers.sh/__maintenance/state-export", { method: "POST", body,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })
  assert.equal(exported.status, 200)
  assert.equal(exported.headers.get("cache-control"), "no-store")
  const sealed = await exported.json()
  assert.equal(sealed.metadata.objectId, idString)
  assert.equal(sealed.metadata.sourceVersion, sourceVersion)
  assert.ok(!JSON.stringify(sealed).includes(command.login))
  assert.ok(!JSON.stringify(sealed).includes(originalVaultKey))
  const bytes = value => Uint8Array.from(Buffer.from(value, "base64"))
  const privateKey = await crypto.subtle.importKey("jwk", pair.privateKey.export({ format: "jwk" }), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"])
  const key = await crypto.subtle.unwrapKey("raw", bytes(sealed.wrappedKey), privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.nonce), additionalData: new TextEncoder().encode(JSON.stringify(sealed.metadata)) }, key, bytes(sealed.ciphertext))
  const snapshot = JSON.parse(new TextDecoder().decode(plain))
  assert.equal(snapshot.entries.length, 1)
  assert.equal(snapshot.entries[0][0], "model-vault:v1")
  assert.equal(snapshot.migrationContext.keyVersion, "model-vault:v1")
  assert.equal(snapshot.migrationContext.modelVaultKey, originalVaultKey)
  if (retired) {
    assert.equal((await stub.fetch("https://vault.internal/vault", { method: "POST", body: JSON.stringify(command) })).status, 410)
    assert.ok(JSON.stringify(snapshot.entries).includes(command.login), "retained pre-retirement storage remains in sealed archive")
  }
  assert.deepEqual(await read(), before, "snapshot preserves exact original fetch contract")
  console.log("workerd original vault + encrypted snapshot + unchanged read passed")
} finally { await runtime.dispose(); rmSync(state, { recursive: true, force: true }) }

const hookRuntime = new Miniflare(convertV4MiniflareOptions({
  modulesRoot: "/", compatibilityDate: "2026-08-01", modules: [
    { type: "ESModule", path: "hook.js", contents: `import { DurableObject } from "cloudflare:workers";
import { withSealedExport } from "./sealed-export-helper.js";
class Original extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.calls = 0; }
  async customRPC(value) { this.calls++; return JSON.stringify({ value, calls: this.calls, alarmed: await this.ctx.storage.get("alarmed") ?? 0 }); }
  async alarm() { await this.ctx.storage.put("alarmed", 1); }
  async fetch() { await this.ctx.storage.setAlarm(Date.now() + 10); return new Response("original-fetch"); }
}
export class AccountModelVault extends withSealedExport(Original, "MODEL_VAULTS") {}
export default { fetch() { return new Response("unused"); } };` },
    { type: "ESModule", path: "sealed-export-helper.js", contents: helper }
  ], durableObjects: { MODEL_VAULTS: { className: "AccountModelVault", useSQLite: true } }
}))
try {
  const namespace = await hookRuntime.getDurableObjectNamespace("MODEL_VAULTS"), stub = namespace.get(namespace.idFromName("hooks"))
  assert.deepEqual(JSON.parse(await stub.customRPC("rpc")), { value: "rpc", calls: 1, alarmed: 0 })
  assert.equal(await (await stub.fetch("https://fixture.internal/start-alarm")).text(), "original-fetch")
  let observed
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = JSON.parse(await stub.customRPC("rpc"))
    if (observed.alarmed === 1) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(observed.alarmed, 1, "platform dispatched the inherited original alarm")
  assert.ok(observed.calls > 1, "RPC and fetch retained one original instance")
  console.log("workerd inherited RPC and native alarm passed")
} finally { await hookRuntime.dispose() }

import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { memoryStorage } from "./DurableStorage"
import { encodeStored, sealSnapshot, type SealedSnapshot } from "./SealedSnapshot"
import { AccountModelVault } from "./retainedDurableObjects"
import { EXPORT_PATH, maintenanceExport, withSealedExport, type MaintenanceEnv } from "./MaintenanceExport"
import { decodeStored, openSnapshot } from "../scripts/cutover/sealed"

let publicJwk: JsonWebKey, privateJwk: JsonWebKey
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"])
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
})
const objectId = "a".repeat(64), migrationId = "11111111-1111-4111-8111-111111111111", token = "s".repeat(43)
const env = () => ({ SMITHERS_EXPORT_TOKEN: token, SMITHERS_EXPORT_RECIPIENT: JSON.stringify(publicJwk), SMITHERS_EXPORT_EXPIRES_AT: new Date(Date.now() + 600_000).toISOString(),
  SMITHERS_EXPORT_SOURCE_REVISION: "a".repeat(40), SMITHERS_EXPORT_SOURCE_VERSION: migrationId, MODEL_VAULT_KEY: "test-only-existing-vault-key" })
const request = (authorization = `Bearer ${token}`) => new Request(`https://state-export.internal${EXPORT_PATH}`, {
  method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ binding: "MODEL_VAULTS", objectId, migrationId })
})

test("ciphertext round-trip preserves storage types and authenticates metadata", async () => {
  const values = { bytes: new Uint8Array([1, 2, 3]), date: new Date(0), map: new Map([["private", 3n]]), array: [undefined, -0, Infinity, NaN] }
  const metadata = { version: 1 as const, schema: "smithers-do-storage/v1" as const, keyVersion: "model-vault:v1" as const,
    objectId, migrationId, binding: "MODEL_VAULTS", sourceRevision: "test", sourceVersion: migrationId, capturedAt: "now" }
  const sealed = await Effect.runPromise(sealSnapshot(metadata, { entries: [["private-key", encodeStored(values)]], alarm: null }, publicJwk))
  expect(JSON.stringify(sealed)).not.toContain("private-key")
  const decoded = await openSnapshot(sealed, privateJwk)
  expect(decodeStored(decoded.entries[0]![1])).toEqual(values)
  await expect(openSnapshot({ ...sealed, metadata: { ...metadata, objectId: "b".repeat(64) } }, privateJwk)).rejects.toThrow()
})

test("the retained vault owner and its storage remain unchanged after a sealed gated snapshot", async () => {
  const original = { version: 1, login: "alice", entries: [], receipts: [] }
  const storage = memoryStorage({ "model-vault:v1": original })
  let locks = 0
  const ctx = { id: { toString: () => objectId }, storage: { ...storage, getAlarm: async () => 17 },
    blockConcurrencyWhile: async <T>(body: () => Promise<T>) => { locks++; return body() } }
  const Wrapped = withSealedExport(AccountModelVault, "MODEL_VAULTS")
  const object = new Wrapped(ctx as ConstructorParameters<typeof Wrapped>[0], env() as MaintenanceEnv)
  const productRead = () => new Request("https://vault.internal/vault", { method: "POST", body: JSON.stringify({ op: "read", login: "alice" }) })
  const before = await new AccountModelVault().fetch()
  const beforeStatus = before.status, beforeBody = await before.text()
  const refused = await object.fetch(request("Bearer wrong"))
  expect(refused.status).toBe(404)
  const exported = await object.fetch(request())
  expect(exported.status).toBe(200)
  const sealed = await exported.json() as SealedSnapshot
  expect(JSON.stringify(sealed)).not.toContain("alice")
  expect(JSON.stringify(sealed)).not.toContain(env().MODEL_VAULT_KEY)
  const opened = await openSnapshot(sealed, privateJwk)
  expect(opened.alarm).toBe(17)
  expect(opened.migrationContext).toEqual({ keyVersion: "model-vault:v1", modelVaultKey: env().MODEL_VAULT_KEY })
  expect(decodeStored(opened.entries[0]![1])).toEqual(original)
  expect(storage.data.get("model-vault:v1")).toEqual(original)
  const second = await (await object.fetch(request())).json() as SealedSnapshot
  expect(second.nonce).not.toBe(sealed.nonce)
  expect(second.wrappedKey).not.toBe(sealed.wrappedKey)
  expect(locks).toBe(3)
  const after = await object.fetch(productRead())
  expect(beforeStatus).toBe(410)
  expect(after.status).toBe(beforeStatus)
  expect(await after.text()).toBe(beforeBody)
})

test("unusable encryption recipients fail closed without returning rows or the source key", async () => {
  const storage = memoryStorage({ "model-vault:v1": { login: "private-row" } })
  const Wrapped = withSealedExport(AccountModelVault, "MODEL_VAULTS")
  const ctx = { id: { toString: () => objectId }, storage: { ...storage, getAlarm: async () => null }, blockConcurrencyWhile: async <T>(body: () => Promise<T>) => body() }
  for (const recipient of [{}, privateJwk, { ...publicJwk, p: "unexpected-private-material" }]) {
    const object = new Wrapped(ctx as ConstructorParameters<typeof Wrapped>[0], { ...env(), SMITHERS_EXPORT_RECIPIENT: JSON.stringify(recipient) } as MaintenanceEnv)
    const response = await object.fetch(request())
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"code":"snapshot_unavailable"}')
    expect(storage.data.size).toBe(1)
  }
})

test("expired or absent maintenance configuration performs no namespace lookup", async () => {
  let reads = 0
  const namespace = { idFromString: () => { reads++; return objectId }, get: () => ({ fetch: async () => new Response("unexpected") }) }
  for (const settings of [{}, { ...env(), SMITHERS_EXPORT_EXPIRES_AT: new Date(0).toISOString() }]) {
    const response = await maintenanceExport(request(), { ...settings, MODEL_VAULTS: namespace } as unknown as MaintenanceEnv)
    expect(response.status).toBe(404)
  }
  expect(reads).toBe(0)
})

test("wrapping inherits the original instance, normal requests, alarms, RPCs and WebSocket hooks", async () => {
  let constructed = 0, alarms = 0, calls = 0, messages = 0
  class Original {
    constructor() { constructed++ }
    async fetch() { calls++; return new Response("legacy") }
    async alarm() { alarms++ }
    rpc() { return "original-rpc" }
    webSocketMessage() { messages++ }
  }
  const Wrapped = withSealedExport(Original, "TURN_CANCELS")
  const object = new Wrapped({} as ConstructorParameters<typeof Wrapped>[0], {} as MaintenanceEnv)
  expect(await (await object.fetch(new Request("https://legacy.internal/journal"))).text()).toBe("legacy")
  await object.alarm!()
  await object.alarm!()
  expect((object as unknown as Original).rpc()).toBe("original-rpc")
  ;(object as unknown as Original).webSocketMessage()
  expect(object).toBeInstanceOf(Original)
  expect({ constructed, alarms, calls, messages }).toEqual({ constructed: 1, alarms: 2, calls: 1, messages: 1 })
})

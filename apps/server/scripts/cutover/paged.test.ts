import { beforeAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { encodeStored, sealSnapshot, snapshotDigest, type PageMetadata } from "../../src/SealedSnapshot"
import { SnapshotPageChain, type PageExpected } from "./sealed"
import { memoryStorage } from "../../src/DurableStorage"
import { EXPORT_PATH, withSealedExport, type MaintenanceEnv } from "../../src/MaintenanceExport"

let publicJwk: JsonWebKey, privateJwk: JsonWebKey
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"])
  publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey); privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
})
const expected: PageExpected = { migrationId: crypto.randomUUID(), binding: "TURN_CANCELS", objectId: "a".repeat(64), sourceRevision: "sha256:" + "b".repeat(64), sourceVersion: crypto.randomUUID() }
const page = async (keys: string[], overrides: Partial<PageMetadata["page"]> = {}, header: Record<string, unknown> = {}) => {
  const metadata: PageMetadata = { version: 2, schema: "smithers-do-storage-page/v2", keyVersion: null, ...expected, capturedAt: new Date().toISOString(),
    page: { scanId: crypto.randomUUID(), index: 0, previousSHA256: null, entriesBefore: 0, entriesThrough: keys.length, complete: true, consistency: "unfenced", ...overrides } }
  const snapshot = await Effect.runPromise(sealSnapshot(metadata, { entries: keys.map(k => [k, encodeStored(k)]), alarm: null, cutoverAlarmMarkers: [], ...header }, publicJwk))
  return { snapshot, cursor: metadata.page.complete ? null : "opaque-cursor" }
}
test("authenticated pages still refuse duplicate keys, wrong order, false counts, empty nonterminal pages and header drift", async () => {
  for (const [keys, overrides, reason] of [
    [["same", "same"], {}, "KEY_ORDER"], [["z", "a"], {}, "KEY_ORDER"], [["one"], { entriesThrough: 2 }, "COUNT"],
    [[], { complete: false }, "COUNT"], [["one"], { index: 1 }, "CHAIN"], [["one"], { entriesBefore: 1 }, "CHAIN"],
    [["one"], { consistency: "object-writers-fenced" } as unknown as Partial<PageMetadata["page"]>, "CONSISTENCY"]
  ] as Array<[string[], Partial<PageMetadata["page"]>, string]>) {
    await expect(new SnapshotPageChain(expected, privateJwk).include(JSON.stringify(await page(keys, overrides)))).rejects.toThrow(reason)
  }
  const first = await page(["a"], { complete: false }), chain = new SnapshotPageChain(expected, privateJwk)
  await chain.include(JSON.stringify(first))
  const after = { index: 1, entriesBefore: 1, entriesThrough: 2, scanId: first.snapshot.metadata.page.scanId, previousSHA256: await Effect.runPromise(snapshotDigest(JSON.stringify(first.snapshot))) }
  await expect(chain.include(JSON.stringify(await page(["a"], after)))).rejects.toThrow("KEY_ORDER")
  await expect(chain.include(JSON.stringify(await page(["b"], after, { alarm: 17 })))).rejects.toThrow("METADATA_CHANGED")
  await chain.include(JSON.stringify(await page(["b"], after)))
  expect(chain.finish().entries).toBe(2)
  await expect(chain.include(JSON.stringify(first))).rejects.toThrow("AFTER_COMPLETE")
})

test("bounded object pages refuse changed alarm metadata, source, recipient and expiry", async () => {
  const storage = memoryStorage(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key-${String(i).padStart(5, "0")}`, i])))
  let alarm: number | null = null, reads = 0
  const ctx = { id: { toString: () => expected.objectId }, storage: { ...storage, getAlarm: async () => alarm,
    list: async <T>(o: { prefix: string; limit: number; startAfter?: string }) => { reads++; expect(o.limit).toBe(1); return storage.list!<T>(o) } }, blockConcurrencyWhile: async <T>(body: () => Promise<T>) => body() }
  class Original { async fetch() { return new Response("original") } }
  const settings = { SMITHERS_EXPORT_TOKEN: "x".repeat(43), SMITHERS_EXPORT_RECIPIENT: JSON.stringify(publicJwk), SMITHERS_EXPORT_EXPIRES_AT: new Date(Date.now() + 600_000).toISOString(),
    SMITHERS_EXPORT_SOURCE_REVISION: expected.sourceRevision, SMITHERS_EXPORT_SOURCE_VERSION: expected.sourceVersion }
  const Wrapped = withSealedExport(Original, "TURN_CANCELS"), object = new Wrapped(ctx as ConstructorParameters<typeof Wrapped>[0], settings as MaintenanceEnv)
  const request = (cursor: string | null) => new Request("https://fixture.test" + EXPORT_PATH, { method: "POST", headers: { authorization: "Bearer " + settings.SMITHERS_EXPORT_TOKEN }, body: JSON.stringify({ migrationId: expected.migrationId, objectId: expected.objectId, binding: expected.binding, page: { cursor } }) })
  const first = await (await object.fetch(request(null))).json() as { cursor: string }
  expect(reads).toBe(257)
  alarm = 17
  expect(await (await object.fetch(request(first.cursor))).json()).toEqual({ code: "snapshot_metadata_changed" })
  alarm = null
  for (const override of [{ SMITHERS_EXPORT_SOURCE_VERSION: crypto.randomUUID() }, { SMITHERS_EXPORT_SOURCE_REVISION: "a".repeat(40) },
    { SMITHERS_EXPORT_RECIPIENT: JSON.stringify({ ...publicJwk, kid: "different" }) }, { SMITHERS_EXPORT_EXPIRES_AT: new Date(Date.now() + 120_000).toISOString() }]) {
    const changed = new Wrapped(ctx as ConstructorParameters<typeof Wrapped>[0], { ...settings, ...override } as MaintenanceEnv)
    expect((await changed.fetch(request(first.cursor))).status).toBe(409)
  }
  const expired = new Wrapped(ctx as ConstructorParameters<typeof Wrapped>[0], { ...settings, SMITHERS_EXPORT_EXPIRES_AT: new Date(0).toISOString() } as MaintenanceEnv)
  const before = reads
  expect((await expired.fetch(request(first.cursor))).status).toBe(404); expect(reads).toBe(before)
})

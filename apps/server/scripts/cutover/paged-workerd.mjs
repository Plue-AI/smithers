import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const require = createRequire(import.meta.url), wrangler = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = await import(wrangler.resolve("miniflare"))
let input = ""
for await (const chunk of process.stdin) input += chunk
const { exporter, validator, reader } = JSON.parse(input)
const { collectPagedSnapshot, validatePagedArchive } = await import("data:text/javascript;base64," + Buffer.from(validator).toString("base64"))
const { SnapshotPageChain, decodeStored, openSnapshot } = await import("data:text/javascript;base64," + Buffer.from(reader).toString("base64"))
const root = mkdtempSync(join(tmpdir(), "smithers-paged-workerd-")), state = join(root, "state"), archiveDir = join(root, "archive")
mkdirSync(archiveDir, { mode: 0o700 })
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 }), privateJwk = pair.privateKey.export({ format: "jwk" }), publicJwk = pair.publicKey.export({ format: "jwk" })
const migrationId = randomUUID(), sourceVersion = randomUUID(), token = "test-paging-secret-".repeat(4), sourceRevision = "sha256:" + "a".repeat(64)
const bindings = { SMITHERS_EXPORT_TOKEN: token, SMITHERS_EXPORT_RECIPIENT: JSON.stringify(publicJwk), SMITHERS_EXPORT_EXPIRES_AT: new Date(Date.now() + 600_000).toISOString(), SMITHERS_EXPORT_SOURCE_REVISION: sourceRevision, SMITHERS_EXPORT_SOURCE_VERSION: sourceVersion }
const original = `import { DurableObject } from "cloudflare:workers";
import { withSealedExport, maintenanceExport } from "./export.js";
class Legacy extends DurableObject {
  async seed(start, count) { const rows = {}; for (let i = start; i < start+count; i++) rows['row:'+String(i).padStart(6,'0')] = {index:i, text:'x'.repeat(180), array:[i, null, true]}; await this.ctx.storage.put(rows); return count; }
  async put(key, value) { await this.ctx.storage.put(key, value); }
  async remove(key) { await this.ctx.storage.delete(key); }
  async get(key) { return this.ctx.storage.get(key); }
  async fetch() { return new Response('original'); }
}
export class Store extends withSealedExport(Legacy, 'TURN_CANCELS') {}
export default { fetch(request, env) { return maintenanceExport(request, env); } };`
const options = () => convertV4MiniflareOptions({
  modulesRoot: "/", compatibilityDate: "2026-08-01", modules: [
    { type: "ESModule", path: "index.js", contents: original }, { type: "ESModule", path: "export.js", contents: exporter }
  ], durableObjects: { TURN_CANCELS: { className: "Store", useSQLite: true } }, durableObjectsPersist: state, bindings
})
const runtime = new Miniflare(options())
const hash = text => createHash("sha256").update(text).digest("hex")
let requests = 0, disposed = false
try {
  const namespace = await runtime.getDurableObjectNamespace("TURN_CANCELS"), id = namespace.idFromName("paged-workerd"), objectId = id.toString(), stub = namespace.get(id)
  for (let start = 0; start < 50001; start += 100) await stub.seed(start, Math.min(100, 50001-start))
  await stub.put("\uE000", "private BMP value")
  await stub.put("\u{10000}", "private astral value")
  const expected = { migrationId, binding: "TURN_CANCELS", objectId, sourceRevision, sourceVersion }
  const post = (cursor, extra = {}, auth = token) => {
    requests++
    return runtime.dispatchFetch("https://fixture.test/__maintenance/state-export", { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ migrationId, binding: "TURN_CANCELS", objectId, page: { cursor }, ...extra }) })
  }
  assert.equal((await post(null, {}, "wrong")).status, 404)
  const legacy = await runtime.dispatchFetch("https://fixture.test/__maintenance/state-export", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(expected, ["migrationId", "binding", "objectId"]) })
  assert.equal(legacy.status, 413)
  assert.equal((await legacy.json()).code, "snapshot_requires_paged_export")
  const first = await (await post(null)).json()
  assert.equal(first.snapshot.metadata.page.consistency, "unfenced")
  assert.ok(!JSON.stringify(first).includes("row:") && !JSON.stringify(first).includes("private BMP"))
  await assert.rejects(openSnapshot(first.snapshot, privateJwk), /Unsupported/)
  const changedCursor = first.cursor.slice(0, 20) + (first.cursor[20] === "A" ? "B" : "A") + first.cursor.slice(21)
  assert.equal((await post(changedCursor)).status, 409)
  assert.equal((await post(first.cursor, { migrationId: randomUUID() })).status, 409)
  const other = namespace.idFromName("other").toString()
  assert.equal((await post(first.cursor, { objectId: other })).status, 409)
  // A mutable scan can miss a key inserted behind its cursor. This must remain explicitly unfenced.
  await stub.put("before-cursor", "mutation after page zero")
  const second = await (await post(first.cursor)).json()
  assert.equal(second.snapshot.metadata.page.consistency, "unfenced")
  // Restore only the test seed by deleting via a fresh fixture; production exporter never writes.
  await stub.remove("before-cursor")
  const big = namespace.get(namespace.idFromName("oversize"))
  await big.put("large", "x".repeat(1_010_000))
  const oversized = await post(null, { objectId: namespace.idFromName("oversize").toString() })
  assert.equal(oversized.status, 413); assert.equal((await oversized.json()).code, "snapshot_entry_exceeds_page_limit")
  let visited = 0, encodedBytes = 0, last
  const verify = (payload, metadata) => {
    assert.equal(metadata.page.consistency, "unfenced")
    assert.equal("fence" in metadata.page, false)
    assert.ok(payload.entries.length <= 256)
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 1_000_000)
    for (const [key, encoded] of payload.entries) {
      encodedBytes += Buffer.byteLength(JSON.stringify([key, encoded]))
      if (key.startsWith("row:")) { const index = Number(key.slice(4)); assert.equal(index, visited); assert.deepEqual(decodeStored(encoded), { index, text: "x".repeat(180), array: [index, null, true] }) }
      else assert.equal(decodeStored(encoded), key === "\uE000" ? "private BMP value" : "private astral value")
      visited++; last = key
    }
  }
  let attempt = 0
  await assert.rejects(collectPagedSnapshot({ directory: archiveDir, stem: "TURN_CANCELS-test", expected, privateJwk,
    fetchPage: cursor => { if (++attempt === 3) throw new Error("interrupted transport"); return post(cursor) } }), /interrupted/)
  assert.equal(readdirSync(archiveDir).length, 2, "partial ciphertext retained without a success manifest")
  const collected = await collectPagedSnapshot({ directory: archiveDir, stem: "TURN_CANCELS-test", expected, privateJwk, fetchPage: post, onPage: verify })
  assert.equal(visited, 50003); assert.equal(last, "\u{10000}"); assert.ok(encodedBytes > 8_000_000); assert.ok(collected.archive.pages.length > 190)
  // Reopen every ciphertext from disk after disposing the source isolate: no live data or fallback.
  await runtime.dispose(); disposed = true
  visited = 0; encodedBytes = 0
  await validatePagedArchive(archiveDir, collected.file, expected, privateJwk, verify)
  assert.equal(visited, 50003)
  const archive = collected.archive, texts = archive.pages.slice(0, 3).map(ref => readFileSync(join(archiveDir, ref.file), "utf8"))
  const chain = () => new SnapshotPageChain(expected, privateJwk)
  let c = chain(); await c.include(texts[0]); assert.throws(() => c.finish(), /TRUNCATED/)
  await assert.rejects(c.include(texts[0]), /CHAIN/)
  c = chain(); await assert.rejects(c.include(texts[1]), /CHAIN/)
  c = chain(); await c.include(texts[0]); await assert.rejects(c.include(texts[2]), /CHAIN/)
  const forged = JSON.parse(texts[0]); forged.snapshot.metadata.page.entriesThrough--
  await assert.rejects(chain().include(JSON.stringify(forged)))
  const tampered = JSON.parse(texts[0]); tampered.snapshot.ciphertext = (tampered.snapshot.ciphertext[0] === "A" ? "B" : "A") + tampered.snapshot.ciphertext.slice(1)
  await assert.rejects(chain().include(JSON.stringify(tampered)))
  for (const change of [{ binding: "IDENTITY" }, { objectId: "f".repeat(64) }, { migrationId: randomUUID() }, { sourceVersion: randomUUID() }, { sourceRevision: "a".repeat(40) }]) {
    await assert.rejects(new SnapshotPageChain({ ...expected, ...change }, privateJwk).include(texts[0]), /PROVENANCE|CONSISTENCY/)
  }
  const saveManifest = (name, a) => writeFileSync(join(archiveDir, name), JSON.stringify(a), { mode: 0o600 })
  saveManifest("truncated.json", { ...archive, pages: archive.pages.slice(0, -1) })
  await assert.rejects(validatePagedArchive(archiveDir, "truncated.json", expected, privateJwk), /TRUNCATED/)
  saveManifest("duplicate.json", { ...archive, pages: [archive.pages[0], archive.pages[0]] })
  await assert.rejects(validatePagedArchive(archiveDir, "duplicate.json", expected, privateJwk), /DUPLICATE/)
  saveManifest("wrong-total.json", { ...archive, entries: archive.entries - 1 })
  await assert.rejects(validatePagedArchive(archiveDir, "wrong-total.json", expected, privateJwk), /TOTALS/)
  saveManifest("escape.json", { ...archive, pages: [{ ...archive.pages[0], file: "../outside.json" }] })
  await assert.rejects(validatePagedArchive(archiveDir, "escape.json", expected, privateJwk), /PATH/)
  saveManifest("digest.json", { ...archive, pages: [{ ...archive.pages[0], sha256: "0".repeat(64) }] })
  await assert.rejects(validatePagedArchive(archiveDir, "digest.json", expected, privateJwk), /DIGEST/)
  console.log(`workerd 50003 exact rows, ${archive.pages.length} bounded pages, ${encodedBytes} encoded bytes reopened; refusal controls passed`)
} finally { if (!disposed) await runtime.dispose(); rmSync(root, { recursive: true, force: true }) }

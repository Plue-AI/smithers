import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { EXPORT_PATH } from "../../src/MaintenanceExport"
import type { SealedSnapshot } from "../../src/SealedSnapshot"
import { target } from "./targets"
import { api, listObjects, scriptPath, validateBindings, type Settings } from "./cloudflare"
import { Inventory } from "./inventory"
import { openSnapshot, type SnapshotPayload } from "./sealed"
import { collectPagedSnapshot } from "./paged"
import { verifyVaultRecovery } from "./vault"
import { requireExportVersion } from "./deployment"
import { exportBatch } from "./batch"

const directory = process.argv[2]
if (!directory || process.argv.length !== 3) throw new Error("Usage: bun scripts/cutover/export.ts PRIVATE_DIRECTORY")
const privateFile = resolve(directory, "recipient.json")
for (const path of [directory, privateFile]) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Export directory and recipient must be owner-only")
}
const recipient = JSON.parse(readFileSync(privateFile, "utf8")) as { migrationId: string; token: string; expiresAt: string; privateJwk: JsonWebKey }
const plan = JSON.parse(readFileSync(resolve(directory, "prepared/plan.json"), "utf8")) as { target: string; sourceRevision: string; sourceVersion: string }
if (plan.target !== target.name) throw new Error("Prepared target differs from selected Worker")
const applied = JSON.parse(readFileSync(resolve(directory, "prepared/verified.json"), "utf8")) as { version: string }
const guardVersion = async () => {
  const deployments = (await api<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(scriptPath + "/deployments")).result.deployments
  requireExportVersion(deployments[0], applied.version)
}
if (!(Date.parse(recipient.expiresAt) > Date.now()) || !recipient.privateJwk.d || recipient.token.length < 43) throw new Error("Recipient is invalid or expired")
await guardVersion()
const settings = (await api<Settings>(scriptPath + "/settings")).result
const namespaces = validateBindings(settings)
const destination = resolve(directory, `${target.kind}-snapshots`)
if (!existsSync(destination)) mkdirSync(destination, { mode: 0o700 })
const destinationStat = lstatSync(destination)
if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory() || (destinationStat.mode & 0o077) !== 0) throw new Error("Snapshot destination must be owner-only")
if (existsSync(resolve(destination, "manifest.json"))) throw new Error("Snapshot already completed; existing archive is immutable")
const inventory = new Inventory()
const manifest: Array<{ binding: string; objectId: string; capturedAt: string; sha256: string; bytes: number; file?: string; format?: "paged" }> = []
let emptyAtListing = 0
const vaultRecovery = { objectsWithKey: 0, objectsWithoutKey: 0, sealedEntries: 0, decryptVerified: 0, decryptFailed: 0, unclassified: 0 }
const startedAt = new Date().toISOString()
const include = async (binding: string, payload: SnapshotPayload, capturedAt: string, firstPage: boolean) => {
  if (binding === "MODEL_VAULTS") {
    const recovery = await verifyVaultRecovery(payload)
    if (firstPage) vaultRecovery[recovery.keyAvailable ? "objectsWithKey" : "objectsWithoutKey"]++
    for (const name of ["sealedEntries", "decryptVerified", "decryptFailed", "unclassified"] as const) vaultRecovery[name] += recovery[name]
  }
  inventory.include(binding, payload, capturedAt, firstPage)
}
for (const namespace of namespaces) {
  const objects = await listObjects(namespace.namespace_id!)
  emptyAtListing += objects.filter(object => !object.hasStoredData).length
  await exportBatch(objects.filter(object => object.hasStoredData), async object => {
    await guardVersion()
    const path = resolve(destination, `${namespace.name}-${object.id}.json`)
    const cached = existsSync(path)
    let text: string | undefined
    let paged = existsSync(resolve(destination, `${namespace.name}-${object.id}.page-000000.json`))
    if (cached) {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Retained snapshot must be an owner-only file")
      text = readFileSync(path, "utf8")
    } else if (!paged) {
      const response = await fetch(`https://${target.domain}${EXPORT_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${recipient.token}`, "content-type": "application/json" },
        body: JSON.stringify({ migrationId: recipient.migrationId, binding: namespace.name, objectId: object.id }) })
      paged = response.status === 413 && await response.clone().json().then((body: { code?: unknown }) => body.code === "snapshot_requires_paged_export", () => false)
      if (!paged) {
        if (!response.ok) throw new Error(`Snapshot refused (${response.status}); partial sealed files retained`)
        text = await response.text()
      }
    }
    if (paged) {
      const result = await collectPagedSnapshot({ directory: destination, stem: `${namespace.name}-${object.id}`,
        expected: { migrationId: recipient.migrationId, binding: namespace.name, objectId: object.id, sourceRevision: plan.sourceRevision, sourceVersion: plan.sourceVersion }, privateJwk: recipient.privateJwk,
        fetchPage: async cursor => { await guardVersion(); return fetch(`https://${target.domain}${EXPORT_PATH}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
          headers: { authorization: `Bearer ${recipient.token}`, "content-type": "application/json" }, body: JSON.stringify({ migrationId: recipient.migrationId, binding: namespace.name, objectId: object.id, page: { cursor } }) }) },
        onPage: (payload, metadata) => include(namespace.name, payload, metadata.capturedAt, metadata.page.index === 0) })
      manifest.push({ binding: namespace.name, objectId: object.id, capturedAt: result.archive.capturedAt, sha256: result.sha256, bytes: result.bytes, file: result.file, format: "paged" })
      return
    }
    if (text === undefined) throw new Error("Snapshot absent")
    if (text.length > 12_000_000) throw new Error("Snapshot exceeds operator limit")
    const sealed = JSON.parse(text) as SealedSnapshot
    if (sealed.metadata.binding !== namespace.name || sealed.metadata.objectId !== object.id || sealed.metadata.migrationId !== recipient.migrationId ||
      sealed.metadata.sourceRevision !== plan.sourceRevision || sealed.metadata.sourceVersion !== plan.sourceVersion ||
      !Number.isFinite(Date.parse(sealed.metadata.capturedAt))) throw new Error("Snapshot provenance mismatch")
    const payload = await openSnapshot(sealed, recipient.privateJwk)
    await include(namespace.name, payload, sealed.metadata.capturedAt, true)
    if (!cached) writeFileSync(path, text, { mode: 0o600, flag: "wx" })
    manifest.push({ binding: namespace.name, objectId: object.id, capturedAt: sealed.metadata.capturedAt,
      sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text) })
  })
  console.log(JSON.stringify({ binding: namespace.name, exportedObjects: manifest.filter(item => item.binding === namespace.name).length }))
}
// This is an inventory snapshot while the old service is live, not a drain receipt.
await guardVersion()
const report = { migrationId: recipient.migrationId, sourceRevision: plan.sourceRevision, sourceVersion: plan.sourceVersion, startedAt, finishedAt: new Date().toISOString(),
  completeForListedStoredObjects: true, globallyQuiescent: false, scanConsistency: "unfenced-not-atomic", credentialMigrationReady: false, verifiedCanonicalIdentityMappings: 0,
  emptyObjectsSkippedAtListing: emptyAtListing, counts: inventory.summary(), vaultRecovery }
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify({ report, objects: manifest }, null, 2), { mode: 0o600, flag: "wx" })
writeFileSync(resolve(destination, "counts.json"), JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" })
console.log(JSON.stringify(report))

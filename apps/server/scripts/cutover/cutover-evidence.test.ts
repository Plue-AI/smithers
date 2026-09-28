import { afterAll, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { encodeStored, sealSnapshot } from "../../src/SealedSnapshot"
import { CLOUDFLARE_PRODUCERS, save, type ArtifactReference, type CloudflareFenceReceipt, type FenceAuthority } from "./fence"
import { classifyDurableObject, emptyCounts, addCounts, orderRows, type DurableDrainObservation, type Disposition, type ChargeRow, type StripeGrant } from "./drain"
import { reconcileMetering, type MeteringEvidence } from "./metering"
import { validateCutoverEvidence, type CutoverEvidenceBundle } from "./cutover-evidence"
import { collectPagedSnapshot } from "./paged"

const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]) as CryptoKeyPair
const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey), privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
const T = Date.parse("2026-09-25T12:00:00.000Z"), iso = (ms: number) => new Date(ms).toISOString()
const sha = (v: string) => createHash("sha256").update(v).digest("hex")
const DO: Record<string, Array<{ binding: string; namespaceId: string }>> = {
  "smithers-mvp-web": [{ binding: "TURN_CANCELS", namespaceId: "1".repeat(32) }],
  "smithers-cloud-billing": [{ binding: "ACCOUNTS", namespaceId: "2".repeat(32) }]
}
interface Options { paged?: "valid" | "duplicate" | "truncated" | "reordered" | "unfenced" | "foreign-source" | "foreign-object"; marker?: "valid" | "invalid" | "hidden"; captureAt?: number; lateCharge?: boolean; fakeCompleted?: boolean; dropWorker?: string; confirmationDrift?: boolean; dropException?: boolean; dropNamespace?: boolean; tamperSnapshot?: boolean; epoch?: string }

const build = async (o: Options = {}) => {
  const root = mkdtempSync(join(tmpdir(), "cutover-evidence-")); roots.push(root)
  const expected = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech" }
  const expiresAt = iso(T + 3_600_000)
  writeFileSync(join(root, "recipient.json"), JSON.stringify({ migrationId: expected.executionID, privateJwk, token: "t".repeat(43), expiresAt }), { mode: 0o600 })
  const authorities = new Map<string, FenceAuthority>()
  for (const worker of CLOUDFLARE_PRODUCERS) {
    const bindings = (DO[worker] ?? []).map(d => ({ type: "durable_object_namespace", name: d.binding, namespace_id: d.namespaceId }))
    authorities.set(worker, { worker, version: randomUUID(), sourceVersion: randomUUID(), sourceArtifactSHA256: sha(worker), settingsSHA256: sha("s" + worker), modulesSHA256: sha("m" + worker),
      observedAt: iso(T + 1000), refusals: [{ origin: `https://${worker}.example`, observedAt: iso(T + 1000), nonce: randomUUID(), status: 503, bodySHA256: sha("r") }],
      evidence: save(root, `${worker}-evidence.json`, { settings: { bindings } }) })
  }
  const queues = ["smithers-metering-canary", "smithers-metering-canary-dlq"].map(name => ({ name, id: randomUUID(), samples: [0, 1].map(i => ({ observedAt: iso(T + 500 + i), backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 })) }))
  const receipt = (at: number, drift = false): CloudflareFenceReceipt => {
    const version = randomUUID(), rows = (offset: number) => [...authorities.values()].map(a => ({ ...a, observedAt: iso(at + offset), ...(drift && a.worker === "smithers-cloud-cron" ? { version } : {}) }))
    return { schema: "smithers-cloudflare-fence/v1", ...expected, startedAt: iso(at), finishedAt: iso(at + 1000), authorities: rows(400), confirmation: rows(500), queues, drain: { state: "unverified", reasons: [] } }
  }
  const fence = receipt(T + 600) // Authorities confirmed at T+1000, receipt finished T+1600.
  for (const a of fence.authorities) authorities.get(a.worker)!.observedAt = a.observedAt
  const seal = async (worker: string, binding: string, objectId: string, entries: Array<[string, unknown]>, alarm: number | null, cutoverAlarmMarkers: string[]) => {
    const a = authorities.get(worker)!, capturedAt = iso(o.captureAt ?? T + 3000)
    if (o.paged) {
      const pageExpected = { migrationId: expected.executionID, binding, objectId: o.paged === "foreign-object" ? "d".repeat(64) : objectId,
        sourceRevision: "sha256:" + a.sourceArtifactSHA256, sourceVersion: o.paged === "foreign-source" ? randomUUID() : a.sourceVersion,
        ...o.paged === "unfenced" ? {} : { fence: { ...expected, worker, sourceVersion: a.sourceVersion, sourceArtifactSHA256: a.sourceArtifactSHA256 } } }
      // Foreign source stays internally coherent but must fail the independent fence's provenance.
      if (pageExpected.fence) pageExpected.fence.sourceVersion = pageExpected.sourceVersion
      let index = 0, previousSHA256: string | null = null
      const scanId = randomUUID()
      const collected = await collectPagedSnapshot({ directory: root, stem: `${binding}-${objectId}`, expected: pageExpected, privateJwk, fetchPage: async () => {
        const snapshot = await Effect.runPromise(sealSnapshot({ version: 2, schema: "smithers-do-storage-page/v2", keyVersion: null,
          migrationId: pageExpected.migrationId, binding, objectId: pageExpected.objectId, sourceRevision: pageExpected.sourceRevision, sourceVersion: pageExpected.sourceVersion, capturedAt,
          page: { scanId, index, previousSHA256, entriesBefore: index, entriesThrough: index + 1, complete: index === entries.length - 1,
            consistency: pageExpected.fence ? "object-writers-fenced" : "unfenced", fence: pageExpected.fence ?? null } }, { entries: [entries[index]], alarm, cutoverAlarmMarkers }, publicJwk))
        previousSHA256 = sha(JSON.stringify(snapshot)); index++
        return Response.json({ snapshot, cursor: index === entries.length ? null : "test-next" })
      } })
      const manifest = collected.archive
      if (o.paged === "duplicate") manifest.pages.splice(1, 0, manifest.pages[0]!)
      if (o.paged === "truncated") manifest.pages.pop()
      if (o.paged === "reordered") manifest.pages.reverse()
      const bytes = JSON.stringify(manifest)
      writeFileSync(join(root, collected.file), bytes, { mode: 0o600 })
      return { path: collected.file, sha256: sha(bytes), binding, objectId, capturedAt, format: "paged" as const }
    }
    const sealed = await Effect.runPromise(sealSnapshot({ version: 1, schema: "smithers-do-storage/v1", keyVersion: null, migrationId: expected.executionID, binding, objectId,
      sourceRevision: "sha256:" + a.sourceArtifactSHA256, sourceVersion: a.sourceVersion, capturedAt }, { entries, alarm, cutoverAlarmMarkers }, publicJwk))
    const bytes = JSON.stringify(sealed), path = `${binding}-${objectId}.json`
    writeFileSync(join(root, path), bytes, { mode: 0o600 })
    if (o.tamperSnapshot && binding === "ACCOUNTS") {
      const tampered = bytes.replace(/"nonce":"([^"]+)"/, (_, nonce: string) => {
        const fixed = "A".repeat(nonce.length)
        return `"nonce":"${nonce === fixed ? "B".repeat(nonce.length) : fixed}"`
      })
      expect(tampered).not.toBe(bytes)
      writeFileSync(join(root, path), tampered, { mode: 0o600 })
    }
    return { path, sha256: sha(bytes), binding, objectId, capturedAt }
  }
  const row = (key: string, value: unknown): [string, unknown] => [key, encodeStored(value)]
  const charge = (id: string, at: number) => row(`chg:${id}`, { id, createdAt: iso(at), amountNanos: 1500, resource: "inference.output_tokens", runId: null })
  const a = authorities.get("smithers-mvp-web")!
  const marker = { schema: "smithers-cutover-alarm/v1", state: "interrupted-unresolved", executionID: expected.executionID, worker: "smithers-mvp-web", binding: "TURN_CANCELS", objectId: "a".repeat(64),
    sourceVersion: a.sourceVersion, sourceArtifactSHA256: a.sourceArtifactSHA256, scheduledNoLaterThan: iso(T + 1500), firstObservedAt: iso(T + 1500), lastObservedAt: iso(T + 2500), observations: 3, lastRetryCount: 2 }
  const markers = o.marker === "invalid" ? [JSON.stringify({ ...marker, objectId: "b".repeat(64) })] : o.marker ? [JSON.stringify(marker)] : []
  const objects: Record<string, Array<{ binding: string; objectId: string; entries: Array<[string, unknown]>; alarm: number | null; markers?: string[] }>> = {
    "smithers-mvp-web": [{ binding: "TURN_CANCELS", objectId: "a".repeat(64), entries: [row("state", { state: "active", at: T - 1000 }), row("turn-journal:v1:head", { terminal: false })], alarm: null, markers }],
    "smithers-cloud-billing": [{ binding: "ACCOUNTS", objectId: "c".repeat(64), alarm: null, entries: [charge("resp_1:inference.output_tokens", T - 60_000), ...o.lateCharge ? [charge("resp_late:inference.output_tokens", T + 2000)] : [],
      row("ledger", { grants: [{ id: "stripe:pi_1", createdAt: iso(T - 60_000) }] })] }]
  }
  const drains: ArtifactReference[] = []
  for (const worker of CLOUDFLARE_PRODUCERS) {
    if (worker === o.dropWorker) continue
    const a = authorities.get(worker)!, namespaces = (DO[worker] ?? []).filter(d => !(o.dropNamespace && d.binding === "ACCOUNTS"))
    const snapshots = [], counts = emptyCounts(), rows = { dispositions: [] as Disposition[], charges: [] as ChargeRow[], stripeGrants: [] as StripeGrant[] }
    for (const object of (objects[worker] ?? []).filter(x => namespaces.some(n => n.binding === x.binding))) {
      snapshots.push(await seal(worker, object.binding, object.objectId, object.entries, object.alarm, object.markers ?? []))
      const c = classifyDurableObject(object.binding, object.objectId, object.entries, object.alarm, o.captureAt ?? T + 3000, o.marker === "hidden" ? [] : object.markers ?? [], worker)
      addCounts(counts, c.counts); rows.dispositions.push(...c.dispositions); rows.charges.push(...c.charges); rows.stripeGrants.push(...c.stripeGrants)
    }
    const ordered = orderRows(rows)
    const drain: DurableDrainObservation = { schema: "smithers-durable-drain/v3", ...expected, worker, version: a.version, sourceVersion: a.sourceVersion, sourceArtifactSHA256: a.sourceArtifactSHA256,
      startedAt: iso(T + 2000), finishedAt: iso(T + 5000), credentialExpiresAt: o.epoch ?? expiresAt, complete: true, counts, ...ordered, ...o.fakeCompleted && worker === "smithers-mvp-web" ? { dispositions: [] } : {},
      snapshots, emptyAtListing: 0, namespaces: namespaces.map(n => ({ ...n, listed: (objects[worker] ?? []).filter(x => x.binding === n.binding).length })) }
    drains.push(save(root, `drain-${worker}.json`, drain))
  }
  const confirmation = receipt(T + 10_000, o.confirmationDrift)
  const watermarks = Object.fromEntries(["smithers-cloud-billing", "smithers-cloud-chat-canary", "smithers-cloud-chat"].map(w => [w, authorities.get(w)!.observedAt]))
  const evidence: MeteringEvidence = { schema: "smithers-cutover-metering-evidence/v1", ...expected, collectedAt: iso(T + 70_000),
    windows: Object.keys(watermarks).map(worker => ({ worker, admissionVersion: randomUUID(), admissionAt: iso(T - 1_800_000), fenceVersion: authorities.get(worker)!.version, fenceAt: iso(T + 500) })),
    telemetry: { from: T - 1_800_000, to: T + 65_000, services: Object.keys(watermarks), events: [{ id: "e1", at: T - 30_000, service: "smithers-cloud-chat-canary", trigger: null, statusCode: null, message: "metering_poison reason=shape message=m7", versionId: null, truncated: false }] },
    queueOperations: { from: T - 1_800_000, fenceAt: Date.parse(watermarks["smithers-cloud-chat-canary"]!), to: T + 65_000, operations: [] },
    queueFinal: queues.map(q => ({ name: q.name, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 })),
    checkout: { createdGte: Math.floor((T - 1_800_000) / 1000) - 86_400, sessions: [{ id: "cs_1", created: (T - 60_000) / 1000, expiresAt: T / 1000 + 3600, status: "complete", paymentStatus: "paid", paymentIntent: "pi_1", topup: true }] } }
  const ledger = { charges: Object.values(objects).flat().flatMap(x => classifyDurableObject(x.binding, x.objectId, x.entries, x.alarm, T).charges), stripeGrants: [{ objectId: "c".repeat(64), id: "stripe:pi_1", createdAt: iso(T - 60_000) }] }
  let metering
  try { metering = reconcileMetering(evidence, ledger, watermarks) } catch { metering = { refusedAtCollection: true } }
  if (o.dropException && "exceptions" in metering) metering.exceptions = []
  const bundle: CutoverEvidenceBundle = { schema: "smithers-cloudflare-cutover/v1", ...expected, createdAt: iso(T + 71_000),
    fence: save(root, "fence.json", fence), drains, confirmation: save(root, "confirmation.json", confirmation), meteringEvidence: save(root, "metering-evidence.json", evidence), metering: save(root, "metering.json", metering) }
  return { root, bundle, expected, now: T + 72_000 }
}
const refusal = async (o: Options, code: string) => {
  const f = await build(o)
  await expect(validateCutoverEvidence(f.root, f.bundle, f.expected, { now: f.now })).rejects.toThrow(code)
}

test("accepts a complete fenced, drained and metered cutover recomputed from sealed state", async () => {
  const f = await build()
  const acceptance = await validateCutoverEvidence(f.root, f.bundle, f.expected, { now: f.now })
  expect(acceptance.authorities).toHaveLength(CLOUDFLARE_PRODUCERS.length)
  expect(acceptance.durable).toEqual({ objects: 2, rows: 4, interruptedUnknown: { "active-at-fence": 1, "open-journal": 1 } })
  expect(acceptance.metering).toEqual({ charges: 1, amountNanos: 1500, exceptions: { "poison-acknowledged": 1 }, streams: "interrupted-unknown" })
})
test("a drain receipt that relabels interrupted work as completed is refused", () => refusal({ fakeCompleted: true }, "CF_DRAIN_RECEIPT_MISMATCH"))
test("every one of the 14 authorities must be drained", () => refusal({ dropWorker: "smithers-flows-flows" }, "CF_DRAIN_AUTHORITY_INCOMPLETE"))
test("state captured before that authority's fence watermark is not drain evidence", () => refusal({ captureAt: T + 900 }, "CF_DRAIN_SNAPSHOT_PROVENANCE"))
test("a skipped Durable Object namespace is refused against the fence's own settings observation", () => refusal({ dropNamespace: true }, "CF_DRAIN_NAMESPACE_COVERAGE"))
test("a charge row written after the billing fence watermark is refused", () => refusal({ lateCharge: true }, "CF_METERING_LATE_CHARGE_ADMITTED"))
test("a metering receipt that drops a recorded exception is refused", () => refusal({ dropException: true }, "CF_METERING_RECEIPT_MISMATCH"))
test("a fence that changed between observation and confirmation is refused", () => refusal({ confirmationDrift: true }, "CF_CUTOVER_FENCE_CHANGED"))
test("sealed bytes altered after collection are refused", () => refusal({ tamperSnapshot: true }, "CF_FENCE_ARTIFACT_DIGEST_MISMATCH"))
test("drains from another export credential epoch are refused", () => refusal({ epoch: iso(T + 7_200_000) }, "CF_DRAIN_CREDENTIAL_EPOCH_MISMATCH"))
test("a stale confirmation is refused at use time", async () => {
  const f = await build()
  await expect(validateCutoverEvidence(f.root, f.bundle, f.expected, { now: f.now + 3_600_000, maxAgeMs: 120_000 })).rejects.toThrow("CF_FENCE_OBSERVATION_STALE")
})

test("an interrupted-alarm marker is surfaced as alarm-interrupted, never hidden, never product data", async () => {
  const f = await build({ marker: "valid" })
  const acceptance = await validateCutoverEvidence(f.root, f.bundle, f.expected, { now: f.now })
  expect(acceptance.durable).toEqual({ objects: 2, rows: 4, interruptedUnknown: { "active-at-fence": 1, "alarm-interrupted": 1, "open-journal": 1 } })
})
test("a drain receipt that omits the sealed alarm marker is refused", () => refusal({ marker: "hidden" }, "CF_DRAIN_RECEIPT_MISMATCH"))
test("a marker for another object is an invalid row, not a silent pass", () => refusal({ marker: "invalid" }, "CF_DRAIN_INVALID_ROWS"))

test("final acceptance reopens every paged ciphertext, counts an object and its repeated alarm marker once, and reconciles its grants", async () => {
  const f = await build({ paged: "valid", marker: "valid" })
  const acceptance = await validateCutoverEvidence(f.root, f.bundle, f.expected, { now: f.now })
  expect(acceptance.durable).toEqual({ objects: 2, rows: 4, interruptedUnknown: { "active-at-fence": 1, "alarm-interrupted": 1, "open-journal": 1 } })
  expect(acceptance.metering.charges).toBe(1)
  const again = await validateCutoverEvidence(f.root, f.bundle, f.expected, { now: f.now })
  expect(again.durable).toEqual(acceptance.durable)
  expect(again.metering).toEqual(acceptance.metering)
})
for (const [paged, code] of [["duplicate", "DUPLICATE"], ["truncated", "TRUNCATED"], ["reordered", "CHAIN"], ["unfenced", "PROVENANCE"], ["foreign-source", "PROVENANCE"], ["foreign-object", "PROVENANCE"]] as const) {
  test(`final acceptance refuses paged ${paged} evidence even with an updated outer manifest digest`, () => refusal({ paged }, code))
}

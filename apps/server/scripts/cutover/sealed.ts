import { compareStorageKeys, PAGE_BYTES, PAGE_ENTRIES, PAGE_RESPONSE_BYTES, CURSOR_BYTES, type SealedSnapshot, type SealedPage, type PageResponse, type SnapshotProvenance } from "../../src/SealedSnapshot"

const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
export interface SnapshotPayload {
  entries: Array<[string, unknown]>; alarm: number | null; migrationContext?: { keyVersion: "model-vault:v1"; modelVaultKey: string | null }
  /** Raw rows of the reserved alarm-marker table (RetiredDurableObject.ts); never part of product `entries`. */
  cutoverAlarmMarkers?: string[]
}
const openEnvelope = async (sealed: SealedSnapshot | SealedPage, privateJwk: JsonWebKey): Promise<SnapshotPayload> => {
  if (sealed.algorithm !== "RSA-OAEP-256+A256GCM") throw new Error("Unsupported encrypted snapshot")
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["unwrapKey"])
  const key = await crypto.subtle.unwrapKey("raw", bytes(sealed.wrappedKey), privateKey, { name: "RSA-OAEP" }, { name: "AES-GCM", length: 256 }, false, ["decrypt"])
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.nonce), additionalData: new TextEncoder().encode(JSON.stringify(sealed.metadata)) }, key, bytes(sealed.ciphertext)))
  try {
    if (plaintext.byteLength > (sealed.metadata.version === 2 ? PAGE_BYTES : 8_000_000)) throw new Error("Snapshot exceeds plaintext limit")
    const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    if (!decoded || typeof decoded !== "object" || !("entries" in decoded) || !Array.isArray(decoded.entries) || !("alarm" in decoded)) throw new Error("Invalid snapshot payload")
    return decoded as SnapshotPayload
  } finally { plaintext.fill(0) }
}
export const openSnapshot = async (sealed: SealedSnapshot, privateJwk: JsonWebKey): Promise<SnapshotPayload> => {
  if (sealed.metadata.version !== 1 || sealed.metadata.schema !== "smithers-do-storage/v1") throw new Error("Unsupported encrypted snapshot")
  return openEnvelope(sealed, privateJwk)
}
export type PageExpected = Pick<SnapshotProvenance, "migrationId" | "binding" | "objectId" | "sourceRevision" | "sourceVersion">
const digest = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("")
const invalid = (reason: string): never => { throw new Error("SNAPSHOT_PAGE_" + reason) }
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object"
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v)

/** Constant retained state; authenticate and validate every page before exposing its rows. */
export class SnapshotPageChain {
  private previousSHA256: string | null = null
  private scanId: string | null = null
  private lastKey: string | undefined
  private state: string | undefined
  private done = false
  private pages = 0
  private entries = 0
  private firstAt: string | undefined
  private lastAt: string | undefined
  constructor(readonly expected: PageExpected, private readonly privateJwk: JsonWebKey) {}
  async include(text: string): Promise<{ response: PageResponse; payload: SnapshotPayload }> {
    if (this.done) invalid("AFTER_COMPLETE")
    if (new TextEncoder().encode(text).byteLength > PAGE_RESPONSE_BYTES) invalid("TOO_LARGE")
    const r = JSON.parse(text) as PageResponse, s = r?.snapshot, m = s?.metadata, p = m?.page
    if (!m || m.version !== 2 || m.schema !== "smithers-do-storage-page/v2" || !p) invalid("SCHEMA")
    for (const k of ["migrationId", "binding", "objectId", "sourceRevision", "sourceVersion"] as const) if (m[k] !== this.expected[k]) invalid("PROVENANCE")
    if (m.keyVersion !== (m.binding === "MODEL_VAULTS" ? "model-vault:v1" : null) || !Number.isFinite(Date.parse(m.capturedAt))) invalid("PROVENANCE")
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(p.scanId) ||
      p.index !== this.pages || p.previousSHA256 !== this.previousSHA256 || p.entriesBefore !== this.entries ||
      !Number.isSafeInteger(p.entriesThrough) || p.entriesThrough < this.entries || typeof p.complete !== "boolean" ||
      this.scanId !== null && p.scanId !== this.scanId) invalid("CHAIN")
    if (p.consistency !== "unfenced") invalid("CONSISTENCY")
    if (p.complete ? r.cursor !== null : typeof r.cursor !== "string" || r.cursor.length < 1 || r.cursor.length > CURSOR_BYTES) invalid("CURSOR")
    const payload = await openEnvelope(s, this.privateJwk)
    if (payload.entries.length > PAGE_ENTRIES || (!p.complete && payload.entries.length === 0) || p.entriesThrough !== this.entries + payload.entries.length) invalid("COUNT")
    if (!(payload.alarm === null || typeof payload.alarm === "number" && Number.isSafeInteger(payload.alarm)) ||
      !Array.isArray(payload.cutoverAlarmMarkers) || payload.cutoverAlarmMarkers.length > 256 || payload.cutoverAlarmMarkers.some(v => typeof v !== "string")) invalid("PAYLOAD")
    const { entries: _, ...header } = payload, state = stable(header)
    if (this.state !== undefined && this.state !== state) invalid("METADATA_CHANGED")
    let lastKey = this.lastKey
    for (const entry of payload.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || lastKey !== undefined && compareStorageKeys(entry[0], lastKey) <= 0) invalid("KEY_ORDER")
      lastKey = entry[0]
    }
    this.state = state; this.lastKey = lastKey; this.entries = p.entriesThrough; this.pages++; this.done = p.complete; this.scanId = p.scanId
    this.previousSHA256 = await digest(JSON.stringify(s)); this.firstAt ??= m.capturedAt; this.lastAt = m.capturedAt
    return { response: r, payload }
  }
  finish() {
    if (!this.done) invalid("TRUNCATED")
    return { scanId: this.scanId!, pages: this.pages, entries: this.entries, capturedAt: this.firstAt!, finishedAt: this.lastAt!, finalSnapshotSHA256: this.previousSHA256! }
  }
}

export const decodeStored = (encoded: unknown): unknown => {
  if (!Array.isArray(encoded)) throw new Error("Invalid storage encoding")
  const [tag, value] = encoded
  switch (tag) {
    case "undefined": return undefined
    case "null": return null
    case "string": case "boolean": return value
    case "number": return value === "-0" ? -0 : Number(value)
    case "bigint": return BigInt(value)
    case "date": return new Date(value)
    case "array": return value.map(decodeStored)
    case "map": return new Map(value.map(([key, item]: [unknown, unknown]) => [decodeStored(key), decodeStored(item)]))
    case "set": return new Set(value.map(decodeStored))
    case "object": return Object.fromEntries(value.map(([key, item]: [string, unknown]) => [key, decodeStored(item)]))
    case "ArrayBuffer": return bytes(value).buffer
    case "Uint8Array": return bytes(value)
    case "Int8Array": return new Int8Array(bytes(value).buffer)
    case "Uint8ClampedArray": return new Uint8ClampedArray(bytes(value).buffer)
    case "Int16Array": return new Int16Array(bytes(value).buffer)
    case "Uint16Array": return new Uint16Array(bytes(value).buffer)
    case "Int32Array": return new Int32Array(bytes(value).buffer)
    case "Uint32Array": return new Uint32Array(bytes(value).buffer)
    case "Float32Array": return new Float32Array(bytes(value).buffer)
    case "Float64Array": return new Float64Array(bytes(value).buffer)
    case "BigInt64Array": return new BigInt64Array(bytes(value).buffer)
    case "BigUint64Array": return new BigUint64Array(bytes(value).buffer)
    case "DataView": return new DataView(bytes(value).buffer)
    default: throw new Error("Unsupported storage encoding")
  }
}

import { Effect } from "effect"
import { z } from "zod"
import { runDurable, runRequest } from "./Boundary"
import { storageFrom, type NativeStorage } from "./DurableStorage"
import { readBoundedJson } from "./Http"
import { authenticatedExport, compareStorageKeys, CURSOR_BYTES, encodeStored, PAGE_BYTES, PAGE_ENTRIES, sealSnapshot, snapshotCursor, snapshotDigest, SnapshotFailure, type PageMetadata } from "./SealedSnapshot"

export const EXPORT_PATH = "/__maintenance/state-export"
/** Reserved maintenance table written only by a retired owner's alarm (RetiredDurableObject.ts). SQLite-only; product KV reads never see it. */
export const ALARM_MARKER_TABLE = "_smithers_cutover_alarm_v1"
export interface MarkerSql { exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, unknown>> } }
/** The web Worker's retained namespaces (workerIdentity.ts); nothing else is exportable. */
export const EXPORT_BINDINGS = ["TURN_CANCELS", "GATEWAY_SESSIONS", "TURN_LIMITS", "CLIENT_ERRORS", "RECOMMEND_LOG", "MODEL_VAULTS"] as const
export interface ExportSettings {
  readonly SMITHERS_EXPORT_TOKEN?: string
  readonly SMITHERS_EXPORT_RECIPIENT?: string
  readonly SMITHERS_EXPORT_EXPIRES_AT?: string
  readonly SMITHERS_EXPORT_SOURCE_REVISION?: string
  readonly SMITHERS_EXPORT_SOURCE_VERSION?: string
  readonly MODEL_VAULT_KEY?: string
}
export type MaintenanceEnv = ExportSettings & { readonly [binding: string]: unknown }
interface SnapshotStorage extends NativeStorage {
  readonly getAlarm: () => Promise<number | null>
  readonly delete: (key: string) => Promise<boolean>
  readonly put: (key: string | Record<string, unknown>, value?: unknown) => Promise<void>
  readonly list: <T>(options: { prefix: string; limit: number; startAfter?: string; reverse?: boolean }) => Promise<Map<string, T>>
  readonly sql?: MarkerSql
  readonly sync?: () => Promise<void>
}
/** Read-only: never creates the table, so exporting an object whose alarm never fired changes nothing. */
const alarmMarkers = (storage: SnapshotStorage): string[] => {
  const sql = sqlOf(storage)
  if (!sql) return []
  if (!sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", ALARM_MARKER_TABLE).toArray().length) return []
  // Bound both row count and individual SQL values before loading them into JS.
  const rows = sql.exec(`SELECT substr(marker, 1, 4097) AS marker FROM ${ALARM_MARKER_TABLE} ORDER BY execution_id LIMIT 257`).toArray()
  if (rows.length > 256 || rows.some(row => new TextEncoder().encode(String(row.marker)).byteLength > 4096)) throw new SnapshotFailure({ code: "snapshot_metadata_too_large" })
  return rows.map(row => String(row.marker))
}
/** On a KV-backed object the platform's `sql` getter itself throws; such an object cannot hold markers. */
export const sqlOf = (storage: { readonly sql?: MarkerSql } | undefined): MarkerSql | undefined => {
  try { return storage?.sql } catch { return undefined }
}
interface ExportContext {
  readonly id: { readonly toString: () => string }
  readonly storage: SnapshotStorage
  readonly blockConcurrencyWhile: <T>(body: () => Promise<T>) => Promise<T>
}
interface LegacyObject {
  fetch(request: Request): Promise<Response>
  alarm?(info?: { readonly retryCount?: number }): Promise<void>
}
type LegacyClass = new (ctx: ExportContext, env: MaintenanceEnv) => LegacyObject

const Input = z.object({ binding: z.enum(EXPORT_BINDINGS), objectId: z.string().regex(/^[a-f0-9]{64}$/), migrationId: z.uuid(),
  page: z.object({ cursor: z.string().min(1).max(CURSOR_BYTES).nullable() }).strict().optional() }).strict()
const Cursor = z.object({ scanId: z.uuid(), index: z.number().int().min(1).max(1_000_000), after: z.string(),
  entriesThrough: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), previousSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  stateSHA256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
type ExportInput = z.infer<typeof Input>
const response = (status: number, code: string) => Response.json({ code }, { status, headers: { "cache-control": "no-store" } })
const enabled = (env: ExportSettings): boolean => {
  const expires = Date.parse(env.SMITHERS_EXPORT_EXPIRES_AT ?? "")
  const remaining = expires - Date.now()
  return remaining > 0 && remaining <= 86_400_000 && !!env.SMITHERS_EXPORT_RECIPIENT &&
    /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64})$/.test(env.SMITHERS_EXPORT_SOURCE_REVISION ?? "") &&
    z.uuid().safeParse(env.SMITHERS_EXPORT_SOURCE_VERSION).success
}
const authorized = (request: Request, env: ExportSettings) =>
  enabled(env) ? authenticatedExport(request.headers.get("authorization"), env.SMITHERS_EXPORT_TOKEN) : Effect.succeed(false)

const decode = (request: Request) => readBoundedJson(request, CURSOR_BYTES + 2048).pipe(
  Effect.flatMap(body => {
    const parsed = Input.safeParse(body)
    return parsed.success ? Effect.succeed(parsed.data) : Effect.fail(new SnapshotFailure({ code: "invalid_export_request" }))
  }),
  Effect.catch(() => Effect.fail(new SnapshotFailure({ code: "invalid_export_request" })))
)

const objectSnapshot = (ctx: ExportContext, env: ExportSettings, binding: string, request: Request) => Effect.gen(function* () {
  if (!(yield* authorized(request, env))) return response(404, "not_found")
  const input = yield* decode(request)
  if (input.binding !== binding || input.objectId !== ctx.id.toString()) return response(409, "export_object_mismatch")
  if (input.page) return yield* objectPage(ctx, env, input)
  const storage = storageFrom(ctx.storage)
  const alarm = yield* Effect.tryPromise({ try: () => ctx.storage.getAlarm(), catch: () => new SnapshotFailure({ code: "snapshot_read_failed" }) })
  const entries: Array<readonly [string, unknown]> = []
  let cursor: string | undefined, bytes = 0
  for (;;) {
    // A SQLite value can be 2 MB; loading 64 at once can exhaust an isolate before encoding.
    const page = yield* storage.list<unknown>({ prefix: "", limit: 8, ...(cursor !== undefined ? { startAfter: cursor } : {}) })
    for (const [key, value] of page) {
      const encoded = yield* Effect.try({ try: () => encodeStored(value), catch: () => new SnapshotFailure({ code: "unsupported_storage_value" }) })
      bytes += new TextEncoder().encode(JSON.stringify([key, encoded])).byteLength
      if (bytes > 8_000_000 || entries.length >= 50_000) return response(413, "snapshot_requires_paged_export")
      entries.push([key, encoded])
      cursor = key
    }
    if (page.size < 8) break
  }
  const recipient = yield* Effect.try({ try: () => JSON.parse(env.SMITHERS_EXPORT_RECIPIENT!) as JsonWebKey, catch: () => new SnapshotFailure({ code: "invalid_export_recipient" }) })
  const sealed = yield* sealSnapshot({ version: 1, schema: "smithers-do-storage/v1", keyVersion: binding === "MODEL_VAULTS" ? "model-vault:v1" : null,
    binding: input.binding, objectId: input.objectId, migrationId: input.migrationId, sourceRevision: env.SMITHERS_EXPORT_SOURCE_REVISION!, sourceVersion: env.SMITHERS_EXPORT_SOURCE_VERSION!, capturedAt: new Date().toISOString() },
    { entries, alarm, cutoverAlarmMarkers: yield* Effect.try({ try: () => alarmMarkers(ctx.storage), catch: () => new SnapshotFailure({ code: "snapshot_read_failed" }) }), ...(binding === "MODEL_VAULTS" ? { migrationContext: { keyVersion: "model-vault:v1", modelVaultKey: env.MODEL_VAULT_KEY ?? null } } : {}) }, recipient)
  return Response.json(sealed, { headers: { "cache-control": "no-store" } })
}).pipe(Effect.catch(() => Effect.succeed(response(503, "snapshot_unavailable"))))

/** One bounded, object-serialized page. A cursor never claims a mutable scan is atomic. */
const objectPage = (ctx: ExportContext, env: ExportSettings, input: ExportInput) => Effect.gen(function* () {
  const provenance = { migrationId: input.migrationId, binding: input.binding, objectId: input.objectId,
    sourceRevision: env.SMITHERS_EXPORT_SOURCE_REVISION!, sourceVersion: env.SMITHERS_EXPORT_SOURCE_VERSION! }
  const aad = JSON.stringify({ protocol: "smithers-do-storage-page/v2", ...provenance, recipient: env.SMITHERS_EXPORT_RECIPIENT, expires: env.SMITHERS_EXPORT_EXPIRES_AT })
  const prior = input.page!.cursor === null ? null : yield* snapshotCursor(env.SMITHERS_EXPORT_TOKEN!, aad, { open: input.page!.cursor }).pipe(
    Effect.flatMap(text => Effect.try({ try: () => Cursor.parse(JSON.parse(text)), catch: () => new SnapshotFailure({ code: "invalid_export_cursor" }) })))
  const alarm = yield* Effect.tryPromise({ try: () => ctx.storage.getAlarm(), catch: () => new SnapshotFailure({ code: "snapshot_read_failed" }) })
  const header = { alarm, cutoverAlarmMarkers: yield* Effect.try({ try: () => alarmMarkers(ctx.storage), catch: () => new SnapshotFailure({ code: "snapshot_read_failed" }) }),
    ...(input.binding === "MODEL_VAULTS" ? { migrationContext: { keyVersion: "model-vault:v1" as const, modelVaultKey: env.MODEL_VAULT_KEY ?? null } } : {}) }
  const headerJSON = JSON.stringify(header)
  const stateSHA256 = yield* snapshotDigest(headerJSON)
  // Alarms may be delivered between pages; a changed marker forces a new scan.
  if (prior && prior.stateSHA256 !== stateSHA256) return response(409, "snapshot_metadata_changed")
  let bytes = new TextEncoder().encode(headerJSON).byteLength + 16
  if (bytes > PAGE_BYTES / 2) return response(413, "snapshot_metadata_too_large")
  const storage = storageFrom(ctx.storage), entries: Array<readonly [string, unknown]> = []
  let after = prior?.after, complete = false
  // The extra read distinguishes a final full page from a truncated stream.
  for (let reads = 0; reads <= PAGE_ENTRIES; reads++) {
    const row = yield* storage.list<unknown>({ prefix: "", limit: 1, ...(after === undefined ? {} : { startAfter: after }) })
    if (row.size === 0) { complete = true; break }
    if (row.size !== 1) return response(503, "snapshot_storage_order_invalid")
    const [key, value] = row.entries().next().value!
    if (after !== undefined && compareStorageKeys(key, after) <= 0) return response(503, "snapshot_storage_order_invalid")
    if (entries.length === PAGE_ENTRIES) break
    const encoded = yield* Effect.try({ try: () => encodeStored(value), catch: () => new SnapshotFailure({ code: "unsupported_storage_value" }) })
    const size = new TextEncoder().encode(JSON.stringify([key, encoded])).byteLength + 1
    if (bytes + size > PAGE_BYTES) {
      if (entries.length === 0) return response(413, "snapshot_entry_exceeds_page_limit")
      break
    }
    entries.push([key, encoded]); bytes += size; after = key
  }
  const metadata: PageMetadata = { version: 2, schema: "smithers-do-storage-page/v2", keyVersion: input.binding === "MODEL_VAULTS" ? "model-vault:v1" : null,
    ...provenance, capturedAt: new Date().toISOString(), page: { scanId: prior?.scanId ?? crypto.randomUUID(), index: prior?.index ?? 0,
      previousSHA256: prior?.previousSHA256 ?? null, entriesBefore: prior?.entriesThrough ?? 0, entriesThrough: (prior?.entriesThrough ?? 0) + entries.length,
      complete, consistency: "unfenced" } }
  const recipient = yield* Effect.try({ try: () => JSON.parse(env.SMITHERS_EXPORT_RECIPIENT!) as JsonWebKey, catch: () => new SnapshotFailure({ code: "invalid_export_recipient" }) })
  const snapshot = yield* sealSnapshot(metadata, { entries, ...header }, recipient)
  const cursor = complete ? null : yield* snapshotCursor(env.SMITHERS_EXPORT_TOKEN!, aad, { seal: JSON.stringify({ scanId: metadata.page.scanId,
    index: metadata.page.index + 1, after, entriesThrough: metadata.page.entriesThrough, previousSHA256: yield* snapshotDigest(JSON.stringify(snapshot)), stateSHA256 }) })
  if (cursor && cursor.length > CURSOR_BYTES) return response(413, "snapshot_cursor_too_large")
  return Response.json({ snapshot, cursor }, { headers: { "cache-control": "no-store" } })
}).pipe(Effect.catch(error => Effect.succeed(response(error instanceof SnapshotFailure && error.code === "invalid_export_cursor" ? 409 : 503,
  error instanceof SnapshotFailure && error.code === "invalid_export_cursor" ? "invalid_export_cursor" : "snapshot_unavailable"))))

/** Inherit every legacy RPC, WebSocket hook and alarm; override only the temporary fetch path. */
export const withSealedExport = (Legacy: LegacyClass, binding: typeof EXPORT_BINDINGS[number]) => class extends Legacy {
  constructor(private readonly snapshotContext: ExportContext, private readonly exportEnv: MaintenanceEnv) {
    super(snapshotContext, exportEnv)
  }
  fetch(request: Request): Promise<Response> { // effect-policy: boundary
    if (new URL(request.url).pathname !== EXPORT_PATH) return super.fetch(request)
    return this.snapshotContext.blockConcurrencyWhile(() => runDurable(objectSnapshot(this.snapshotContext, this.exportEnv, binding, request)))
  }
}

interface ByIdNamespace {
  readonly idFromString: (id: string) => unknown
  readonly get: (id: unknown) => { readonly fetch: (request: Request) => Promise<Response> }
}

/** Temporary operator-only ciphertext export. No user cookie, OAuth token, or product bearer grants it. */
export const maintenanceExport = (request: Request, env: MaintenanceEnv): Promise<Response> => runRequest(Effect.gen(function* () {
  if (!(yield* authorized(request, env))) return response(404, "not_found")
  if (request.method !== "POST") return response(405, "method_not_allowed")
  const input: ExportInput = yield* decode(request)
  const namespace = (env as unknown as Record<string, ByIdNamespace | undefined>)[input.binding]
  if (!namespace || typeof namespace.idFromString !== "function") return response(503, "export_binding_unavailable")
  return yield* Effect.tryPromise({
    try: () => namespace.get(namespace.idFromString(input.objectId)).fetch(new Request(`https://state-export.internal${EXPORT_PATH}`, {
      method: "POST", headers: { authorization: `Bearer ${env.SMITHERS_EXPORT_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(input)
    })),
    catch: () => new SnapshotFailure({ code: "snapshot_unavailable" })
  })
}).pipe(Effect.catch(() => Effect.succeed(response(503, "snapshot_unavailable")))), request.signal)

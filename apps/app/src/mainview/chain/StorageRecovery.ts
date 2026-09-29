import { Data } from "effect"
import { PERSISTED_KEY_PREFIX, SCHEMA_QUARANTINE_PREFIX } from "./SchemaVersion"
import type { SqliteRowDatabase } from "./SqliteRowStorage"
import { PRIVACY_RETIREMENT_KEY, RESET_ERASURE_OUTBOX_KEY } from "./PrivacyRetirement"

/** A local recovery artifact, not a database restore command or a telemetry payload. */
export interface StorageRecoverySnapshot {
  readonly format: "smithers-ui-recovery"
  readonly version: 1
  readonly capturedAt: string
  /** The session exporting this file; never a claim that two backends were merged. */
  readonly session?: "unopened" | "opfs" | "localStorage" | "memory"
  /** Browser APIs not available to this capture, distinguished from an absent database. */
  readonly unavailable?: ReadonlyArray<"localStorage" | "sqlite">
  readonly localStorage?: ReadonlyArray<{ readonly key: string; readonly value: string }>
  readonly sqlite?: ReadonlyArray<RecoveryTable>
  readonly memory?: ReadonlyArray<{ readonly key: string; readonly value: string }>
}

export type RecoveryCell =
  | { readonly type: "null" }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "text-bytes"; readonly hex: string }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "integer"; readonly value: string }
  | { readonly type: "blob"; readonly hex: string }

export interface RecoveryTable {
  readonly name: string
  readonly sql: string | null
  readonly columns: ReadonlyArray<string>
  readonly rows: ReadonlyArray<ReadonlyArray<RecoveryCell>>
}

export interface EnumerableRecoveryStorage {
  readonly length: number
  readonly key: (index: number) => string | null
  readonly getItem: (key: string) => string | null
}

export class StorageRecoveryError extends Data.TaggedError("StorageRecoveryError")<{
  readonly code: "limit" | "unreadable" | "changed"
  readonly message: string
}> {
  constructor(code: "limit" | "unreadable" | "changed") {
    super({
      code,
      message: code === "limit"
        ? "The local recovery snapshot exceeds its safety limit. No partial download was produced and saved data was not reset."
        : code === "changed"
        ? "Local storage changed while preparing recovery. Retry when other Smithers tabs are idle. Saved data was not reset."
        : "The local recovery snapshot could not be read completely. No partial download was produced and saved data was not reset."
    })
  }
}

export const RECOVERY_MAX_BYTES = 64 * 1024 * 1024
const MAX_TABLES = 128
const PAGE_ROWS = 256

/** Size accounting bounds the complete artifact; it never silently truncates a table or value. */
class RecoveryBudget {
  private used = 0
  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new StorageRecoveryError("limit")
  }
  add(value: unknown): void {
    this.used += new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (this.used > this.maxBytes) throw new StorageRecoveryError("limit")
  }
  get remaining(): number {
    return this.maxBytes - this.used
  }
}

/** Only app-owned live/legacy/quarantine namespaces; never a browser-wide storage dump. */
export const readLocalStorageRecovery = (
  storage: EnumerableRecoveryStorage,
  maxBytes = RECOVERY_MAX_BYTES
): ReadonlyArray<{ readonly key: string; readonly value: string }> => {
  const scan = () => {
    const budget = new RecoveryBudget(maxBytes)
    const keys = new Set<string>()
    const length = storage.length
    if (!Number.isSafeInteger(length) || length < 0) throw new StorageRecoveryError("unreadable")
    if (length > 100_000) throw new StorageRecoveryError("limit")
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index)
      if (key !== null && key !== PRIVACY_RETIREMENT_KEY && key !== RESET_ERASURE_OUTBOX_KEY && (key.startsWith(PERSISTED_KEY_PREFIX) || key.startsWith(SCHEMA_QUARANTINE_PREFIX))) {
        keys.add(key)
      }
    }
    return [...keys].sort().map((key) => {
      const value = storage.getItem(key)
      if (value === null) throw new StorageRecoveryError("changed")
      const entry = { key, value }
      budget.add(entry)
      return entry
    })
  }
  const first = scan()
  // localStorage has no read transaction. Refuse observable concurrent edits
  // instead of claiming a mixed set of keys is one committed snapshot.
  const second = scan()
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new StorageRecoveryError("changed")
  return first
}

const identifier = (name: string): string => {
  if (name.includes("\0")) throw new StorageRecoveryError("unreadable")
  return `"${name.replaceAll("\"", "\"\"")}"`
}

const hexBytes = (value: Uint8Array, remaining: number): string => {
  if (value.byteLength * 2 > remaining) throw new StorageRecoveryError("limit")
  let hex = ""
  for (let offset = 0; offset < value.length; offset += 8192) {
    hex += Array.from(value.subarray(offset, offset + 8192), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  return hex
}

const cell = (type: unknown, value: unknown, remaining: number): RecoveryCell => {
  if (type === "null" && value === null) return { type: "null" }
  if (type === "text" && value instanceof Uint8Array) {
    if (value.byteLength > remaining) throw new StorageRecoveryError("limit")
    try {
      // Read text as bytes so malformed UTF-8 is not silently replaced by the
      // driver's string decoder. A valid leading BOM is content, not framing.
      return { type: "text", value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value) }
    } catch {
      return { type: "text-bytes", hex: hexBytes(value, remaining) }
    }
  }
  if (type === "integer" && typeof value === "string" && /^-?\d+$/.test(value)) return { type: "integer", value }
  if (type === "real" && typeof value === "number" && Number.isFinite(value)) {
    return { type: "number", value }
  }
  if (type === "blob" && value instanceof Uint8Array) {
    return { type: "blob", hex: hexBytes(value, remaining) }
  }
  throw new StorageRecoveryError("unreadable")
}

/**
 * Read raw cells, schema text and every table under one SQLite read transaction.
 * Never invokes application schemas, migrations, quarantine or repair. The
 * caller must own/serialize use of this connection for the whole operation.
 * This is a logical recovery dump, not a byte-for-byte SQLite backup.
 */
export const readSqliteRecovery = async (
  database: SqliteRowDatabase,
  maxBytes = RECOVERY_MAX_BYTES
): Promise<ReadonlyArray<RecoveryTable>> => {
  const budget = new RecoveryBudget(maxBytes)
  await database.execute("BEGIN DEFERRED")
  try {
    const catalog = await database.execute<{ readonly name: unknown; readonly sql: unknown }>(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT ${MAX_TABLES + 1}`
    )
    if (catalog.length > MAX_TABLES) throw new StorageRecoveryError("limit")
    const tables: RecoveryTable[] = []
    for (const table of catalog) {
      if (typeof table.name !== "string" || (typeof table.sql !== "string" && table.sql !== null)) {
        throw new StorageRecoveryError("unreadable")
      }
      const name = identifier(table.name)
      const info = await database.execute<{ readonly name: unknown }>(`PRAGMA table_info(${name})`)
      if (info.length === 0 || info.some((column) => typeof column.name !== "string")) {
        throw new StorageRecoveryError("unreadable")
      }
      const columns = info.map((column) => column.name as string)
      budget.add({ name: table.name, sql: table.sql, columns })
      // Bound raw table bytes before selecting cells: pagination alone cannot
      // protect the browser from one enormous BLOB/text cell. The final encoded
      // artifact is checked separately because JSON/hex add overhead.
      const measured = await database.execute<{ readonly size: unknown }>(
        `SELECT COALESCE(SUM(${
          columns.map((column) => `COALESCE(length(CAST(recovery_source.${identifier(column)} AS BLOB)), 0)`).join(
            " + "
          )
        }), 0) AS size FROM ${name} AS recovery_source`
      )
      const size = measured[0]?.size
      if (
        (typeof size !== "number" && typeof size !== "bigint") ||
        (typeof size === "number" && !Number.isSafeInteger(size)) || size < 0 || size > maxBytes
      ) throw new StorageRecoveryError("limit")
      const rows: RecoveryCell[][] = []
      // Cast integer values inside SQLite, before the driver can round them to
      // JavaScript numbers. Fixed aliases also preserve unusual column names
      // such as __proto__ in drivers that build their result as plain objects.
      const projection = columns.map((column, index) => {
        // Qualification prevents SQLite's double-quoted-string fallback from
        // turning an unreadable/missing identifier into fabricated cell text.
        const quoted = `recovery_source.${identifier(column)}`
        return `typeof(${quoted}) AS recovery_type_${index}, CASE typeof(${quoted}) WHEN 'integer' THEN CAST(${quoted} AS TEXT) WHEN 'text' THEN CAST(${quoted} AS BLOB) ELSE ${quoted} END AS recovery_value_${index}`
      }).join(", ")
      for (let offset = 0;; offset += PAGE_ROWS) {
        const page = await database.execute<Record<string, unknown>>(
          `SELECT ${projection} FROM ${name} AS recovery_source LIMIT ${PAGE_ROWS} OFFSET ${offset}`
        )
        for (const row of page) {
          const encoded = columns.map((_, index) =>
            cell(row[`recovery_type_${index}`], row[`recovery_value_${index}`], budget.remaining)
          )
          budget.add(encoded)
          rows.push(encoded)
        }
        if (page.length < PAGE_ROWS) break
      }
      tables.push({ name: table.name, sql: table.sql, columns, rows })
    }
    return tables
  } finally {
    await database.execute("ROLLBACK")
  }
}

/** The final whole-file limit includes both stores and JSON/container overhead. */
export const encodeStorageRecovery = (snapshot: StorageRecoverySnapshot, maxBytes = RECOVERY_MAX_BYTES): string => {
  const budget = new RecoveryBudget(maxBytes)
  budget.add(snapshot)
  return JSON.stringify(snapshot)
}

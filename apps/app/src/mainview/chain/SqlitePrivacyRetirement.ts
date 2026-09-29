import type { SqliteRowDatabase } from "./SqliteRowStorage"
import { PrivacyAuthorityMissing } from "./PrivacyRetirement"

const quote = (name: string): string => {
  if (name.includes("\0")) throw new PrivacyAuthorityMissing()
  return `"${name.replaceAll('"', '""')}"`
}
/** This connection must name the app-owned database, never an arbitrary user database. */
export const eraseSqliteRecoveryCopies = async (
  database: SqliteRowDatabase,
  keep?: { readonly metadata: ReadonlyMap<string, string>;
    readonly rows: ReadonlyArray<readonly [string, string, string, string]> }
): Promise<void> => {
  await database.execute("BEGIN IMMEDIATE")
  try {
    const tables = await database.execute<{ readonly name: unknown; readonly type: unknown }>("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY type DESC, name")
    for (const { name, type } of tables) {
      if (typeof name !== "string") throw new PrivacyAuthorityMissing()
      if (name.startsWith("sqlite_")) {
        // ANALYZE samples can retain old row values even after DELETE. These
        // internal tables cannot be dropped, but their logical rows can go.
        if (name !== "sqlite_sequence" && !/^sqlite_stat[1-4]$/.test(name)) throw new PrivacyAuthorityMissing()
        await database.execute(`DELETE FROM ${quote(name)}`)
      } else {
        if (type !== "table" && type !== "view") throw new PrivacyAuthorityMissing()
        await database.execute(`DROP ${type === "view" ? "VIEW" : "TABLE"} ${quote(name)}`)
      }
    }
    if (keep !== undefined) {
      // Recreate the fixed owned schema too: old extra columns, defaults,
      // triggers and index samples must not recreate retired payloads.
      await database.execute("CREATE TABLE smithers_collection_rows (collection_id TEXT NOT NULL, row_key TEXT NOT NULL, version_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection_id, row_key))")
      await database.execute("CREATE TABLE smithers_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      for (const row of keep.rows) await database.execute("INSERT INTO smithers_collection_rows (collection_id, row_key, version_key, value) VALUES (?, ?, ?, ?)", row)
      for (const [key, value] of keep.metadata) await database.execute("INSERT INTO smithers_metadata (key, value) VALUES (?, ?)", [key, value])
    }
    await database.execute("COMMIT")
  } catch (error) {
    await database.execute("ROLLBACK")
    throw error
  }
}

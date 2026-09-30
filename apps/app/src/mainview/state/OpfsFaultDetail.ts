/*
 * Content-free detail for an OPFS open or write failure (#3113, #3133).
 *
 * The OPFS worker reports a SQLite failure as message text only; its numeric
 * result code is dropped. The generic SQLite result strings below are a fixed
 * vocabulary, so an exact match names the result class without reading any
 * statement, row, path or credential. Anything else is "other".
 */
export type SqliteFault =
  | "io" | "busy" | "full" | "cantopen" | "corrupt" | "readonly" | "nomem"
  | "nested-transaction" | "no-transaction" | "other"

const SQLITE_RESULTS: ReadonlyMap<string, SqliteFault> = new Map([
  ["disk I/O error", "io"],
  ["database is locked", "busy"],
  ["database or disk is full", "full"],
  ["unable to open database file", "cantopen"],
  ["database disk image is malformed", "corrupt"],
  ["attempt to write a readonly database", "readonly"],
  ["out of memory", "nomem"],
  ["cannot start a transaction within a transaction", "nested-transaction"],
  ["cannot commit - no transaction is active", "no-transaction"],
  ["cannot rollback - no transaction is active", "no-transaction"]
])

export const sqliteFault = (error: unknown): SqliteFault => {
  if (typeof error !== "object" || error === null) return "other"
  const message = (error as { readonly message?: unknown }).message
  return typeof message === "string" ? SQLITE_RESULTS.get(message) ?? "other" : "other"
}

/** The Web Lock wa-sqlite's OPFSCoopSyncVFS holds while a context owns the database's access handles. */
export const OPFS_HANDLE_LOCK = "ahp:/smithers-mvp.sqlite"

/**
 * Who holds the database's access handles when a failure is reported. A held
 * handle lock says another context (a closing page's worker or another tab)
 * still owns the file; none held points at the file system itself. Counts
 * only: lock client ids are never reported.
 */
export type OpfsHandleContention = { readonly held: number; readonly waiting: number } | "unknown"

export interface OpfsLockQuery {
  readonly query: () => Promise<{
    readonly held?: ReadonlyArray<{ readonly name?: string }>
    readonly pending?: ReadonlyArray<{ readonly name?: string }>
  }>
}

export const opfsHandleContention = async (
  locks: OpfsLockQuery | undefined = globalThis.navigator?.locks
): Promise<OpfsHandleContention> => {
  if (locks === undefined || typeof locks.query !== "function") return "unknown"
  try {
    const snapshot = await locks.query()
    const count = (entries: ReadonlyArray<{ readonly name?: string }> | undefined) =>
      (entries ?? []).filter(entry => entry.name === OPFS_HANDLE_LOCK).length
    return { held: count(snapshot.held), waiting: count(snapshot.pending) }
  } catch {
    return "unknown"
  }
}

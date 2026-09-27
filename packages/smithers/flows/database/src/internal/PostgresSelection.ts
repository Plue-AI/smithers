/** Native configuration selection shared by Node and Bun.
 * @since 1.0.0
 */
import { Effect, Layer } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"

/** Recognizes PostgreSQL connection strings.
 * @since 1.0.0
 * @private
 */
export const isUrl = (value: string): boolean => /^postgres(?:ql)?:\/\//.test(value)

/** Explicit URLs select one schema; environment selection preserves each local store's identity.
 * @since 1.0.0
 * @private
 */
export const layer = (filename: string): Layer.Layer<SqlClient> | undefined => {
  const explicit = isUrl(filename)
  const url = explicit ? filename : process.env.SMITHERS_POSTGRES_URL?.trim() || process.env.DATABASE_URL?.trim()
  if (!url && process.env.SMITHERS_BACKEND === "postgres") {
    throw new Error("PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL")
  }
  if (!url || (!explicit && process.env.SMITHERS_BACKEND === "sqlite")) return undefined
  if (!isUrl(url)) throw new Error("PostgreSQL configuration requires a postgres:// or postgresql:// URL")
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("Invalid PostgreSQL connection URL")
  }
  const schema = explicit ?
    parsed.searchParams.get("schema") ?? "smithers_flows"
    : process.env.SMITHERS_POSTGRES_SCHEMA
    ? `${process.env.SMITHERS_POSTGRES_SCHEMA}_${basename(filename).replaceAll(/[^a-zA-Z0-9_]/g, "_")}`
    : `smithers_${createHash("sha256").update(resolve(filename)).digest("hex").slice(0, 32)}`
  parsed.searchParams.delete("schema")
  return Layer.unwrap(
    Effect.promise(() => import("../postgres/PostgresDatabase.ts")).pipe(
      Effect.map((database) => database.layer({ url: parsed.toString(), schema }))
    )
  )
}

/** Real child stores use the matrix backend, with an isolated identity per journal. */
import { dropSchema } from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import * as TestStores from "../../src/test/TestStores.ts"

export const remoteTestDatabases = (directory: string) => {
  const url = process.env.SMITHERS_TEST_PG_URL
  const identities = new Map<string, { filename: string; schema?: string }>()
  const filename = (name: string): string => {
    const existing = identities.get(name)
    if (existing) return existing.filename
    if (!url) {
      const value = join(directory, `${name}.sqlite`)
      identities.set(name, { filename: value })
      console.log(JSON.stringify({ event: "child-store", name, backend: "sqlite", filename: value }))
      return value
    }
    const schema = `remote_${randomUUID().replaceAll("-", "")}`
    const value = new URL(url)
    value.searchParams.set("schema", schema)
    identities.set(name, { filename: value.toString(), schema })
    console.log(JSON.stringify({ event: "child-store", name, backend: "postgres", schema }))
    return value.toString()
  }
  const close = async (): Promise<void> => {
    for (const identity of identities.values()) {
      if (!identity.schema) continue
      const schema = identity.schema
      await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* dropSchema(sql, schema)
        }).pipe(Effect.provide(TestStores.databaseAt(identity.filename)))
      ))
      console.log(JSON.stringify({ event: "child-store-retired", backend: "postgres", schema }))
    }
  }
  return { filename, close }
}

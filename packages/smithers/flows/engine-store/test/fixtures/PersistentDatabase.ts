/** Persistent identity shared by independent processes in the storage matrix. */
import * as PostgresDatabase from "@smthrs/database/postgres/PostgresDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { randomUUID } from "node:crypto"

export const filename = (sqlitePath: string): string => {
  if (!process.env.SMITHERS_TEST_PG_URL) return sqlitePath
  const url = new URL(process.env.SMITHERS_TEST_PG_URL)
  url.searchParams.set("schema", `test_restart_${randomUUID().replaceAll("-", "")}`)
  return url.toString()
}

export const remove = async (filename: string): Promise<void> => {
  if (!/^postgres(?:ql)?:/.test(filename)) return
  const url = new URL(filename)
  const schema = url.searchParams.get("schema")!
  url.searchParams.delete("schema")
  await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* TestDatabase.dropSchema(sql, schema)
    }).pipe(Effect.provide(PostgresDatabase.layer({ url: url.toString(), schema })))
  )
}

import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Result from "effect/Result"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelError } from "../src/TimeTravelError.ts"

const messages = (value: unknown): ReadonlyArray<string> => {
  const found: Array<string> = []
  const seen = new Set<unknown>()
  let current = value
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const message = (current as { readonly message?: unknown }).message
    if (typeof message === "string") found.push(message)
    current = (current as { readonly cause?: unknown }).cause
  }
  return found
}

describe("SqlTimeTravelStore migration failures", () => {
  it.effect("fails with a typed error that retains the driver failure", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.gen(function*() {
          yield* EngineMigrations.run
          const sql = yield* Effect.service(SqlClient.SqlClient)
          yield* sql`CREATE VIEW flows_time_travel_audits AS SELECT 1`
          yield* SqlTimeTravelStore.make
        }).pipe(
          Effect.provide(TestDatabase.layer),
          Effect.provide(DurableWriter.layerNoop)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Result.isFailure(Cause.findDefect(exit.cause))).toBe(true)
        const found = Cause.findError(exit.cause)
        expect(Result.isSuccess(found)).toBe(true)
        if (Result.isSuccess(found)) {
          expect(found.success).toBeInstanceOf(TimeTravelError)
          expect(found.success).toMatchObject({
            code: "unknown",
            message: "time-travel schema migration failed"
          })
          expect(messages(found.success).join(" ")).toContain("flows_time_travel_audits")
          // The step that named the SQL object is itself a tagged error with a code.
          const causes: Array<unknown> = []
          for (let current: unknown = found.success; typeof current === "object" && current !== null;) {
            causes.push(current)
            current = (current as { readonly cause?: unknown }).cause
          }
          expect(causes).toContainEqual(
            expect.objectContaining({
              _tag: "@smthrs/time-travel/TimeTravelError",
              code: "unknown",
              message: expect.stringContaining("time-travel migration failed creating")
            })
          )
        }
      }
    }))
})

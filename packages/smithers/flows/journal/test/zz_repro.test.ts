import { expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { inspect } from "node:util"
import { Journal } from "../src/Journal.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"

const layer = SqlJournal.layer({ capacity: 8, overflow: "reject" }).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
) as Layer.Layer<Journal | DurableWriter | SqlClient.SqlClient>

it.effect("repro", () => Effect.gen(function*() {
  const journal = yield* Journal
  const f = yield* Effect.flip(journal.emitDurableUnfenced({ runId: "r", sourceId: "s", eventType: "", payload: { note: "UNREDACTED-SECRET-123" } } as any))
  process.stderr.write(JSON.stringify([f.message, inspect(f, { depth: 20 }).includes("UNREDACTED-SECRET-123"), JSON.stringify(f).includes("UNREDACTED-SECRET-123"), String((f as any).cause).includes("UNREDACTED")])+"\n")
  const g = yield* Effect.flip(journal.emitDurableUnfenced({ runId: "r", sourceId: "s", eventType: "x", payload: { note: "UNREDACTED-SECRET-123", n: 1n } } as any))
  process.stderr.write(JSON.stringify([g.message, inspect(g, { depth: 20 }).includes("UNREDACTED-SECRET-123")])+"\n")
}).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())))

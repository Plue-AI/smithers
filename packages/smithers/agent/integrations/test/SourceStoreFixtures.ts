import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as Migrations from "../src/core/Migrations.ts"
import type { SourceRecord } from "../src/core/SourceRecord.ts"
import * as SourceStore from "../src/core/SourceStore.ts"

/** A generic chat record in `team-chat`, channel `c-general`. */
export const record = (overrides: Partial<SourceRecord> = {}): SourceRecord => ({
  provider: "example",
  connectionId: "team-chat",
  externalId: "m-1",
  kind: "message",
  url: "https://chat.example.test/m-1",
  author: { id: "u-1", label: "builder" },
  createdAtMs: 1_000,
  updatedAtMs: 1_000,
  version: null,
  retrievedAtMs: 2_000,
  access: { scope: "container", containerId: "c-general" },
  thread: { containerId: "c-general", threadId: null, parentId: null },
  text: "hello",
  deleted: false,
  payload: { text: "hello" },
  ...overrides
})

/** A record placed in `container` for both access and thread. */
export const inContainer = (container: string | null, overrides: Partial<SourceRecord> = {}): SourceRecord =>
  record({
    access: container === null
      ? { scope: "private", containerId: null }
      : { scope: "container", containerId: container },
    thread: { containerId: container, threadId: null, parentId: null },
    ...overrides
  })

/**
 * The real SQLite store over an in-memory database with the real migrations applied.
 *
 * The type is inferred, not asserted. A database or migration failure while
 * building it is a broken fixture, so `orDie` turns it into a defect rather
 * than a hand annotation hiding the `SqlError | MigrationError` channel.
 */
export const sqlLayer = Layer.orDie(Layer.provideMerge(
  SourceStore.layerSql,
  Layer.provideMerge(Migrations.layer, TestDatabase.layer)
))

/** Runs `effect` against a fresh store built from `layer`. */
export const runWith = <R>(layer: Layer.Layer<R>) => <A, E>(effect: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped))

/**
 * Never called; tsc checks it (#2704). Dropping the database provider from
 * {@link sqlLayer} must surface as an unmet `SqlClient`, not compile.
 */
export const unprovidedServiceProbe = () => {
  // @ts-expect-error without TestDatabase.layer nothing provides the SqlClient the store and migrations need
  runWith(Layer.orDie(Layer.provideMerge(SourceStore.layerSql, Migrations.layer)))
  runWith(sqlLayer)
}

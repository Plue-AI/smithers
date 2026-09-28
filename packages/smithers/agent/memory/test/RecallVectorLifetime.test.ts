import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Cause, Effect, Exit, Option, Scheduler, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { expect, it } from "vitest"
import * as MemoryError from "../src/MemoryError.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

// Exercise every cooperative release point of one real SQL vector read. The
// client adapter owns a copy of returned bytes: transferring a PostgreSQL
// driver's shared receive buffer would invalidate unrelated driver state.
const scanWithRelease = async (releaseAfter?: number) => {
  const state = {
    armed: false,
    steps: 0,
    queued: false,
    captures: 0,
    transfers: 0,
    bytes: undefined as Uint8Array<ArrayBuffer> | undefined,
    transferred: undefined as ArrayBuffer | undefined,
    transferFailure: undefined as unknown
  }
  const base = new Scheduler.MixedScheduler()
  const scheduler: Scheduler.Scheduler = {
    executionMode: "async",
    shouldYield: () => {
      if (!state.armed) return false
      state.steps++
      if (state.steps !== releaseAfter) return false
      state.queued = true
      return true
    },
    makeDispatcher: () => {
      const dispatcher = base.makeDispatcher()
      return {
        flush: () => dispatcher.flush(),
        scheduleTask: (task, priority) =>
          dispatcher.scheduleTask(() => {
            if (state.queued) {
              state.queued = false
              try {
                const buffer = state.bytes!.buffer
                state.transferred = structuredClone(buffer, { transfer: [buffer] })
                state.transfers++
              } catch (cause) {
                state.transferFailure = cause
              }
            }
            task()
          }, priority)
      }
    }
  }
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter
      const owningClient = new Proxy(sql, {
        apply(target, receiver, args) {
          const query: Effect.Effect<ReadonlyArray<Record<string, unknown>>, SqlError> = Reflect.apply(
            target,
            receiver,
            args
          )
          return query.pipe(Effect.map((rows) =>
            rows.map((row) => {
              if (!(row["vector_bytes"] instanceof Uint8Array)) return row
              const bytes = new Uint8Array(row["vector_bytes"])
              state.bytes = bytes
              state.captures++
              state.armed = true
              return { ...row, vector_bytes: bytes }
            })
          ))
        }
      })
      const source = Semantic.makeSqlVectorStore({ sql, write: writer.write })
      const reader = Semantic.makeSqlVectorStore({ sql: owningClient, write: writer.write })
      yield* source.upsert({
        bank: "flow-one",
        recordKind: "note",
        recordId: "key",
        model: "test",
        contentDigest: "original",
        dimensions: 2,
        vector: [1, 2],
        updatedAtMs: 1
      })
      const exit = yield* Effect.exit(Stream.runCollect(reader.scan(["flow-one"], "test")))
      state.armed = false
      const recovered = yield* Stream.runCollect(source.scan(["flow-one"], "test"))
      return { exit, recovered }
    }).pipe(Effect.provide(TestMemory.layerWithDatabase)),
    { scheduler }
  )
  return { ...result, state }
}

const expectOriginal = (pages: ReadonlyArray<ReadonlyArray<Semantic.Vector>>) => {
  expect(pages).toHaveLength(1)
  expect(pages[0]).toHaveLength(1)
  expect(pages[0]![0]).toMatchObject({
    bank: "flow-one",
    recordKind: "note",
    recordId: "key",
    model: "test",
    contentDigest: "original",
    dimensions: 2,
    updatedAtMs: 1
  })
  expect(Array.from(pages[0]![0]!.vector)).toEqual([1, 2])
}

it("preserves typed failures and recovery when SQL vector buffers are released at cooperative boundaries", async () => {
  const baseline = await scanWithRelease()
  expect(baseline.state.captures).toBe(1)
  expect(baseline.state.transfers).toBe(0)
  expect(Exit.isSuccess(baseline.exit)).toBe(true)
  if (Exit.isFailure(baseline.exit)) throw new Error(Cause.pretty(baseline.exit.cause))
  expectOriginal(baseline.exit.value)
  expectOriginal(baseline.recovered)
  // A finite scheduling exploration, derived from the successful operation
  // rather than depending on a particular Effect interpreter instruction.
  expect(baseline.state.steps).toBeGreaterThan(0)
  expect(baseline.state.steps).toBeLessThan(512)
  let invalidLength = 0
  let failedDecode = 0
  let copied = 0
  for (let releaseAfter = 1; releaseAfter <= baseline.state.steps; releaseAfter++) {
    const { exit, recovered, state } = await scanWithRelease(releaseAfter)
    expect(state.captures).toBe(1)
    expect(state.transferFailure).toBeUndefined()
    expect(state.transfers).toBe(1)
    expect(state.bytes!.byteLength).toBe(0)
    expect(Array.from(new Uint8Array(state.transferred!))).toEqual([0, 0, 128, 63, 0, 0, 0, 64])
    expectOriginal(recovered)
    if (Exit.isSuccess(exit)) {
      copied++
      expectOriginal(exit.value)
      continue
    }
    expect(Cause.hasDies(exit.cause)).toBe(false)
    const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause))
    expect(failure).toBeInstanceOf(MemoryError.MemoryError)
    expect(failure).toMatchObject({ code: "store", path: ["flow", "one", "note", "key", "test"] })
    expect([
      "stored memory vector flow/one note/key (model test) has invalid dimensions or byte length",
      "stored memory vector flow/one note/key (model test) could not be decoded"
    ]).toContain(failure.message)
    if (failure.message.endsWith("could not be decoded")) {
      failedDecode++
      expect(failure.cause).toBeInstanceOf(TypeError)
    } else invalidLength++
  }
  expect(invalidLength).toBeGreaterThan(0)
  expect(failedDecode).toBeGreaterThan(0)
  expect(copied).toBeGreaterThan(0)
})

import { describe, expect, it } from "@effect/vitest"
import { RunStoreError } from "@smthrs/run-store/RunStore"
import { Effect } from "effect"
import type * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import { coherentBatch } from "../src/internal/ExecutionSnapshotRead.ts"

const source = "0123456789abcdef0123456789abcdef"
const otherSource = "abcdef0123456789abcdef0123456789"

const observed: ExecutionSnapshot.Observed = {
  _tag: "Observed",
  runId: "present",
  source,
  revision: 2,
  status: "completed",
  flowName: "example",
  createdAtMs: 0,
  startedAtMs: 1,
  finishedAtMs: 2,
  parentRunId: null,
  lineageId: "present",
  roundOrdinal: 0,
  cancellation: { requestedAtMs: null, acknowledgement: null },
  waiting: null
}

const missing: ExecutionSnapshot.Missing = {
  _tag: "Missing",
  runId: "missing",
  source,
  revision: 3,
  deleted: false
}

const batch = (snapshots: ReadonlyArray<ExecutionSnapshot.Snapshot>): ExecutionSnapshot.Batch => ({
  source,
  revision: 3,
  snapshots
})

const rejected = (runIds: ReadonlyArray<string>, value: ExecutionSnapshot.Batch) =>
  Effect.gen(function*() {
    const error = yield* Effect.flip(coherentBatch(runIds, value))
    expect(error).toBeInstanceOf(RunStoreError)
    expect(error.code).toBe("persistence_failed")
  })

describe("coherent execution snapshot batches", () => {
  it.effect("preserves request order and duplicate observed and missing rows", () =>
    Effect.gen(function*() {
      const ids = ["missing", "present", "present", "deleted", "missing"] as const
      const deleted: ExecutionSnapshot.Missing = { ...missing, runId: "deleted", revision: 1, deleted: true }
      const value = batch([missing, observed, observed, deleted, missing])
      expect(yield* coherentBatch(ids, value)).toEqual(value)
    }))

  it.effect("accepts an empty batch at revision zero", () =>
    Effect.gen(function*() {
      const value: ExecutionSnapshot.Batch = { source, revision: 0, snapshots: [] }
      expect(yield* coherentBatch([], value)).toEqual(value)
    }))

  it.effect("accepts a row at the batch watermark and a missing row at revision zero", () =>
    Effect.gen(function*() {
      const value = batch([{ ...observed, revision: 3 }, { ...missing, revision: 0 }])
      expect(yield* coherentBatch(["present", "missing"], value)).toEqual(value)
    }))

  for (const invalidSource of ["", "0".repeat(31), "0".repeat(33), "g".repeat(32), "A".repeat(32)]) {
    it.effect(`rejects invalid batch source ${JSON.stringify(invalidSource)}`, () =>
      rejected([], { source: invalidSource, revision: 0, snapshots: [] }))
  }

  it.effect("rejects fewer rows than requested, including a missing duplicate", () =>
    rejected(["present", "present"], batch([observed])))

  it.effect("rejects more rows than requested", () =>
    rejected(["present"], batch([observed, observed])))

  it.effect("rejects rows returned for an empty request", () => rejected([], batch([observed])))

  it.effect("rejects rows in a different order", () =>
    rejected(["present", "missing"], batch([missing, observed])))

  it.effect("rejects an unrelated row even when the count matches", () =>
    rejected(["requested"], batch([observed])))

  for (const row of [observed, missing]) {
    it.effect(`rejects a ${row._tag} row from another source`, () =>
      rejected([row.runId], batch([{ ...row, source: otherSource }])))

    it.effect(`rejects a ${row._tag} row with a malformed source`, () =>
      rejected([row.runId], batch([{ ...row, source: "malformed" }])))

    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      it.effect(`rejects a ${row._tag} row with revision ${revision}`, () =>
        rejected([row.runId], batch([{ ...row, revision }])))
    }

    it.effect(`rejects a ${row._tag} row newer than the batch watermark`, () =>
      rejected([row.runId], batch([{ ...row, revision: 4 }])))
  }

  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it.effect(`rejects batch revision ${revision} even when there are no rows`, () =>
      rejected([], { source, revision, snapshots: [] }))
  }

  it.effect("accepts the maximum safe watermark and row revision", () =>
    Effect.gen(function*() {
      const value: ExecutionSnapshot.Batch = {
        source,
        revision: Number.MAX_SAFE_INTEGER,
        snapshots: [{ ...observed, revision: Number.MAX_SAFE_INTEGER }]
      }
      expect(yield* coherentBatch(["present"], value)).toEqual(value)
    }))
})

import { RunState } from "@smthrs/engine-store/RunState"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Clock, Effect, Result, Schema } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ClaimLost } from "../src/ControlError.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { durable, fileBundle } from "./DurableStack.ts"

const directory = mkdtempSync(join(tmpdir(), "control-engine-resume-scope-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const oldOwner = { hostId: "engine-host", pid: 101, nonce: "engine" }
const newOwner = { hostId: "control-host", pid: 202, nonce: "control" }
const state = Schema.decodeSync(RunState)({
  version: 1,
  flowName: "review/engine-child",
  payload: { valuable: "preserve" },
  parentExecutionId: "engine-parent",
  onParentExit: "cancel"
})

const later = (ms: number) =>
  Effect.map(Effect.clockWith(Effect.succeed), (clock): Clock.Clock => ({
    ...clock,
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + ms,
    currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + ms),
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n)
  }))

const resume = (spelling: "resume" | "run", runId: string, allowCodeDrift = false) =>
  Effect.gen(function*() {
    const control = yield* Control
    const input = { runId, idempotencyKey: `resume:${spelling}:${runId}`, allowCodeDrift }
    return yield* spelling === "resume"
      ? control.resume(input)
      : control.run({ _tag: "Resume", ...input })
  })

describe("public resume scope over durable engine rows", () => {
  it.each(
    [
      { spelling: "resume", allowCodeDrift: false },
      { spelling: "run", allowCodeDrift: false },
      { spelling: "resume", allowCodeDrift: true },
      { spelling: "run", allowCodeDrift: true }
    ] as const
  )(
    "preserves an unindexed running engine row after its owner dies ($spelling, drift=$allowCodeDrift)",
    async ({ spelling, allowCodeDrift }) => {
      const runId = `dead-engine-${spelling}-${allowCodeDrift}`
      const filename = join(directory, `${runId}.sqlite`)
      const observed = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          yield* store.create(runId, JSON.stringify(state))
          const pending = yield* store.get(runId)
          expect(yield* store.claimAndOwn(runId, pending, oldOwner, yield* Clock.currentTimeMillis))
            .toEqual({ _tag: "Activated" })
          const before = yield* store.get(runId)
          const clock = yield* later(60_000)
          const result = yield* Effect.result(
            resume(spelling, runId, allowCodeDrift).pipe(Effect.provideService(Clock.Clock, clock))
          )
          return { before, after: yield* store.get(runId), result }
        }).pipe(
          Effect.provide(durable({
            database: fileBundle(filename),
            owner: newOwner,
            isAlive: () => Effect.succeed(false)
          })),
          Effect.orDie
        )
      ))

      expect(observed.before.status).toBe("running")
      expect(Schema.is(RunState)(JSON.parse(observed.before.stateJson))).toBe(true)
      expect(observed.after).toEqual(observed.before)
      expect(Schema.is(RunState)(JSON.parse(observed.after.stateJson))).toBe(true)
      expect(Result.isFailure(observed.result)).toBe(true)
      if (Result.isFailure(observed.result)) expect(observed.result.failure).toBeInstanceOf(ClaimLost)
    }
  )

  it.each(["resume", "run"] as const)(
    "joins its own unindexed running engine row without changing it (%s)",
    async (spelling) => {
      const runId = `self-engine-${spelling}`
      const filename = join(directory, `${runId}.sqlite`)
      const observed = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          yield* store.create(runId, JSON.stringify(state))
          const pending = yield* store.get(runId)
          expect(yield* store.claimAndOwn(runId, pending, oldOwner, yield* Clock.currentTimeMillis))
            .toEqual({ _tag: "Activated" })
          const before = yield* store.get(runId)
          const result = yield* Effect.result(resume(spelling, runId))
          return { before, after: yield* store.get(runId), result }
        }).pipe(Effect.provide(durable({ database: fileBundle(filename), owner: oldOwner })), Effect.orDie)
      ))

      expect(observed.before.status).toBe("running")
      expect(observed.after).toEqual(observed.before)
      expect(Schema.is(RunState)(JSON.parse(observed.after.stateJson))).toBe(true)
      expect(Result.isSuccess(observed.result)).toBe(true)
      if (Result.isSuccess(observed.result)) expect(observed.result.success._tag).toBe("Accepted")
    }
  )

  it.each(["resume", "run"] as const)(
    "preserves an unindexed running engine row owned by a live peer (%s)",
    async (spelling) => {
      const runId = `live-engine-${spelling}`
      const filename = join(directory, `${runId}.sqlite`)
      const observed = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          yield* store.create(runId, JSON.stringify(state))
          const pending = yield* store.get(runId)
          expect(yield* store.claimAndOwn(runId, pending, oldOwner, yield* Clock.currentTimeMillis))
            .toEqual({ _tag: "Activated" })
          const before = yield* store.get(runId)
          const clock = yield* later(60_000)
          const result = yield* Effect.result(resume(spelling, runId).pipe(Effect.provideService(Clock.Clock, clock)))
          return { before, after: yield* store.get(runId), result }
        }).pipe(
          Effect.provide(durable({
            database: fileBundle(filename),
            owner: newOwner,
            isAlive: () => Effect.succeed(true)
          })),
          Effect.orDie
        )
      ))

      expect(Result.isFailure(observed.result)).toBe(true)
      if (Result.isFailure(observed.result)) expect(observed.result.failure).toBeInstanceOf(ClaimLost)
      expect(observed.after).toEqual(observed.before)
    }
  )

  it.each(["resume", "run"] as const)(
    "accepts resume while preserving an unindexed suspended engine row (%s)",
    async (spelling) => {
      const runId = `suspended-engine-${spelling}`
      const filename = join(directory, `${runId}.sqlite`)
      const observed = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          yield* store.create(runId, JSON.stringify(state))
          const pending = yield* store.get(runId)
          expect(yield* store.claimAndOwn(runId, pending, oldOwner, yield* Clock.currentTimeMillis))
            .toEqual({ _tag: "Activated" })
          expect(yield* store.transitionOwned(runId, oldOwner, "suspended"))
            .toEqual({ _tag: "Transitioned" })
          const before = yield* store.get(runId)
          const result = yield* resume(spelling, runId)
          return { before, after: yield* store.get(runId), result }
        }).pipe(Effect.provide(durable({ database: fileBundle(filename), owner: newOwner })), Effect.orDie)
      ))

      expect(observed.result._tag).toBe("Accepted")
      expect(observed.after).toEqual(observed.before)
    }
  )

  it.each(["resume", "run"] as const)(
    "recovers an indexed Control launch after its owner dies (%s)",
    async (spelling) => {
      const filename = join(directory, `indexed-${spelling}.sqlite`)
      const runId = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const card = yield* control.plan({ flowId: "system/test", input: {} })
          yield* control.approve({ ...card.approval, idempotencyKey: `approve:${spelling}` })
          const receipt = yield* control.run({
            _tag: "Plan",
            planId: card.planId,
            digest: card.digest,
            envelope: card.envelope,
            idempotencyKey: `launch:${spelling}`
          })
          if (!("runId" in receipt) || receipt.runId === undefined) return yield* Effect.die("missing run ID")
          yield* runtime.resume(receipt.runId)
          const fence = yield* runtime.claimFence(receipt.runId)
          yield* runtime.writeStatus(receipt.runId, fence, "running")
          return receipt.runId
        }).pipe(Effect.provide(durable({ database: fileBundle(filename), owner: oldOwner })), Effect.orDie)
      ))

      const observed = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const before = yield* store.get(runId)
          const clock = yield* later(60_000)
          const receipt = yield* resume(spelling, runId).pipe(Effect.provideService(Clock.Clock, clock))
          return { before, after: yield* store.get(runId), receipt }
        }).pipe(
          Effect.provide(durable({
            database: fileBundle(filename),
            owner: newOwner,
            isAlive: () => Effect.succeed(false)
          })),
          Effect.orDie
        )
      ))

      expect(observed.before.status).toBe("running")
      expect(observed.receipt._tag).toBe("Accepted")
      expect(observed.after.owner).toMatchObject({ hostId: newOwner.hostId, pid: newOwner.pid })
    }
  )
})

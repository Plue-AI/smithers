import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { jjError } from "@smthrs/jj"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import * as Compensation from "../src/internal/Compensation.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import { error, TimeTravelError } from "../src/TimeTravelError.ts"

/**
 * Rewind preflight decides, before a single effect is undone, whether the
 * crossed suffix can be reversed at all. Compensation then executes in reverse
 * journal order and must leave nothing half-done: a failed revert rolls back
 * every receipt it already collected, and a failed workspace restore puts the
 * jj pointer back where it found it.
 */

const record = (
  overrides: Partial<EffectRecord> & Pick<EffectRecord, "id" | "kind" | "tier" | "seq">
): EffectRecord => ({
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  // The handlers below require a key, and `guard` never records an
  // irreversible effect without one.
  idempotencyKey: "compensation-key",
  durableBoundary: true,
  providerStream: false,
  ...overrides
})

const cache = (overrides: Partial<CacheStore.Service> = {}) =>
  Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop(overrides))

const hit: CacheStore.CacheEntry = {
  keyDigest: "digest",
  result: { ok: true },
  meta: {},
  createdAtMs: 0,
  recordedRunId: "run",
  recordedEventSeq: 1
}

const registryOf = (handlers: Parameters<typeof EffectHandlerRegistry.make>[0]) =>
  Layer.succeed(
    EffectHandlerRegistry.EffectHandlerRegistry,
    Effect.runSync(EffectHandlerRegistry.make(handlers))
  )

const jjOf = (overrides: Partial<Jj.Jj> = {}) => Layer.succeed(Jj.Jj, Jj.makeNoop(overrides))

/**
 * The two workspace steps in the order Rewind runs them, without the durable
 * write Rewind makes between them.
 */
const restoreWorkspace = (
  plan: Compensation.Plan,
  handlerReceipts: ReadonlyArray<EffectHandlerRegistry.RollbackReceipt>,
  timeout?: Duration.Input
) =>
  Compensation.prepareWorkspace(plan, handlerReceipts, timeout).pipe(
    Effect.flatMap((result) => Compensation.restorePreparedWorkspace(result, timeout))
  )

describe("Compensation.assess", () => {
  it.effect("blocks a sealed effect that never recorded a cache key", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1 })]).pipe(
          Effect.provide(cache()),
          Effect.provide(registryOf([]))
        )
      )

      expect(plan.assessments).toMatchObject([
        { classification: "blocking", reason: "The sealed effect has no content-addressed cache key." }
      ])
    }))

  it.effect("warns for a present sealed entry and blocks a missing one, in journal order", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([
          record({ id: "gone", kind: "read", tier: "sealed", seq: 2, cacheKey: "missing" }),
          record({ id: "kept", kind: "read", tier: "sealed", seq: 1, cacheKey: "digest" })
        ]).pipe(
          Effect.provide(
            cache({ get: (key) => Effect.succeed(key === "digest" ? Option.some(hit) : Option.none()) })
          ),
          Effect.provide(registryOf([]))
        )
      )

      expect(plan.effects.map((effect) => effect.id)).toEqual(["kept", "gone"])
      expect(plan.assessments.map((assessment) => assessment.classification)).toEqual([
        "warning",
        "blocking"
      ])
      expect(plan.assessments[1]?.reason).toBe("Sealed cache entry missing is missing.")
    }))

  it.effect("fails the whole preflight when the cache cannot be consulted", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(
          Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1, cacheKey: "digest" })])
            .pipe(
              Effect.provide(
                cache({
                  get: () => Effect.fail(new CacheStore.CacheStoreError({ code: "unknown", message: "cache down" }))
                })
              ),
              Effect.provide(registryOf([]))
            )
        )
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "could not consult sealed result digest"
      })
    }))

  it.effect("blocks a compensable effect without a target pointer and reverts one with it", () =>
    Effect.gen(function*() {
      const effects = [record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })]
      const without = yield* (
        Compensation.assess(effects).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      )
      const withTarget = yield* (
        Compensation.assess(effects, "target").pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      )

      expect(without.assessments[0]).toMatchObject({
        classification: "blocking",
        reason: "The target frame has no recorded jj snapshot pointer."
      })
      expect(without.targetChangeId).toBeUndefined()
      expect(withTarget.assessments[0]).toMatchObject({
        classification: "revertible",
        reason: "The workspace will be restored to jj change target."
      })
      expect(withTarget.targetChangeId).toBe("target")
    }))

  it.effect("keeps a recorded residue on a blocking sealed assessment", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([
          record({ id: "seal", kind: "read", tier: "sealed", seq: 1, residue: "the model already answered" })
        ]).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      )

      expect(plan.assessments[0]?.residue).toBe("the model already answered")
    }))

  it.effect("delegates an irreversible effect to its registered handler", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([record({ id: "send", kind: "send", tier: "irreversible", seq: 1 })]).pipe(
          Effect.provide(cache()),
          Effect.provide(
            registryOf([{
              kind: "send",
              tier: "irreversible",
              requiresIdempotencyKey: true,
              residue: () => "an email left the building",
              revert: () => Effect.succeed({ voided: true }),
              rollback: () => Effect.void
            }])
          )
        )
      )

      expect(plan.assessments[0]).toMatchObject({
        classification: "revertible",
        residue: "an email left the building"
      })
    }))
})

describe("Compensation.compensate", () => {
  const irreversible = (id: string, seq: number) => record({ id, kind: "send", tier: "irreversible", seq })

  it.effect("refuses to execute a plan that carries any blocking assessment", () =>
    Effect.gen(function*() {
      const marker = "SECRET-RAW-EFFECT-PAYLOAD"
      const plan = yield* (
        Compensation.assess([record({
          id: "seal",
          kind: "read",
          tier: "sealed",
          seq: 1,
          input: { marker },
          output: { marker },
          residue: marker
        })]).pipe(
          Effect.provide(cache()),
          Effect.provide(registryOf([]))
        )
      )
      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(registryOf([]))))
      )

      expect(failure).toMatchObject({
        code: "irreversible",
        message: "rewind is blocked by 1 crossed effect(s)"
      })
      expect(JSON.stringify(Schema.encodeSync(TimeTravelError)(failure))).not.toContain(marker)
      expect(failure.cause).toEqual([{
        id: "seal",
        kind: "read",
        tier: "sealed",
        seq: 1,
        classification: "blocking",
        reason: "The sealed effect has no content-addressed cache key."
      }])
    }))

  it.effect("reverts in reverse journal order", () =>
    Effect.gen(function*() {
      const reverted: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          Effect.sync(() => {
            reverted.push(effect.id)
            return { voided: effect.id }
          }),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const receipts = yield* (Compensation.compensate(plan).pipe(Effect.provide(layer)))

      expect(reverted).toEqual(["second", "first"])
      expect(receipts.map((receipt) => receipt.id)).toEqual(["second:rollback", "first:rollback"])
    }))

  it.effect("refuses a credential-shaped receipt before it is durable and rolls every receipt back", () =>
    Effect.gen(function*() {
      const secret = "sk-live-0123456789abcdef"
      const durable: Array<number> = []
      const rolledBack: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          Effect.succeed(effect.id === "first" ? { refundId: "re_1", apiToken: secret } : { voided: effect.id }),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* Effect.flip(
        Compensation.compensate(plan, (receipts) => Effect.sync(() => void durable.push(receipts.length))).pipe(
          Effect.provide(layer)
        )
      )

      // Only `second` became durable; `first` was refused before its callback.
      expect(durable).toEqual([1])
      expect(rolledBack).toEqual(["first", "second"])
      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: expect.stringContaining("receipt for first carries a credential-shaped value")
      })
      expect(JSON.stringify(Schema.encodeSync(TimeTravelError)(failure))).not.toContain(secret)
    }))

  it.effect("leaves receipt data that is not JSON to the store's typed encoder", () =>
    Effect.gen(function*() {
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({ amount: 1n }),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1)]).pipe(Effect.provide(cache()), Effect.provide(layer))
      )

      const receipts = yield* Compensation.compensate(plan).pipe(Effect.provide(layer))

      expect(receipts.map((receipt) => receipt.data)).toEqual([{ amount: 1n }])
    }))

  it.effect("rolls back the receipts it already collected when a later revert fails", () =>
    Effect.gen(function*() {
      const rolledBack: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          effect.id === "first"
            ? Effect.fail(error("compensation_failed", "provider refused"))
            : Effect.succeed({ voided: effect.id }),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
      )

      expect(rolledBack).toEqual(["second"])
      expect(failure.code).toBe("compensation_failed")
      expect(failure.message).toContain("could not compensate first")
    }))

  it.effect("rolls back collected receipts when their durability callback fails", () =>
    Effect.gen(function*() {
      for (const rollbackFails of [false, true]) {
        const durable: Array<ReadonlyArray<string>> = []
        const rolledBack: Array<string> = []
        const layer = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: (effect) => Effect.succeed({ voided: effect.id }),
          rollback: (effect) =>
            Effect.sync(() => rolledBack.push(effect.id)).pipe(
              Effect.andThen(
                rollbackFails
                  ? Effect.fail(error("compensation_failed", "rollback refused"))
                  : Effect.void
              )
            )
        }])
        const plan = yield* Compensation.assess([irreversible("send", 1)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )

        const failure = yield* Effect.flip(
          Compensation.compensate(
            plan,
            (receipts) =>
              Effect.sync(() => durable.push(receipts.map((receipt) => receipt.id))).pipe(
                Effect.andThen(Effect.fail(error("unknown", "audit write failed")))
              )
          ).pipe(Effect.provide(layer))
        )

        expect(durable).toEqual([["send:rollback"]])
        expect(rolledBack).toEqual(["send"])
        expect(failure).toMatchObject({
          code: "compensation_failed",
          message: "could not persist compensation receipt for send: audit write failed"
        })
        if (rollbackFails) {
          expect(failure.cause).toMatchObject({ rollback: expect.anything() })
        } else {
          expect(failure.cause).toMatchObject({ rollback: undefined })
        }
      }
    }))

  it.effect("reports the rollback failure alongside the compensation failure", () =>
    Effect.gen(function*() {
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          effect.id === "first"
            ? Effect.fail(error("compensation_failed", "provider refused"))
            : Effect.succeed({ voided: effect.id }),
        rollback: () => Effect.fail(error("compensation_failed", "rollback refused"))
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
      )

      expect(failure.cause).toMatchObject({ rollback: expect.anything() })
    }))

  it.effect("normalizes a non-Error compensation defect into the failure message", () =>
    Effect.gen(function*() {
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.die("provider-defect"),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess([irreversible("send", 1)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "could not compensate send: provider-defect"
      })
    }))
})

describe("Compensation.prepareWorkspace then restorePreparedWorkspace", () => {
  const compensable = record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })

  const planFor = (
    effects: ReadonlyArray<EffectRecord>,
    target?: string
  ) => Compensation.assess(effects, target).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))

  it.effect("skips jj entirely when no compensable effect was crossed", () =>
    Effect.gen(function*() {
      let snapshots = 0
      const plan = yield* planFor([], "target")

      const result = yield* (
        restoreWorkspace(plan, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(
            jjOf({
              snapshot: () =>
                Effect.sync(() => {
                  snapshots += 1
                  return { commitId: "current", changeId: "current" }
                })
            })
          )
        )
      )

      expect(snapshots).toBe(0)
      expect(result).toEqual({ handlerReceipts: [] })
    }))

  it.effect("restores the workspace to the target pointer and reports both change ids", () =>
    Effect.gen(function*() {
      let pointer = "current"
      const plan = yield* planFor([compensable], "target")

      const result = yield* (
        restoreWorkspace(plan, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(
            jjOf({
              snapshot: () => Effect.succeed({ commitId: pointer, changeId: pointer }),
              restore: (changeId: string) =>
                Effect.sync(() => {
                  pointer = changeId
                })
            })
          )
        )
      )

      expect(pointer).toBe("target")
      expect(result.workspace).toEqual({ currentChangeId: "current", targetChangeId: "target" })
    }))

  it.effect("restores and rolls back the whole repository by operation when asked", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const plan = yield* Compensation.assess([compensable], "target", {
        wholeRepo: true,
        targetOperationId: "target-op"
      }).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      const jj = jjOf({
        snapshot: () => Effect.succeed({ commitId: "current", changeId: "current", operationId: "current-op" }),
        restore: (revision: string) => Effect.sync(() => void calls.push(`restore:${revision}`)),
        opRestore: (operationId: string) => Effect.sync(() => void calls.push(`opRestore:${operationId}`))
      })

      const result = yield* restoreWorkspace(plan, []).pipe(Effect.provide(registryOf([])), Effect.provide(jj))
      expect(result.workspace).toEqual({
        currentChangeId: "current",
        targetChangeId: "target",
        currentOperationId: "current-op",
        targetOperationId: "target-op"
      })
      yield* Compensation.rollback(result).pipe(Effect.provide(registryOf([])), Effect.provide(jj))
      expect(calls).toEqual(["opRestore:target-op", "opRestore:current-op"])
    }))

  it.effect("restores the whole repository even when no compensable effect was crossed", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const plan = yield* Compensation.assess([], "target", { wholeRepo: true, targetOperationId: "target-op" }).pipe(
        Effect.provide(cache()),
        Effect.provide(registryOf([]))
      )
      yield* restoreWorkspace(plan, []).pipe(
        Effect.provide(registryOf([])),
        Effect.provide(jjOf({
          snapshot: () => Effect.succeed({ commitId: "current", changeId: "current", operationId: "current-op" }),
          opRestore: (operationId: string) => Effect.sync(() => void calls.push(operationId))
        }))
      )
      expect(calls).toEqual(["target-op"])
    }))

  it.effect("rolls a failed whole-repository restore back to the current operation", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const plan = yield* Compensation.assess([compensable], "target", {
        wholeRepo: true,
        targetOperationId: "target-op"
      }).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      const failure = yield* Effect.flip(
        restoreWorkspace(plan, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(jjOf({
            snapshot: () => Effect.succeed({ commitId: "current", changeId: "current", operationId: "current-op" }),
            opRestore: (operationId: string) =>
              Effect.suspend(() => {
                calls.push(operationId)
                return operationId === "target-op"
                  ? Effect.fail(Jj.jjError({ code: "conflict", method: "opRestore" }))
                  : Effect.void
              })
          }))
        )
      )
      expect(failure.code).toBe("compensation_failed")
      expect(calls).toEqual(["target-op", "current-op"])
    }))

  for (const rollbackFails of [false, true]) {
    it.effect(`refuses a whole-repository restore with no current operation (rollback fails=${rollbackFails})`, () =>
      Effect.gen(function*() {
        const rolledBack: Array<string> = []
        const registry = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: () => Effect.succeed({}),
          rollback: (effect) =>
            Effect.suspend(() => {
              rolledBack.push(effect.id)
              return rollbackFails ? Effect.fail(error("compensation_failed", "rollback refused")) : Effect.void
            })
        }])
        const plan = yield* Compensation.assess([compensable], "target", {
          wholeRepo: true,
          targetOperationId: "target-op"
        }).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
        const receipt = {
          id: "send:rollback",
          effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
          data: {}
        }
        const failure = yield* Effect.flip(
          restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(jjOf({ snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }) }))
          )
        )
        expect(failure.code).toBe("compensation_failed")
        expect(failure.cause === undefined).toBe(!rollbackFails)
        expect(rolledBack).toEqual(["send"])
      }))
  }

  it.effect("reports a host without operation restore as not installed", () =>
    Effect.gen(function*() {
      const plan = yield* Compensation.assess([compensable], "target", {
        wholeRepo: true,
        targetOperationId: "target-op"
      }).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      const { opRestore: _absent, ...withoutOpRestore } = Jj.makeNoop({
        snapshot: () => Effect.succeed({ commitId: "current", changeId: "current", operationId: "current-op" })
      })
      const failure = yield* Effect.flip(
        restoreWorkspace(plan, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(Layer.succeed(Jj.Jj, Jj.make(withoutOpRestore)))
        )
      )
      expect(failure.code).toBe("compensation_failed")
      expect(failure.message).toContain("cannot restore an operation")
    }))

  it.effect("blocks a whole-repository restore to a frame with no recorded operation", () =>
    Effect.gen(function*() {
      const plan = yield* Compensation.assess([compensable], "target", { wholeRepo: true }).pipe(
        Effect.provide(cache()),
        Effect.provide(registryOf([]))
      )
      expect(plan.assessments.map((assessment) => assessment.classification)).toEqual(["blocking"])
      expect(plan.targetOperationId).toBeUndefined()
    }))

  it.effect("rolls handler receipts back when the pre-restore snapshot fails", () =>
    Effect.gen(function*() {
      const rolledBack: Array<string> = []
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({ snapshot: () => Effect.fail(jjError({ code: "not_installed", method: "snapshot" })) })
            )
          )
        )
      )

      expect(rolledBack).toEqual(["send"])
      expect(failure.message).toContain("could not snapshot current jj state")
    }))

  it.effect("reports a handler cleanup failure alongside a pre-restore snapshot failure", () =>
    Effect.gen(function*() {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.fail(error("compensation_failed", "handler cleanup failed"))
      }])
      const plan = yield* planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({ snapshot: () => Effect.fail(jjError({ code: "not_installed", method: "snapshot" })) })
            )
          )
        )
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: expect.stringContaining("could not snapshot current jj state"),
        cause: {
          snapshot: expect.anything(),
          handlerRollback: expect.anything()
        }
      })
    }))

  it.effect("restores the original pointer and the receipts when the target restore fails", () =>
    Effect.gen(function*() {
      const restores: Array<string> = []
      const rolledBack: Array<string> = []
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({
                snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }),
                restore: (changeId: string) =>
                  Effect.gen(function*() {
                    restores.push(changeId)
                    if (changeId === "target") {
                      return yield* Effect.fail(jjError({ code: "conflict", method: "restore" }))
                    }
                  })
              })
            )
          )
        )
      )

      expect(restores).toEqual(["target", "current"])
      expect(rolledBack).toEqual(["send"])
      expect(failure.message).toContain("could not restore jj state target")
    }))

  for (
    const faults of [
      { workspaceRollback: true, handlerRollback: false },
      { workspaceRollback: false, handlerRollback: true },
      { workspaceRollback: true, handlerRollback: true }
    ]
  ) {
    it.effect(`reports target-restore cleanup failures (workspace=${faults.workspaceRollback}, handlers=${faults.handlerRollback})`, () =>
      Effect.gen(function*() {
        const registry = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: () => Effect.succeed({}),
          rollback: () =>
            faults.handlerRollback
              ? Effect.fail(error("compensation_failed", "handler cleanup failed"))
              : Effect.void
        }])
        const plan = yield* planFor([compensable], "target")
        const receipt = {
          id: "send:rollback",
          effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
          data: {}
        }

        const failure = yield* (
          Effect.flip(
            restoreWorkspace(plan, [receipt]).pipe(
              Effect.provide(registry),
              Effect.provide(
                jjOf({
                  snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }),
                  restore: (changeId: string) =>
                    changeId === "target" || faults.workspaceRollback
                      ? Effect.fail(jjError({ code: "conflict", method: "restore" }))
                      : Effect.void
                })
              )
            )
          )
        )
        const cause = failure.cause as {
          readonly workspaceRollback?: unknown
          readonly handlerRollback?: unknown
        }

        expect(cause.workspaceRollback === undefined).toBe(!faults.workspaceRollback)
        expect(cause.handlerRollback === undefined).toBe(!faults.handlerRollback)
      }))
  }

  // Every refusal rolls the receipts back, not just the two that touch jj.
  // The caller hands ownership of them over with the call and treats the
  // failure as "they are undone", so a path that kept them would strand a
  // compensated effect with nothing left to reverse it.
  for (
    const scenario of [
      {
        name: "the plan is not executable at all",
        plan: {
          effects: [compensable],
          assessments: [{
            effect: compensable,
            classification: "blocking" as const,
            reason: "blocked",
            residue: "residue"
          }],
          targetChangeId: "target"
        },
        code: "irreversible"
      },
      {
        name: "the plan needs a restore but carries no resolved pointer",
        plan: { effects: [compensable], assessments: [] },
        code: "compensation_failed"
      }
    ]
  ) {
    it.effect(`rolls the receipts back when ${scenario.name}`, () =>
      Effect.gen(function*() {
        const rolledBack: Array<string> = []
        const registry = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: () => Effect.succeed({}),
          rollback: (effect) =>
            Effect.sync(() => {
              rolledBack.push(effect.id)
            })
        }])
        const receipt = {
          id: "send:rollback",
          effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
          data: {}
        }

        const failure = yield* (
          Effect.flip(
            restoreWorkspace(scenario.plan, [receipt]).pipe(
              Effect.provide(registry),
              Effect.provide(jjOf())
            )
          )
        )

        expect(failure.code, scenario.name).toBe(scenario.code)
        expect(rolledBack, scenario.name).toEqual(["send"])
      }))
  }

  it.effect("reports a cleanup failure on a refused restore without hiding the refusal", () =>
    Effect.gen(function*() {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.fail(error("compensation_failed", "handler cleanup failed"))
      }])
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          restoreWorkspace({ effects: [compensable], assessments: [] }, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(jjOf())
          )
        )
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "target jj pointer was not resolved during preflight"
      })
    }))
})

describe("Compensation.compensate then the workspace restore", () => {
  it.effect("compensates handlers first and then restores the workspace", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          Effect.sync(() => {
            order.push(`revert:${effect.id}`)
            return {}
          }),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess(
          [
            record({ id: "write", kind: "fs", tier: "compensable", seq: 1 }),
            record({ id: "send", kind: "send", tier: "irreversible", seq: 2 })
          ],
          "target"
        ).pipe(Effect.provide(cache()), Effect.provide(layer))
      )

      const result = yield* (
        Compensation.compensate(plan).pipe(
          Effect.flatMap((receipts) => restoreWorkspace(plan, receipts)),
          Effect.provide(layer),
          Effect.provide(
            jjOf({
              // A distinct change id: the pre-restore pointer is the commit id.
              snapshot: () => Effect.succeed({ commitId: "current", changeId: "moving" }),
              restore: (changeId: string) =>
                Effect.sync(() => {
                  order.push(`jj:${changeId}`)
                })
            })
          )
        )
      )

      expect(order).toEqual(["revert:send", "jj:target"])
      expect(result.handlerReceipts.map((receipt) => receipt.id)).toEqual(["send:rollback"])
      expect(result.workspace).toEqual({ currentChangeId: "current", targetChangeId: "target" })
    }))
})

describe("Compensation.rollback", () => {
  const receipt = {
    id: "send:rollback",
    effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
    data: {}
  }

  it.effect("undoes the workspace pointer before the handler receipts", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () =>
          Effect.sync(() => {
            order.push("handler")
          })
      }])

      yield* (
        Compensation.rollback({
          handlerReceipts: [receipt],
          workspace: { currentChangeId: "current", targetChangeId: "target" }
        }).pipe(
          Effect.provide(registry),
          Effect.provide(
            jjOf({
              restore: (changeId: string) =>
                Effect.sync(() => {
                  order.push(`jj:${changeId}`)
                })
            })
          )
        )
      )

      expect(order).toEqual(["jj:current", "handler"])
    }))

  it.effect("aggregates a failing workspace restore with a failing handler rollback", () =>
    Effect.gen(function*() {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.fail(error("compensation_failed", "handler refused"))
      }])

      const failure = yield* (
        Effect.flip(
          Compensation.rollback({
            handlerReceipts: [receipt],
            workspace: { currentChangeId: "current", targetChangeId: "target" }
          }).pipe(
            Effect.provide(registry),
            Effect.provide(jjOf({ restore: () => Effect.fail(jjError({ code: "conflict", method: "restore" })) }))
          )
        )
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "2 rewind rollback operation(s) failed"
      })
    }))
})

describe("Compensation.toStoreReceipts", () => {
  it("namespaces every receipt under its audit for atomic archival", () => {
    const receipts = Compensation.toStoreReceipts("audit-1", {
      handlerReceipts: [{
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: { voided: true }
      }]
    })

    expect(receipts).toEqual([{
      id: "audit-1:send:rollback",
      auditId: "audit-1",
      effectId: "send",
      receipt: expect.objectContaining({ id: "send:rollback" })
    }])
  })
})

describe("Compensation deadlines", () => {
  it.effect("lets interruption finish after a stalled rollback reaches its deadline", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      }])
      const fiber = yield* Effect.forkChild(
        Compensation.rollback({
          handlerReceipts: [{
            id: "receipt",
            data: {},
            effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 1 })
          }]
        }, "1 second").pipe(Effect.provide(registry), Effect.provide(jjOf())),
        { startImmediately: true }
      )
      yield* Deferred.await(entered)
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(fiber), { startImmediately: true })
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(interrupted)
      expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
    }))

  for (const operation of ["revert", "rollback", "snapshot", "restore"] as const) {
    it.effect(`bounds a nonterminating ${operation} inside the atomic region`, () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const hang = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
        const send = record({ id: "send", kind: "send", tier: "irreversible", seq: 1 })
        const registry = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: () => operation === "revert" ? hang : Effect.succeed({}),
          rollback: () => operation === "rollback" ? hang : Effect.void
        }])
        const plan = yield* Compensation.assess([
          operation === "revert" ? send : record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })
        ], "target").pipe(Effect.provide(cache()), Effect.provide(registry))
        const work = operation === "revert"
          ? Compensation.compensate(plan, undefined, "1 second")
          : operation === "rollback"
          ? Compensation.rollback({ handlerReceipts: [{ id: "receipt", effect: send, data: {} }] }, "1 second")
          : restoreWorkspace(plan, [], "1 second")
        const fiber = yield* Effect.forkChild(
          work.pipe(
            Effect.provide(registry),
            Effect.provide(jjOf({
              snapshot: () =>
                operation === "snapshot"
                  ? hang.pipe(Effect.as({ commitId: "current", changeId: "current" }))
                  : Effect.succeed({ commitId: "current", changeId: "current" }),
              restore: (id) => operation === "restore" && id === "target" ? hang : Effect.void
            }))
          ),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        yield* Effect.gen(function*() {
          yield* TestClock.adjust("2 seconds")
          const result = fiber.pollUnsafe()
          expect(result?._tag).toBe("Failure")
          if (result !== undefined && Exit.isFailure(result)) {
            const failure = Cause.squash(result.cause) as TimeTravelError
            expect(failure.code).toBe("compensation_failed")
            expect(JSON.stringify(failure.cause)).toContain("TimeoutError")
          }
        }).pipe(Effect.ensuring(Deferred.succeed(release, undefined).pipe(Effect.andThen(Fiber.await(fiber)))))
      }))
  }
})

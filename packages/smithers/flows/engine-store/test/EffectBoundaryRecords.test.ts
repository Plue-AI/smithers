/**
 * The engine writes the effect-boundary evidence a rewind assesses.
 *
 * Time travel (`packages/smithers/flows/time-travel/docs/README.md`) requires one durable entry
 * before the adapter begins and a terminal entry after it settles, for tier-3
 * work only. These cases pin both halves and the shape the decoder in
 * `@smthrs/time-travel` reads them under.
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Layer, Logger } from "effect"
import * as Cause from "effect/Cause"
import * as References from "effect/References"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as EffectRecords from "../src/internal/EffectRecords.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "boundary", pid: 1, nonce: "owner" }

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "snapshot" as never, changeId: "snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const boundaries = (entries: ReadonlyArray<{ readonly eventType: string; readonly payload: unknown }>) =>
  entries
    .filter((entry) => entry.eventType === EffectRecords.eventType)
    .map((entry) => (entry.payload as { readonly effect: Record<string, unknown> }).effect)

const dispatch = (options: {
  readonly runId: string
  readonly action: unknown
  readonly tier: "sealed" | "irreversible"
  readonly idempotencyKey?: string
  readonly execute: Effect.Effect<unknown, unknown>
  readonly failUnknownBoundary?: boolean
}) =>
  withCrypto(
    Effect.gen(function*() {
      const runs = yield* RunStore.RunStore
      yield* runs.create(options.runId, "{}")
      const pending = yield* runs.get(options.runId)
      const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
      const claim = yield* runs.claim(options.runId, snapshot, owner, 1)
      if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
      yield* runs.activate(options.runId, owner, claim.claimedAtMs, snapshot)
      const journal = yield* Journal.Journal
      const injected = new Journal.JournalError({ code: "sink_failed", message: "unknown boundary unavailable" })
      const exit = yield* Effect.exit(
        ActionPersistence.make({
          runId: options.runId,
          owner,
          sourceId: "boundary-test",
          execute: () => options.execute,
          ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey })
        })({
          action: options.action,
          attempt: 1,
          key: `${options.runId}-key`,
          tier: options.tier
        }).pipe(Effect.provideService(Journal.Journal, {
          ...journal,
          emitDurable: (input, claimant) =>
            options.failUnknownBoundary && input.eventType === EffectRecords.eventType &&
              (input.payload as { readonly effect: { readonly status: string } }).effect.status === "unknown"
              ? Effect.fail(injected)
              : journal.emitDurable(input, claimant)
        }))
      )
      yield* journal.flush
      const page = yield* journal.entries({ runId: options.runId as never, limit: 20 })
      return { exit, entries: page.entries }
    }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)), Effect.scoped)
  )

describe("effect-boundary records", () => {
  it.effect("brackets an irreversible dispatch with intended and succeeded, keyed by the action name", () =>
    Effect.gen(function*() {
      const result = yield* dispatch({
        runId: "boundary-ok",
        action: { name: "billing/Charge" },
        tier: "irreversible",
        idempotencyKey: "charge-1",
        execute: Effect.succeed("receipt")
      })

      expect(boundaries(result.entries)).toEqual([
        {
          id: expect.stringContaining("boundary-ok:"),
          kind: "billing/Charge",
          tier: "irreversible",
          status: "intended",
          runId: "boundary-ok",
          lineageId: FlowEngine.Lineage.root("boundary-ok"),
          attempt: 1,
          durableBoundary: true,
          providerStream: false,
          idempotencyKey: "charge-1"
        },
        {
          id: expect.stringContaining("boundary-ok:"),
          kind: "billing/Charge",
          tier: "irreversible",
          status: "succeeded",
          runId: "boundary-ok",
          lineageId: FlowEngine.Lineage.root("boundary-ok"),
          attempt: 1,
          durableBoundary: true,
          providerStream: false,
          idempotencyKey: "charge-1",
          output: "receipt"
        }
      ])
    }))

  it.effect("settles a failed irreversible dispatch as `unknown`, never as absent", () =>
    Effect.gen(function*() {
      const result = yield* dispatch({
        runId: "boundary-failed",
        // No declared name and no idempotency key: the kind falls back to the
        // constant, which resolves to no handler and therefore blocks a rewind.
        action: {},
        tier: "irreversible",
        execute: Effect.fail("provider refused")
      })

      expect(result.exit._tag).toBe("Failure")
      expect(boundaries(result.entries).map((effect) => [effect.kind, effect.status])).toEqual([
        ["flows/engine-store/action", "intended"],
        ["flows/engine-store/action", "unknown"]
      ])
    }))

  it.effect("writes no boundary record for work that is not tier-3", () =>
    Effect.gen(function*() {
      const result = yield* dispatch({
        runId: "boundary-sealed",
        action: { name: "reports/Read" },
        tier: "sealed",
        execute: Effect.succeed("read")
      })

      expect(boundaries(result.entries)).toEqual([])
    }))

  it("carries every optional descriptor field, and omits the ones that are absent", () => {
    const full = EffectRecords.boundary(
      {
        id: "e-1",
        kind: "billing/Charge",
        tier: "irreversible",
        runId: "run",
        lineageId: "run/root",
        sourceId: "src",
        attempt: 2,
        idempotencyKey: "idem",
        cacheKey: "digest",
        changeId: "change",
        compensation: "billing/refund",
        residue: "The charge stands."
      },
      "succeeded",
      { ok: true }
    )
    const bare = EffectRecords.boundary({
      id: "e-2",
      kind: "billing/Charge",
      tier: "irreversible",
      runId: "run",
      lineageId: "run/root",
      sourceId: "src",
      attempt: 1
    }, "intended")

    expect((full.payload as { readonly effect: Record<string, unknown> }).effect).toMatchObject({
      idempotencyKey: "idem",
      cacheKey: "digest",
      changeId: "change",
      compensation: "billing/refund",
      residue: "The charge stands.",
      output: { ok: true }
    })
    expect(full.meta).toMatchObject({
      lineageId: "run/root",
      cacheKey: "digest",
      timeTravel: { effectId: "e-1", kind: "billing/Charge", tier: "irreversible", status: "succeeded" }
    })
    const bareEffect = (bare.payload as { readonly effect: Record<string, unknown> }).effect
    expect(Object.keys(bareEffect).sort()).toEqual([
      "attempt",
      "durableBoundary",
      "id",
      "kind",
      "lineageId",
      "providerStream",
      "runId",
      "status",
      "tier"
    ])
    expect(bare.meta).toEqual({
      lineageId: "run/root",
      timeTravel: { effectId: "e-2", kind: "billing/Charge", tier: "irreversible", status: "intended" }
    })
  })

  it("gives every effect and status pair its own sourceId at sourceSeq 0", () => {
    const descriptor = {
      id: "e-1",
      kind: "billing/Charge",
      tier: "irreversible" as const,
      runId: "run",
      lineageId: "run/root",
      sourceId: "src",
      attempt: 1
    }
    const intended = EffectRecords.boundary(descriptor, "intended")
    const succeeded = EffectRecords.boundary(descriptor, "succeeded", { ok: true })
    const sibling = EffectRecords.boundary({ ...descriptor, id: "e-2" }, "intended")

    // The status varies the sourceId, not the sequence: the duplicate key is
    // `(runId, sourceId, sourceSeq)`, so a per-status sequence would let two
    // statuses of one effect share an identity.
    expect(intended.sourceId).toBe("src:effect:e-1:intended")
    expect(succeeded.sourceId).toBe("src:effect:e-1:succeeded")
    expect(sibling.sourceId).toBe("src:effect:e-2:intended")
    expect([intended.sourceSeq, succeeded.sourceSeq, sibling.sourceSeq]).toEqual([0, 0, 0])

    // Re-emitting one status for one effect converges on that pair, which is
    // what makes a replay settle as `Duplicate` rather than append a row.
    const replayed = EffectRecords.boundary(descriptor, "succeeded", { ok: true })
    expect([replayed.runId, replayed.sourceId, replayed.sourceSeq]).toEqual([
      succeeded.runId,
      succeeded.sourceId,
      succeeded.sourceSeq
    ])
  })
})

it.effect("warns when unknown boundary persistence fails and preserves the provider failure", () =>
  Effect.gen(function*() {
    const logs: Array<{ level: string; message: unknown; annotations: unknown }> = []
    const primary = new Journal.JournalError({ code: "unknown", message: "provider refused" })
    const result = yield* dispatch({
      runId: "boundary-warning",
      action: { name: "billing/Charge" },
      tier: "irreversible",
      execute: Effect.fail(primary),
      failUnknownBoundary: true
    }).pipe(Effect.provide(Logger.layer([Logger.make((options) => {
      logs.push({
        level: options.logLevel,
        message: Cause.pretty(options.cause),
        annotations: options.fiber.getRef(References.CurrentLogAnnotations)
      })
    })])))
    expect(result.exit._tag).toBe("Failure")
    if (result.exit._tag === "Failure") expect(Cause.squash(result.exit.cause)).toBe(primary)
    expect(boundaries(result.entries).map((effect) => effect.status)).toEqual(["intended"])
    expect(logs).toEqual([
      expect.objectContaining({
        level: "Warn",
        annotations: expect.objectContaining({ runId: "boundary-warning", step: "boundary-warning-key" })
      })
    ])
    expect(String(logs[0]?.message)).toContain("unknown boundary unavailable")
  }))

/**
 * The boundary fold refuses evidence that does not describe one crossing.
 *
 * `EffectStatus` is monotonic: `intended`, then at most one terminal record.
 * The fold used to keep whichever record the caller listed last, so a
 * conflicted or reordered journal turned an `unknown` outcome, which must
 * block a rewind, into a `succeeded` one a handler would compensate before
 * its evidence was truncated. These cases pin the legal histories, every
 * conflict, and the golden vector `guard` itself produces.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import { error } from "../src/TimeTravelError.ts"

const record = (
  overrides: Partial<EffectRecord> & Pick<EffectRecord, "id" | "seq" | "status">
): EffectRecord => ({
  kind: "mail.send",
  tier: "irreversible",
  runId: "run",
  lineageId: "run/root",
  idempotencyKey: "send-1",
  durableBoundary: true,
  providerStream: false,
  ...overrides
})

const fold = (records: ReadonlyArray<EffectRecord>) => Effect.runSync(EffectBoundary.fromRecords(records))
const refusal = (records: ReadonlyArray<EffectRecord>) =>
  Effect.runSync(Effect.flip(EffectBoundary.fromRecords(records)))

const permutations = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
      permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])
    )

describe("EffectBoundary.fromRecords", () => {
  it("folds intended followed by one terminal record, in whatever order a reader listed them", () => {
    const intended = record({ id: "a", seq: 1, status: "intended" })
    const succeeded = record({ id: "a", seq: 2, status: "succeeded", output: "sent" })
    const otherIntended = record({ id: "b", seq: 3, status: "intended" })
    const unknown = record({ id: "b", seq: 4, status: "unknown" })

    for (const permutation of permutations([intended, succeeded, otherIntended, unknown])) {
      expect(fold(permutation)).toEqual([succeeded, unknown])
    }
  })

  it("keeps a crossing that has not reached a terminal record, and one paged without its intended", () => {
    const intended = record({ id: "a", seq: 1, status: "intended" })
    const terminalOnly = record({ id: "b", seq: 2, status: "unknown" })

    expect(fold([terminalOnly, intended])).toEqual([intended, terminalOnly])
  })

  it("tolerates a record a reader paged twice", () => {
    const intended = record({ id: "a", seq: 1, status: "intended" })
    const succeeded = record({ id: "a", seq: 2, status: "succeeded" })

    expect(fold([intended, succeeded, succeeded, intended])).toEqual([succeeded])
  })

  it("refuses a terminal record that another terminal record follows", () => {
    const unknown = record({ id: "a", seq: 3, status: "unknown" })
    const succeeded = record({ id: "a", seq: 4, status: "succeeded" })

    // The exact history the old fold accepted as `succeeded`.
    for (const permutation of permutations([unknown, succeeded])) {
      expect(refusal(permutation)).toMatchObject({
        code: "invalid",
        message: "effect a has conflicting boundary evidence: succeeded at seq 4 follows terminal unknown at seq 3"
      })
    }
  })

  it("refuses intended after a terminal record, and a repeated intended", () => {
    expect(
      refusal([record({ id: "a", seq: 2, status: "succeeded" }), record({ id: "a", seq: 3, status: "intended" })])
    ).toMatchObject({
      code: "invalid",
      message: "effect a has conflicting boundary evidence: intended at seq 3 follows terminal succeeded at seq 2"
    })
    expect(
      refusal([record({ id: "a", seq: 1, status: "intended" }), record({ id: "a", seq: 2, status: "intended" })])
    ).toMatchObject({
      code: "invalid",
      message: "effect a has conflicting boundary evidence: intended at seq 2 repeats intended at seq 1"
    })
  })

  it("refuses two records at one seq that disagree", () => {
    expect(
      refusal([record({ id: "a", seq: 2, status: "succeeded" }), record({ id: "a", seq: 2, status: "unknown" })])
    ).toMatchObject({
      code: "invalid",
      message: "effect a has conflicting boundary evidence: records at seq 2 report both succeeded and unknown"
    })
  })

  it("refuses records whose identity fields differ", () => {
    expect(
      refusal([
        record({ id: "a", seq: 1, status: "intended" }),
        record({ id: "a", seq: 2, status: "succeeded", kind: "mail.bounce" })
      ])
    ).toMatchObject({
      code: "invalid",
      message: "effect a has conflicting boundary evidence: kind is mail.send at seq 1 and mail.bounce at seq 2"
    })
    expect(
      refusal([
        record({ id: "a", seq: 1, status: "intended" }),
        record({ id: "a", seq: 2, status: "succeeded", compensation: "mail/refund/v2" })
      ])
    ).toMatchObject({ code: "invalid", message: expect.stringContaining("compensation is undefined at seq 1") })
  })
})

describe("EffectBoundary golden vector", () => {
  it.effect("folds what guard journals to the effect's terminal record, whichever way it is paged", () =>
    Effect.gen(function*() {
      const entries: Array<JournalEvent.Entry> = []
      const journal = Journal.makeNoop({
        emitDurable: (input) =>
          Effect.sync(() => {
            const seq = (entries.length + 1) as JournalEvent.Seq
            const sourceSeq = (input.sourceSeq ?? 0) as JournalEvent.SourceSeq
            entries.push({
              runId: input.runId,
              seq,
              eventId: `event-${seq}`,
              sourceId: input.sourceId,
              sourceSeq,
              emittedAtMs: seq,
              eventType: input.eventType,
              payload: input.payload,
              meta: input.meta
            })
            return { _tag: "Accepted" as const, seq, sourceSeq }
          })
      })
      const result = yield* EffectBoundary.guard({
        id: "golden",
        kind: "mail.send",
        tier: "irreversible",
        runId: "run",
        lineageId: "run/root",
        sourceId: "adapter",
        sourceSeq: 0,
        owner: { hostId: "test-host", pid: 1, nonce: "test-owner" },
        idempotencyKey: "send-1",
        compensation: "mail/refund/v1"
      }, Effect.succeed("sent")).pipe(Effect.provide(Layer.succeed(Journal.Journal, journal)))

      const folded = yield* EffectBoundary.fromEntries(entries)
      const reversed = yield* EffectBoundary.fromEntries([...entries].reverse())

      expect(result).toBe("sent")
      expect(entries).toHaveLength(2)
      expect(folded).toEqual([
        expect.objectContaining({
          id: "golden",
          seq: 2,
          status: "succeeded",
          output: "sent",
          idempotencyKey: "send-1",
          compensation: "mail/refund/v1"
        })
      ])
      expect(reversed).toEqual(folded)
    }))
})

describe("boundary persistence warnings", () => {
  for (const interrupted of [false, true]) {
    it.effect(`preserves ${interrupted ? "interruption" : "the provider failure"} when the unknown record cannot be written`, () =>
      Effect.gen(function*() {
        const logs: Array<{ level: string; message: unknown; annotations: unknown }> = []
        const storageFailure = new Journal.JournalError({ code: "sink_failed", message: "boundary unavailable" })
        const primary = error("unknown", "provider refused")
        let writes = 0
        const journal = Journal.makeNoop({
          emitDurable: () =>
            ++writes === 1
              ? Effect.succeed({ _tag: "Accepted", seq: 1 as JournalEvent.Seq, sourceSeq: 0 as JournalEvent.SourceSeq })
              : Effect.fail(storageFailure)
        })
        const exit = yield* EffectBoundary.guard({
          id: "warning-effect",
          kind: "mail.send",
          tier: "irreversible",
          runId: "warning-run",
          lineageId: "warning-run/root",
          sourceId: "adapter",
          sourceSeq: 0,
          owner: { hostId: "test", pid: 1, nonce: "owner" },
          idempotencyKey: "send-1"
        }, interrupted ? Effect.interrupt : Effect.fail(primary)).pipe(
          Effect.exit,
          Effect.provide(Layer.succeed(Journal.Journal, journal)),
          Effect.provide(Logger.layer([Logger.make((options) => {
            logs.push({
              level: options.logLevel,
              message: Cause.pretty(options.cause),
              annotations: options.fiber.getRef(References.CurrentLogAnnotations)
            })
          })]))
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          if (interrupted) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          else expect(Cause.squash(exit.cause)).toBe(primary)
        }
        expect(writes).toBe(2)
        expect(logs).toEqual([
          expect.objectContaining({
            level: "Warn",
            annotations: expect.objectContaining({ runId: "warning-run", step: "warning-effect" })
          })
        ])
        expect(String(logs[0]?.message)).toContain("boundary unavailable")
      }))
  }
})

import { NodeCrypto } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import { Action, Flow } from "@smthrs/flow"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { Cause, Clock, Context, Duration, Effect, Exit, Latch, Layer, Logger, Option, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { vi } from "vitest"
import { opaqueHandlerBody } from "../flows/engine-store/test/fixtures/OpaqueHandlerBody.ts"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"
import * as ReleasedChildResume from "../src/internal/ReleasedChildResume.ts"

const owner: Ownership.OwnerId = { hostId: "host", pid: process.pid, nonce: "worker" }
const setup = Effect.gen(function*() {
  const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const engineRuns = Context.get(native, RunStore.RunStore)
  yield* engineRuns.create("root", JSON.stringify({ version: 1, flowName: "root", payload: {} }))
  return {
    native,
    engineJournal: Context.get(native, Journal.Journal),
    controlJournal: Context.get(control, Journal.Journal),
    controlRuns: Context.get(control, RunStore.RunStore),
    engineRuns,
    attempts: Context.get(native, AttemptStore.AttemptStore),
    sql: Context.get(native, SqlClient),
    engineState: Context.get(native, DurableEngineState.DurableEngineState)
  }
}).pipe(Effect.provide(NodeCrypto.layer))
type Fixture = Effect.Success<typeof setup>
const withStores = <A, E>(use: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(Effect.flatMap(setup, use))
const event = (
  journal: Journal.Service,
  run: string,
  source: string,
  decision = "interrupt-released",
  releaseOwner?: unknown
) =>
  journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(run),
      sourceId: JournalEvent.SourceId.make(source),
      sourceSeq: JournalEvent.SourceSeq.make(0),
      eventType: "flows.engine.run-decision",
      payload: { decision, owner: releaseOwner }
    })
  )
const released = (f: Fixture, id = "child", parent = "root", result?: unknown) =>
  Effect.gen(function*() {
    const state = JSON.stringify({ version: 1, flowName: "worker", payload: {}, parentExecutionId: parent, result })
    yield* f.engineRuns.create(id, state)
    yield* f.engineState.recordRunParent(id, parent)
    const now = yield* Clock.currentTimeMillis
    expect((yield* f.engineRuns.claimAndOwn(id, yield* f.engineRuns.get(id), owner, now))._tag).toBe("Activated")
    expect((yield* f.engineRuns.transitionOwned(id, owner, "suspended", state))._tag).toBe("Transitioned")
  })
const grants = (f: Fixture) =>
  f.controlJournal.entries({
    runId: JournalEvent.RunId.make("root"),
    limit: 1000,
    eventTypes: ["control.engine.released-children-resume"]
  })
const failures = (f: Fixture) =>
  f.controlJournal.entries({
    runId: JournalEvent.RunId.make("root"),
    limit: 1000,
    eventTypes: ["control.engine.released-children-resume-failed"]
  })

it.effect("persists an explicit retry bound to its release even while control projection has no release", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release-one")
      const resume = ReleasedChildResume.make(f)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect((yield* grants(f)).entries).toHaveLength(0)
      yield* resume.authorize("root", 7)
      // A fresh helper instance reads the receipt, so authorization is durable.
      expect(yield* ReleasedChildResume.make(f).canRetryReleased("child", "root")).toBe(true)
      yield* event(f.engineJournal, "child", "release-two")
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      yield* resume.authorize("root", 7)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect((yield* grants(f)).entries).toHaveLength(1)
      yield* resume.authorize("root", 8)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
    })
  ))

it.effect("replay of an empty explicit resume cannot authorize a later release", () =>
  withStores((f) =>
    Effect.gen(function*() {
      const resume = ReleasedChildResume.make(f)
      yield* resume.authorize("root", 7)
      yield* released(f)
      yield* event(f.engineJournal, "child", "later-release")
      yield* resume.authorize("root", 7)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect((yield* grants(f)).entries).toHaveLength(1)
      yield* resume.authorize("root", 8)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
    })
  ))

it.effect("grants nested linked children once across a diamond ancestry", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f, "left")
      yield* released(f, "right")
      yield* f.engineState.recordRunParent("left", "right")
      yield* released(f, "child", "left")
      yield* f.engineState.recordRunParent("child", "right")
      yield* event(f.engineJournal, "child", "release")
      const resume = ReleasedChildResume.make(f)
      yield* resume.authorize("root", 1)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
      const payload = (yield* grants(f)).entries[0]!.payload
      expect(payload).toMatchObject({ resumeSequence: 1, releases: [{ executionId: "child" }] })
      expect((payload as { releases: Array<unknown> }).releases).toHaveLength(1)
      expect(yield* resume.canRetryReleased("left", "root")).toBe(false)
    })
  ))

it.effect("skips deliberate suspension, cancellation and a running child", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f, "intentional", "root", { _tag: "Suspended", token: "wait" })
      yield* released(f, "cancelled")
      yield* f.engineRuns.requestCancel("cancelled", yield* Clock.currentTimeMillis)
      yield* released(f, "running")
      expect(
        (yield* f.engineRuns.claimAndOwn(
          "running",
          yield* f.engineRuns.get("running"),
          owner,
          yield* Clock.currentTimeMillis
        ))._tag
      ).toBe("Activated")
      for (const id of ["intentional", "cancelled", "running"]) yield* event(f.engineJournal, id, "release")
      const resume = ReleasedChildResume.make(f)
      yield* resume.authorize("root", 1)
      for (const id of ["intentional", "cancelled", "running"]) {
        expect(yield* resume.canRetryReleased(id, "root")).toBe(false)
      }
    })
  ))

it.effect("reads a release beyond journal pagination without depending on projection", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      for (let i = 0; i < 257; i++) yield* event(f.engineJournal, "child", `noise-${i}`, "heartbeat")
      yield* event(f.engineJournal, "child", "release")
      const resume = ReleasedChildResume.make(f)
      yield* resume.authorize("root", 1)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
    })
  ))

it.effect("fails authorization on unreadable source history without emitting a grant", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const resume = ReleasedChildResume.make({
        ...f,
        engineJournal: { ...f.engineJournal, entries: () => Effect.die("journal unavailable") }
      })
      expect((yield* Effect.exit(resume.authorize("root", 1)))._tag).toBe("Failure")
      expect((yield* grants(f)).entries).toHaveLength(0)
      expect((yield* Effect.exit(resume.canRetryReleased("child", "root")))._tag).toBe("Failure")
    })
  ))

it.effect("invalidates a grant when the same release event belongs to a later rewind generation", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release")
      let generation = 0
      // Simulate a rewind-capable adapter's generation boundary while keeping
      // the real SQLite release and grant journals. Reused event IDs must not
      // authorize a different incarnation of the same child.
      const resume = ReleasedChildResume.make({
        ...f,
        engineJournal: { ...f.engineJournal, generation: () => Effect.succeed({ generation, afterSeq: -1 }) }
      })
      yield* resume.authorize("root", 1)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
      generation = 1
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      yield* resume.authorize("root", 1)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      yield* resume.authorize("root", 2)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
    })
  ))

it.effect("fails closed when a rewind crosses the release history read", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release")
      let reads = 0
      const resume = ReleasedChildResume.make({
        ...f,
        engineJournal: {
          ...f.engineJournal,
          generation: () => Effect.sync(() => ({ generation: reads++, afterSeq: -1 }))
        }
      })
      const exit = yield* Effect.exit(resume.authorize("root", 1))
      expect(exit._tag).toBe("Failure")
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ))

it.effect("rejects incomplete or foreign lineage without writing authorization", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const row = yield* f.engineRuns.get("root")
      for (
        const [index, lineage] of [[], [{ ...row, lineageId: "foreign" }, {
          ...row,
          runId: "alien",
          lineageId: "alien"
        }]].entries()
      ) {
        // The real store never returns malformed ancestry; this seam verifies
        // fail-closed behavior for a corrupt persistence adapter.
        const resume = ReleasedChildResume.make({
          ...f,
          engineRuns: { ...f.engineRuns, lineage: () => Effect.succeed(lineage) }
        })
        expect((yield* Effect.exit(resume.authorize("root", index + 1)))._tag).toBe("Failure")
      }
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ))

it.effect("includes later trampoline rounds without a second child edge", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const state = JSON.stringify({ version: 1, flowName: "worker", payload: {} })
      yield* f.engineRuns.create("next-round", state, { parentRunId: "child", lineageId: "child", roundOrdinal: 1 })
      const now = yield* Clock.currentTimeMillis
      expect((yield* f.engineRuns.claimAndOwn("next-round", yield* f.engineRuns.get("next-round"), owner, now))._tag)
        .toBe("Activated")
      expect((yield* f.engineRuns.transitionOwned("next-round", owner, "suspended", state))._tag).toBe("Transitioned")
      yield* event(f.engineJournal, "next-round", "release")
      const resume = ReleasedChildResume.make(f)
      yield* resume.authorize("root", 1)
      expect(yield* resume.canRetryReleased("next-round", "root")).toBe(true)
    })
  ))

it.effect("supports an append-only journal adapter with no generation operation", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release")
      const resume = ReleasedChildResume.make({ ...f, engineJournal: { ...f.engineJournal, generation: undefined } })
      yield* resume.authorize("root", 1)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
    })
  ))

for (
  const [name, meta] of [
    ["unkeyed", { tier: "sealed", keyed: false }],
    ["legacy", { tier: "sealed" }]
  ] as const
) {
  it.effect(`requires a matching explicit grant for a ${name} release after its same-host owner dies`, () =>
    withStores((f) =>
      Effect.gen(function*() {
        const deadOwner = { ...owner, pid: process.pid + 2, nonce: "dead-parent" }
        yield* f.controlRuns.create("root", "{}")
        expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), deadOwner, 0))._tag)
          .toBe("Activated")
        expect(
          (yield* f.controlRuns.transitionOwned(
            "root",
            deadOwner,
            "suspended",
            JSON.stringify({ updatedAt: 0, parkedBy: JSON.stringify(deadOwner) })
          ))._tag
        ).toBe("Transitioned")
        yield* released(f)
        yield* attempt(f, "child", "unfinished", meta)
        yield* event(f.engineJournal, "child", "dead-owner-release", "interrupt-released", deadOwner)
        yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
        const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
        const deadProbe = vi.fn(() => Effect.succeed(false))
        const admit = ControlAffinity.make({
          runs: f.controlRuns,
          engineRuns: f.engineRuns,
          claimant: { ...owner, pid: process.pid + 1 },
          isAlive: deadProbe,
          canRetryReleased: resume.canRetryReleased
        })
        expect(yield* admit("child")).toBe(false)
        expect(deadProbe).toHaveBeenCalledTimes(1)
        expect((yield* grants(f)).entries).toHaveLength(0)
        yield* resume.authorize("root", 1)
        expect(yield* admit("child")).toBe(true)
        yield* event(f.engineJournal, "child", "next-dead-owner-release", "interrupt-released", deadOwner)
        expect(yield* admit("child")).toBe(false)
      })
    ).pipe(Effect.provide(TestClock.layer())))
}

it.effect("keeps a new live released owner stopped after the old parked parent is confirmed dead", () =>
  withStores((f) =>
    Effect.gen(function*() {
      const oldParker = { ...owner, pid: process.pid + 2, nonce: "old-parent" }
      yield* f.controlRuns.create("root", "{}")
      expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), oldParker, 0))._tag).toBe(
        "Activated"
      )
      expect(
        (yield* f.controlRuns.transitionOwned(
          "root",
          oldParker,
          "suspended",
          JSON.stringify({ updatedAt: 0, parkedBy: JSON.stringify(oldParker) })
        ))._tag
      ).toBe("Transitioned")
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
      yield* released(f)
      yield* event(f.engineJournal, "child", "new-release", "interrupt-released", owner)
      const claimant = { ...owner, pid: process.pid + 1 }
      const resume = ReleasedChildResume.make(f)
      const oldProbe = vi.fn(() => Effect.succeed(false))
      const admit = ControlAffinity.make({
        runs: f.controlRuns,
        engineRuns: f.engineRuns,
        claimant,
        isAlive: oldProbe,
        canRetryReleased: resume.canRetryReleased
      })
      expect(yield* admit("child")).toBe(false)
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
      expect(yield* admit("child")).toBe(false)
      expect(oldProbe).toHaveBeenCalledTimes(2)
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ).pipe(Effect.provide(TestClock.layer())))

it.effect("records failure cause durably and consumes that resume before a later release exists", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const broken = ReleasedChildResume.make({
        ...f,
        engineJournal: { ...f.engineJournal, entries: () => Effect.die("release source unavailable") }
      })
      const exit = yield* Effect.exit(broken.authorize("root", 1))
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("release source unavailable")
      const receipt = (yield* failures(f)).entries
      expect(receipt).toHaveLength(1)
      expect(receipt[0]!.payload).toMatchObject({
        resumeSequence: 1,
        cause: expect.stringContaining("release source unavailable")
      })
      yield* event(f.engineJournal, "child", "later-release")
      const repaired = ReleasedChildResume.make(f)
      yield* repaired.authorize("root", 1)
      expect(yield* repaired.canRetryReleased("child", "root")).toBe(false)
      expect((yield* grants(f)).entries).toHaveLength(0)
      yield* repaired.authorize("root", 2)
      expect(yield* repaired.canRetryReleased("child", "root")).toBe(true)
      expect((yield* failures(f)).entries).toHaveLength(1)
    })
  ))

it.effect("retains the source failure if writing its durable failure receipt also fails", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const logs: Array<unknown> = []
      const resume = ReleasedChildResume.make({
        ...f,
        engineJournal: { ...f.engineJournal, entries: () => Effect.die("source failure") },
        controlJournal: { ...f.controlJournal, emitDurableUnfenced: () => Effect.die("receipt failure") }
      })
      const exit = yield* Effect.exit(resume.authorize("root", 1)).pipe(
        Effect.provide(
          Logger.layer([Logger.make((entry) => void logs.push(entry.message))], { mergeWithExisting: false })
        )
      )
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain("source failure")
      expect(JSON.stringify(logs)).toContain("failure receipt could not be recorded")
      expect(JSON.stringify(logs)).toContain("receipt failure")
    })
  ))

it.effect("preserves interruption without writing a misleading authorization failure", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const resume = ReleasedChildResume.make({
        ...f,
        engineJournal: { ...f.engineJournal, entries: () => Effect.interrupt }
      })
      const exit = yield* Effect.exit(resume.authorize("root", 1))
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect((yield* failures(f)).entries).toHaveLength(0)
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ))

it.effect("preserves an interrupted failure-receipt write without claiming authorization", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const resume = ReleasedChildResume.make({
        ...f,
        engineJournal: { ...f.engineJournal, entries: () => Effect.die("source failure") },
        controlJournal: { ...f.controlJournal, emitDurableUnfenced: () => Effect.interrupt }
      })
      const exit = yield* Effect.exit(resume.authorize("root", 1))
      expect(exit._tag).toBe("Failure")
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect((yield* grants(f)).entries).toHaveLength(0)
      expect((yield* failures(f)).entries).toHaveLength(0)
    })
  ))

const attempt = (f: Fixture, id: string, key: string, meta: AttemptStore.JsonValue, state = "running") =>
  Effect.gen(function*() {
    const row = yield* f.engineRuns.get(id)
    expect((yield* f.engineRuns.claimAndOwn(id, row, owner, yield* Clock.currentTimeMillis))._tag).toBe("Activated")
    expect(
      (yield* f.attempts.put(
        { runId: id, stepKeyDigest: key, attempt: 1, state: "running", startedAtMs: 0, meta },
        owner
      ))._tag
    )
      .toBe("Inserted")
    if (state !== "running") {
      expect(
        (yield* f.attempts.finish({ runId: id, stepKeyDigest: key, attempt: 1, state, finishedAtMs: 1 }, owner))._tag
      )
        .toBe("Finished")
    }
    expect((yield* f.engineRuns.transitionOwned(id, owner, "suspended", row.stateJson))._tag).toBe("Transitioned")
  })

for (
  const [name, meta] of [
    ["legacy absent", { tier: "sealed" }],
    ["false", { tier: "sealed", keyed: false }],
    ["string", { tier: "sealed", keyed: "true" }],
    ["missing tier", { keyed: true }],
    ["invalid tier", { tier: "unknown", keyed: true }],
    ["null", null],
    ["array", [true]],
    ["empty", {}]
  ] as const
) {
  it.effect(`keeps a running attempt with ${name} keyed metadata behind explicit consent`, () =>
    withStores((f) =>
      Effect.gen(function*() {
        yield* released(f)
        yield* attempt(f, "child", "effect", meta)
        yield* event(f.engineJournal, "child", "release", "interrupt-released", owner)
        const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
        expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
        yield* resume.authorize("root", 1)
        expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
        yield* event(f.engineJournal, "child", "next-release", "interrupt-released", owner)
        expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      })
    ))
}

it.effect("automatically retries keyed unfinished actions and ignores terminal unkeyed actions", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* attempt(f, "child", "start", { tier: "irreversible", keyed: true })
      yield* attempt(f, "child", "poll", { tier: "sealed", keyed: true })
      for (const state of ["succeeded", "failed", "interrupted"]) {
        yield* attempt(f, "child", state, { tier: "sealed" }, state)
      }
      yield* event(f.engineJournal, "child", "release", "interrupt-released", owner)
      const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
      expect((yield* grants(f)).entries).toHaveLength(0)
      yield* attempt(f, "child", "unkeyed", { tier: "compensable" })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
    })
  ))

it.effect("automatically retries an empty released execution but requires actual release evidence", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      yield* event(f.engineJournal, "child", "release")
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
    })
  ))

it.effect("does not automatically retry running, cancelled, terminal or deliberately suspended keyed executions", () =>
  withStores((f) =>
    Effect.gen(function*() {
      for (const id of ["running", "cancelled", "completed", "failed", "intentional", "state-cancelled"]) {
        yield* released(f, id)
        yield* attempt(f, id, "effect", { tier: "sealed", keyed: true })
        yield* event(f.engineJournal, id, "release")
        if (id === "cancelled") yield* f.engineRuns.requestCancel(id, 1)
        else {
          const row = yield* f.engineRuns.get(id)
          expect((yield* f.engineRuns.claimAndOwn(id, row, owner, yield* Clock.currentTimeMillis))._tag).toBe(
            "Activated"
          )
          if (id !== "running") {
            const state = JSON.parse(row.stateJson)
            if (id === "intentional") state.result = { _tag: "Suspended", token: "wait" }
            if (id === "state-cancelled") state.cancellation = { interruptedAtMs: 1 }
            expect(
              (yield* f.engineRuns.transitionOwned(
                id,
                owner,
                id === "completed" || id === "failed" ? id : "suspended",
                JSON.stringify(state)
              ))._tag
            ).toBe("Transitioned")
          }
        }
        expect(yield* ReleasedChildResume.make({ ...f, engineSql: f.sql }).canRetryReleased(id, "root")).toBe(false)
      }
    })
  ))

it.effect("refuses a keyed retry when its release changes during the attempt snapshot", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* attempt(f, "child", "effect", { tier: "sealed", keyed: true })
      yield* event(f.engineJournal, "child", "release")
      let reads = 0
      // The SQL stores are real; changing the generation at the read seam
      // simulates a rewind crossing eligibility, without rewriting journal rows.
      const resume = ReleasedChildResume.make({
        ...f,
        engineSql: f.sql,
        engineJournal: {
          ...f.engineJournal,
          generation: () => Effect.sync(() => ({ generation: reads++ < 2 ? 0 : 1, afterSeq: -1 }))
        }
      })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
    })
  ))

it.effect("does not treat unreadable attempt storage as repeat-safe", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release")
      const resume = ReleasedChildResume.make({
        ...f,
        engineSql: new Proxy(f.sql, {
          get: (target, key, receiver) =>
            key === "withTransaction"
              ? () => Effect.die("attempt storage unavailable")
              : Reflect.get(target, key, receiver)
        })
      })
      const exit = yield* Effect.exit(resume.canRetryReleased("child", "root"))
      expect(exit._tag).toBe("Failure")
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ))

it.effect("keeps a keyed child's foreign live control owner fenced out", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* attempt(f, "child", "effect", { tier: "sealed", keyed: true })
      yield* event(f.engineJournal, "child", "release")
      yield* f.controlRuns.create("root", "{}")
      expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), owner, 0))._tag).toBe(
        "Activated"
      )
      const claimant = { ...owner, pid: owner.pid + 1, nonce: "peer" }
      const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
      const admit = ControlAffinity.make({
        runs: f.controlRuns,
        engineRuns: f.engineRuns,
        claimant,
        canRetryReleased: resume.canRetryReleased,
        isAlive: () => Effect.succeed(true)
      })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
      expect(yield* admit("child")).toBe(false)
      expect((yield* f.engineRuns.get("child")).status).toBe("suspended")
    })
  ))

it.effect("a keyed retry remains subject to one winning native ownership claim", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* attempt(f, "child", "effect", { tier: "sealed", keyed: true })
      yield* event(f.engineJournal, "child", "release")
      const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
      const snapshot = yield* f.engineRuns.get("child")
      const peer = { ...owner, nonce: "peer" }
      const claims = yield* Effect.all([
        f.engineRuns.claimAndOwn("child", snapshot, owner, 0),
        f.engineRuns.claimAndOwn("child", snapshot, peer, 0)
      ], { concurrency: "unbounded" })
      expect(claims.filter((claim) => claim._tag === "Activated")).toHaveLength(1)
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect((yield* f.attempts.get({ runId: "child", stepKeyDigest: "effect", attempt: 1 }))._tag).toBe("Some")
    })
  ))

it.effect("refuses automatic retry when cancellation arrives after the first native read", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* attempt(f, "child", "effect", { tier: "sealed", keyed: true })
      yield* event(f.engineJournal, "child", "release")
      let reads = 0
      const resume = ReleasedChildResume.make({
        ...f,
        engineSql: f.sql,
        engineRuns: {
          ...f.engineRuns,
          get: (id) =>
            f.engineRuns.get(id).pipe(Effect.tap(() => ++reads === 1 ? f.engineRuns.requestCancel(id, 1) : Effect.void))
        }
      })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect((yield* f.engineRuns.get("child")).cancelRequestedAtMs).toBe(1)
    })
  ))

for (
  const [keyed, outcome, race] of [
    [true, "succeeded", undefined],
    [true, "failed", undefined],
    [false, "succeeded", undefined],
    [false, "succeeded", "aba"],
    [false, "succeeded", "generation"],
    [true, "succeeded", "cancel"],
    [true, "succeeded", "legacy"]
  ] as const
) {
  it.effect(`genuine ${keyed ? "keyed" : "unkeyed"} action release ${race ?? outcome}`, () =>
    withStores((f) =>
      Effect.gen(function*() {
        let dispatches = 0
        let externalStarts = 0
        const externalJobs = new Set<string>()
        let changed = false
        const entered = yield* Latch.make(false)
        const operation = Action.make({
          name: "genuine-release/effect",
          success: Schema.String,
          error: Schema.String,
          ...(keyed ? { idempotencyKey: "external-create-or-get" } : {}),
          execute: Effect.gen(function*() {
            dispatches++
            // Model a provider's create-or-get at its actual side-effect
            // boundary. Re-entry of a keyed action attaches to the first job.
            const jobKey = keyed ? "external-create-or-get" : `unkeyed-${dispatches}`
            if (!externalJobs.has(jobKey)) {
              externalJobs.add(jobKey)
              externalStarts++
            }
            if (dispatches === 1) {
              yield* Latch.open(entered)
              return yield* Effect.never
            }
            return outcome === "failed" ? yield* Effect.fail("recorded-failure") : "recorded-result"
          })
        })
        const flow = Flow.make("GenuineRelease", {
          payload: {},
          success: Schema.String,
          error: Schema.String,
          body: opaqueHandlerBody
        })
        const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
        const makeEngine = (scope: Scope.Scope, admission: boolean) =>
          EngineStore.make({
            owner: { hostId: "genuine-host" },
            journalSource: "genuine-release",
            ...(admission ?
              {
                canExecute: (row: RunStore.RunRow) =>
                  Effect.gen(function*() {
                    if (row.status === "pending" || row.cancelRequestedAtMs !== null) return true
                    const allowed = yield* resume.canRetryReleased(row.runId, "root")
                    if (allowed && race !== undefined && race !== "legacy" && !changed) {
                      changed = true
                      if (race === "cancel") yield* f.engineRuns.requestCancel(row.runId, 1)
                      else if (race === "generation") {
                        // The rewind fence reads real persisted generation, not
                        // a mocked journal operation. Old consent stays invalid.
                        yield* f.sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq)
                        VALUES (${row.runId}, 1, -1)
                        ON CONFLICT (run_id) DO UPDATE SET generation = 1`
                      } else {
                        expect((yield* f.engineRuns.claimAndOwn(row.runId, row, owner, 0))._tag).toBe("Activated")
                        expect((yield* f.engineRuns.transitionOwned(row.runId, owner, "suspended", row.stateJson))._tag)
                          .toBe("Transitioned")
                        yield* event(f.engineJournal, row.runId, "intervening-release")
                      }
                    }
                    return allowed
                  }).pipe(Effect.orDie),
                canActivate: (row: RunStore.RunRow) =>
                  row.status === "pending" || row.cancelRequestedAtMs !== null
                    ? Effect.succeed(true)
                    : resume.canRetryReleased(row.runId, "root").pipe(Effect.orDie)
              } :
              {})
          }).pipe(Scope.provide(scope))
        const firstScope = yield* Scope.make()
        const first = yield* makeEngine(firstScope, false)
        yield* first.register(flow, () => operation)
        yield* first.execute(flow, { executionId: "genuine", payload: {}, discard: true })
        yield* Latch.await(entered)
        yield* Scope.close(firstScope, Exit.void)
        const releasedRow = yield* f.engineRuns.get("genuine")
        expect(releasedRow.status).toBe("suspended")
        expect(Option.getOrUndefined(yield* f.engineState.waiting("genuine"))?.reason).toBe("released")
        yield* f.engineState.recordRunParent("genuine", "root")
        if (race === "legacy") {
          // Upgrade fixture: keep the genuine admitted action/attempt and
          // strip only the marker absent in historical executable metadata.
          const records = yield* f.sql<{ meta: string; key: string }>`
            SELECT meta_json AS "meta", step_key_digest AS "key" FROM flows_attempts WHERE run_id = 'genuine'`
          expect(records).toHaveLength(1)
          const meta = JSON.parse(records[0]!.meta)
          delete meta.keyed
          yield* f.sql`UPDATE flows_attempts SET meta_json = ${JSON.stringify(meta)}
            WHERE run_id = 'genuine' AND step_key_digest = ${records[0]!.key}`
        }
        expect(yield* resume.canRetryReleased("genuine", "root")).toBe(keyed && race !== "legacy")
        expect(dispatches).toBe(1)
        const secondScope = yield* Scope.make()
        const second = yield* makeEngine(secondScope, true)
        yield* second.register(flow, () => operation)
        if (!keyed || race === "legacy") {
          yield* second.resume(flow, "genuine", { poll: true })
          expect(dispatches).toBe(1)
          expect((yield* f.engineRuns.get("genuine")).status).toBe("suspended")
          yield* resume.authorize("root", 1)
        }
        yield* second.resume(flow, "genuine", { poll: true })
        const finished = yield* f.engineRuns.get("genuine")
        if (race !== undefined && race !== "legacy") {
          expect(changed).toBe(true)
          expect(dispatches).toBe(1)
          expect(externalStarts).toBe(1)
          expect(finished.status).toBe(race === "cancel" ? "cancelled" : "suspended")
          expect(finished.claim).toBeNull()
          expect(finished.owner).toBeNull()
          expect(yield* resume.canRetryReleased("genuine", "root")).toBe(false)
          yield* Scope.close(secondScope, Exit.void)
          return
        }
        expect(finished.status).toBe(outcome === "failed" ? "failed" : "completed")
        expect(dispatches).toBe(2)
        expect(externalStarts).toBe(keyed ? 1 : 2)
        const replay = yield* Effect.exit(second.execute(flow, { executionId: "genuine", payload: {}, discard: false }))
        expect(replay._tag).toBe(outcome === "failed" ? "Failure" : "Success")
        if (Exit.isSuccess(replay)) expect(replay.value).toBe("recorded-result")
        else expect(Cause.pretty(replay.cause)).toContain("recorded-failure")
        expect(dispatches).toBe(2)
        yield* Scope.close(secondScope, Exit.void)
      }).pipe(
        Effect.provideContext(f.native),
        Effect.provide(StepBoundary.layerTest()),
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(
          Jj.Jj,
          Jj.make({
            snapshot: () => Effect.succeed({ commitId: "unused" as never, changeId: "unused" as never }),
            restore: () => Effect.void,
            diff: () => Effect.succeed(""),
            workspaceAdd: () => Effect.void,
            workspaceForget: () => Effect.void,
            status: () => Effect.succeed("")
          })
        )
      )
    ))
}

for (const location of ["control-root", "approved-module", "engine-root"] as const) {
  for (
    const [name, meta] of [
      ["keyed", { tier: "sealed", keyed: true }],
      ["unkeyed", { tier: "sealed", keyed: false }],
      ["legacy", { tier: "sealed" }]
    ] as const
  ) {
    it.effect(`applies the same released policy to ${location} with ${name} unfinished work`, () =>
      withStores((f) =>
        Effect.gen(function*() {
          const id = location === "approved-module" ? "module" : "root"
          if (location !== "engine-root") {
            yield* f.controlRuns.create("root", JSON.stringify({ flowId: "worker" }))
            expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), owner, 0))._tag)
              .toBe("Activated")
          }
          if (location === "approved-module") {
            const root = yield* f.engineRuns.get("root")
            expect((yield* f.engineRuns.claimAndOwn("root", root, owner, 0))._tag).toBe("Activated")
            expect(
              (yield* f.engineRuns.transitionOwned(
                "root",
                owner,
                "suspended",
                JSON.stringify({
                  version: 1,
                  flowName: "agent/run",
                  payload: {}
                })
              ))._tag
            ).toBe("Transitioned")
            yield* f.engineRuns.create(
              id,
              JSON.stringify({
                version: 1,
                flowName: "worker",
                payload: {},
                parentExecutionId: "root",
                onParentExit: "cancel"
              })
            )
            yield* f.engineState.recordRunParent(id, "root")
          }
          yield* attempt(f, id, "unfinished", meta)
          yield* event(f.engineJournal, id, "release", "interrupt-released", owner)
          const resume = ReleasedChildResume.make({ ...f, engineSql: f.sql })
          const admit = ControlAffinity.make({
            runs: f.controlRuns,
            engineRuns: f.engineRuns,
            claimant: owner,
            canRetryReleased: resume.canRetryReleased
          })
          expect(yield* admit(id)).toBe(name === "keyed")
          yield* resume.authorize("root", 1)
          expect(yield* admit(id)).toBe(true)
          yield* event(f.engineJournal, id, "next-release", "interrupt-released", owner)
          expect(yield* admit(id)).toBe(name === "keyed")
          yield* f.engineRuns.requestCancel(id, 1)
          expect(yield* admit(id)).toBe(true)
        })
      ))
  }
}

it.effect("keeps root admission fail-closed for native read failures but admits roots not yet registered", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* f.controlRuns.create("new-root", "{}")
      const options = { runs: f.controlRuns, engineRuns: f.engineRuns, claimant: owner }
      expect(yield* ControlAffinity.make(options)("new-root")).toBe(true)
      const error = new RunStore.RunStoreError({
        code: "invalid_run",
        method: "get",
        message: "native read failed",
        cause: null
      })
      expect(
        yield* ControlAffinity.make({ ...options, engineRuns: { ...f.engineRuns, get: () => Effect.fail(error) } })(
          "new-root"
        )
      ).toBe(false)
      yield* f.controlRuns.create("root", "{}")
      expect(yield* ControlAffinity.make(options)("root")).toBe(true)
      yield* attempt(f, "root", "unfinished", { tier: "sealed" })
      expect(yield* ControlAffinity.make(options)("root")).toBe(false)
      const row = yield* f.engineRuns.get("root")
      expect((yield* f.engineRuns.claimAndOwn("root", row, owner, 0))._tag).toBe("Activated")
      expect(
        (yield* f.engineRuns.transitionOwned(
          "root",
          owner,
          "suspended",
          JSON.stringify({
            version: 1,
            flowName: "root",
            payload: {},
            cancellation: { interruptedAtMs: 1 }
          })
        ))._tag
      ).toBe("Transitioned")
      expect(yield* ControlAffinity.make(options)("root")).toBe(true)
    })
  ))

for (const nativeState of ["running", "released", "cancelled", "settled"] as const) {
  for (
    const parentState of [
      "own-park",
      "invalid-park",
      "missing-owner",
      "remote-park",
      "fresh-park",
      "live-park",
      "dead-park",
      "own-running",
      "live-running",
      "pending"
    ] as const
  ) {
    it.effect(`preserves ${parentState} control ownership for a ${nativeState} descendant`, () =>
      withStores((f) =>
        Effect.gen(function*() {
          const foreign = { ...owner, pid: process.pid + 1 }
          const parker = parentState === "own-park" || parentState === "own-running" ?
            owner
            : parentState === "remote-park"
            ? { ...foreign, hostId: "other-host" }
            : foreign
          yield* f.controlRuns.create("root", "{}")
          if (parentState !== "pending") {
            expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), parker, 0))._tag)
              .toBe("Activated")
            if (!parentState.endsWith("running")) {
              const park = parentState === "invalid-park" ?
                "{}" :
                JSON.stringify({
                  updatedAt: 0,
                  parkedBy: parentState === "missing-owner" ? "{}" : JSON.stringify(parker)
                })
              expect((yield* f.controlRuns.transitionOwned("root", parker, "suspended", park))._tag)
                .toBe("Transitioned")
            }
          }
          yield* released(
            f,
            "child",
            "intermediate",
            nativeState === "settled" ? { _tag: "Success", value: 1 } : undefined
          )
          yield* f.engineRuns.create(
            "intermediate",
            JSON.stringify({ version: 1, flowName: "intermediate", payload: {}, parentExecutionId: "root" })
          )
          if (nativeState === "running") {
            expect((yield* f.engineRuns.claimAndOwn("child", yield* f.engineRuns.get("child"), owner, 0))._tag)
              .toBe("Activated")
          }
          if (nativeState === "cancelled") yield* f.engineRuns.requestCancel("child", 1)
          if (parentState !== "fresh-park") {
            yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
          }
          const retry = vi.fn(() => Effect.succeed(true))
          const admit = ControlAffinity.make({
            runs: f.controlRuns,
            engineRuns: f.engineRuns,
            claimant: owner,
            isAlive: () => Effect.succeed(parentState === "live-park" || parentState === "live-running"),
            canRetryReleased: retry
          })
          const blocked = ["invalid-park", "missing-owner", "remote-park", "fresh-park", "live-park", "live-running"]
            .includes(parentState)
          expect(yield* admit("child")).toBe(nativeState === "cancelled" || !blocked)
          expect(retry).toHaveBeenCalledTimes(nativeState === "released" && !blocked ? 1 : 0)
        })
      ).pipe(Effect.provide(TestClock.layer())))
  }
}

it.effect("refuses cyclic native ancestry and released work without a configured retry policy", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f, "cycle")
      // Public writes reject cycles. Model a corrupt historical native row at
      // the SQL seam while retaining real stores and admission traversal.
      yield* f.sql`UPDATE flows_runs SET state_json = ${
        JSON.stringify({
          version: 1,
          flowName: "worker",
          payload: {},
          parentExecutionId: "cycle"
        })
      } WHERE run_id = 'cycle'`
      const admit = ControlAffinity.make({ runs: f.controlRuns, engineRuns: f.engineRuns, claimant: owner })
      expect(yield* admit("cycle")).toBe(false)
      yield* released(f, "child")
      yield* f.controlRuns.create("root", "{}")
      expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), owner, 0))._tag)
        .toBe("Activated")
      expect(yield* admit("child")).toBe(false)
      expect(
        (yield* f.controlRuns.transitionOwned(
          "root",
          owner,
          "suspended",
          JSON.stringify({
            updatedAt: 0,
            parkedBy: JSON.stringify(owner)
          })
        ))._tag
      ).toBe("Transitioned")
      expect(yield* admit("child")).toBe(false)
      const root = yield* f.engineRuns.get("root")
      expect((yield* f.engineRuns.claimAndOwn("root", root, owner, 0))._tag).toBe("Activated")
      expect((yield* f.engineRuns.transitionOwned("root", owner, "suspended", root.stateJson))._tag).toBe(
        "Transitioned"
      )
      expect(
        yield* ControlAffinity.make({
          runs: {
            ...f.controlRuns,
            get: () =>
              Effect.fail(
                new RunStore.RunStoreError({
                  code: "not_found_row",
                  method: "get",
                  message: "no control",
                  cause: null
                })
              )
          },
          engineRuns: f.engineRuns,
          claimant: owner
        })("root")
      ).toBe(false)
    })
  ))

it.effect("admits native cancellation and fresh engine roots while denying a dead parent's release without policy", () =>
  withStores((f) =>
    Effect.gen(function*() {
      const options = { runs: f.controlRuns, engineRuns: f.engineRuns, claimant: owner }
      expect(yield* ControlAffinity.make(options)("root")).toBe(true)
      yield* released(f, "cancelled-child")
      const cancelled = yield* f.engineRuns.get("cancelled-child")
      expect((yield* f.engineRuns.claimAndOwn("cancelled-child", cancelled, owner, 0))._tag).toBe("Activated")
      expect(
        (yield* f.engineRuns.transitionOwned(
          "cancelled-child",
          owner,
          "suspended",
          JSON.stringify({
            version: 1,
            flowName: "worker",
            payload: {},
            parentExecutionId: "root",
            cancellation: { interruptedAtMs: 1 }
          })
        ))._tag
      ).toBe("Transitioned")
      expect(yield* ControlAffinity.make(options)("cancelled-child")).toBe(true)
      const dead = { ...owner, pid: process.pid + 1 }
      yield* f.controlRuns.create("root", "{}")
      expect((yield* f.controlRuns.claimAndOwn("root", yield* f.controlRuns.get("root"), dead, 0))._tag)
        .toBe("Activated")
      expect(
        (yield* f.controlRuns.transitionOwned(
          "root",
          dead,
          "suspended",
          JSON.stringify({
            updatedAt: 0,
            parkedBy: JSON.stringify(dead)
          })
        ))._tag
      ).toBe("Transitioned")
      yield* released(f, "ungranted-child")
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
      expect(yield* ControlAffinity.make({ ...options, isAlive: () => Effect.succeed(false) })("ungranted-child"))
        .toBe(false)
    })
  ).pipe(Effect.provide(TestClock.layer())))

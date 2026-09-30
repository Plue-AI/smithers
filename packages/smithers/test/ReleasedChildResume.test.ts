import { NodeCrypto } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as TestStores from "@smthrs/engine-store/test/TestStores"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"
import * as ReleasedChildResume from "../src/internal/ReleasedChildResume.ts"

const owner: Ownership.OwnerId = { hostId: "host", pid: process.pid, nonce: "worker" }
const setup = Effect.gen(function*() {
  const native = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const control = yield* Layer.build(Layer.fresh(TestStores.layerAt(":memory:")))
  const engineRuns = Context.get(native, RunStore.RunStore)
  yield* engineRuns.create("root", JSON.stringify({ version: 1, flowName: "root", payload: {} }))
  return {
    engineJournal: Context.get(native, Journal.Journal),
    controlJournal: Context.get(control, Journal.Journal),
    controlRuns: Context.get(control, RunStore.RunStore),
    engineRuns,
    engineState: Context.get(native, DurableEngineState.DurableEngineState)
  }
}).pipe(Effect.provide(NodeCrypto.layer))
type Fixture = Effect.Success<typeof setup>
const withStores = <A, E>(use: (fixture: Fixture) => Effect.Effect<A, E>) => Effect.scoped(Effect.flatMap(setup, use))
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

it.effect("recovers without an explicit grant only after the released owner is stale and confirmed dead", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release", "interrupt-released", owner)
      const claimant = { ...owner, pid: process.pid + 1, nonce: "observer" }
      const isAlive = vi.fn(() => Effect.succeed(false))
      const resume = ReleasedChildResume.make({ ...f, claimant, isAlive })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter))
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect(isAlive).not.toHaveBeenCalled()
      yield* TestClock.adjust(1)
      isAlive.mockImplementation(() => Effect.succeed(true))
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect(isAlive).toHaveBeenCalledWith(owner, {
        claimant,
        heartbeatAtMs: 0,
        nowMs: Duration.toMillis(Ownership.heartbeatStaleAfter) + 1
      })
      isAlive.mockImplementation(() => Effect.succeed(false))
      expect(yield* resume.canRetryReleased("child", "root")).toBe(true)
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ).pipe(Effect.provide(TestClock.layer())))

it.effect("does not infer dead ownership from missing or malformed release evidence", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      const isAlive = vi.fn(() => Effect.succeed(false))
      const resume = ReleasedChildResume.make({ ...f, claimant: owner, isAlive })
      for (const [index, evidence] of [undefined, { pid: owner.pid }, "owner"].entries()) {
        yield* event(f.engineJournal, "child", `release-${index}`, "interrupt-released", evidence)
        yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
        expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      }
      expect(isAlive).not.toHaveBeenCalled()
    })
  ).pipe(Effect.provide(TestClock.layer())))

it.effect("preserves an inconclusive released-owner probe as a failure", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release", "interrupt-released", owner)
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
      const resume = ReleasedChildResume.make({
        ...f,
        claimant: owner,
        isAlive: () => Effect.die("process probe unavailable")
      })
      expect((yield* Effect.exit(resume.canRetryReleased("child", "root")))._tag).toBe("Failure")
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ).pipe(Effect.provide(TestClock.layer())))

it.effect("keeps a stale released worker parked when the default process probe finds its PID alive", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "release", "interrupt-released", owner)
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
      const resume = ReleasedChildResume.make({ ...f, claimant: { ...owner, pid: process.pid + 1 } })
      expect(yield* resume.canRetryReleased("child", "root")).toBe(false)
      expect((yield* grants(f)).entries).toHaveLength(0)
    })
  ).pipe(Effect.provide(TestClock.layer())))

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
      const resume = ReleasedChildResume.make({ ...f, claimant })
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

it.effect("does not probe a released owner on an unknown remote host", () =>
  withStores((f) =>
    Effect.gen(function*() {
      yield* released(f)
      yield* event(f.engineJournal, "child", "remote-release", "interrupt-released", {
        ...owner,
        hostId: "remote-host"
      })
      yield* TestClock.adjust(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1)
      const isAlive = vi.fn(() => Effect.succeed(false))
      expect(yield* ReleasedChildResume.make({ ...f, claimant: owner, isAlive }).canRetryReleased("child", "root"))
        .toBe(false)
      expect(isAlive).not.toHaveBeenCalled()
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

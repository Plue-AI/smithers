import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import * as Sha256 from "@smthrs/crypto/Sha256"
import { DurableDeferred, Flow, FlowRuntime, WaitFor } from "@smthrs/flow"
import { ExecutionFact, Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as State from "../src/DurableEngineState.ts"
import * as Facts from "../src/ExecutionFacts.ts"
import * as Snapshot from "../src/ExecutionSnapshot.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import { fixture, onFile, state as stateJson } from "./ExecutionSnapshotFixture.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"

const services = Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer, State.layer)
const owner = { hostId: "facts-host", pid: 123, nonce: "facts" }
const TestFlow = Flow.make("facts/test", { payload: {}, success: Schema.String, body: opaqueHandlerBody })
const history = (journal: Journal.Service, executionId: string) =>
  Effect.gen(function*() {
    const generation = journal.generation === undefined
      ? { generation: 0 }
      : yield* journal.generation(JournalEvent.RunId.make(executionId))
    const page = yield* journal.entries({ runId: JournalEvent.RunId.make(executionId), limit: 1000 })
    return page.entries.map((entry): ExecutionFact.Input => ({
      executionId,
      generation: generation.generation,
      sequence: entry.seq,
      eventType: entry.eventType,
      payload: entry.payload
    }))
  })
const ports = Effect.gen(function*() {
  const runs = yield* RunStore.RunStore
  const state = yield* State.DurableEngineState
  const journal = yield* Journal.Journal
  return { runs, state, journal, facts: Facts.make({ runs, state, journal, sourceId: "facts-test" }) }
})
const verified = (executionId: string) =>
  Effect.gen(function*() {
    const { runs, state, journal } = yield* ports
    const observed = yield* Facts.observe(yield* runs.get(executionId), state)
    const reader = yield* Snapshot.make()
    const batch = yield* reader.read([executionId])
    const snapshot = batch.snapshots[0]!
    if (snapshot._tag !== "Observed") return yield* Effect.die("missing observation")
    expect(observed).toEqual({
      executionId: snapshot.runId,
      flowName: snapshot.flowName,
      status: snapshot.status,
      createdAtMs: snapshot.createdAtMs,
      startedAtMs: snapshot.startedAtMs,
      finishedAtMs: snapshot.finishedAtMs,
      parentRunId: snapshot.parentRunId,
      lineageId: snapshot.lineageId,
      roundOrdinal: snapshot.roundOrdinal,
      cancelRequestedAtMs: snapshot.cancellation.requestedAtMs,
      treeVersion: 1,
      parentPolicy: "cancel",
      waiting: snapshot.waiting === null
        ? null
        : {
          reason: snapshot.waiting.reason,
          tokenDigest: snapshot.waiting.tokenDigest,
          wakeAtMs: snapshot.waiting.wakeAtMs,
          point: null,
          request: null
        }
    })
    const events = yield* history(journal, executionId)
    const folded = ExecutionFact.fold(events, executionId, { root: observed, current: observed })
    expect(folded.provenance.source, JSON.stringify({ observed, events })).toBe("events")
    expect(folded.view).toEqual({
      root: observed,
      current: observed,
      humanWaits: observed.status === "suspended" && observed.waiting?.reason === "approval" ? [observed] : []
    })
    return folded
  })

const suspendedPointOnReopen = (token: string, point: string | null) =>
  fixture((file) =>
    Effect.gen(function*() {
      const executionId = "question"
      yield* onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            const driver = yield* RunDriver.make({
              owner,
              journalSource: "wait-point-facts",
              engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
            })
            yield* driver.register(TestFlow, () =>
              FlowRuntime.annotateWaiting({ reason: "approval", token }).pipe(
                Effect.andThen(Effect.flatMap(FlowRuntime.FlowInstance, Flow.suspend))
              ))
            yield* driver.execute(TestFlow, { executionId, payload: {}, discard: true })
          }).pipe(Effect.provide(services), Effect.provide(NodeCrypto.layer))
        )
      )
      yield* onFile(
        file,
        Effect.gen(function*() {
          const { runs, state, journal } = yield* ports
          expect((yield* runs.get(executionId)).status).toBe("suspended")
          const observed = yield* Facts.observe(yield* runs.get(executionId), state)
          expect(observed.status).toBe("suspended")

          const events = yield* history(journal, executionId)
          const suspendedFacts = events.flatMap((event) => {
            const fact = (event.payload as { executionFact?: { observation?: ExecutionFact.Observation } })
              .executionFact
            return fact?.observation?.status === "suspended" ? [fact.observation] : []
          })
          expect(suspendedFacts.length).toBeGreaterThan(0)
          for (const fact of suspendedFacts) expect(fact.waiting?.point).toBe(point)
          expect(observed.waiting?.point).toBe(point)
          expect(observed.waiting?.tokenDigest).toBe(Sha256.digestSync(token))
          const folded = ExecutionFact.fold(events, executionId)
          expect(folded.provenance.source).toBe("events")
          expect(folded.view?.current.status).toBe("suspended")
          expect(folded.view?.current.waiting?.point).toBe(point)
        }).pipe(Effect.provide(services))
      )
    })
  )

describe("native facts over file SQLite", () => {
  it.effect("legacy parent observations resolve equal sequence metadata deterministically", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            const { runs, state } = yield* ports
            yield* runs.create("legacy-child", stateJson)
            const row = yield* runs.get("legacy-child")
            const observed = yield* Facts.observe(row, {
              ...state,
              runParents: () =>
                Effect.succeed([
                  { parentId: "zeta", childId: row.runId, seq: 1 },
                  { parentId: "alpha", childId: row.runId, seq: 1 }
                ])
            })
            expect(observed.parentRunId).toBe("alpha")
          }).pipe(Effect.provide(services))
        )
      )
    ))

  it.effect("the real driver records creation, wait, resume and settlement equal to SQLite snapshots after reopening", () =>
    fixture((file) =>
      Effect.gen(function*() {
        yield* onFile(
          file,
          Effect.scoped(
            Effect.gen(function*() {
              const { runs, journal } = yield* ports
              let suspend = true
              const driver = yield* RunDriver.make({
                owner,
                journalSource: "driver-facts",
                engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
              })
              yield* driver.register(TestFlow, () =>
                Effect.gen(function*() {
                  if (!suspend) return "done"
                  yield* FlowRuntime.annotateWaiting({ reason: "approval", token: "request" })
                  return yield* Effect.flatMap(FlowRuntime.FlowInstance, Flow.suspend)
                }))
              yield* driver.execute(TestFlow, { executionId: "driver", payload: {}, discard: true })
              expect((yield* verified("driver")).view?.current.waiting).toEqual({
                reason: "approval",
                wakeAtMs: null,
                tokenDigest: Sha256.digestSync("request"),
                point: null,
                request: null
              })
              expect((yield* verified("driver")).provenance.baseline).toBe("created")
              suspend = false
              yield* driver.resume(TestFlow, "driver")
              expect((yield* verified("driver")).view?.current.status).toBe("completed")
              expect((yield* runs.get("driver")).status).toBe("completed")
              const events = yield* history(journal, "driver")
              expect(events.map((event) => (event.payload as { decision?: string }).decision)).toContain("resumed")
            }).pipe(Effect.provide(services), Effect.provide(NodeCrypto.layer))
          )
        )
        yield* onFile(file, verified("driver").pipe(Effect.provide(services)))
      })
    ))

  it.effect("reopens a question fact equal to the redacted raw wait without putting its wake token in history", () =>
    fixture((file) =>
      Effect.gen(function*() {
        const token = globalThis.btoa(JSON.stringify([TestFlow._tag, "question", "WaitFor/review#1"]))
        const request = { kind: "ask", name: "review", attempt: 1, prompt: "Review Bearer syntheticcredential123" }
        yield* onFile(
          file,
          Effect.scoped(
            Effect.gen(function*() {
              const driver = yield* RunDriver.make({
                owner,
                journalSource: "question-facts",
                engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
              })
              yield* driver.register(TestFlow, () =>
                FlowRuntime.annotateWaiting({
                  reason: "approval",
                  token,
                  request: JSON.stringify(request)
                }).pipe(Effect.andThen(Effect.flatMap(FlowRuntime.FlowInstance, Flow.suspend))))
              yield* driver.execute(TestFlow, { executionId: "question", payload: {}, discard: true })
            }).pipe(Effect.provide(services), Effect.provide(NodeCrypto.layer))
          )
        )
        yield* onFile(
          file,
          Effect.gen(function*() {
            const { runs, state, journal } = yield* ports
            const observed = yield* Facts.observe(yield* runs.get("question"), state)
            const events = yield* history(journal, "question")
            const view = { root: observed, current: observed, humanWaits: [observed] }
            expect(ExecutionFact.fold(events, "question", view)).toMatchObject({
              view,
              provenance: { source: "events", humanWaits: "events" }
            })
            expect(observed.waiting).toMatchObject({
              point: "review#1",
              request: {
                prompt: "Review Bearer [REDACTED_TOKEN]"
              }
            })
            const raw = yield* (yield* Snapshot.make()).read(["question"])
            expect(raw.snapshots[0]?._tag === "Observed" && raw.snapshots[0].waiting?.request).toEqual(request)
            const encoded = JSON.stringify(events)
            expect(encoded).not.toContain(token)
            expect(encoded).not.toContain("syntheticcredential123")
          }).pipe(Effect.provide(services))
        )
      })
    ))

  it.effect.each(["review", "révision", "审批", "🚀"])(
    "Unicode public wait token survives history: %s",
    (name) =>
      suspendedPointOnReopen(
        DurableDeferred.tokenFromExecutionId(WaitFor.deferred(name), {
          flow: TestFlow,
          executionId: "question"
        }),
        name
      )
  )

  it.effect.each([
    { name: "malformed opaque token", token: "not-a-durable-deferred-token" },
    {
      name: "valid non-WaitFor token",
      token: DurableDeferred.tokenFromExecutionId(DurableDeferred.make("Other/review"), {
        flow: TestFlow,
        executionId: "question"
      })
    }
  ])("keeps the point null for a $name after reopening", ({ token }) => suspendedPointOnReopen(token, null))

  it.effect("a rejected suspension event rolls the waiting payload back with its run status and publishes no terminal fact", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            const { state, journal } = yield* ports
            const broken = Journal.make({
              ...journal,
              emitDurableUnfenced: (input) => {
                const payload = input.payload as { decision?: string; status?: string }
                return payload.decision === "transitioned" && payload.status === "suspended"
                  ? journal.emitDurableUnfenced(input).pipe(
                    Effect.andThen(
                      Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "after suspension insert" }))
                    )
                  )
                  : journal.emitDurableUnfenced(input)
              }
            })
            const driver = yield* RunDriver.make({
              owner,
              journalSource: "broken-wait",
              engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
            }).pipe(Effect.provideService(Journal.Journal, broken))
            yield* driver.register(TestFlow, () =>
              FlowRuntime.annotateWaiting({ reason: "approval", token: "request" }).pipe(
                Effect.andThen(Effect.flatMap(FlowRuntime.FlowInstance, Flow.suspend))
              ))
            yield* driver.execute(TestFlow, { executionId: "broken", payload: {}, discard: true }).pipe(Effect.exit)
            expect(Option.isNone(yield* state.waiting("broken"))).toBe(true)
            const folded = yield* verified("broken")
            expect(folded.view?.current.status).toBe("running")
            const sql = yield* SqlClient.SqlClient
            const records = yield* sql<
              { count: number }
            >`SELECT count(*) AS count FROM flows_runs WHERE run_id = 'broken' AND waiting_reason IS NOT NULL`
            expect(records[0]?.count).toBe(0)
          }).pipe(Effect.provide(services), Effect.provide(NodeCrypto.layer))
        )
      )
    ))

  it.effect("a direct native cancellation changes every live round and publishes only after the exact event commits; failure rolls everything back", () =>
    fixture((file) =>
      onFile(
        file,
        Effect.scoped(
          Effect.gen(function*() {
            const { runs, state, journal, facts } = yield* ports
            yield* runs.create("root", stateJson)
            yield* runs.create("round", stateJson, { lineageId: "root", roundOrdinal: 1, parentRunId: "root" })
            const published: Array<string> = []
            const changes = yield* journal.changes
            yield* Stream.fromSubscription(changes).pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  published.push(event.eventType)
                })
              ),
              Effect.forkScoped
            )
            let inserted = 0
            const failing = Facts.make({
              runs,
              state,
              sourceId: "facts-test",
              journal: Journal.make({
                ...journal,
                emitDurableUnfenced: (input) =>
                  journal.emitDurableUnfenced(input).pipe(Effect.tap(() =>
                    ++inserted === 2
                      ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "after second insert" }))
                      : Effect.void
                  ))
              })
            })
            expect(Exit.isFailure(yield* Effect.exit(failing.requestCancelLineage("root", 10)))).toBe(true)
            expect((yield* runs.get("root")).cancelRequestedAtMs).toBeNull()
            expect((yield* runs.get("round")).cancelRequestedAtMs).toBeNull()
            expect(yield* history(journal, "root")).toEqual([])
            expect(yield* history(journal, "round")).toEqual([])
            yield* Effect.yieldNow
            expect(published).toEqual([])
            expect((yield* facts.requestCancelLineage("root", 10))._tag).toBe("CancelRequested")
            expect((yield* verified("root")).provenance.baseline).toBe("legacy")
            yield* verified("round")
            expect((yield* facts.requestCancelLineage("root", 20))._tag).toBe("AlreadyRequested")
            expect(yield* history(journal, "root")).toHaveLength(1)
            expect((yield* facts.requestCancelLineage("absent", 20))._tag).toBe("NotFound")
            yield* runs.create("completed-root", stateJson)
            yield* runs.create("live-round", stateJson, {
              lineageId: "completed-root",
              roundOrdinal: 1,
              parentRunId: "completed-root"
            })
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE flows_runs SET status = 'completed', finished_at_ms = 1 WHERE run_id = 'completed-root'`
            expect((yield* facts.requestCancelLineage("completed-root", 30))._tag).toBe("CancelRequested")
            expect((yield* runs.get("completed-root")).cancelRequestedAtMs).toBeNull()
            expect(yield* history(journal, "completed-root")).toEqual([])
            expect((yield* verified("live-round")).view?.current.cancelRequestedAtMs).toBe(30)
          }).pipe(Effect.provide(services))
        )
      )
    ))
})

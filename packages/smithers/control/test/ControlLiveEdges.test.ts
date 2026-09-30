/**
 * The refusals and degraded paths `ControlLive` owns, and the composition that
 * has no executor at all.
 *
 * Three things meet here that the happy-path suites never reach. An
 * idempotency key is the only caller-supplied string this package uses as a
 * durable primary key, so what it accepts is a storage contract and not a
 * formatting preference. A verb answered on a run that already settled has to
 * say so rather than pretend it acted. And `ControlLive` composes an OPTIONAL
 * executor: without one there is no engine, and every verb that would have
 * asked one has to answer from what the control plane alone knows.
 */
import { Journal } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import { ClaimLost, InvalidInput, PersistenceError, RunNotFound } from "../src/ControlError.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import { ControlRuntime, type MemoryFlow, type Service as ControlRuntimeService } from "../src/ControlRuntime.ts"
import type { Envelope, Receipt, RunSummary } from "../src/ControlSchema.ts"
import { live, memoryRuntime, type Stack } from "./TestStack.ts"

const envelope: Envelope = { capabilities: [], flows: [], budget: {} }

const flows: ReadonlyArray<MemoryFlow> = [
  { flowId: "system/test", description: "Reserved test system flow", deployClass: false, envelope }
]

const run = <A, E>(
  body: Effect.Effect<A, E, Stack>,
  stack: Layer.Layer<Stack> = live({ runtime: memoryRuntime({ flows }) })
): Promise<A> => Effect.runPromise(body.pipe(Effect.provide(stack), Effect.scoped, Effect.orDie))

/** Plans, approves, and starts one run. */
const start = (suffix: string) =>
  Effect.gen(function*() {
    const control = yield* Control
    const runtime = yield* ControlRuntime
    const card = yield* control.plan({ flowId: "system/test", input: { suite: suffix } })
    yield* control.approve({ ...card.approval, idempotencyKey: `approve:${suffix}` })
    const receipt = yield* control.run({
      _tag: "Plan",
      planId: card.planId,
      digest: card.digest,
      envelope: card.envelope,
      idempotencyKey: `run:${suffix}`
    })
    if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a started run")
    yield* runtime.resume(receipt.runId)
    return receipt.runId
  })

/**
 * The deterministic runtime with individual methods replaced.
 *
 * `ControlLive` reads the same row more than once inside one verb, and the
 * states between those reads belong to a second process: an engine that
 * settled the run, a peer holding its fence, a row that will not take a write.
 * Replacing one method is how a single-process suite reaches them.
 */
const wrapping = (
  override: (runtime: ControlRuntimeService) => Partial<ControlRuntimeService>
): Layer.Layer<ControlRuntime> =>
  Layer.effect(
    ControlRuntime,
    Effect.map(ControlRuntime, (runtime) => ({ ...runtime, ...override(runtime) }))
  ).pipe(Layer.provide(memoryRuntime({ flows })))

/** What a receipt says, flattened for a single equality. */
const said = (receipt: Receipt): ReadonlyArray<unknown> => [
  receipt._tag,
  receipt._tag === "Terminal" ? receipt.status : undefined
]

describe("ControlLive idempotency keys", () => {
  it.each(["interrupt", "settle"] as const)("journals cancellation when the engine wins during %s", async (phase) => {
    let cancelling = false
    let finished = false
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start(`cancel-race:${phase}`)
        yield* runtime.writeStatus(runId, yield* runtime.claimFence(runId), "parked")
        cancelling = true
        yield* control.cancel({ runId, idempotencyKey: "cancel:engine-wins" })
        const after = yield* runtime.getRun(runId)
        yield* control.cancel({ runId, idempotencyKey: "cancel:engine-wins" })
        const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
        return { after, events }
      }),
      live({
        runtime: wrapping((runtime) => ({
          interrupt: (runId) =>
            Effect.gen(function*() {
              if (phase === "interrupt") finished = true
              return yield* new ClaimLost({ runId })
            }),
          resume: (runId, options) =>
            cancelling && !finished ? Effect.fail(new ClaimLost({ runId })) : runtime.resume(runId, options)
        })),
        executor: ControlExecutor.makeNoop({
          readExecution: () =>
            Effect.sync(() => ({
              _tag: "Observed" as const,
              status: finished ? "cancelled" as const : "parked" as const
            })),
          requestCancel: () => Effect.succeed("recorded" as const),
          settleCancelledPark: () =>
            Effect.sync(() => {
              finished = true
            })
        })
      })
    )
    expect(observed.after.status).toBe("cancelled")
    expect(observed.events.filter((event) => event.kind === "control.run.cancelled")).toHaveLength(1)
  })

  it("refuses a key the durable store could not tell one intent from another by", async () => {
    // Each of these is a way for one key to name nothing storable: an empty key
    // names no operation, an over-long one is past the column's bound, and a NUL
    // truncates the store's own length check so two different keys compare
    // equal after a round trip.
    const refused = await run(Effect.gen(function*() {
      const control = yield* Control
      return yield* Effect.forEach(
        ["", "k".repeat(1025), "with\0nul"],
        (idempotencyKey) => control.cancel({ runId: "missing-run", idempotencyKey }).pipe(Effect.flip)
      )
    }))

    for (const error of refused) {
      expect(error).toBeInstanceOf(InvalidInput)
      expect((error as InvalidInput).issue).toContain("cancel.idempotencyKey")
    }
    // The refusal names the rule, never the key that broke it.
    for (const error of refused) expect((error as InvalidInput).issue).not.toContain("nul")
  })

  it("accepts a key whose surrogates are paired, because that is one well-formed string", async () => {
    // Ill-formed text is refused a step earlier, by the mutation boundary. A
    // surrogate PAIR is a single astral character and has to survive, or every
    // emoji an operator puts in a key would be refused as ill-formed.
    const receipt = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("paired")
      return yield* control.cancel({ runId, idempotencyKey: "cancel:🚀" })
    }))

    expect(said(receipt)).toEqual(["Terminal", "cancelled"])
  })

  it("refuses ill-formed text before it is ever a key", async () => {
    const error = await run(Effect.gen(function*() {
      const control = yield* Control
      return yield* control.cancel({ runId: "missing-run", idempotencyKey: "lead\ud800" }).pipe(Effect.flip)
    }))

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toContain("ill-formed text")
  })

  it("names the offending property when a mutation's shape is wrong", async () => {
    const error = await run(Effect.gen(function*() {
      const control = yield* Control
      return yield* control.cancel(
        { runId: 7, idempotencyKey: "cancel:mistyped" } as unknown as { runId: string; idempotencyKey: string }
      ).pipe(Effect.flip)
    }))

    expect(error).toBeInstanceOf(InvalidInput)
    expect((error as InvalidInput).issue).toContain("cancel: invalid mutation at")
    expect((error as InvalidInput).issue).toContain("runId")
  })

  it("answers Conflict when one key is reused for a different intent", async () => {
    // The key is the caller's promise that two calls are the same operation.
    // Two different runs under one key are two operations, and answering the
    // first one's receipt would report a cancel that never happened.
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const first = yield* start("conflict-a")
      const second = yield* start("conflict-b")
      const cancelled = yield* control.cancel({ runId: first, idempotencyKey: "shared-key" })
      const conflicted = yield* control.cancel({ runId: second, idempotencyKey: "shared-key" })
      // A conflict is derived from the STORED fingerprint, so it survives this
      // call rather than being remembered by it.
      const again = yield* control.cancel({ runId: second, idempotencyKey: "shared-key" })
      const secondStatus = yield* Effect.map(
        Effect.flatMap(ControlRuntime, (runtime) => runtime.getRun(second)),
        (summary) => summary.status
      )
      return { again, cancelled, conflicted, secondStatus }
    }))

    expect(said(observed.cancelled)).toEqual(["Terminal", "cancelled"])
    expect(observed.conflicted._tag).toBe("Conflict")
    expect(observed.again._tag).toBe("Conflict")
    // The refused call did nothing: the second run is untouched.
    expect(observed.secondStatus).toBe("accepted")
  })
})

describe("ControlLive listings", () => {
  it("applies filters.principalId to the recorded launcher and a reader to its own runs", async () => {
    // The field crosses the wire, so a caller can reasonably read it as a
    // tenant restriction. It selects on the launcher every control launch now
    // records, and a restricted reader cannot use it to borrow another's view.
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("principal-filter")
      const ids = (input: Parameters<typeof control.list>[0]) =>
        Effect.map(control.list(input), (page) => page._tag === "runs" ? page.items.map((item) => item.runId) : [])
      const reader = { id: "memory", kind: "test", stampedAt: 0 }
      return {
        runId,
        nobody: yield* ids({ _tag: "runs", filters: { principalId: "nobody" } }),
        launcher: yield* ids({ _tag: "runs", filters: { principalId: "memory" } }),
        exact: yield* ids({ _tag: "runs", filters: { runId, principalId: "nobody" } }),
        reader: yield* ids({ _tag: "runs", reader }),
        otherKind: yield* ids({ _tag: "runs", reader: { ...reader, kind: "user" } }),
        borrowed: yield* ids({ _tag: "runs", reader: { ...reader, id: "other" }, filters: { principalId: "memory" } })
      }
    }))

    expect(observed.nobody).toEqual([])
    expect(observed.launcher).toEqual([observed.runId])
    expect(observed.exact).toEqual([])
    expect(observed.reader).toEqual([observed.runId])
    expect(observed.otherKind).toEqual([])
    expect(observed.borrowed).toEqual([])
  })

  it("leaves the steering count absent when the queue cannot answer", async () => {
    // One journal instance, shared by the stack and by the queue built over it:
    // two independent `TestJournal.layer()` values are two databases, and the
    // queue would then read a schema the stack never migrated.
    const journal = Layer.orDie(TestJournal.layer())
    const refusing = Layer.effect(
      NotificationQueue.NotificationQueue,
      Effect.map(NotificationQueue.NotificationQueue, (queue) => ({
        ...queue,
        pending: () =>
          Effect.fail(
            new NotificationQueue.NotificationError({
              code: "notification_unavailable",
              message: "the queue is unavailable"
            })
          )
      }))
    ).pipe(Layer.provide(NotificationQueue.layer), Layer.provide(journal))

    const listed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        yield* start("queue-offline")
        return yield* control.list({ _tag: "runs" })
      }),
      live({ journal, notifications: refusing, runtime: memoryRuntime({ flows }) })
    )

    if (listed._tag !== "runs") throw new Error("expected a run listing")
    expect(listed.items).toHaveLength(1)
    // "Not known" is representable and it is the truth. A zero would have been
    // a claim the queue never made, and an operator would read it as "no
    // steering is waiting".
    expect(listed.items[0]?.steering).toBeUndefined()
  })

  it("fails the listing when the journal under the queue fails", async () => {
    // A queue that refuses is a missing count. A JOURNAL that fails is a
    // storage failure, and answering a listing over it would report every run
    // as steer-free on evidence nobody read.
    const journal = Layer.orDie(TestJournal.layer())
    const broken = Layer.effect(
      NotificationQueue.NotificationQueue,
      Effect.map(NotificationQueue.NotificationQueue, (queue) => ({
        ...queue,
        pending: () => Effect.fail(new Journal.JournalError({ code: "read_failed", message: "the journal is gone" }))
      }))
    ).pipe(Layer.provide(NotificationQueue.layer), Layer.provide(journal))

    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        yield* start("journal-offline")
        return yield* control.list({ _tag: "runs" }).pipe(Effect.flip)
      }),
      live({ journal, notifications: broken, runtime: memoryRuntime({ flows }) })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toBe("control.list.steering")
  })
})

describe("ControlLive steering refusal", () => {
  it("does not acknowledge a full queue and can retry the same keyed message after drain", async () => {
    const journal = Layer.orDie(TestJournal.layer())
    const notifications = NotificationQueue.layerWith({ capacity: 1 }).pipe(Layer.provide(journal))
    await run(
      Effect.gen(function*() {
        const control = yield* Control, queue = yield* NotificationQueue.NotificationQueue
        const runId = yield* start("full-steering")
        const submit = (id: string) =>
          control.steer({
            runId,
            idempotencyKey: id,
            message: {
              runId,
              messageId: id,
              body: "private submitted feedback",
              createdAt: 0,
              principal: { kind: "test", id: "operator", stampedAt: 0 }
            }
          })
        expect((yield* submit("first"))._tag).toBe("Accepted")
        const rejected = yield* submit("second").pipe(Effect.flip)
        expect(rejected).toBeInstanceOf(NotificationQueue.NotificationError)
        expect(rejected.code).toBe("notification_full")
        expect(rejected.message).not.toContain("private submitted feedback")
        expect((yield* queue.pending(runId)).map((note) => note.id)).toEqual(["first"])
        yield* queue.drain({ runId, targetLineageId: runId, boundary: "release", wouldIdle: true })
        expect((yield* submit("second"))._tag).toBe("Accepted")
        expect((yield* submit("second"))._tag).toBe("AlreadyApplied")
        expect((yield* queue.pending(runId)).map((note) => note.id)).toEqual(["second"])
      }),
      live({ journal, notifications, runtime: memoryRuntime({ flows }) })
    )
  })
})

describe("ControlLive without an executor", () => {
  const headless = () => live({ executor: "absent", runtime: memoryRuntime({ flows }) })

  it("cancels from what the control plane alone knows", async () => {
    // No executor means no engine row to record the request on and no park to
    // settle. The control row is still the operator's answer, and it has to
    // reach a terminal status rather than wait for a messenger that is absent.
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start("headless-cancel")
        const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:headless", reason: "operator" })
        return { after: yield* runtime.getRun(runId), receipt }
      }),
      headless()
    )

    expect(said(observed.receipt)).toEqual(["Terminal", "cancelled"])
    expect(observed.after.status).toBe("cancelled")
  })

  it("records a signal without claiming a wait point closed", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start("headless-signal")
        const receipt = yield* control.signal({
          runId,
          signal: { name: "continue", payload: null },
          idempotencyKey: "signal:headless"
        })
        return { delivered: yield* runtime.deliveredSignals(runId), receipt }
      }),
      headless()
    )

    expect(observed.receipt._tag).toBe("Accepted")
    // The delivery is recorded on the control plane. Nothing here could have
    // matched it to a wait point, and nothing pretended to.
    expect(observed.delivered.map((signal) => signal.name)).toEqual(["continue"])
  })

  it("leaves an approved run's resume standing for a host that can take it up", async () => {
    const target = {
      _tag: "Node" as const,
      runId: "run-1",
      requestId: "ask/run-1/digest",
      digest: "digest",
      envelope
    }

    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start("headless-approval")
        yield* runtime.registerApproval({ ...target, runId })
        const receipt = yield* control.approve({
          target: { ...target, runId },
          scope: "once",
          idempotencyKey: "approve:headless"
        })
        return { receipt, summary: yield* runtime.getRun(runId) }
      }),
      headless()
    )

    expect(observed.receipt._tag).toBe("Accepted")
    // Durable and still standing: a composition with no executor has nobody to
    // hand the restart to, and dropping it would lose the decision.
    expect(observed.summary.pendingResume).toBeDefined()
  })
})

describe("ControlLive on a settled run", () => {
  it("answers Terminal from resume, signal, and a Resume submitted through run", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const runId = yield* start("settled")
      yield* control.cancel({ runId, idempotencyKey: "cancel:settled" })
      return {
        resumed: yield* control.resume({ runId, idempotencyKey: "resume:settled" }),
        signalled: yield* control.signal({
          runId,
          signal: { name: "continue", payload: null },
          idempotencyKey: "signal:settled"
        }),
        submitted: yield* control.run({ _tag: "Resume", runId, idempotencyKey: "run-resume:settled" })
      }
    }))

    expect(said(observed.resumed)).toEqual(["Terminal", "cancelled"])
    expect(said(observed.signalled)).toEqual(["Terminal", "cancelled"])
    // `run({_tag:"Resume"})` is the same verb over the wire, so it owes the
    // same answer rather than a receipt recorded before the run settled.
    expect(said(observed.submitted)).toEqual(["Terminal", "cancelled"])
  })

  it("carries a decision on a run this plane cannot find through to the token", async () => {
    const error = await run(Effect.gen(function*() {
      const control = yield* Control
      return yield* control.approve({
        target: { _tag: "Node", runId: "run-that-never-existed", requestId: "ask/x", digest: "digest", envelope },
        scope: "once",
        idempotencyKey: "approve:unknown-run"
      }).pipe(Effect.flip)
    }))

    // The missing RUN is not the refusal: the terminality read answers "unknown,
    // carry on", and the decision is refused because no token was registered.
    expect(error._tag).toBe("/control/RunNotFound")
  })
})

describe("ControlLive when the journal cannot commit", () => {
  it("reports a failed mutation transaction as a persistence failure naming the pair", async () => {
    // The mutation and its idempotency receipt commit together or not at all.
    // A caller that saw a bare journal failure could not tell whether the
    // receipt landed, which is the one thing the key exists to answer.
    const error = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        // Seed the approval directly: Control.plan also requires a transaction.
        const { card } = yield* runtime.plan({ flowId: "system/test", input: { suite: "no-journal" } })
        return yield* control.approve({ ...card.approval, idempotencyKey: "approve:no-journal" }).pipe(Effect.flip)
      }),
      live({
        journal: Layer.effect(
          Journal.Journal,
          Effect.map(Journal.Journal, (journal) => ({
            ...journal,
            transact: () =>
              Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "the writer refused" }))
          }))
        ).pipe(Layer.provide(Layer.orDie(TestJournal.layer()))),
        runtime: memoryRuntime({ flows })
      })
    )

    expect(error).toBeInstanceOf(PersistenceError)
    expect((error as PersistenceError).operation).toContain("idempotency")
  })
})

describe("ControlLive executor uptake", () => {
  it("clears the delegation only when the host says it is driving the run", async () => {
    const asked: Array<string> = []
    const executor = ControlExecutor.makeNoop({
      resumeRun: ({ runId }) =>
        Effect.sync(() => {
          asked.push(runId)
          return "resuming" as const
        })
    })
    const target = { _tag: "Node" as const, requestId: "ask/uptake", digest: "digest", envelope }

    const observed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start("uptake")
        yield* runtime.registerApproval({ ...target, runId })
        // A key of its own: `start` already spent `approve:uptake` on the
        // plan-level decision, and one key over two intents is a Conflict.
        yield* control.approve({ target: { ...target, runId }, scope: "once", idempotencyKey: "approve:uptake-node" })
        return yield* runtime.getRun(runId)
      }),
      live({ executor, runtime: memoryRuntime({ flows }) })
    )

    expect(asked).toEqual(["run-1"])
    // A host that claimed the row and re-drove the run owns the resume, so the
    // record it was handed is cleared rather than left for a second host to
    // take up a second time.
    expect(observed.pendingResume).toBeUndefined()
  })
})

describe("ControlLive when the row moves under it", () => {
  it("answers Terminal when the run settles between the two reads a resume takes", async () => {
    // The outer read decides whether to replay a receipt; the inner one, inside
    // the write transaction, decides what to do. Between them the run can
    // settle — in the shipped CLI the engine owns a second `flows_runs` table
    // in a second file — and the mutation has to notice rather than claim a
    // fence on a finished run.
    let settledReads = 0
    const receipt = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start("mid-flight")
        // Armed after the run exists: from here the FIRST read still sees a
        // live run and every later one sees the settled row.
        settledReads = 1
        return yield* control.resume({ runId, idempotencyKey: "resume:mid-flight" })
      }),
      live({
        runtime: wrapping((runtime) => ({
          getRun: (runId) =>
            Effect.map(
              runtime.getRun(runId),
              (summary) =>
                settledReads > 0 && settledReads++ > 1 ? { ...summary, status: "completed" as const } : summary
            )
        }))
      })
    )

    expect(said(receipt)).toEqual(["Terminal", "completed"])
  })

  it("leaves a control row that already agrees with the engine alone, and survives one it cannot write", async () => {
    // A cancel that learns the engine settled first reconciles the control row
    // onto the engine's status. Two things must not happen: a second write when
    // the row already agrees, and a failed reconciliation taking the operator's
    // receipt down with it.
    const terminalEngine = ControlExecutor.makeNoop({
      requestCancel: () => Effect.succeed({ _tag: "Terminal" as const, status: "completed" as const })
    })
    let agreed = 0
    const alreadyAgreed = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start("engine-agreed")
        agreed = 1
        return yield* control.cancel({ runId, idempotencyKey: "cancel:engine-agreed" })
      }),
      live({
        executor: terminalEngine,
        runtime: wrapping((runtime) => ({
          getRun: (runId) =>
            Effect.map(
              runtime.getRun(runId),
              (summary) => agreed > 0 && agreed++ > 1 ? { ...summary, status: "completed" as const } : summary
            )
        }))
      })
    )

    let unwritableRow = false
    const unwritable = await run(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start("engine-unwritable")
        // Armed after the run exists: starting one needs the fence this then
        // refuses.
        unwritableRow = true
        const receipt = yield* control.cancel({ runId, idempotencyKey: "cancel:engine-unwritable" })
        return { after: yield* (yield* ControlRuntime).getRun(runId), receipt }
      }),
      live({
        executor: terminalEngine,
        runtime: wrapping((runtime) => ({
          claimFence: (runId) =>
            unwritableRow
              ? Effect.fail(
                new PersistenceError({ operation: "claim a fence", message: `the row for ${runId} is unwritable` })
              )
              : runtime.claimFence(runId)
        }))
      })
    )

    expect(said(alreadyAgreed)).toEqual(["Terminal", "completed"])
    // The engine's own status is still the receipt, and the unreconciled row
    // is left as it was rather than the caller losing the answer.
    expect(said(unwritable.receipt)).toEqual(["Terminal", "completed"])
    expect(unwritable.after.status).not.toBe("completed")
  })

  it("records a steer for a parked run whose wake nobody can take", async () => {
    // The wake is a courtesy: the message is already durable, so a run whose
    // fence a peer holds — or whose row this plane cannot find — must not turn
    // an admitted steer into a failed one.
    const parked = (summary: RunSummary): RunSummary => ({
      ...summary,
      status: "parked",
      waitingReason: "event"
    })
    const steer = (runId: string) => ({
      runId,
      message: {
        messageId: `steer:${runId}`,
        runId,
        principal: { id: "operator", kind: "test", stampedAt: 0 },
        createdAt: 0,
        body: "wake up"
      },
      idempotencyKey: `steer:${runId}`
    })
    const receipts = await Promise.all(
      [
        (runId: string) => new ClaimLost({ runId }),
        (runId: string) => new RunNotFound({ runId })
      ].map((refusal) => {
        // Armed after the run exists: starting one needs the very reads and
        // claims this then takes away.
        let armed = false
        const stack = live({
          runtime: wrapping((runtime) => ({
            getRun: (runId) => armed ? Effect.map(runtime.getRun(runId), parked) : runtime.getRun(runId),
            resume: (runId, options) => armed ? Effect.fail(refusal(runId)) : runtime.resume(runId, options)
          }))
        })
        return run(
          Effect.gen(function*() {
            const control = yield* Control
            const runId = yield* start("parked-wake")
            armed = true
            return yield* control.steer(steer(runId))
          }),
          stack
        )
      })
    )

    for (const receipt of receipts) expect(receipt._tag).toBe("Accepted")
  })
})

/**
 * The host side of a guard park, through `AgentSession.budgetParking` over the
 * production approval-request commit, a SQL journal, and the memory control
 * runtime.
 *
 * A budget park asks one question per exceeded ceiling and reuses it on every
 * re-drive. A timeout park asks one question per timed-out subject and
 * ordinal: an open question is re-parked on, Stop is final, and a decision
 * that lands between the journal scan and the commit is settled on. Every
 * read or commit the park cannot make fails the park with a typed error
 * rather than parking on a question nobody recorded.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ControlFacts, ControlRuntime, type ControlSchema } from "@smthrs/control"
import { EnvelopeMismatch, PersistenceError } from "@smthrs/control/ControlError"
import * as HarnessError from "@smthrs/harness/HarnessError"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import * as AgentSession from "../src/AgentSession.ts"
import * as Budget from "../src/Budget.ts"
import * as RunawayGuard from "../src/RunawayGuard.ts"

type Runtime = ControlRuntime.ControlRuntime["Service"]
type RequestFact = typeof ControlFacts.ApprovalRequestFact.Type

interface World {
  readonly journal: Journal.Service
  readonly runtime: Runtime
  readonly runId: string
}

const latencyEnvelope: ControlSchema.Envelope = {
  capabilities: [],
  flows: [],
  budget: { milliseconds: 100, onExceeded: "park" }
}

const latency = (used: number) =>
  new Budget.BudgetExceeded({
    scope: "latency",
    onExceeded: "park",
    used,
    reserved: 0,
    max: 100,
    next: 0,
    message: `latency used ${used} of 100`
  })

const timeout = new RunawayGuard.Timeout({
  source: "tool-call",
  subject: "bash#1",
  limitMillis: 300,
  message: "bash ran past 300 ms."
})

const layer = Layer.merge(TestJournal.layer(), ControlRuntime.layerMemory().pipe(Layer.provide(NodeCrypto.layer)))

/** One launched run over a fresh journal and control runtime. */
const inWorld = <A, E>(body: (world: World) => Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const runtime = yield* ControlRuntime.ControlRuntime
      const planned = yield* runtime.plan({ flowId: "system/test", input: {} })
      const plan = yield* runtime.lookupApproval(planned.card.approval.target)
      yield* runtime.resolveApproval(plan, "approved", yield* runtime.stampPrincipal(), "once")
      const launch = yield* runtime.launch(planned.card.planId, planned.card.digest, planned.card.envelope)
      if (launch._tag !== "Started") return yield* Effect.die(`launch: ${launch._tag}`)
      return yield* body({ journal, runtime, runId: launch.run.runId })
    }).pipe(Effect.provide(layer), Effect.scoped)
  )

/** Every approval request the run's journal recorded, in order. */
const requests = (journal: Journal.Service, runId: string) =>
  journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1_000 }).pipe(
    Effect.map((page) =>
      page.entries
        .filter((entry) => entry.eventType === "control.approval.requested")
        .map((entry) => Schema.decodeUnknownSync(ControlFacts.ApprovalRequestFact)(entry.payload))
    )
  )

const emit = (world: World, eventType: string, payload: unknown) =>
  world.journal.emitDurableUnfenced(
    new JournalEvent.Input({
      runId: JournalEvent.RunId.make(world.runId),
      sourceId: JournalEvent.SourceId.make("control"),
      eventType,
      payload: JSON.parse(JSON.stringify(payload))
    })
  )

/** An operator's decision, as the control plane records it: token, then fact. */
const decide = (world: World, request: RequestFact, decision: "approved" | "denied") =>
  Effect.gen(function*() {
    const token = yield* world.runtime.lookupApproval(request.payload.target)
    yield* world.runtime.resolveApproval(token, decision, yield* world.runtime.stampPrincipal(), "once")
    yield* emit(
      world,
      `control.approval.${decision}`,
      ControlFacts.approvalDecisionFact(token.tokenId, request.payload.target)
    )
  })

/** A journal separate from the run's, for learning a request's identity. */
const scratchJournal = Effect.map(
  Layer.build(Layer.fresh(TestJournal.layer())),
  (context) => Context.get(context, Journal.Journal)
)

/**
 * A timeout request recorded without guard incident facts, as a writer that
 * predates them would have: the request a trip of {@link timeout} would make
 * at `ordinal`, committed with its question and target only.
 */
const bareTimeoutRequest = (world: World, ordinal: number) =>
  Effect.gen(function*() {
    const scratch = yield* scratchJournal
    yield* AgentSession.budgetParking(scratch, world.runtime)(world.runId, latencyEnvelope).trip(timeout)
    const [first] = yield* requests(scratch, world.runId)
    const target = first!.payload.target
    if (target._tag !== "Node") return yield* Effect.die("a timeout park targets its run")
    const requestId = target.requestId.replace(/\/1$/, `/${ordinal}`)
    yield* ControlFacts.commitApprovalRequest(world.journal, world.runtime, {
      runId: world.runId,
      requestId,
      question: "Run the timed-out command again?",
      payload: { ...first!.payload, target: { ...target, requestId } }
    }, "legacy-host")
    return (yield* requests(world.journal, world.runId)).find((request) => request.requestId === requestId)!
  })

/** The incident facts a Stop's failure carries. */
const stoppedFacts = (failure: HarnessError.HarnessError) => {
  expect(failure.code).toBe("model_failed")
  const { _tag, ...facts } = failure.cause as { readonly _tag: string }
  expect(_tag).toBe(RunawayGuard.stoppedTag)
  return facts
}

describe("a budget park", () => {
  it("asks a token park in tokens and freezes the raise it proposes", async () => {
    const tokens: ControlSchema.Envelope = {
      capabilities: [],
      flows: [],
      budget: { tokens: 1_000, onExceeded: "park" }
    }
    const exceeded = new Budget.BudgetExceeded({
      scope: "tokens",
      onExceeded: "park",
      used: 900,
      reserved: 50,
      max: 1_000,
      next: 200,
      message: "tokens used 900 of 1000"
    })
    const raised = Budget.raise(tokens.budget, exceeded)
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const parked = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, tokens)
          .park(exceeded)
        return { parked, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(raised.tokens).toBe(2_150)
    const question = "Raise the tokens budget from 1000 to 2150 tokens?"
    expect(observed.recorded).toHaveLength(1)
    const [request] = observed.recorded
    expect(request).toMatchObject({
      question,
      incident: {
        classification: "Runaway",
        source: "tokens",
        used: 900,
        reserved: 50,
        max: 1_000,
        next: 200,
        allowance: 2_150
      },
      payload: { target: { envelope: { budget: { tokens: 2_150, onExceeded: "park" } } } }
    })
    expect(observed.parked.waiting).toEqual({
      reason: "budget",
      token: request!.requestId,
      request: JSON.stringify({ question })
    })
  })

  it("asks a USD park in dollars and freezes the raise it proposes", async () => {
    const dollars: ControlSchema.Envelope = {
      capabilities: [],
      flows: [],
      budget: { usd: 1, tokens: 50_000, onExceeded: "park" }
    }
    const exceeded = new Budget.BudgetExceeded({
      scope: "usd",
      onExceeded: "park",
      used: 0.7,
      reserved: 0,
      max: 1,
      next: 0.4,
      message: "The run has spent $0.7 of its $1 approved"
    })
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const parked = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, dollars)
          .park(exceeded)
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "approved")
        return {
          parked,
          request: request!,
          approved: yield* AgentSession.approvedEnvelope(world.journal, world.runId, dollars)
        }
      })
    )

    const question = "Raise the USD budget from $1.00 to $2.10?"
    expect(observed.request).toMatchObject({
      question,
      incident: {
        classification: "Runaway",
        source: "usd",
        used: 0.7,
        reserved: 0,
        max: 1,
        next: 0.4,
        allowance: 2.1
      },
      payload: { target: { envelope: { budget: { usd: 2.1, tokens: 50_000, onExceeded: "park" } } } }
    })
    expect(observed.parked.waiting).toMatchObject({ reason: "budget", request: JSON.stringify({ question }) })
    // The operator's approval is the raised dollar ceiling the resumed run spends against.
    expect(observed.approved.budget).toEqual({ usd: 2.1, tokens: 50_000, onExceeded: "park" })
  })

  it("words a sub-cent USD ceiling to the micro-dollar", async () => {
    const tiny: ControlSchema.Envelope = { capabilities: [], flows: [], budget: { usd: 0.0005, onExceeded: "park" } }
    const [request] = await inWorld((world) =>
      Effect.gen(function*() {
        yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, tiny).park(
          new Budget.BudgetExceeded({
            scope: "usd",
            onExceeded: "park",
            used: 0.0004,
            max: 0.0005,
            next: 0.0004,
            message: "over"
          })
        )
        return yield* requests(world.journal, world.runId)
      })
    )
    expect(request?.question).toBe("Raise the USD budget from $0.0005 to $0.01?")
  })

  it("parks a re-driven attempt on the recorded question, not on its own elapsed time", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const first = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
          .park(latency(150))
        // A later drive of the same run, against the same ceiling, 250 ms on.
        const again = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
          .park(latency(400))
        return { first, again, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.again.waiting).toEqual(observed.first.waiting)
    expect(observed.recorded).toHaveLength(2)
    const [asked, reasked] = observed.recorded
    expect(reasked).toEqual(asked)
    expect(asked).toMatchObject({
      question: "Raise the latency budget from 100 to 250 ms?",
      incident: { used: 150, allowance: 250 }
    })
  })

  it("stops a budget park the operator denied, on the incident it recorded", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const parking = AgentSession.budgetParking(world.journal, world.runtime)
        yield* parking(world.runId, latencyEnvelope).park(latency(150))
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "denied")
        // The re-drive after Stop measures more elapsed time; the facts stay the frozen ones.
        const stopped = yield* Effect.flip(parking(world.runId, latencyEnvelope).park(latency(400)))
        return { request: request!, stopped }
      })
    )

    expect(stoppedFacts(observed.stopped)).toEqual(observed.request.incident)
    expect(observed.stopped.message).toBe(`Stopped by the operator: ${observed.request.incident!.message}`)
  })

  it("stops on the facts a concurrent park froze when it recorded and denied the request after this scan", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        let armed = true
        let request: RequestFact | undefined
        const racing = Journal.make({
          ...world.journal,
          entries: (query) =>
            world.journal.entries(query).pipe(
              Effect.tap(() => {
                if (!armed) return Effect.void
                armed = false
                // A peer parks first, on its own measurement, and the operator stops it.
                return Effect.orDie(Effect.gen(function*() {
                  yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
                    .park(latency(150))
                  request = (yield* requests(world.journal, world.runId))[0]
                  yield* decide(world, request!, "denied")
                }))
              })
            )
        })
        const stopped = yield* Effect.flip(
          AgentSession.budgetParking(racing, world.runtime)(world.runId, latencyEnvelope).park(latency(400))
        )
        return { request: request!, stopped }
      })
    )

    expect(observed.request.incident).toMatchObject({ used: 150 })
    expect(stoppedFacts(observed.stopped)).toEqual(observed.request.incident)
  })

  it("fails an approved park this attempt did not apply as the budget it exceeded", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const parking = AgentSession.budgetParking(world.journal, world.runtime)
        yield* parking(world.runId, latencyEnvelope).park(latency(150))
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "approved")
        return yield* Effect.flip(parking(world.runId, latencyEnvelope).park(latency(400)))
      })
    )

    expect(observed.code).toBe("model_failed")
    expect(observed.cause).toBeInstanceOf(Budget.BudgetExceeded)
  })

  it("reuses a request recorded without incident facts as it was recorded", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        // The request this park would make, recorded by a writer that kept
        // only its question and target.
        const scratch = yield* scratchJournal
        yield* AgentSession.budgetParking(scratch, world.runtime)(world.runId, latencyEnvelope).park(latency(150))
        const [proposed] = yield* requests(scratch, world.runId)
        yield* ControlFacts.commitApprovalRequest(world.journal, world.runtime, {
          runId: world.runId,
          requestId: proposed!.requestId,
          question: proposed!.question,
          payload: proposed!.payload
        }, "legacy-host")
        const parked = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
          .park(latency(400))
        return { proposed: proposed!, parked, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.parked.waiting.token).toBe(observed.proposed.requestId)
    expect(observed.recorded).toHaveLength(2)
    // The re-park adds no facts the first record never had.
    for (const request of observed.recorded) {
      expect(request).not.toHaveProperty("incident")
      expect(request.question).toBe(observed.proposed.question)
      expect(request.payload).toEqual(observed.proposed.payload)
    }
  })

  it("resolves the envelope a run spends against from the raises an operator approved", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope).park(latency(150))
        // A decision entry no decision fact decodes from names no target.
        yield* emit(world, "control.approval.approved", { factVersion: 99, approvalTarget: "budget/unreadable" })
        const pending = yield* AgentSession.approvedEnvelope(world.journal, world.runId, latencyEnvelope)
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "approved")
        const approved = yield* AgentSession.approvedEnvelope(world.journal, world.runId, latencyEnvelope)
        return { pending, approved }
      })
    )

    expect(observed.pending).toEqual(latencyEnvelope)
    expect(observed.approved).toEqual({ ...latencyEnvelope, budget: { milliseconds: 250, onExceeded: "park" } })
  })

  it("reads an approval recorded past the first page of the run's journal", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope).park(latency(150))
        // A long-running run: a full page of other events before the decision.
        for (let index = 0; index < 1_000; index++) {
          yield* emit(world, "control.agent.model-retried", { attempt: index, code: "rate_limited", delayMillis: 0 })
        }
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "approved")
        return yield* AgentSession.approvedEnvelope(world.journal, world.runId, latencyEnvelope)
      })
    )

    expect(observed.budget).toEqual({ milliseconds: 250, onExceeded: "park" })
  })

  it("asks its own question beside a timeout park of the same run", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const parking = AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
        const stuck = yield* parking.trip(timeout)
        const runaway = yield* parking.park(latency(150))
        return { stuck, runaway, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.runaway.waiting.token).not.toBe(observed.stuck.waiting.token)
    expect(observed.recorded.map((request) => request.incident?.classification)).toEqual(["Stuck", "Runaway"])
  })

  it("fails the park when the run's journal cannot be read", async () => {
    const unreadable = new Journal.JournalError({ code: "read_failed", message: "the journal is unreadable" })
    const failure = await inWorld((world) =>
      Effect.flip(
        AgentSession.budgetParking(
          Journal.make({ ...world.journal, entries: () => Effect.fail(unreadable) }),
          world.runtime
        )(world.runId, latencyEnvelope).park(latency(150))
      )
    )

    expect(failure).toBeInstanceOf(HarnessError.HarnessError)
    expect(failure).toMatchObject({ code: "engine_failed", message: "The run's budget requests could not be read" })
    expect(failure.cause).toBe(unreadable)
  })

  it("fails the park when the control runtime cannot register its request", async () => {
    const refused = new PersistenceError({ operation: "register an approval", message: "the control store is locked" })
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          AgentSession.budgetParking(world.journal, { registerApproval: () => Effect.fail(refused) })(
            world.runId,
            latencyEnvelope
          ).park(latency(150))
        )
        return { failure, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.failure).toMatchObject({
      code: "engine_failed",
      message: "The budget approval request and token could not be committed"
    })
    expect(observed.failure.cause).toBe(refused)
    expect(observed.recorded).toEqual([])
  })

  it("does not park on a concurrent proposal whose registered envelope cannot be read", async () => {
    let mismatch: EnvelopeMismatch | undefined
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const failure = yield* Effect.flip(
          AgentSession.budgetParking(world.journal, {
            // The runtime holds another proposal under this identity, but
            // reports it in a form no envelope decodes from.
            registerApproval: (target) =>
              Effect.fail(
                mismatch = new EnvelopeMismatch({
                  planId: target.requestId,
                  expected: "{\"budget\":",
                  actual: JSON.stringify(target.envelope)
                })
              )
          })(world.runId, latencyEnvelope).park(latency(150))
        )
        return { failure, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.failure).toMatchObject({
      code: "engine_failed",
      message: "The budget approval request and token could not be committed"
    })
    expect(observed.failure.cause).toBe(mismatch)
    expect(observed.recorded).toEqual([])
  })
})

describe("a timeout park", () => {
  it("re-parks on an open question instead of asking a second one", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const first = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
          .trip(timeout)
        const redriven = AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
        const again = yield* redriven.trip(timeout)
        const admitted = yield* redriven.admit(timeout.subject)
        return { first, again, admitted, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.first.waiting.token).toMatch(/\/timeout\/[^/]+\/1$/)
    expect(observed.again.waiting).toEqual(observed.first.waiting)
    expect(new Set(observed.recorded.map((request) => request.requestId))).toEqual(
      new Set([observed.first.waiting.token])
    )
    expect(observed.recorded[0]).toMatchObject({
      question: "bash ran past 300 ms. Continue runs it again with another 300 ms; Stop fails the run.",
      incident: { classification: "Stuck", source: "tool-call", subject: "bash#1", max: 300, allowance: 300 }
    })
    expect(observed.admitted).toMatchObject({ _tag: "park", parked: { waiting: observed.first.waiting } })
  })

  it("fails the trip when the run's timeout decisions cannot be read", async () => {
    const unreadable = new Journal.JournalError({ code: "read_failed", message: "the journal is unreadable" })
    const failure = await inWorld((world) =>
      Effect.flip(
        AgentSession.budgetParking(
          Journal.make({ ...world.journal, entries: () => Effect.fail(unreadable) }),
          world.runtime
        )(world.runId, latencyEnvelope).trip(timeout)
      )
    )

    expect(failure).toMatchObject({ code: "engine_failed", message: "The run's timeout decisions could not be read" })
    expect(failure.cause).toBe(unreadable)
  })

  it("stops a subject the operator stopped, with the incident it was stopped on", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope).trip(timeout)
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "denied")
        const tripped = yield* Effect.flip(
          AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope).trip(timeout)
        )
        const admitted = yield* Effect.flip(
          AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
            .admit(timeout.subject)
        )
        return { request: request!, tripped, admitted, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(stoppedFacts(observed.tripped)).toEqual(observed.request.incident)
    expect(stoppedFacts(observed.admitted)).toEqual(observed.request.incident)
    // Stop asked nothing further.
    expect(observed.recorded).toHaveLength(1)
  })

  it("stops a stopped request that recorded no incident on what it can still say", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const request = yield* bareTimeoutRequest(world, 1)
        yield* decide(world, request, "denied")
        const tripped = yield* Effect.flip(
          AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope).trip(timeout)
        )
        const admitted = yield* Effect.flip(
          AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
            .admit(timeout.subject)
        )
        return { tripped, admitted }
      })
    )

    // A trip still holds the timeout that tripped it.
    expect(stoppedFacts(observed.tripped)).toEqual(RunawayGuard.incident(timeout))
    // An admission has only the recorded question.
    expect(stoppedFacts(observed.admitted)).toEqual({
      classification: "Stuck",
      source: "tool-call",
      message: "Run the timed-out command again?"
    })
  })

  it("admits a subject that never timed out without asking anything", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const admitted = yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
          .admit(timeout.subject)
        return { admitted, recorded: yield* requests(world.journal, world.runId) }
      })
    )

    expect(observed.admitted).toEqual({ _tag: "proceed", continued: 0 })
    expect(observed.recorded).toEqual([])
  })

  it("reads the latest park of a subject by ordinal, whatever order it was recorded in", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        // The second park is recorded, and continued, before the first; the
        // first is still open. The second is the latest, so its Continue holds.
        const second = yield* bareTimeoutRequest(world, 2)
        yield* decide(world, second, "approved")
        yield* bareTimeoutRequest(world, 1)
        return yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
          .admit(timeout.subject)
      })
    )

    expect(observed).toEqual({ _tag: "proceed", continued: 1 })
  })

  it.each([
    { recorded: "with", incident: true },
    { recorded: "without", incident: false }
  ])(
    "settles on a Stop that lands between the scan and the commit, $recorded recorded incident facts",
    async ({ incident }) => {
      const observed = await inWorld((world) =>
        Effect.gen(function*() {
          const request = incident
            ? yield* AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
              .trip(timeout)
              .pipe(Effect.andThen(requests(world.journal, world.runId)), Effect.map(([first]) => first!))
            : yield* bareTimeoutRequest(world, 1)
          // The operator's Stop commits right after the next drive's scan
          // read the question as still open.
          let armed = true
          const racing = Journal.make({
            ...world.journal,
            entries: (query) =>
              world.journal.entries(query).pipe(
                Effect.tap(() => {
                  if (!armed) return Effect.void
                  armed = false
                  return Effect.orDie(decide(world, request, "denied"))
                })
              )
          })
          const tripped = yield* Effect.flip(
            AgentSession.budgetParking(racing, world.runtime)(world.runId, latencyEnvelope).trip(timeout)
          )
          return { request, tripped, recorded: yield* requests(world.journal, world.runId) }
        })
      )

      expect(stoppedFacts(observed.tripped)).toEqual(observed.request.incident ?? RunawayGuard.incident(timeout))
      // The decided request was not asked again.
      expect(observed.recorded).toHaveLength(1)
    }
  )
})

describe("historical budget requests", () => {
  it("stops a denied legacy request using the current incident when none was recorded", async () => {
    const stopped = await inWorld((world) =>
      Effect.gen(function*() {
        const scratch = yield* scratchJournal
        yield* AgentSession.budgetParking(scratch, world.runtime)(world.runId, latencyEnvelope).park(latency(150))
        const [proposed] = yield* requests(scratch, world.runId)
        yield* ControlFacts.commitApprovalRequest(world.journal, world.runtime, {
          runId: world.runId,
          requestId: proposed!.requestId,
          question: proposed!.question,
          payload: proposed!.payload
        }, "legacy-host")
        const [request] = yield* requests(world.journal, world.runId)
        yield* decide(world, request!, "denied")
        return yield* Effect.flip(
          AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope).park(latency(400))
        )
      })
    )
    expect(stoppedFacts(stopped)).toEqual(RunawayGuard.incident(latency(400)))
  })

  it("reuses a concurrent USD request whose registered envelope has no USD allowance", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        let commits = 0
        const parking = AgentSession.budgetParking(world.journal, {
          registerApproval: (target) =>
            Effect.suspend(() => {
              commits++
              return commits === 1 ?
                Effect.fail(
                  new EnvelopeMismatch({
                    planId: target.requestId,
                    expected: JSON.stringify(latencyEnvelope),
                    actual: JSON.stringify(target.envelope)
                  })
                ) :
                world.runtime.registerApproval(target)
            })
        })(world.runId, latencyEnvelope)
        const parked = yield* parking.park(
          new Budget.BudgetExceeded({
            scope: "usd",
            onExceeded: "park",
            used: 2,
            reserved: 0,
            max: 1,
            next: 0,
            message: "USD limit reached"
          })
        )
        return { parked, recorded: yield* requests(world.journal, world.runId) }
      })
    )
    expect(observed.parked.waiting.reason).toBe("budget")
    expect(observed.recorded[0]!.question).toBe("Raise the USD budget from $1.00 to $0.00?")
    expect(observed.recorded[0]!.payload.target.envelope).toEqual(latencyEnvelope)
  })

  it("asks a timeout with no numeric limit using its recorded limit wording", async () => {
    const observed = await inWorld((world) =>
      Effect.gen(function*() {
        const unbounded = new RunawayGuard.Timeout({
          source: "tool-call",
          subject: "reader#1",
          message: "reader expired"
        })
        const parking = AgentSession.budgetParking(world.journal, world.runtime)(world.runId, latencyEnvelope)
        yield* parking.trip(unbounded)
        return yield* requests(world.journal, world.runId)
      })
    )
    expect(observed[0]!.question).toBe("reader expired Continue runs it again with its limit; Stop fails the run.")
  })
})

/**
 * The supervisor's seat beside the cell loop: a one-slot sliding queue the
 * loop offers to, a forked fiber that reads the newest snapshot, scores the
 * run's monitors, judges the rows it recalls and marks the transcript
 * segments not yet marked, and a mailbox the next turn boundary takes a
 * monitor's message, memory and marks from.
 *
 * The loop never awaits any of it. `offer` is a sliding enqueue and returns
 * at once; `take` is a `Ref` swap. Everything Jev is asked, and everything
 * that comes back, happens on the forked fiber. A run that ends with a
 * reading in flight gives it `Supervisor.closeGraceMs` to settle and journal
 * as the scope closes, and no longer: a reading still unanswered then is
 * interrupted and journaled `supervisor-unjudged` with reason `interrupted`,
 * so a Jev call that was made is never missing from the record. A snapshot
 * the fiber never took is dropped and journals nothing: nobody asked.
 *
 * The reading is taken through `EngineLike.record`, keyed on the session,
 * the frame and the cell digest, so a resumed run is handed the reading its
 * original attempt recorded and never asks Jev again. The reading records
 * each monitor's raw value and nothing about delivery: `Monitor.gate` runs at
 * the boundary that takes it, inside that boundary's own recorded drain and
 * against the ledger the run holds there, so streaks, cooldowns and limits
 * count every delivery before it, a replayed boundary delivers exactly what it
 * delivered the first time, and a mailbox left over from a replayed frame is
 * discarded as stale rather than delivered twice. The rows a run has been shown are the boundary's to know:
 * a row shown between the offer and the drain is dropped there, so no row is
 * delivered twice however the readings interleave. Marks name segments by
 * digest and are never stale: a boundary stores them whichever frame's
 * reading they came from, and the model is not sent them.
 *
 * @since 1.0.0-rc.0
 * @private
 */

import { ModelRequest } from "@smthrs/model"
import type * as Evaluator from "@smthrs/model/Evaluator"
import type * as Descriptor from "@smthrs/registry/Descriptor"
import { Deferred, Effect, Fiber, Option, Queue, Ref, Schema, type Scope } from "effect"
import * as AgentEvent from "../AgentEvent.ts"
import type { State } from "../CellTurn.ts"
import type * as EngineLike from "../EngineLike.ts"
import * as Judgement from "../Judgement.ts"
import * as Monitor from "../Monitor.ts"
import * as Relevance from "../Relevance.ts"
import * as Supervisor from "../Supervisor.ts"
import * as UnmovedTree from "../UnmovedTree.ts"
import * as compactionMarks from "./compactionMarks.ts"
import type * as Frame from "./frame.ts"

const eventType = AgentEvent.eventType

const nothing: Taken = { messages: [], memory: [], suppressed: [], marks: [] }

/**
 * What one frame hands the supervisor: the snapshot without its frames,
 * which the handle keeps, and the cell digest the record is keyed on.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Offer {
  readonly frame: number
  readonly digest: string
  /** The frame just closed; the handle keeps the ones before it. */
  readonly current: Supervisor.Frame
  readonly snapshot: Omit<Supervisor.Snapshot, "frames">
  /** Keys of the memory rows the run had been shown when the frame closed; never asked about. */
  readonly shown: ReadonlyArray<string>
  /** The head of the frame's prose, which the relevance reading is told as `recent`. */
  readonly recent: string
  /** Whether more than `Supervisor.skillLimit` skills could have been offered. */
  readonly skillsCapped: boolean
  /**
   * The transcript segments the run has no answer about yet, each once by
   * digest; empty unless the host holds a real judge.
   */
  readonly unmarked: ReadonlyArray<{ readonly digest: string; readonly item: compactionMarks.Item }>
  /** The labels of the checks still failing when the frame closed, which the marks reading is told. */
  readonly failing: ReadonlyArray<string>
}

/**
 * What one boundary takes from the mailbox.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Taken {
  /** The delivered monitor's message, then each memory row delivered. */
  readonly messages: ReadonlyArray<ModelRequest.Message>
  /** Keys of the memory rows delivered, in order. */
  readonly memory: ReadonlyArray<string>
  /** The monitor whose message leads `messages`, when one was delivered. */
  readonly monitor?: string
  /** Crossed monitors withheld, and why. */
  readonly suppressed: Monitor.Gated["suppressed"]
  /** The ledger after gating a reading; absent when no reading was gated. */
  readonly ledger?: Monitor.Ledger
  /** Jev's answers about the segments the reading marked. */
  readonly marks: ReadonlyArray<compactionMarks.Marking>
}

/**
 * The loop's two calls into the supervisor.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export interface Handle {
  /** Slides this frame's snapshot into the one-slot queue and returns at once. */
  readonly offer: (offer: Offer) => Effect.Effect<void>
  /**
   * What the boundary closing `frame` delivers from the newest reading when
   * that reading is of this frame or the one before, nothing otherwise: the
   * one message `Monitor.gate` lets through against `ledger`, the run's
   * ledger as the boundary holds it, then the memory rows. A row whose key is
   * in `shown`, the run's shown set as the boundary holds it, is dropped, and
   * nothing is gated or delivered unless `deliver`. A reading Jev could not
   * take gates nothing. Takes the mailbox either way, so a stale reading is
   * dropped and never delivered later; its marks are taken all the same.
   */
  readonly take: (
    frame: number,
    options: {
      readonly ledger: Monitor.Ledger
      readonly shown: ReadonlyArray<string>
      readonly deliver: boolean
    }
  ) => Effect.Effect<Taken>
}

const MonitorRow = Schema.Struct({
  id: Schema.String,
  kind: AgentEvent.MonitorKind,
  p: Schema.Number,
  crossed: Schema.Boolean
})

const MonitorCandidate = Schema.Struct({
  id: Schema.String,
  kind: AgentEvent.MonitorKind,
  priority: Schema.Number,
  p: Schema.Number,
  text: Schema.String
})

/** Everything one recorded reading holds, so a replay re-emits and re-delivers it. */
const Recorded = Schema.Struct({
  settled: Schema.NullOr(AgentEvent.SupervisorSettled),
  decision: Schema.NullOr(AgentEvent.DecisionSettled),
  unjudged: Schema.NullOr(AgentEvent.SupervisorUnjudged),
  /** The relevance reading of the recalled rows; null when none was asked or it failed. */
  memory: Schema.NullOr(AgentEvent.RelevanceSettled),
  memoryDecisions: Schema.Array(AgentEvent.DecisionSettled),
  memoryUnjudged: Schema.NullOr(AgentEvent.DecisionUnjudged),
  /** The recalled rows not withheld: every row when the reading failed. */
  memoryRows: Schema.Array(Supervisor.Recalled),
  /** Every monitor's value in the reading; empty when the reading failed. */
  monitorRows: Schema.Array(MonitorRow),
  /** The crossed monitors' messages, ungated; the boundary gates them. */
  monitorCandidates: Schema.Array(MonitorCandidate),
  /** The answers of the marks reading; empty when none was asked or it failed. */
  marks: Schema.Array(compactionMarks.Marking),
  marksDecisions: Schema.Array(AgentEvent.DecisionSettled),
  marksUnjudged: Schema.NullOr(AgentEvent.DecisionUnjudged)
})

type Recorded = typeof Recorded.Type

interface Mailbox {
  readonly frame: number
  /** What the monitors said; absent when Jev could not take the reading. */
  readonly monitors: Monitor.Evaluation | undefined
  /** The monitors the reading scored, which the boundary gates against. */
  readonly declared: ReadonlyArray<Monitor.Monitor>
  readonly rows: ReadonlyArray<Supervisor.Recalled>
  readonly marks: ReadonlyArray<compactionMarks.Marking>
}

/**
 * The counts the deterministic controls keep, read off the state the frame
 * closed on. Nothing is re-derived: every field is a state field, a ledger
 * length, or a filter over a ledger the harness already wrote.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const signals = (
  state: State,
  facts: Frame.Accounting["facts"],
  workspaceDigest: string,
  paths: number
): Supervisor.Signals => ({
  frame: state.frame,
  maxFrames: state.maxFrames,
  readOnlyFrames: facts.readOnlyFrames,
  repeatFrames: facts.repeatFrames,
  mutations: facts.mutations,
  remoteMutations: facts.remoteMutations,
  treeMoved: UnmovedTree.find({
    opened: facts.openingDigest,
    digest: workspaceDigest,
    elsewhere: facts.remoteMutations
  }) === undefined,
  paths,
  checksRun: facts.checks.length,
  checksFailing: facts.checks.filter((check) => check.failing).length,
  failuresUnanswered: facts.failures.length,
  callsFailed: facts.callLedger.filter((entry) => !entry.ok).length,
  callsSettled: facts.callLedger.length,
  narrowingDemands: state.narrowingDemands,
  unmovedDemands: state.unmovedDemands,
  unresolvedDemands: state.unresolvedDemands,
  claimDemands: state.claimDemands,
  sufficiencyStated: state.sufficiencyStated
})

/**
 * What a snapshot says about the frame's catalog: the Markdown skills the
 * model may call and has not, sorted by name and at most
 * `Supervisor.skillLimit` of them, offered only when `read` is in the catalog
 * to read them with; the distinct flows the ledger names, newest
 * `Supervisor.calledLimit` of them; and whether `jev` is in the catalog.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const catalog = (
  flows: ReadonlyArray<Descriptor.FlowDescriptor>,
  ledger: ReadonlyArray<{ readonly flow: string }>
): Pick<Supervisor.Snapshot, "skills" | "called" | "jevAvailable"> & { readonly capped: boolean } => {
  const called = [...new Set(ledger.map((entry) => entry.flow))]
  const readable = flows.some((descriptor) => descriptor.name === "read")
  const skills = readable
    ? flows
      .filter((descriptor) =>
        descriptor.modelInvocable && descriptor.body._tag === "Markdown" && !called.includes(descriptor.name)
      )
      .sort((a, b) => a.name < b.name ? -1 : 1)
    : []
  return {
    skills: skills.slice(0, Supervisor.skillLimit).map((descriptor) =>
      Supervisor.skill(descriptor.name, descriptor.description, descriptor.body.path)
    ),
    called: called.slice(-Supervisor.calledLimit),
    jevAvailable: flows.some((descriptor) => descriptor.name === "jev"),
    capped: skills.length > Supervisor.skillLimit
  }
}

/**
 * Opens the supervisor beside the loop: the queue, the mailbox, and the
 * forked fiber that serves them. Requires a scope, which is the loop's own,
 * so closing the loop closes the fiber.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const open = (input: {
  readonly session: string
  readonly engine: EngineLike.EngineLike
  readonly emit: (event: AgentEvent.AgentEvent) => Effect.Effect<void>
  /** The host's monitors; each reading adds `Monitor.skills` of its snapshot and `Monitor.useJev`. */
  readonly monitors: ReadonlyArray<Monitor.Monitor>
  /** Whether a monitor's message and memory inserts reach the run: the host holds a real judge. */
  readonly deliver: boolean
}): Effect.Effect<Handle, never, Scope.Scope | Evaluator.Evaluator> =>
  Effect.gen(function*() {
    const { deliver, emit, engine, monitors, session } = input
    const mailbox = yield* Ref.make<Option.Option<Mailbox>>(Option.none())
    // The host's monitors, then one per skill the snapshot offers, then the
    // use-jev lint: what one reading asks and scores and its boundary gates.
    const scored = (snapshot: Supervisor.Snapshot): ReadonlyArray<Monitor.Monitor> => [
      ...monitors,
      ...Monitor.skills(snapshot),
      Monitor.useJev()
    ]
    const memory = yield* Supervisor.Memory
    // The evaluator the loop was given, captured once so the fiber asks the
    // same transport the completion brake does.
    const services = yield* Effect.context<Evaluator.Evaluator>()
    // The newest frames ahead of the one just closed, kept in memory: they
    // are evidence for a reading nothing replays, so durable state need not
    // carry them. A resumed run's first snapshots see fewer frames, which is
    // the honest reading of a past this process did not witness.
    const recent: Array<Supervisor.Frame> = []
    // Digests this fiber has marked. A segment is offered until a boundary
    // stores its answer, and a reading that lags the loop would otherwise
    // ask about it again each frame.
    const marked = new Set<string>()
    // The frame whose reading the fiber is taking, and a latch released when
    // that reading is done, whatever it came to. Read only by the scope's
    // closing grace below.
    const inFlight = yield* Ref.make<Option.Option<{ readonly frame: number; readonly done: Deferred.Deferred<void> }>>(
      Option.none()
    )

    // A store that refused a read is journaled, typed, and the reading goes
    // on: memory is the supervisor's aid, not its evidence.
    const recallFailed = (frame: number, failure: Supervisor.MemoryFailure) =>
      emit(
        new AgentEvent.SupervisorMemoryFailed({
          eventType: eventType.supervisorMemoryFailed,
          scope: session,
          frame,
          operation: "recall",
          detail: failure.detail
        })
      )

    const supervise = (offer: Offer & { readonly frames: ReadonlyArray<Supervisor.Frame> }): Effect.Effect<void> =>
      Effect.gen(function*() {
        const snapshot: Supervisor.Snapshot = { ...offer.snapshot, frames: offer.frames }
        const declared = scored(snapshot)
        const unmarked = offer.unmarked.filter(({ digest }) => !marked.has(digest))
        const recorded = yield* engine.record({
          name: "supervisor",
          identity: { session, frame: offer.frame, boundary: `supervisor:${offer.digest}` },
          success: Recorded,
          execute: Effect.gen(function*() {
            // The task does not change between frames, so the store ranks the
            // same rows first each time: it is asked past every row already
            // shown, and a row shown once is never asked about again.
            const recalled = memory.bound
              ? yield* memory.recall(
                [offer.snapshot.task, offer.recent].filter(Boolean).join("\n").slice(-16_384),
                Supervisor.recalledLimit + offer.shown.length
              ).pipe(
                Effect.catch((failure) => Effect.as(recallFailed(offer.frame, failure), []))
              )
              : []
            const rows = recalled.filter((row) => !offer.shown.includes(row.key)).slice(0, Supervisor.recalledLimit)
            const [result, relevance, marking] = yield* Effect.all([
              Effect.result(Supervisor.read(snapshot, Monitor.questions(declared, snapshot))),
              rows.length === 0 ? Effect.succeed(undefined) : Effect.result(
                Relevance.judge(
                  { task: snapshot.task, recent: offer.recent },
                  rows.map((row): Relevance.Item => ({ kind: "memory", id: row.key, text: row.text }))
                )
              ),
              unmarked.length === 0 ? Effect.succeed(undefined) : Effect.result(
                compactionMarks.read(
                  { task: snapshot.task, failing: offer.failing },
                  unmarked.map(({ item }) => item)
                )
              )
            ], { concurrency: 3 }).pipe(Effect.provideContext(services))
            const at = { scope: session, frame: offer.frame }
            // Marking changes nothing the model is sent, so no decision acts.
            const marksRecord = marking === undefined
              ? { marks: [], marksDecisions: [], marksUnjudged: null }
              : marking._tag === "Failure"
              ? {
                marks: [],
                marksDecisions: [],
                marksUnjudged: Judgement.unjudgedEvent(marking.failure, {
                  ...at,
                  classifier: "compaction/marks",
                  items: unmarked.length
                })
              }
              : {
                marks: unmarked.map(({ digest }, index) => ({ digest, ...marking.success.answers[index]! })),
                marksDecisions: marking.success.asked.map((asked) =>
                  Judgement.decision(asked, { ...at, acted: false })
                ),
                marksUnjudged: null
              }
            const memoryRecord = relevance === undefined
              ? { memory: null, memoryDecisions: [], memoryUnjudged: null, memoryRows: [] }
              : relevance._tag === "Failure"
              ? {
                memory: null,
                memoryDecisions: [],
                memoryUnjudged: Judgement.unjudgedEvent(relevance.failure, {
                  ...at,
                  classifier: "relevance/unnecessary",
                  items: rows.length
                }),
                memoryRows: rows
              }
              : {
                memory: Relevance.settled(relevance.success, { ...at, source: "supervisor" }),
                memoryDecisions: relevance.success.asked.map((asked) =>
                  Judgement.decision(asked, {
                    ...at,
                    acted: relevance.success.verdicts.some((verdict) => verdict.withheld)
                  })
                ),
                memoryUnjudged: null,
                memoryRows: rows.filter((_, index) => !relevance.success.verdicts[index]!.withheld)
              }
            if (result._tag === "Failure") {
              const record: Recorded = {
                settled: null,
                decision: null,
                unjudged: new AgentEvent.SupervisorUnjudged({
                  eventType: eventType.supervisorUnjudged,
                  ...at,
                  reason: result.failure.reason,
                  detail: result.failure.detail
                }),
                ...memoryRecord,
                ...marksRecord,
                monitorRows: [],
                monitorCandidates: []
              }
              return record
            }
            const reading = result.success
            const evaluation = Monitor.evaluate({ monitors: declared, reading, snapshot, values: reading.monitors })
            // Whether a monitor's message is handed to the boundary, which may
            // still withhold it for its streak, cooldown, limit or slot.
            const nudged = deliver && evaluation.candidates.length > 0
            const record: Recorded = {
              settled: new AgentEvent.SupervisorSettled({
                eventType: eventType.supervisorSettled,
                ...at,
                thrashing: reading.thrashing,
                onTarget: reading.onTarget,
                suspect: reading.suspect,
                outdatedContext: reading.outdatedContext,
                irrelevantContext: reading.irrelevantContext,
                ...reading.emotions,
                needsHelp: reading.needsHelp,
                crossed: evaluation.rows.some((row) => row.crossed),
                nudged,
                steer: deliver,
                latencyMs: reading.latencyMs,
                ...(reading.usage === undefined ? {} : { usage: reading.usage }),
                monitors: evaluation.rows,
                ...(offer.skillsCapped ? { skillsCapped: true } : {})
              }),
              decision: new AgentEvent.DecisionSettled({
                eventType: eventType.decisionSettled,
                ...at,
                classifier: Supervisor.classifier.id,
                digest: reading.asked.digest,
                state: reading.asked.state,
                questions: reading.asked.questions,
                answers: reading.asked.answers,
                latencyMs: reading.latencyMs,
                acted: nudged,
                decidedBy: "jev"
              }),
              unjudged: null,
              ...memoryRecord,
              ...marksRecord,
              monitorRows: evaluation.rows,
              monitorCandidates: evaluation.candidates
            }
            return record
          })
        })
        // Posted before anything is journaled: an observer's checkpoint sits
        // inside `emit`, and a boundary that wakes on the settled event must
        // find the reading already waiting for it. Every reading Jev took is
        // posted, crossed or not, so the boundary's gate sees each monitor's
        // streak move.
        for (const { digest } of recorded.marks) marked.add(digest)
        if (recorded.settled !== null || recorded.memoryRows.length > 0 || recorded.marks.length > 0) {
          // A reading replaces the one no boundary took, but not its marks.
          yield* Ref.update(mailbox, (held) =>
            Option.some({
              frame: offer.frame,
              declared,
              monitors: recorded.settled === null
                ? undefined
                : { rows: recorded.monitorRows, candidates: recorded.monitorCandidates },
              rows: recorded.memoryRows,
              marks: [...Option.match(held, { onNone: () => [], onSome: (value) => value.marks }), ...recorded.marks]
            }))
        }
        // The verdict is the last thing this fiber does with a reading: the
        // full decisions and the memory reading go ahead of it, so a host that
        // acts on the verdict the moment it is checkpointed never finds the
        // record behind it missing.
        if (recorded.decision !== null) yield* emit(recorded.decision)
        for (const decision of recorded.memoryDecisions) yield* emit(decision)
        if (recorded.memory !== null) yield* emit(recorded.memory)
        if (recorded.memoryUnjudged !== null) yield* emit(recorded.memoryUnjudged)
        for (const decision of recorded.marksDecisions) yield* emit(decision)
        if (recorded.marksUnjudged !== null) yield* emit(recorded.marksUnjudged)
        if (recorded.unjudged !== null) yield* emit(recorded.unjudged)
        if (recorded.settled !== null) yield* emit(recorded.settled)
      }).pipe(
        // A reading the fiber could not even record is logged and dropped:
        // the supervisor may not fail the run it watches.
        Effect.catchCause((cause) =>
          Effect.annotateLogs(Effect.logWarning("A supervisor reading could not be recorded", cause), {
            frame: offer.frame
          })
        )
      )

    const offers = yield* Queue.make<Offer & { readonly frames: ReadonlyArray<Supervisor.Frame> }>({
      capacity: 1,
      strategy: "sliding"
    })
    // The reading the fiber was taking when it was interrupted, if it was.
    const cut = yield* Ref.make<Option.Option<number>>(Option.none())
    const serve = (offer: Offer & { readonly frames: ReadonlyArray<Supervisor.Frame> }) =>
      Effect.gen(function*() {
        const done = yield* Deferred.make<void>()
        yield* Ref.set(inFlight, Option.some({ frame: offer.frame, done }))
        yield* supervise(offer).pipe(
          Effect.onInterrupt(() => Ref.set(cut, Option.some(offer.frame))),
          Effect.ensuring(Ref.set(inFlight, Option.none()).pipe(Effect.andThen(Deferred.succeed(done, undefined))))
        )
      })
    const fiber = yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(offers), serve)))
    // Registered after the fork, so it runs before the fork's own interruption:
    // a finalizer added later runs earlier. A reading in flight gets the grace
    // to settle and journal itself; one still unanswered after it is
    // interrupted and journaled as such. Nothing here waits past the grace.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function*() {
        const held = yield* Ref.get(inFlight)
        if (Option.isSome(held)) {
          yield* Deferred.await(held.value.done).pipe(Effect.timeoutOption(Supervisor.closeGraceMs))
        }
        yield* Fiber.interrupt(fiber)
        const interrupted = yield* Ref.get(cut)
        if (Option.isNone(interrupted)) return
        yield* emit(
          new AgentEvent.SupervisorUnjudged({
            eventType: eventType.supervisorUnjudged,
            scope: session,
            frame: interrupted.value,
            reason: "interrupted",
            detail:
              `The run ended with this reading in flight; it was interrupted after a ${Supervisor.closeGraceMs} ms grace.`
          })
        )
      })
    )

    return {
      offer: (offer) =>
        Effect.suspend(() => {
          // Fixed at offer time, on the loop's fiber, so the snapshot is of
          // the frames as they stood when this one closed whatever the fiber
          // reaches it.
          const frames = [...recent.slice(-(Supervisor.recentFrames - 1)), offer.current]
          recent.push(offer.current)
          if (recent.length > Supervisor.recentFrames) recent.splice(0, recent.length - Supervisor.recentFrames)
          return Effect.asVoid(Queue.offer(offers, { ...offer, frames }))
        }),
      take: (frame, { deliver, ledger, shown }) =>
        Ref.modify(mailbox, (held): readonly [Taken, Option.Option<Mailbox>] => {
          if (Option.isNone(held) || !deliver) return [nothing, Option.none()]
          const { marks } = held.value
          if (held.value.frame < frame - 1) return [{ ...nothing, marks }, Option.none()]
          const rows = held.value.rows.filter((row) => !shown.includes(row.key))
          const gated = held.value.monitors === undefined
            ? undefined
            : Monitor.gate({ ...held.value.monitors, monitors: held.value.declared, ledger, frame })
          const message = gated?.message
          return [{
            messages: [...(message === undefined ? [] : [message.text]), ...rows.map(Supervisor.recalledInsert)].map((
              text
            ) => ModelRequest.Message.user(text)),
            memory: rows.map((row) => row.key),
            ...(message === undefined ? {} : { monitor: message.id }),
            suppressed: gated?.suppressed ?? [],
            ...(gated === undefined ? {} : { ledger: gated.ledger }),
            marks
          }, Option.none()]
        })
    }
  })

/**
 * A handle for a loop that supervises nothing: offers are dropped and every
 * boundary takes nothing.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const none: Handle = {
  offer: () => Effect.void,
  take: () => Effect.succeed(nothing)
}

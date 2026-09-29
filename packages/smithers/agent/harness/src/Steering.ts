/**
 * Turn-boundary steering values and their source contract.
 *
 * Governing design: `../docs/concepts.md#notification-queue`.
 *
 * @since 0.1.0
 */

import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Context, Effect, Layer, Schema } from "effect"
import * as AgentEvent from "./AgentEvent.ts"
import type { HarnessError } from "./HarnessError.ts"
import * as compactionMarks from "./internal/compactionMarks.ts"
import * as Monitor from "./Monitor.ts"

/**
 * The boundary at which a transcript insertion may be promoted.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Delivery = "steer" | "queue"

/**
 * A transcript insertion promoted at the next turn boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SteerInsert {
  readonly _tag: "Insert"
  readonly delivery: "steer"
  readonly admittedAt: number
  readonly message: ModelRequest.Message
}

/**
 * A transcript insertion promoted only when the run would otherwise go idle.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface QueueInsert {
  readonly _tag: "Insert"
  readonly delivery: "queue"
  readonly admittedAt: number
  readonly message: ModelRequest.Message
}

/**
 * A transcript insertion admitted for a future turn.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Insert = SteerInsert | QueueInsert

/**
 * A model-seat change that applies only after the current turn closes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SeatChange {
  readonly _tag: "SeatChange"
  readonly delivery: "steer"
  readonly admittedAt: number
  readonly seat: string
}

/**
 * A thinking-level change that applies only after the current turn closes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface ThinkingChange {
  readonly _tag: "ThinkingChange"
  readonly delivery: "steer"
  readonly admittedAt: number
  readonly thinking: ModelRequest.ReasoningEffort
}

/**
 * A serializable steering event.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Item = Insert | SeatChange | ThinkingChange

/**
 * An immutable, FIFO queue of steering events.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Queue {
  readonly items: ReadonlyArray<Item>
}

/**
 * The values promoted when a turn reaches its close boundary.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Drain {
  readonly inserts: ReadonlyArray<ModelRequest.Message>
  readonly seatChanges: ReadonlyArray<SeatChange | ThinkingChange>
  readonly remaining: Queue
  readonly queued: boolean
  /**
   * Whether this boundary had already drained, so the answer is the one it gave
   * the first time.
   *
   * This is what makes a parked run answerable. A park resumes by re-executing
   * its own frames, so it reaches the same boundary again and must be told the
   * same thing — and it must also be able to find out that a NEWER boundary is
   * the one an operator's answer is waiting at. A run walks its park's
   * boundaries until one reports `false`, which is the first one this run has
   * not consulted before.
   *
   * Host queue bookkeeping, like {@link Drain.remaining}, and deliberately not
   * part of {@link DrainRecord}: it says which attempt asked, not what the
   * boundary holds, and freezing it in a journaled value would tell every later
   * attempt it was the first.
   */
  readonly duplicate: boolean
}

/**
 * The boundary a drain is being attempted at, and whether the run would go
 * idle if nothing were delivered. Followups are held back until it would.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface BoundaryInput {
  readonly boundary: string
  readonly wouldIdle: boolean
}

const SeatChangeRecord = Schema.Struct({
  _tag: Schema.Literal("SeatChange"),
  delivery: Schema.Literal("steer"),
  admittedAt: Schema.Number,
  seat: Schema.String
})

const ThinkingChangeRecord = Schema.Struct({
  _tag: Schema.Literal("ThinkingChange"),
  delivery: Schema.Literal("steer"),
  admittedAt: Schema.Number,
  thinking: ModelRequest.ReasoningEffort
})

/**
 * The journaled record of one turn-boundary drain.
 *
 * A drain consumes host queue state, so it is a nondeterministic read: the
 * controller journals exactly this projection through `EngineLike.record`,
 * keyed on the frame and boundary, and a re-executed frame replays the record
 * instead of draining an already-drained queue. Everything the controller
 * folds into durable state is here; `remaining` is host queue bookkeeping and
 * deliberately is not.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const DrainRecord = Schema.Struct({
  inserts: Schema.Array(ModelRequest.Message),
  seatChanges: Schema.Array(Schema.Union([SeatChangeRecord, ThinkingChangeRecord])),
  queued: Schema.Boolean,
  /**
   * Messages the run's supervisor delivers at this boundary, kept apart from
   * `inserts` because they are not the person's words: the model reads them,
   * and the completion brake's task never does. Absent from records written
   * before the supervisor had a field of its own, and from boundaries it
   * delivered nothing at.
   */
  supervisor: Schema.optional(Schema.Array(ModelRequest.Message)),
  /**
   * Keys of the memory rows among `supervisor`, which the run has now been
   * shown. Absent from boundaries that delivered none.
   */
  memory: Schema.optional(Schema.Array(Schema.String)),
  /** The monitor whose message leads `supervisor`, when one was delivered. */
  monitor: Schema.optional(Schema.String),
  /** Crossed monitors this boundary withheld, and why. Absent when none was. */
  suppressed: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, reason: AgentEvent.Suppression }))),
  /**
   * The monitor ledger after this boundary gated a reading, which the run
   * carries into its next frame. Absent from boundaries that gated none.
   */
  monitorLedger: Schema.optional(Monitor.Ledger),
  /**
   * Jev's answers about transcript segments, by digest, which the run stores
   * for its next compaction. The model is not sent them. Absent from
   * boundaries that took none.
   */
  marks: Schema.optional(Schema.Array(compactionMarks.Marking)),
  /**
   * The context triggers the delivered supervisor reading fired, which
   * compact the run at its next frame. Absent from boundaries that took none.
   */
  compact: Schema.optional(Schema.Array(AgentEvent.CompactionCause))
})

/**
 * The journaled record of one turn-boundary drain.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type DrainRecord = typeof DrainRecord.Type

/**
 * Projects a {@link Drain} into its journaled record.
 *
 * @category conversions
 * @since 0.1.0
 * @slop
 */
export const drainRecord = (drain: Drain): DrainRecord => ({
  inserts: drain.inserts,
  seatChanges: drain.seatChanges,
  queued: drain.queued
})

const immutable = (items: ReadonlyArray<Item>): Queue => Object.freeze({ items: Object.freeze([...items]) })

const immutableItem = (item: Item): Item => Object.freeze({ ...item })

/**
 * Creates an empty immutable steering queue.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const empty = (): Queue => immutable([])

/**
 * Appends an item without mutating the prior queue.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const enqueue = (queue: Queue, item: Item): Queue => immutable([...queue.items, immutableItem(item)])

/**
 * Drains only items admitted at or before the turn's fixed cutoff.
 *
 * @category operations
 * @since 0.1.0
 * @slop
 */
export const drainAtClose = (queue: Queue, cutoff: number): Drain => {
  const inserts: Array<ModelRequest.Message> = []
  const seatChanges: Array<SeatChange | ThinkingChange> = []
  const remaining: Array<Item> = []
  for (const item of queue.items) {
    if (item.delivery === "queue" || item.admittedAt > cutoff) {
      remaining.push(item)
      continue
    }
    switch (item._tag) {
      case "Insert":
        inserts.push(item.message)
        break
      case "SeatChange":
      case "ThinkingChange":
        seatChanges.push(item)
        break
    }
  }
  return {
    inserts: Object.freeze(inserts),
    seatChanges: Object.freeze(seatChanges),
    remaining: immutable(remaining),
    queued: false,
    // An in-memory cutoff drain keeps no boundary ledger, so it can never say
    // it has answered this boundary before.
    duplicate: false
  }
}

/**
 * Source of a serializable steering-queue snapshot. Storage and persistence
 * promotion are deliberately supplied by the host.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export interface Source {
  readonly read: () => Effect.Effect<Queue, HarnessError>
  /**
   * Promotes what one boundary may deliver.
   *
   * A drain is IDEMPOTENT in its boundary string: a second drain at one
   * boundary promotes nothing and hands back exactly what the first one
   * promoted, with {@link Drain.duplicate} set. That is not an optimization, it
   * is the contract a resumed run depends on — a re-executed frame drains the
   * boundaries it already drained and must be told the same thing, or it
   * rebuilds a different context and re-keys every later sealed step. A source
   * that promotes afresh each time cannot answer a parked run and will deliver
   * one message many times.
   */
  readonly drain: (input: BoundaryInput) => Effect.Effect<Drain, HarnessError>
}

/**
 * The methods {@link make} needs to build a {@link Source}.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface SourceInput {
  readonly read: () => Effect.Effect<Queue, HarnessError>
  readonly drain: (input: BoundaryInput) => Effect.Effect<Drain, HarnessError>
}

/**
 * Service tag for the external steering queue source.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Source: Context.Service<Source, Source> = Context.Service("@smthrs/harness/Steering/Source")

/**
 * Constructs a steering source service.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (implementation: SourceInput): Source => Source.of(implementation)

/**
 * Creates a source that always returns an empty queue.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Source> = {}): Source =>
  make({
    read: Effect.fn("Steering.Source.read")(() => Effect.succeed(empty())),
    drain: Effect.fn("Steering.Source.drain")(() =>
      Effect.succeed({
        inserts: [],
        seatChanges: [],
        remaining: empty(),
        queued: false,
        duplicate: false
      })
    ),
    ...overrides
  })

/**
 * Provides a steering source as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (implementation: SourceInput): Layer.Layer<Source> => Layer.succeed(Source)(make(implementation))

/**
 * Provides an empty steering source as a layer.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (overrides: Partial<Source> = {}): Layer.Layer<Source> =>
  Layer.succeed(Source)(makeNoop(overrides))

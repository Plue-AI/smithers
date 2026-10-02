/**
 * Burndown pattern: work a backlog down to nothing. Each round re-discovers the
 * backlog, selects the items that are ours, claims them, works each one as a
 * durable child, lands each result as its work finishes, one at a time, and
 * releases every claim, at a concurrency and a capacity the burndown owns.
 *
 * The backlog can be anything with a stable `id` per item: GitHub issues, Linear
 * tickets, queue messages. Nothing here names a provider.
 *
 * The pattern has two halves. {@link make} declares the lineage: a capacity
 * gate that parks durably, the discovery call, one dispatch call per round, and
 * the `Flow.to` handoff that opens the next round. {@link round} is the Effect a
 * dispatch implementation runs, because a round's width is the length of the
 * discovered backlog, which no plan knows when it is built. {@link layer}
 * connects the two.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 1.0.0
 */

import * as Action from "@smthrs/flow/Action"
import * as Fault from "@smthrs/flow/Fault"
import * as Flow from "@smthrs/flow/Flow"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import * as RetryPolicy from "@smthrs/flow/RetryPolicy"
import * as Sleep from "@smthrs/flow/Sleep"
import * as WaitFor from "@smthrs/flow/WaitFor"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member as Callable } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { PatternError } from "./PatternError.ts"

/**
 * One backlog item.
 *
 * `id` is the identity a row, a claim, a settled list, and the work member's
 * execution id all use, so it must be a nonblank string, unique within one
 * discovery.
 *
 * @category models
 * @since 1.0.0
 */
export interface Item {
  readonly id: string
}

/**
 * What happened to one item.
 *
 * `landed`: the work succeeded and landed. `held`: the claim reported another
 * owner. `failed`: a claim, work, or landing failure. `skipped`: selection said
 * the item is not ours this round, or failed to decide (`select failed: ...`,
 * or `selection did not answer ours`). `requeued`: the work was interrupted without
 * a recorded cancel, such as a host whose lease lapsed, so its claim was
 * released and a later round or a resumed run works the item again.
 *
 * @category models
 * @since 1.0.0
 */
export const Status = Schema.Literals(["landed", "held", "failed", "skipped", "requeued"])

/**
 * What happened to one item.
 *
 * @category models
 * @since 1.0.0
 */
export type Status = typeof Status.Type

/**
 * One outcome row: the item id, its status, and a human-readable detail.
 *
 * @category models
 * @since 1.0.0
 */
export const Row = Schema.Struct({
  id: Schema.String,
  status: Status,
  detail: Schema.String,
  requeues: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
})

/**
 * One outcome row.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

/**
 * Why a burndown stopped.
 *
 * `drained`: a round launched and requeued nothing and its selection reported
 * no error, so nothing ours is left. A round that launched nothing because
 * selection failed does not drain: it fails with {@link Stop} naming the
 * cause. `max_rounds`: the round budget ran out first.
 *
 * @category models
 * @since 1.0.0
 */
export const Stopped = Schema.Literals(["drained", "max_rounds"])

/**
 * What the declared burndown settles to.
 *
 * `rows` holds one row per item the lineage touched, in first-seen order. A
 * settled row (`landed`, `held`, `failed`) is final; a `skipped` or
 * `requeued` row is the latest round's outcome and is reconsidered next round. `rounds` counts the rounds the lineage opened,
 * parks included.
 *
 * @category models
 * @since 1.0.0
 */
export const Result = Schema.Struct({
  rows: Schema.Array(Row),
  rounds: Schema.Number,
  stopped: Stopped
})

/**
 * What the declared burndown settles to.
 *
 * @category models
 * @since 1.0.0
 */
export type Result = typeof Result.Type

/**
 * What one dispatched round reports.
 *
 * `launched` counts the items the round claimed or tried to claim. `deferred`
 * counts the items that were ours but that the capacity admitted no slot
 * for; the next round rediscovers them.
 *
 * @category models
 * @since 1.0.0
 */
export const RoundResult = Schema.Struct({
  rows: Schema.Array(Row),
  launched: Schema.Number,
  deferred: Schema.Number
})

/**
 * What one dispatched round reports.
 *
 * @category models
 * @since 1.0.0
 */
export type RoundResult = typeof RoundResult.Type

/**
 * What a capacity member answers.
 *
 * `Available` launches at most `slots` items this round. `WaitUntil` parks
 * the lineage on a durable timer until the epoch-millisecond instant `at`.
 * `Exhausted` parks it on a durable signal that only an operator resolves.
 *
 * @category models
 * @since 1.0.0
 */
export const Capacity = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Available"), slots: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
  Schema.Struct({ _tag: Schema.Literal("WaitUntil"), at: Schema.Finite }),
  Schema.Struct({ _tag: Schema.Literal("Exhausted"), detail: Schema.String })
])

/**
 * What a capacity member answers.
 *
 * @category models
 * @since 1.0.0
 */
export type Capacity = typeof Capacity.Type

/**
 * `slots` items may launch this round.
 *
 * @category constructors
 * @since 1.0.0
 */
export const available = (slots: number): Capacity => ({ _tag: "Available", slots })

/**
 * Nothing may launch before the epoch-millisecond instant `at`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const waitUntil = (at: number): Capacity => ({ _tag: "WaitUntil", at })

/**
 * Nothing may launch until an operator resolves the capacity signal.
 *
 * @category constructors
 * @since 1.0.0
 */
export const exhausted = (detail: string): Capacity => ({ _tag: "Exhausted", detail })

/**
 * The name of the `WaitFor` wait point an exhausted burndown parks on when
 * {@link MakeOptions.signal} is absent.
 *
 * @category constants
 * @since 1.0.0
 */
export const DefaultSignal = "burndown/capacity"

/**
 * The durable deferred an operator completes to resume a burndown parked on
 * exhausted capacity.
 *
 * It is `WaitFor.deferred(name)`, so the resolver uses the ordinary
 * `DurableDeferred.tokenFromExecutionId` and `DurableDeferred.succeed` path
 * against the parked round's execution id. The parked round's waiting row also
 * carries the token.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signal = (name: string = DefaultSignal): ReturnType<typeof WaitFor.deferred> => WaitFor.deferred(name)

/**
 * A selection decision.
 *
 * Only the exact `Ours` value launches an item. An answered `Skip` is a policy
 * decision. A selection failure or a malformed answer also skips the item, so
 * a selection member cannot launch work by returning something unexpected, but
 * it counts as a selection error: a round that launches nothing because of
 * selection errors stops instead of draining.
 *
 * @category models
 * @since 1.0.0
 */
export type Selection = { readonly _tag: "Ours" } | { readonly _tag: "Skip"; readonly detail: string }

/**
 * The item is ours: claim and work it.
 *
 * @category constructors
 * @since 1.0.0
 */
export const ours: Selection = Object.freeze({ _tag: "Ours" })

/**
 * The item is not ours this round, for the stated reason.
 *
 * @category constructors
 * @since 1.0.0
 */
export const skip = (detail: string): Selection => ({ _tag: "Skip", detail })

/**
 * The typed failure a claim member raises when another owner holds the item.
 *
 * A held item is reported as `held`, is never retried by the burndown, and is
 * not released, because the claim it would release is not ours.
 *
 * @category errors
 * @since 1.0.0
 */
export class Held extends Schema.TaggedError<Held>()("flows/patterns/Burndown/Held", {
  message: Schema.String
}) {}

/**
 * The typed failure that stops a round and releases its open claims.
 * Defects, including a defect containing Stop, settle only their own item.
 *
 * @category errors
 * @since 1.0.0
 */
export class Stop extends Schema.TaggedError<Stop>()("flows/patterns/Burndown/Stop", {
  message: Schema.String
}) {}

const DispatchError = Schema.Union([PatternError, Stop])

/**
 * The action an item's landing runs and is journaled under.
 *
 * Inside a running flow, {@link round} lands each item as its own durable
 * action under this name, keyed by the item, so a round that runs again after
 * a crash replays the recorded landing instead of landing twice. The step is
 * journaled as it happens: `flows.engine.node-scheduled` when the landing
 * starts and `flows.engine.node-settled` when it settles, with node id
 * `${key}/${item.id}/land` and the item's {@link Row} as the settled value.
 *
 * @category constants
 * @since 1.0.0
 */
export const LandStep = "flows/patterns/Burndown/land"

/**
 * The action an item's release is journaled under.
 *
 * Inside a running flow, {@link round} journals each release as it happens,
 * with node id `${key}/${item.id}/release` and the item's final {@link Row}
 * as the settled value. A release runs again when the round does, because the
 * round claims again.
 *
 * @category constants
 * @since 1.0.0
 */
export const ReleaseStep = "flows/patterns/Burndown/release"

/**
 * The payload a dispatch member receives, once per round.
 *
 * @category models
 * @since 1.0.0
 */
export const DispatchPayload = Schema.Struct({
  input: Schema.Unknown,
  round: Schema.Number,
  items: Schema.Unknown,
  settled: Schema.Array(Schema.String),
  rows: Schema.optional(Schema.Array(Row)),
  slots: Schema.optional(Schema.Number)
})

/**
 * The declared form of a dispatch action.
 *
 * @category models
 * @since 1.0.0
 */
export type Dispatch<Tag extends string> = Action.Declared<
  Tag,
  typeof DispatchPayload,
  typeof RoundResult,
  typeof DispatchError
>

/**
 * Declares the action a burndown dispatches each round through.
 *
 * Declare it once at module level and implement it with {@link layer}. It is
 * `nondeterministic`: a replayed round reads the recorded rows, and a round
 * that crashed before recording reruns, where the work member's derived
 * execution id reattaches each child instead of starting it again.
 *
 * @category constructors
 * @since 1.0.0
 */
export const dispatch = <const Tag extends string>(tag: Tag): Dispatch<Tag> =>
  Action.make(tag, {
    payload: DispatchPayload,
    success: RoundResult,
    error: DispatchError,
    nondeterministic: true
  })

/**
 * The payload of a declared burndown.
 *
 * A caller passes `{ input }`. `round` and `rows` are the lineage's own
 * counters, carried from one round to the next.
 *
 * @category models
 * @since 1.0.0
 */
export const Payload = Schema.Struct({
  input: Schema.Unknown,
  round: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  rows: Schema.optional(Schema.Array(Row))
})

/**
 * The declared form of a burndown.
 *
 * @category models
 * @since 1.0.0
 */
export type BurndownFlow<E extends Schema.Top = typeof Schema.Unknown> = Flow.Flow<string, typeof Payload, typeof Result, E, any>

/**
 * Configuration for {@link make}.
 *
 * `discover` is called with `{ input, round }` and answers the backlog, an
 * array of {@link Item}. `dispatch` is called with the {@link DispatchPayload}
 * and answers a {@link RoundResult}; declare it with {@link dispatch} and
 * implement it with {@link layer}. `capacity`, when present, is called with
 * `{ input, round }` before discovery and answers a {@link Capacity}.
 *
 * `maxRounds` bounds every round the lineage opens, including a round spent
 * parked. `deadline` bounds the whole lineage from its first start. `signal`
 * names the `WaitFor` wait point an exhausted burndown parks on.
 *
 * @category models
 * @since 1.0.0
 */
export interface MakeOptions<E extends Schema.Top = typeof Schema.Unknown> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly discover: Callable<any>
  readonly dispatch: Callable<any>
  readonly capacity?: Callable<any> | undefined
  readonly maxRounds: number
  readonly deadline?: Duration.Input | undefined
  readonly signal?: string | undefined
  /**
   * The failures a lineage may settle with: the discover, capacity and
   * dispatch members' typed errors and {@link Stop}. A run's result is
   * journaled through this schema, so an error it does not encode cannot be
   * recorded. Default: `Schema.Unknown`, which records only plain data.
   */
  readonly error?: E | undefined
}

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

/** Whether a row is final for the lineage: every status but `skipped` and `requeued`. */
const isSettled = (status: Status): boolean => status !== "skipped" && status !== "requeued"

const decodeCapacity = Schema.decodeUnknownSync(Capacity)
const decodeRound = Schema.decodeUnknownSync(RoundResult)
const isCapacity = Schema.is(Capacity)

interface Folded {
  readonly continue: boolean
  readonly rows: ReadonlyArray<Row>
  readonly result: Result
}

/**
 * Merges one round's rows into the rows the lineage carried. A settled row is
 * final; a skipped or requeued row is replaced by the item's latest row.
 */
const merge = (carried: ReadonlyArray<Row>, fresh: ReadonlyArray<Row>): ReadonlyArray<Row> => {
  const rows = new Map<string, Row>(carried.map((row) => [row.id, row]))
  for (const row of fresh) {
    const previous = rows.get(row.id)
    if (previous === undefined || !isSettled(previous.status)) rows.set(row.id, row)
  }
  return [...rows.values()]
}

/**
 * Declares the burndown lineage.
 *
 * One round is: the capacity gate, when `capacity` is declared; one
 * `discover` call; one `dispatch` call carrying the discovered items, the ids
 * already settled, and the capacity's slots; then a branch. A round that
 * launched at least one item hands off to the next round with `Flow.to`,
 * carrying the merged rows, so the next round rediscovers the backlog. A round
 * that launched nothing settles the lineage as `drained`; a round that
 * launched nothing because selection erred fails the lineage with the round's
 * {@link Stop} instead. The round budget settles it as `max_rounds`.
 *
 * The capacity gate parks durably and never polls. `WaitUntil` arms
 * `Sleep.action` until the instant, and `Exhausted` awaits
 * `WaitFor.action` on {@link MakeOptions.signal}; either then hands off to a
 * fresh round that asks for capacity again. A host executing a burndown with a
 * capacity member provides `Sleep.layer` and `WaitFor.layer`.
 *
 * A capacity or dispatch answer outside its schema is a defect: the member
 * broke its contract, and no row can say what it meant.
 *
 * `make` throws a `PatternError` when `maxRounds` is not a positive safe
 * integer below `Number.MAX_SAFE_INTEGER`, `deadline` is not a positive
 * finite duration, or `signal` is blank. It snapshots every option at the
 * call.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = <E extends Schema.Top = typeof Schema.Unknown>(options: MakeOptions<E>): BurndownFlow<E> => {
  const discover = options.discover
  const dispatcher = options.dispatch
  const capacity = options.capacity
  const maxRounds = options.maxRounds
  const deadline = options.deadline
  const signalName = options.signal ?? DefaultSignal
  // The lineage bound handed to `Flow.make` is one above `maxRounds`, and it
  // must stay a safe integer too.
  if (!bound(maxRounds) || maxRounds === Number.MAX_SAFE_INTEGER) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Burndown maxRounds must be a positive safe integer below Number.MAX_SAFE_INTEGER"
    })
  }
  if (deadline !== undefined) {
    const resolved = Option.getOrUndefined(Duration.fromInput(deadline))
    if (resolved === undefined || !Duration.isFinite(resolved) || Duration.toMillis(resolved) <= 0) {
      throw new PatternError({
        code: "invalid_decorator",
        message: "Burndown deadline must be a positive finite duration"
      })
    }
  }
  if (signalName.trim().length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Burndown signal must be a nonblank name" })
  }
  const captures = { maxRounds, signal: signalName, capacity: capacity !== undefined }
  const { name, description } = Compose.label(
    "burndown",
    { maxRounds, capacity: capacity !== undefined },
    options
  )
  const body = (payload: typeof Payload.Type): Node.Node<unknown, unknown, any> => {
    const round = payload.round ?? 0
    const rows = payload.rows ?? []
    const input = payload.input
    if (round >= maxRounds) {
      return Flow.done({ rows, rounds: round, stopped: "max_rounds" } satisfies Result)
    }
    const next = (carried: ReadonlyArray<Row> | Planned.Planned<ReadonlyArray<Row>>) =>
      self.to({ input, round: round + 1, rows: carried as ReadonlyArray<Row> })
    const settled = rows.filter((row) => isSettled(row.status)).map((row) => row.id)
    const fold = (value: unknown): Folded => {
      const result = decodeRound(value)
      const merged = merge(rows, result.rows)
      const launched = result.launched > 0 || result.rows.some((row) => row.status === "requeued")
      return {
        continue: launched && round + 1 < maxRounds,
        rows: merged,
        result: { rows: merged, rounds: round + 1, stopped: launched ? "max_rounds" : "drained" }
      }
    }
    const work = (slots: Planned.Planned<number> | undefined): Node.Node<unknown, unknown, any> =>
      callMember(discover, { input, round }).pipe(
        Node.bindPlanned((items) =>
          callMember(dispatcher, {
            input,
            round,
            items,
            settled,
            rows,
            ...(slots === undefined ? {} : { slots })
          })
        ),
        Node.map(Node.capture({ ...captures, round, settled }, fold)),
        Node.branch({
          if: Node.capture({ ...captures, round }, (folded: Folded) => folded.continue),
          then: (folded) => next(folded.rows),
          else: (folded) => Flow.done(folded.result)
        })
      )
    if (capacity === undefined) return work(undefined)
    return callMember(capacity, { input, round }).pipe(
      Node.map(Node.capture({ ...captures, round }, (value: unknown) => decodeCapacity(value))),
      Node.branch({
        if: Node.capture({ ...captures, round }, (answer: Capacity) => answer._tag === "Available"),
        then: (answer) => work((answer as Planned.Planned<{ readonly slots: number }>).slots),
        else: (answer) =>
          Node.succeed(answer).pipe(
            Node.branch({
              if: Node.capture({ ...captures, round }, (parked: Capacity) => parked._tag === "WaitUntil"),
              then: (parked) =>
                Node.andThen(
                  Sleep.action.call({ until: (parked as Planned.Planned<{ readonly at: number }>).at }),
                  next(rows)
                ),
              else: () => Node.andThen(WaitFor.action.call({ name: signalName }), next(rows))
            })
          )
      })
    )
  }
  // The body names the flow it is the body of, which is what makes one round
  // open the next. It is read when a round is planned, long after `Flow.make`
  // has returned, so the binding is initialized by then. The lineage bound is
  // one above `maxRounds`: the body itself settles the round at the budget, so
  // the engine's bound is only a backstop.
  const self: BurndownFlow<E> = Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: Payload,
    success: Result,
    error: (options.error ?? Schema.Unknown) as E,
    maxRounds: maxRounds + 1,
    ...(deadline === undefined ? {} : { deadline }),
    body: Node.capture(captures, body) as never
  })
  return self
}

/**
 * What one round reads.
 *
 * `items` is the discovered backlog. `settled` lists ids an earlier round
 * already settled; they are left alone. `slots`, when present, caps how many
 * items are worked at once and how many launch before
 * {@link RoundOptions.capacity} is asked.
 *
 * @category models
 * @since 1.0.0
 */
export interface RoundInput<I, It extends Item> {
  readonly input: I
  readonly round: number
  readonly items: ReadonlyArray<It>
  readonly settled?: ReadonlyArray<string> | undefined
  readonly rows?: ReadonlyArray<Row> | undefined
  readonly slots?: number | undefined
}

/**
 * What every member of a round receives.
 *
 * @category models
 * @since 1.0.0
 */
export interface ItemArgs<I, It extends Item> {
  readonly input: I
  readonly item: It
  readonly round: number
}

/**
 * The members of one round, and its bounds.
 *
 * `key` prefixes the execution id each work call receives:
 * `${key}/${item.id}`. Pass it to `Flow.execute`, or build `work` with
 * {@link child}, so a rerun of the round reattaches to the child that already
 * exists instead of starting a second one.
 *
 * `select` defaults to {@link ours} for every item. `claim` may fail with
 * {@link Held}. `land`, when present, starts items in the order work finished,
 * at most `landConcurrency` at a time (default 1), and one failed landing does
 * not stop the next; without it a worked item counts as landed. A `land` that
 * runs concurrently serializes whatever must stay serial, such as the final
 * push, itself. `release` runs once for every item whose claim
 * succeeded, whatever happened after, with the item's final status and row
 * detail. `detail` renders a landed item's detail from its work output and,
 * when `land` is present, what `land` answered, such as the landed revision.
 *
 * `capacity`, when present, is asked each time a slot frees and an item that
 * is ours is still waiting beyond the round's `slots`. Only an `Available`
 * answer with more slots than the work still in flight admits the item. Any
 * other answer, or a failure, admits nothing through that slot, and the items
 * left over are `deferred` to the next round, where the lineage's capacity
 * gate can park. Without it a round launches at most `slots` items.
 *
 * `cancelled`, when present, is asked once for each claimed item whose work was
 * interrupted, and answers whether an operator cancel was recorded for it,
 * typically by reading the durable cancel request of the item's execution.
 * Only `true` settles the item `failed`; `false`, a failure, or no member at
 * all requeues it, the same rule the engine applies when it releases an
 * interrupted run for reclaim instead of closing it.
 *
 * @category models
 * @since 1.0.0
 */
export interface RoundOptions<I, It extends Item, W, E, R, L = unknown> {
  readonly key: string
  readonly concurrency: number
  /** Maximum infra requeues per item, counted in carried rows; defaults to 3. */
  readonly maxRequeues?: number | undefined
  readonly select?: ((args: ItemArgs<I, It>) => Effect.Effect<Selection, E, R>) | undefined
  readonly claim: (args: ItemArgs<I, It>) => Effect.Effect<unknown, E | Held, R>
  readonly work: (args: ItemArgs<I, It> & { readonly executionId: string }) => Effect.Effect<W, E, R>
  readonly land?: ((args: ItemArgs<I, It> & { readonly output: W }) => Effect.Effect<L, E, R>) | undefined
  readonly landConcurrency?: number | undefined
  readonly release: (
    args: ItemArgs<I, It> & { readonly status: Status; readonly detail: string }
  ) => Effect.Effect<unknown, E, R>
  readonly detail?: ((output: W, landing: L | undefined) => string) | undefined
  readonly cancelled?:
    | ((args: ItemArgs<I, It> & { readonly executionId: string }) => Effect.Effect<boolean, E, R>)
    | undefined
  readonly capacity?:
    | ((args: { readonly input: I; readonly round: number }) => Effect.Effect<Capacity, E, R>)
    | undefined
}

/**
 * The human-readable text of a typed failure: its own `message` when it has
 * one, otherwise its string form.
 */
const detailOf = (error: unknown): string => {
  try {
    return typeof error === "object" && error !== null &&
        typeof (error as { readonly message?: unknown }).message === "string"
      ? (error as { readonly message: string }).message
      : String(error)
  } catch {
    return "unrenderable failure"
  }
}

const ownTag = (value: unknown, tag: string): boolean => {
  try {
    return typeof value === "object" && value !== null && Object.hasOwn(value, "_tag") &&
      (value as { readonly _tag: unknown })._tag === tag
  } catch {
    return false
  }
}

/**
 * What one selection decided: a {@link Selection} the member answered, or an
 * `Erred` skip when it failed or answered outside the contract. Only an
 * answered `Skip` is a policy decision; an `Erred` skip is an error the round
 * reports when it launches nothing.
 */
type Selected = Selection | { readonly _tag: "Erred"; readonly detail: string }

const selectionOf = (value: unknown): Selected => {
  if (ownTag(value, "Ours")) return ours
  if (ownTag(value, "Skip") && typeof (value as { readonly detail?: unknown }).detail === "string") {
    return skip((value as { readonly detail: string }).detail)
  }
  return { _tag: "Erred", detail: "selection did not answer ours" }
}

const refusal = (message: string): PatternError => new PatternError({ code: "invalid_input", message })

const roundRefusal = (
  input: { readonly round: unknown; readonly items: unknown; readonly settled?: unknown; readonly slots?: unknown },
  key: unknown,
  concurrency: number,
  landConcurrency: unknown
): PatternError | undefined => {
  if (typeof key !== "string" || key.trim().length === 0) {
    return new PatternError({ code: "invalid_decorator", message: "Burndown key must be a nonblank string" })
  }
  const width = Compose.concurrencyRefusal("Burndown", concurrency)
  if (width !== undefined) return width
  if (landConcurrency !== undefined && (typeof landConcurrency !== "number" || !bound(landConcurrency))) {
    return new PatternError({
      code: "invalid_decorator",
      message: "Burndown landConcurrency must be a positive safe integer"
    })
  }
  if (typeof input.round !== "number" || !Number.isSafeInteger(input.round) || input.round < 0) {
    return refusal("Burndown round must be a non-negative safe integer")
  }
  if (input.slots !== undefined && (typeof input.slots !== "number" || !bound(input.slots))) {
    return refusal("Burndown slots must be a positive safe integer")
  }
  if (input.settled !== undefined && !Array.isArray(input.settled)) {
    return refusal("Burndown settled must be an array of item ids")
  }
  if (!Array.isArray(input.items)) return refusal("Burndown items must be an array")
  const ids = new Set<string>()
  for (const item of input.items as ReadonlyArray<unknown>) {
    const id = typeof item === "object" && item !== null && Object.hasOwn(item, "id")
      ? (item as { readonly id: unknown }).id
      : undefined
    if (typeof id !== "string" || id.trim().length === 0) {
      return refusal("Burndown items must each have a nonblank string id")
    }
    if (ids.has(id)) return refusal(`Burndown item ids must be unique, "${id}" repeats`)
    ids.add(id)
  }
  return undefined
}

interface Card<It> {
  readonly id: string
  readonly item: It
}

type Attempt<W> =
  | { readonly _tag: "Settled"; readonly status: Status; readonly detail: string }
  | { readonly _tag: "Worked"; readonly output: W }

/** The engine a round runs under when it is the dispatch of a running flow. */
interface Engine {
  readonly instance: FlowRuntime.FlowInstance["Service"]
  readonly runtime: FlowRuntime.FlowRuntime["Service"]
  readonly crypto: Crypto.Crypto
}

const engineOf: Effect.Effect<Engine | undefined> = Effect.map(
  Effect.all([
    Effect.serviceOption(FlowRuntime.FlowInstance),
    Effect.serviceOption(FlowRuntime.FlowRuntime),
    Effect.serviceOption(Crypto.Crypto)
  ]),
  ([instance, runtime, crypto]) =>
    Option.isSome(instance) && Option.isSome(runtime) && Option.isSome(crypto)
      ? { instance: instance.value, runtime: runtime.value, crypto: crypto.value }
      : undefined
)

/** A landing is never retried by the engine: its failures settle the item's row instead. */
const once = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 1 })

/** A step's settlement: the item's row, and whether the step itself succeeded. */
const Stepped = Schema.Struct({ row: Row, ok: Schema.Boolean })

/** A step's settlement. */
type Stepped = typeof Stepped.Type

/**
 * Journals one item's step of a round the way the interpreter journals a
 * node: a scheduled record before `run`, and a settled record after it whose
 * value is the item's row. An interrupted step settles no record, so a rerun
 * schedules it again and the journal keeps one record per identity.
 *
 * `dispatch`, when present, runs the step as a durable action keyed by the
 * item, so its recorded outcome is replayed instead of run again.
 */
const journaled = <R>(
  engine: Engine,
  options: {
    readonly key: string
    readonly round: number
    readonly id: string
    readonly stage: "land" | "release"
    readonly action: string
    readonly dispatch: boolean
  },
  run: Effect.Effect<Stepped, Stop, R>
): Effect.Effect<Row, Stop, R> => {
  const nodeId = `${options.key}/${options.id}/${options.stage}`
  const sourceId = `burndown/${options.round}/${nodeId}`
  const record = (make: () => FlowRuntime.NodeRecord) =>
    engine.runtime.recordNode === undefined
      ? Effect.void
      : Effect.provideService(engine.runtime.recordNode(make()), FlowRuntime.FlowInstance, engine.instance)
  const reports = { executed: 0, replayed: 0, digests: new Set<string | undefined>() }
  const step: Effect.Effect<Stepped, Stop, R> = options.dispatch
    ? Action.make({
      name: options.action,
      success: Stepped,
      error: Stop,
      tier: "irreversible",
      idempotencyKey: nodeId,
      retryPolicy: once,
      // A Stop a member reported as a plain object is recorded as a Stop.
      execute: Effect.mapError(
        run,
        (error): Stop => error instanceof Stop ? error : new Stop({ message: detailOf(error) })
      )
    }).pipe(
      Effect.provideService(
        Action.DispatchReport,
        Action.DispatchReport.of({
          dispatched: (dispatch) =>
            Effect.sync(() => {
              if (dispatch.outcome === "executed") reports.executed += 1
              else reports.replayed += 1
              reports.digests.add(dispatch.stepKeyDigest)
            })
        })
      ),
      Effect.provideService(FlowRuntime.FlowInstance, engine.instance),
      Effect.provideService(FlowRuntime.FlowRuntime, engine.runtime),
      Effect.provideService(Crypto.Crypto, engine.crypto)
    )
    : run
  const settled = (outcome: FlowRuntime.NodeOutcome, value: unknown) =>
    record(() => ({
      _tag: "NodeSettled",
      sourceId: `${sourceId}/settled`,
      nodeId,
      outcome,
      // Never retried: a landing's failure settles its row.
      attempts: 1,
      // A runtime that keeps no attempt rows reports no digest.
      stepKeyDigests: [...reports.digests].filter((digest): digest is string => digest !== undefined),
      value,
      action: options.action
    }))
  return record(() => ({
    _tag: "NodeScheduled",
    sourceId,
    nodeId,
    kind: "ActionCall",
    attempt: 1,
    action: options.action
  })).pipe(
    Effect.andThen(step),
    Effect.tap(({ ok, row }) =>
      settled(!ok ? "failed" : reports.executed === 0 && reports.replayed > 0 ? "clean" : "built", row)
    ),
    Effect.tapError((error) => settled("failed", error)),
    Effect.map(({ row }) => row)
  )
}

/**
 * Runs one round of a burndown.
 *
 * Items whose id is in `settled` are left alone. `select` runs for the rest at
 * `concurrency`; a skipped item, or one whose selection failed, gets a
 * `skipped` row and is reconsidered next round. When no item is ours and none
 * was requeued, but a selection failed or answered outside the contract, the
 * round fails with {@link Stop} naming how many selections failed and the
 * first causes, before any claim: an error is not an empty backlog. A round
 * whose skips are all answered `Skip`s returns normally. Of the items that are ours,
 * the first `slots` launch, in discovery order. When a launched item finishes
 * working, its slot admits the next item that is ours while
 * {@link RoundOptions.capacity} allows, so a slow item never holds another
 * slot idle. The items never admitted count as `deferred`.
 *
 * Each launched item is claimed, then worked, at most `concurrency` and at
 * most `slots` at a time. A claim that fails with {@link Held} settles the
 * item `held`; typed infra failures requeue up to `maxRequeues` (default 3),
 * counted in the carried rows. Other failures settle only that item `failed`. A failure is recorded on its own row and never
 * cancels the items beside it. A worked item enters the landing queue at
 * once: landings start in the order work finished, at most
 * {@link RoundOptions.landConcurrency} at a time, while other items still work. Every item whose claim succeeded is released as soon as
 * it settles, with its final status and detail; a release failure is appended
 * to the row's detail. A release defect fails the item; a typed infra release
 * failure requeues within the same bound. Rows keep discovery
 * order.
 *
 * Inside a running flow, each landing runs as a durable action named
 * {@link LandStep} and keyed by the item, so a rerun of the round replays a
 * recorded landing instead of landing again. Each landing and release is
 * journaled as it settles, as a {@link LandStep} or {@link ReleaseStep} node
 * record whose settled value is the item's row.
 *
 * Members report failures on the typed channel. Work interrupted from inside
 * settles its item `failed` with the detail `work: interrupted` only when
 * {@link RoundOptions.cancelled} reports a recorded operator cancel. Any other
 * interruption, such as a child execution released because its host's lease
 * lapsed, gets a `requeued` row, which settles nothing: its claim is released
 * with status `requeued` and a later round works the item again. A member that
 * throws fails only its item, with `Fault.of(defect)` in the detail. Typed
 * {@link Stop} is the only member failure that stops the round; a release
 * already running finishes and every open claim is released as `failed`. When the round itself is interrupted, each open
 * claim is released the same way if `cancelled` reports a recorded cancel for
 * it, and otherwise with status `requeued` and the detail `round interrupted`,
 * so a resumed run claims it again.
 *
 * `round` fails with a `PatternError` before any member runs when `key` is
 * blank, `concurrency`, `landConcurrency`, or `slots` is not a positive safe integer, `round` is
 * not a non-negative safe integer, or an item lacks a nonblank string id or
 * repeats one. It snapshots `items`, each item's `id`, and every option at the
 * call; the item records themselves stay the caller's.
 *
 * @category combinators
 * @since 1.0.0
 */
export const round = <I, It extends Item, W, E = never, R = never, L = unknown>(
  input: RoundInput<I, It>,
  options: RoundOptions<I, It, W, E, R, L>
): Effect.Effect<RoundResult, PatternError | Stop, R> => {
  const key = options.key
  const concurrency = options.concurrency
  const select = options.select
  const claim = options.claim
  const work = options.work
  const land = options.land
  const landers = options.landConcurrency ?? 1
  const release = options.release
  const detail = options.detail
  const capacity = options.capacity
  const cancelled = options.cancelled
  const maxRequeues = options.maxRequeues ?? 3
  if (!Number.isSafeInteger(maxRequeues) || maxRequeues < 0) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Burndown maxRequeues must be a non-negative safe integer"
      })
    )
  }
  if (input.rows !== undefined && !Schema.is(Schema.Array(Row))(input.rows)) {
    return Effect.fail(refusal("Burndown rows must be valid outcome rows"))
  }
  const invalid = roundRefusal(input, key, concurrency, options.landConcurrency)
  if (invalid !== undefined) return Effect.fail(invalid)
  const value = input.input
  const index = input.round
  const slots = input.slots
  const settled = new Set(input.settled ?? [])
  const cards: ReadonlyArray<Card<It>> = input.items.map((item) => ({ id: item.id, item }))
  const args = (card: Card<It>): ItemArgs<I, It> => ({ input: value, item: card.item, round: index })
  const counts = new Map(
    (input.rows ?? []).flatMap((row) => row.requeues === undefined ? [] : [[row.id, row.requeues] as const])
  )
  const priorCounts = new Map(counts)
  type Settled = Extract<Attempt<W>, { readonly _tag: "Settled" }>
  type Observed<A> = { readonly _tag: "Value"; readonly value: A } | Settled
  const failure = (card: Card<It>, stage: string, cause: Cause.Cause<unknown>): Effect.Effect<Settled, Stop> => {
    const defect = cause.reasons.find(Cause.isDieReason)
    const error = cause.reasons.find(Cause.isFailReason)?.error
    if (defect === undefined && ownTag(error, "flows/patterns/Burndown/Stop")) return Effect.fail(error as Stop)
    const value = defect === undefined ? error ?? Cause.squash(cause) : defect.defect
    const fault = Fault.of(value)
    const spent = priorCounts.get(card.id) ?? 0
    const infra = defect === undefined && fault.class === "infra"
    if (infra) counts.set(card.id, spent < maxRequeues ? spent + 1 : spent)
    return Effect.succeed({
      _tag: "Settled",
      status: infra && spent < maxRequeues ? "requeued" : "failed",
      detail: `${stage}: ${detailOf(value)}${defect === undefined ? "" : `; ${JSON.stringify(fault)}`}`
    })
  }
  const observe = <A>(
    card: Card<It>,
    stage: string,
    run: () => Effect.Effect<A, unknown, R>
  ): Effect.Effect<Observed<A>, Stop, R> =>
    Effect.suspend(run).pipe(Effect.matchCauseEffect({
      onSuccess: (value) => Effect.succeed<Observed<A>>({ _tag: "Value", value }),
      onFailure: (cause) => failure(card, stage, cause)
    }))
  const outcomeRow = (card: Card<It>, status: Status, detail: string): Row => ({
    id: card.id,
    status,
    detail,
    ...(counts.has(card.id) ? { requeues: counts.get(card.id)! } : {})
  })
  return Effect.gen(function*() {
    const rows = new Map<string, Row>()
    const fresh = cards.filter((card) => !settled.has(card.id))
    const selections = yield* Effect.forEach(
      fresh,
      (card) =>
        observe(card, "select", () =>
          (select === undefined ? Effect.succeed<Selected>(ours) : select(args(card))).pipe(
            Effect.map(selectionOf),
            Effect.catch((error: E) =>
              ownTag(error, "flows/patterns/Burndown/Stop") || Fault.of(error).class === "infra"
                ? Effect.fail(error)
                : Effect.succeed<Selected>({ _tag: "Erred", detail: `select failed: ${detailOf(error)}` })
            )
          )).pipe(Effect.map((selection) => ({ card, selection }))),
      { concurrency }
    )
    const mine: Array<Card<It>> = []
    // Selection errors: failed selections and skips no member decided.
    const erred: Array<string> = []
    let requeued = false
    for (const { card, selection } of selections) {
      if (selection._tag === "Settled") {
        rows.set(card.id, outcomeRow(card, selection.status, selection.detail))
        if (selection.status === "failed") erred.push(`${card.id}: ${selection.detail}`)
        requeued ||= selection.status === "requeued"
      } else if (selection.value._tag === "Ours") mine.push(card)
      else {
        rows.set(card.id, outcomeRow(card, "skipped", selection.value.detail))
        if (selection.value._tag === "Erred") erred.push(`${card.id}: ${selection.value.detail}`)
      }
    }
    // Drained means nothing was eligible. A round that would launch and
    // requeue nothing because selection erred stops with the cause instead.
    if (mine.length === 0 && !requeued && erred.length > 0) {
      return yield* new Stop({
        message: `round ${index} launched nothing: selection failed for ${erred.length} of ${fresh.length} items; ${
          erred.slice(0, 3).join("; ")
        }`
      })
    }
    // The first `budget` items launch on the capacity the lineage already
    // asked for; every later admission asks the round's own capacity member.
    const budget = Math.min(slots ?? mine.length, mine.length)
    const first = mine.slice(0, Math.min(concurrency, budget))
    let next = first.length
    let working = 0
    const claimed = new Set<Card<It>>()
    const executionId = (card: Card<It>) => `${key}/${card.id}`
    // Only a recorded operator cancel makes an interruption final; an
    // unanswerable question counts as no cancel, so the item is worked again.
    const wasCancelled = (card: Card<It>): Effect.Effect<boolean, Stop, R> =>
      cancelled === undefined
        ? Effect.succeed(false)
        : Effect.suspend(() => cancelled({ ...args(card), executionId: executionId(card) })).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              const error = cause.reasons.find(Cause.isFailReason)?.error
              if (Cause.hasDies(cause)) return Effect.die(cause.reasons.find(Cause.isDieReason)!.defect)
              return ownTag(error, "flows/patterns/Burndown/Stop") ? Effect.fail(error as Stop) : Effect.succeed(false)
            },
            onSuccess: (answer) => Effect.succeed(answer === true)
          })
        )
    const attempt = (card: Card<It>): Effect.Effect<Attempt<W>, Stop, R> =>
      Effect.gen(function*() {
        const held = yield* Effect.suspend(() => claim(args(card))).pipe(Effect.matchCauseEffect({
          onSuccess: () => Effect.succeed<Observed<void>>({ _tag: "Value", value: undefined }),
          onFailure: (cause) => {
            const error = cause.reasons.find(Cause.isFailReason)?.error
            return !Cause.hasDies(cause) && ownTag(error, "flows/patterns/Burndown/Held")
              ? Effect.succeed<Settled>({ _tag: "Settled", status: "held", detail: detailOf(error) })
              : failure(card, "claim", cause)
          }
        }))
        if (held._tag === "Settled") return held
        claimed.add(card)
        return yield* Effect.suspend(() => work({ ...args(card), executionId: executionId(card) })).pipe(
          Effect.matchCauseEffect({
            onSuccess: (output) => Effect.succeed<Attempt<W>>({ _tag: "Worked", output }),
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.map(observe(card, "cancelled", () => wasCancelled(card)), (cancel): Attempt<W> =>
                  cancel._tag === "Settled" ? cancel : {
                    _tag: "Settled",
                    status: cancel.value ? "failed" : "requeued",
                    detail: "work: interrupted"
                  })
                : failure(card, "work", cause)
          })
        )
      })
    // A claim leaves `claimed` when its release starts, so no path releases it
    // twice. A release that started always finishes.
    const releaseOne = (card: Card<It>, row: Pick<Row, "status" | "detail">) =>
      Effect.uninterruptible(Effect.suspend(() => {
        claimed.delete(card)
        return Effect.suspend(() => release({ ...args(card), status: row.status, detail: row.detail })).pipe(
          Effect.matchCauseEffect({
            onSuccess: () => Effect.succeed(undefined),
            onFailure: (cause) => {
              if (!Cause.hasDies(cause)) {
                const error = cause.reasons.find(Cause.isFailReason)?.error
                if (!ownTag(error, "flows/patterns/Burndown/Stop") && Fault.of(error).class !== "infra") {
                  return Effect.succeed({ ...row, detail: `release: ${detailOf(error)}` })
                }
              }
              return failure(card, "release", cause)
            }
          })
        )
      }))
    // Whether a freed slot may take another item: only an `Available` answer
    // wider than the work still in flight admits one.
    const allows = capacity === undefined
      ? Effect.succeed(false)
      : Effect.suspend(() => capacity({ input: value, round: index })).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            const error = cause.reasons.find(Cause.isFailReason)?.error
            return ownTag(error, "flows/patterns/Burndown/Stop") && !Cause.hasDies(cause)
              ? Effect.fail(error as Stop)
              : Effect.succeed(false)
          },
          onSuccess: (answer) =>
            Effect.succeed(isCapacity(answer) && answer._tag === "Available" && answer.slots > working)
        })
      )
    const admit: Effect.Effect<Card<It> | undefined, Stop, R> = Effect.suspend(() => {
      if (next < budget) return Effect.succeed(mine[next++])
      if (next >= mine.length) return Effect.succeed(undefined)
      return Effect.map(allows, (allowed) => allowed && next < mine.length ? mine[next++] : undefined)
    })
    const landings = yield* Queue.unbounded<{ readonly card: Card<It>; readonly output: W }, Cause.Done>()
    const releases = yield* Queue.unbounded<Card<It>, Cause.Done>()
    const settleRow = (card: Card<It>, status: Status, text: string) => {
      rows.set(card.id, outcomeRow(card, status, text))
      if (claimed.has(card)) Queue.offerUnsafe(releases, card)
    }
    const rendered = (output: W, landing: L | undefined): string => detail === undefined ? "" : detail(output, landing)
    // One slot: works an item, hands it on, and takes the next one admitted.
    const slot = (start: Card<It>) =>
      Effect.gen(function*() {
        let card: Card<It> | undefined = start
        while (card !== undefined) {
          working += 1
          const outcome = yield* attempt(card)
          working -= 1
          if (outcome._tag === "Settled") settleRow(card, outcome.status, outcome.detail)
          else if (land === undefined) {
            const row = yield* observe(card, "detail", () => Effect.sync(() => rendered(outcome.output, undefined)))
            settleRow(
              card,
              row._tag === "Settled" ? row.status : "landed",
              row._tag === "Settled" ? row.detail : row.value
            )
          } else Queue.offerUnsafe(landings, { card, output: outcome.output })
          card = yield* admit
        }
      })
    const drain = <A>(queue: Queue.Dequeue<A, Cause.Done>, handle: (entry: A) => Effect.Effect<void, Stop, R>) =>
      Queue.take(queue).pipe(Effect.flatMap(handle), Effect.forever, Effect.catchIf(Cause.isDone, () => Effect.void))
    // Inside a running flow, each landing and release is journaled as it
    // settles, and a landing is a durable step that a rerun replays.
    const engine = yield* engineOf
    const step = (
      card: Card<It>,
      stage: "land" | "release",
      run: Effect.Effect<Stepped, Stop, R>
    ): Effect.Effect<Row, Stop, R> =>
      engine === undefined ? Effect.map(run, ({ row }) => row) : journaled(engine, {
        key,
        round: index,
        id: card.id,
        stage,
        action: stage === "land" ? LandStep : ReleaseStep,
        dispatch: stage === "land"
      }, run)
    // The row landing an item settles it to.
    const landed = (card: Card<It>, output: W): Effect.Effect<Stepped, Stop, R> =>
      Effect.flatMap(
        observe(card, "land", () => land!({ ...args(card), output })),
        (landing) =>
          landing._tag === "Settled"
            ? Effect.succeed(outcomeRow(card, landing.status, landing.detail))
            : Effect.map(
              observe(card, "detail", () => Effect.sync(() => rendered(output, landing.value))),
              (row) =>
                row._tag === "Settled"
                  ? outcomeRow(card, row.status, row.detail)
                  : outcomeRow(card, "landed", row.value)
            )
      ).pipe(Effect.map((row) => ({ row, ok: row.status === "landed" })))
    // Landings start in the order work finished, `landers` at a time.
    const lander = drain(landings, ({ card, output }) =>
      Effect.map(step(card, "land", landed(card, output)), (row) => {
        // A replayed landing carries the requeue count its first run spent.
        if (row.requeues !== undefined) counts.set(card.id, row.requeues)
        settleRow(card, row.status, row.detail)
      }))
    const releaser = drain(releases, (card) =>
      Effect.asVoid(step(
        card,
        "release",
        Effect.map(releaseOne(card, rows.get(card.id)!), (failure) => {
          if (failure !== undefined) {
            const row = rows.get(card.id)!
            rows.set(
              card.id,
              outcomeRow(
                card,
                failure.status,
                row.detail.length === 0 ? failure.detail : `${row.detail}; ${failure.detail}`
              )
            )
          }
          return { row: rows.get(card.id)!, ok: failure === undefined }
        })
      )))
    const each = { concurrency: "unbounded", discard: true } as const
    yield* Effect.onExit(
      Effect.all([
        Effect.andThen(Effect.forEach(first, slot, each), Queue.end(landings)),
        Effect.andThen(Effect.forEach(Array.from({ length: landers }), () => lander, each), Queue.end(releases)),
        Effect.forEach(first, () => releaser, each)
      ], each),
      (exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.forEach(
            [...claimed],
            (card) =>
              Effect.flatMap(
                Cause.hasInterruptsOnly(exit.cause)
                  ? observe(card, "cancelled", () => wasCancelled(card)).pipe(
                    Effect.map((answer) => answer._tag === "Settled" || answer.value),
                    Effect.catch(() => Effect.succeed(true))
                  )
                  : Effect.succeed(true),
                (died) =>
                  releaseOne(
                    card,
                    died
                      ? { status: "failed", detail: "round died" }
                      : { status: "requeued", detail: "round interrupted" }
                  )
              ).pipe(
                Effect.catch((error) => Effect.logWarning("Burndown release stopped during round cleanup", error))
              ),
            { concurrency, discard: true }
          )
    )
    return {
      rows: cards.flatMap((card) => {
        const row = rows.get(card.id)
        return row === undefined ? [] : [row]
      }),
      launched: next,
      deferred: mine.length - next
    }
  })
}

/**
 * Builds a work member that runs `flow` as a durable child under the derived
 * execution id the round hands it, so a rerun reattaches instead of
 * duplicating.
 *
 * @category constructors
 * @since 1.0.0
 */
export const child = <I, It extends Item, P, A, E, R>(
  flow: {
    readonly execute: (
      payload: P,
      options: { readonly executionId: string }
    ) => Effect.Effect<A, E, R>
  },
  payload: (args: ItemArgs<I, It>) => P
) =>
(args: ItemArgs<I, It> & { readonly executionId: string }): Effect.Effect<A, E, R> =>
  flow.execute(payload(args), { executionId: args.executionId })

/**
 * Implements a {@link dispatch} action with {@link round}.
 *
 * The dispatch payload's `items` is read as the round's backlog, so `round`'s
 * input checks are what refuse a malformed discovery.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <Tag extends string, It extends Item, W, E = never, R = never, L = unknown>(
  action: Dispatch<Tag>,
  options: RoundOptions<unknown, It, W, E, R, L>
) =>
  action.toLayer((payload) =>
    round(
      {
        input: payload.input,
        round: payload.round,
        items: payload.items as ReadonlyArray<It>,
        settled: payload.settled,
        rows: payload.rows,
        slots: payload.slots
      },
      options
    )
  )

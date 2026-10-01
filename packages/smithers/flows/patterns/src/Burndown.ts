/**
 * Burndown pattern: work a backlog down to nothing. Each round re-discovers the
 * backlog, selects the items that are ours, claims them, works each one as a
 * durable child, lands the results through a merge queue, and releases every
 * claim, at a concurrency and a capacity the burndown owns.
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
import * as Flow from "@smthrs/flow/Flow"
import * as Sleep from "@smthrs/flow/Sleep"
import * as WaitFor from "@smthrs/flow/WaitFor"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member as Callable } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import * as MergeQueue from "./MergeQueue.ts"
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
 * the item is not ours this round.
 *
 * @category models
 * @since 1.0.0
 */
export const Status = Schema.Literals(["landed", "held", "failed", "skipped"])

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
export const Row = Schema.Struct({ id: Schema.String, status: Status, detail: Schema.String })

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
 * `drained`: a round launched no item, so nothing ours is left. `max_rounds`:
 * the round budget ran out first.
 *
 * @category models
 * @since 1.0.0
 */
export const Stopped = Schema.Literals(["drained", "max_rounds"])

/**
 * What the declared burndown settles to.
 *
 * `rows` holds one row per item the lineage touched, in first-seen order. A
 * settled row (`landed`, `held`, `failed`) is final; a `skipped` row is the
 * latest round's selection. `rounds` counts the rounds the lineage opened,
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
 * counts the items that were ours but did not fit the capacity's slots; the
 * next round rediscovers them.
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
 * Only the exact `Ours` value launches an item. Anything else, including a
 * malformed answer, skips it, so a selection member cannot launch work by
 * returning something unexpected.
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
  typeof PatternError
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
    error: PatternError,
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
export type BurndownFlow = Flow.Flow<string, typeof Payload, typeof Result, typeof Schema.Unknown, any>

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
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly discover: Callable<any>
  readonly dispatch: Callable<any>
  readonly capacity?: Callable<any> | undefined
  readonly maxRounds: number
  readonly deadline?: Duration.Input | undefined
  readonly signal?: string | undefined
}

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const decodeCapacity = Schema.decodeUnknownSync(Capacity)
const decodeRound = Schema.decodeUnknownSync(RoundResult)

interface Folded {
  readonly continue: boolean
  readonly rows: ReadonlyArray<Row>
  readonly result: Result
}

/**
 * Merges one round's rows into the rows the lineage carried. A settled row is
 * final; a skipped row is replaced by the item's latest row.
 */
const merge = (carried: ReadonlyArray<Row>, fresh: ReadonlyArray<Row>): ReadonlyArray<Row> => {
  const rows = new Map<string, Row>(carried.map((row) => [row.id, row]))
  for (const row of fresh) {
    const previous = rows.get(row.id)
    if (previous === undefined || previous.status === "skipped") rows.set(row.id, row)
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
 * that launched nothing settles the lineage as `drained`. The round budget
 * settles it as `max_rounds`.
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
export const make = (options: MakeOptions): BurndownFlow => {
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
    const settled = rows.filter((row) => row.status !== "skipped").map((row) => row.id)
    const fold = (value: unknown): Folded => {
      const result = decodeRound(value)
      const merged = merge(rows, result.rows)
      const launched = result.launched > 0
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
  const self: BurndownFlow = Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: Payload,
    success: Result,
    error: Schema.Unknown,
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
 * items launch this round.
 *
 * @category models
 * @since 1.0.0
 */
export interface RoundInput<I, It extends Item> {
  readonly input: I
  readonly round: number
  readonly items: ReadonlyArray<It>
  readonly settled?: ReadonlyArray<string> | undefined
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
 * {@link Held}. `land`, when present, runs through a `MergeQueue` at
 * concurrency 1 under the `quarantine` policy, so landings are serialized and
 * one failed landing does not stop the next; without it a worked item counts
 * as landed. `release` runs once for every item whose claim succeeded,
 * whatever happened after, with the item's final status. `detail` renders a
 * landed item's detail from its work output.
 *
 * @category models
 * @since 1.0.0
 */
export interface RoundOptions<I, It extends Item, W, E, R> {
  readonly key: string
  readonly concurrency: number
  readonly select?: ((args: ItemArgs<I, It>) => Effect.Effect<Selection, E, R>) | undefined
  readonly claim: (args: ItemArgs<I, It>) => Effect.Effect<unknown, E | Held, R>
  readonly work: (args: ItemArgs<I, It> & { readonly executionId: string }) => Effect.Effect<W, E, R>
  readonly land?: ((args: ItemArgs<I, It> & { readonly output: W }) => Effect.Effect<unknown, E, R>) | undefined
  readonly release: (args: ItemArgs<I, It> & { readonly status: Status }) => Effect.Effect<unknown, E, R>
  readonly detail?: ((output: W) => string) | undefined
}

/**
 * The human-readable text of a typed failure: its own `message` when it has
 * one, otherwise its string form.
 */
const detailOf = (error: unknown): string =>
  typeof error === "object" && error !== null && typeof (error as { readonly message?: unknown }).message === "string"
    ? (error as { readonly message: string }).message
    : String(error)

const ownTag = (value: unknown, tag: string): boolean =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "_tag") &&
  (value as { readonly _tag: unknown })._tag === tag

const selectionOf = (value: unknown): Selection => {
  if (ownTag(value, "Ours")) return ours
  const detail = ownTag(value, "Skip") && typeof (value as { readonly detail?: unknown }).detail === "string"
    ? (value as { readonly detail: string }).detail
    : "selection did not answer ours"
  return skip(detail)
}

const refusal = (message: string): PatternError => new PatternError({ code: "invalid_input", message })

const roundRefusal = (
  input: { readonly round: unknown; readonly items: unknown; readonly settled?: unknown; readonly slots?: unknown },
  key: unknown,
  concurrency: number
): PatternError | undefined => {
  if (typeof key !== "string" || key.trim().length === 0) {
    return new PatternError({ code: "invalid_decorator", message: "Burndown key must be a nonblank string" })
  }
  const width = Compose.concurrencyRefusal("Burndown", concurrency)
  if (width !== undefined) return width
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

/**
 * Runs one round of a burndown.
 *
 * Items whose id is in `settled` are left alone. `select` runs for the rest at
 * `concurrency`; a skipped item, or one whose selection failed, gets a
 * `skipped` row and is reconsidered next round. Of the items that are ours,
 * the first `slots` launch, in discovery order, and the remainder count as
 * `deferred`.
 *
 * Each launched item is claimed, then worked, at most `concurrency` at a time.
 * A claim that fails with {@link Held} settles the item `held`; any other
 * claim, work, or landing failure settles it `failed` with the failure's
 * message. A failure is recorded on its own row and never cancels the items
 * beside it. Worked items then land, one at a time, through
 * `MergeQueue.run` with the `quarantine` policy. Finally every item whose
 * claim succeeded is released with its final status; a release failure is
 * appended to the row's detail and does not change its status.
 *
 * Members report failures on the typed channel. A member that throws raises a
 * defect, which fails the round; the claims already taken are still released,
 * each with status `failed`.
 *
 * `round` fails with a `PatternError` before any member runs when `key` is
 * blank, `concurrency` or `slots` is not a positive safe integer, `round` is
 * not a non-negative safe integer, or an item lacks a nonblank string id or
 * repeats one. It snapshots `items`, each item's `id`, and every option at the
 * call; the item records themselves stay the caller's.
 *
 * @category combinators
 * @since 1.0.0
 */
export const round = <I, It extends Item, W, E = never, R = never>(
  input: RoundInput<I, It>,
  options: RoundOptions<I, It, W, E, R>
): Effect.Effect<RoundResult, PatternError, R> => {
  const key = options.key
  const concurrency = options.concurrency
  const select = options.select
  const claim = options.claim
  const work = options.work
  const land = options.land
  const release = options.release
  const detail = options.detail
  const invalid = roundRefusal(input, key, concurrency)
  if (invalid !== undefined) return Effect.fail(invalid)
  const value = input.input
  const index = input.round
  const slots = input.slots
  const settled = new Set(input.settled ?? [])
  const cards: ReadonlyArray<Card<It>> = input.items.map((item) => ({ id: item.id, item }))
  const args = (card: Card<It>): ItemArgs<I, It> => ({ input: value, item: card.item, round: index })
  return Effect.gen(function*() {
    const fresh = cards.filter((card) => !settled.has(card.id))
    const selections = yield* Effect.forEach(
      fresh,
      (card) =>
        (select === undefined ? Effect.succeed(ours) : select(args(card))).pipe(
          Effect.map(selectionOf),
          Effect.catch((error: E) => Effect.succeed(skip(`select failed: ${detailOf(error)}`))),
          Effect.map((selection) => ({ card, selection }))
        ),
      { concurrency }
    )
    const rows = new Map<string, Row>()
    const mine: Array<Card<It>> = []
    for (const { card, selection } of selections) {
      if (selection._tag === "Ours") mine.push(card)
      else rows.set(card.id, { id: card.id, status: "skipped", detail: selection.detail })
    }
    const launch = mine.slice(0, slots ?? mine.length)
    const claimed: Array<Card<It>> = []
    const attempt = (card: Card<It>): Effect.Effect<Attempt<W>, never, R> =>
      claim(args(card)).pipe(
        Effect.matchEffect({
          onFailure: (error: E | Held) =>
            Effect.succeed<Attempt<W>>(
              ownTag(error, "flows/patterns/Burndown/Held")
                ? { _tag: "Settled", status: "held", detail: detailOf(error) }
                : { _tag: "Settled", status: "failed", detail: `claim: ${detailOf(error)}` }
            ),
          onSuccess: () => {
            claimed.push(card)
            return work({ ...args(card), executionId: `${key}/${card.id}` }).pipe(
              Effect.match({
                onSuccess: (output): Attempt<W> => ({ _tag: "Worked", output }),
                onFailure: (error: E): Attempt<W> => ({
                  _tag: "Settled",
                  status: "failed",
                  detail: `work: ${detailOf(error)}`
                })
              })
            )
          }
        })
      )
    const releaseAll = (statusOf: (card: Card<It>) => Status) =>
      Effect.forEach(
        claimed,
        (card) =>
          release({ ...args(card), status: statusOf(card) }).pipe(
            Effect.match({
              onSuccess: () => undefined,
              onFailure: (error: E) => `release: ${detailOf(error)}`
            }),
            Effect.map((failure) => ({ id: card.id, failure }))
          ),
        { concurrency }
      )
    const settle = Effect.gen(function*() {
      const attempts = yield* Effect.forEach(launch, attempt, { concurrency })
      const worked = launch.flatMap((card, position) => {
        const outcome = attempts[position]!
        if (outcome._tag === "Settled") {
          rows.set(card.id, { id: card.id, status: outcome.status, detail: outcome.detail })
          return []
        }
        return [{ card, output: outcome.output }]
      })
      const rendered = (output: W): string => detail === undefined ? "" : detail(output)
      if (land === undefined || worked.length === 0) {
        for (const { card, output } of worked) {
          rows.set(card.id, { id: card.id, status: "landed", detail: rendered(output) })
        }
        return
      }
      const queue = yield* Effect.orDie(MergeQueue.run(undefined, {
        members: worked.map(({ card, output }) => ({
          id: card.id,
          run: () => land({ ...args(card), output })
        })),
        failurePolicy: "quarantine"
      }))
      const quarantined = new Map(queue.quarantined.map((entry) => [entry.id, entry.error]))
      for (const { card, output } of worked) {
        rows.set(
          card.id,
          quarantined.has(card.id)
            ? { id: card.id, status: "failed", detail: `land: ${detailOf(quarantined.get(card.id))}` }
            : { id: card.id, status: "landed", detail: rendered(output) }
        )
      }
    })
    yield* Effect.onExit(settle, (exit) => Exit.isSuccess(exit) ? Effect.void : releaseAll(() => "failed"))
    const releases = yield* releaseAll((card) => rows.get(card.id)!.status)
    for (const { failure, id } of releases) {
      if (failure === undefined) continue
      const row = rows.get(id)!
      rows.set(id, { ...row, detail: row.detail.length === 0 ? failure : `${row.detail}; ${failure}` })
    }
    return {
      rows: cards.flatMap((card) => {
        const row = rows.get(card.id)
        return row === undefined ? [] : [row]
      }),
      launched: launch.length,
      deferred: mine.length - launch.length
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
export const layer = <Tag extends string, It extends Item, W, E = never, R = never>(
  action: Dispatch<Tag>,
  options: RoundOptions<unknown, It, W, E, R>
) =>
  action.toLayer((payload) =>
    round(
      {
        input: payload.input,
        round: payload.round,
        items: payload.items as ReadonlyArray<It>,
        settled: payload.settled,
        slots: payload.slots
      },
      options
    )
  )

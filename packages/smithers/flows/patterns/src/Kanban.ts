/**
 * Kanban pattern: move every item through an ordered list of columns, with a
 * concurrency bound applied inside each column.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"
import * as Quarantine from "./Quarantine.ts"

/**
 * One card on the board.
 *
 * `id` is the identity a column call, a board row, and a failure entry all use,
 * so it must be unique across the declared items.
 *
 * @category models
 * @since 0.1.0
 */
export interface Item {
  readonly id: string
}

/**
 * One declared column.
 *
 * @category models
 * @since 0.1.0
 */
export interface Column<R = never> {
  readonly name: string
  readonly flow: Member<R>
}

/**
 * The declared form of a board.
 *
 * @category models
 * @since 0.1.0
 */
export type KanbanFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Configuration for {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly columns: ReadonlyArray<Column<R>>
  readonly items: ReadonlyArray<Item>
  readonly concurrency: number
  readonly onComplete?: Member<R> | undefined
}

/**
 * One column at runtime.
 *
 * `previous` is the value the same item produced in the preceding column, and
 * is `undefined` in the first column.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeColumn<It extends Item, Out, E, R> {
  readonly name: string
  readonly run: (args: {
    readonly item: It
    readonly column: string
    readonly previous: Out | undefined
  }) => Effect.Effect<Out, E, R>
}

/**
 * One item that a column rejected.
 *
 * @category models
 * @since 0.1.0
 */
export interface Failure<E> {
  readonly id: string
  readonly column: string
  readonly error: E
}

/**
 * The state of the board after a pass.
 *
 * `board` holds one row per item that cleared at least one column, keyed by
 * item id then column name. `completed` lists the items that cleared every
 * column, in declaration order. `failed` lists the column that rejected an item
 * and the error it raised.
 *
 * @category models
 * @since 0.1.0
 */
export interface Board<Out, E> {
  readonly board: Record<string, Record<string, Out>>
  readonly completed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<Failure<E>>
  readonly iterations: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * `maxIterations` is the number of passes the board runs, and defaults to one.
 * `until` stops it early, after the pass whose result satisfies the predicate,
 * and requires `maxIterations`, because a predicate that never holds would
 * otherwise run forever.
 * `run` snapshots `items`, `columns`, and every option at the call and reads
 * each item's `id` once there, so a later edit to the arrays or the option
 * object does not alter that run. The item record itself is handed to the
 * column as the caller's own object. See
 * https://smithers.sh/docs/reference/api/patterns#identity-and-ownership.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<It extends Item, Out, E, R, E2 = never, R2 = never> {
  readonly columns: ReadonlyArray<RuntimeColumn<It, Out, E, R>>
  readonly concurrency: number
  /**
   * Runs once after the final pass with the original items and final board.
   * A failure from this callback is the run's failure.
   */
  readonly onComplete?:
    | ((args: {
      readonly items: ReadonlyArray<It>
      readonly board: Board<Out, E>
    }) => Effect.Effect<unknown, E2, R2>)
    | undefined
  readonly until?: ((board: Board<Out, E>) => boolean) | undefined
  readonly maxIterations?: number | undefined
}

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

const completionBoard = (
  outcomes: ReadonlyArray<unknown>,
  ids: ReadonlyArray<string>,
  names: ReadonlyArray<string>
): Board<unknown, unknown> => {
  const board = new Map<string, Record<string, unknown>>()
  const failed: Array<Failure<unknown>> = []
  const rejected = new Set<string>()
  for (const [index, values] of outcomes.entries()) {
    const column = names[index]!
    for (const id of ids) {
      // Later calls remain in the declaration, but a failed card cannot
      // become completed just because one of those calls accepted its marker.
      if (rejected.has(id)) continue
      const outcome = (values as Record<string, Quarantine.Settled<unknown, unknown>>)[id]!
      if (outcome._tag === "Succeeded") {
        board.set(id, { ...board.get(id), [column]: outcome.value })
      } else {
        rejected.add(id)
        failed.push({ id, column, error: outcome.error })
      }
    }
  }
  return {
    board: Object.fromEntries(board),
    completed: ids.filter((id) => !rejected.has(id)),
    failed,
    iterations: 1
  }
}

/**
 * Builds the board topology: for each column in order, one call per item,
 * batched into `Node.all` groups of `concurrency` members, with the batches
 * sequenced so the plan never admits more parallel calls than the bound.
 *
 * Each call receives `{ column, item, previous }`. `previous` refers to the
 * same item's result in the preceding column, so a built graph shows the
 * per-item chain across columns rather than a column-wide barrier of values.
 * The flow settles to the {@link Board} of its one pass, the record {@link run}
 * returns with `iterations: 1`. `onComplete` receives `{ items, board }` and
 * its own answer is discarded, as in `run`.
 * The columns themselves are sequenced: a column's first call depends on the
 * whole preceding column.
 *
 * `make` throws a `PatternError` when there are no columns, no items, a
 * duplicate item id, duplicate column name, or a concurrency that is not a
 * positive safe integer.
 *
 * `make` snapshots `columns`, `items`, and every option at the call, copying
 * each item record, so a later edit to the caller's arrays or records does
 * not change the declaration.
 *
 * A column joins its batch with {@link Quarantine.all} under the `quarantine`
 * policy, because one rejected card is not a reason to interrupt the cards
 * beside it, which is the same call {@link run} makes. A rejected card
 * settles as a {@link Quarantine.Quarantined} marker naming the item.
 *
 * A later column's call for a card is the live arm of a `Node.branch` on the
 * real set of rejected cards, so a card an earlier column rejected makes no
 * further call, exactly as in `run`. The declared call count is therefore an
 * upper bound on a pass, and the calls an executed declaration makes are the
 * calls `run` makes.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): KanbanFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. An item record is
  // copied because it enters key material as a literal.
  const columns: ReadonlyArray<Column<R>> = options.columns.map((column) => ({
    name: column.name,
    flow: column.flow
  }))
  const items: ReadonlyArray<Item> = options.items.map((item) => ({ ...item }))
  const concurrency = options.concurrency
  const onComplete = options.onComplete
  if (columns.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one column" })
  }
  if (items.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one item" })
  }
  if (!bound(concurrency)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Kanban concurrency must be a positive safe integer"
    })
  }
  const ids = items.map((item) => item.id)
  if (new Set(ids).size !== ids.length) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban item ids must be unique" })
  }
  const names = columns.map((column) => column.name)
  if (new Set(names).size !== names.length) {
    throw new PatternError({ code: "invalid_decorator", message: "Kanban column names must be unique" })
  }
  const captures = { columns: names, items: ids, concurrency }
  // What one column hands the next: each live card's latest output, and every
  // card a column has rejected so far.
  const advance = (values: unknown, rejected: ReadonlyArray<string>): Carried => {
    const outcomes = values as Readonly<Record<string, Quarantine.Settled<unknown, unknown>>>
    // Entries, not assignment: an item id such as `__proto__` is an own key.
    const previous: Array<readonly [string, unknown]> = []
    const still: Array<string> = [...rejected]
    for (const id of ids) {
      if (rejected.includes(id)) continue
      const outcome = outcomes[id]!
      if (outcome._tag === "Succeeded") previous.push([id, outcome.value])
      else still.push(id)
    }
    return { previous: Object.fromEntries(previous), rejected: still }
  }
  const column = (index: number, carried: Planned.Planned<Carried> | undefined): Node.Node<unknown, unknown, R> => {
    const declared = columns[index]!
    const call = (item: Item, previous: unknown): Node.Node<unknown, unknown, R> =>
      callMember(declared.flow, { column: declared.name, item, previous })
    // A card an earlier column rejected makes no call here, as in `run`: the
    // call is the live arm of a branch on the real rejected set. The skipped
    // arm's value is never read, because the board fold drops a rejected card
    // from every later column.
    const card = (item: Item): Node.Node<unknown, unknown, R> =>
      carried === undefined ? call(item, undefined) : Node.branch(Node.succeed(carried.rejected), {
        if: Node.capture(
          { column: declared.name, item: item.id },
          (rejected: ReadonlyArray<string>) => !rejected.includes(item.id)
        ),
        then: () => call(item, (carried.previous as Readonly<Record<string, unknown>>)[item.id]),
        else: () => Node.succeed(null)
      })
    const batchAt = (offset: number): Node.Node<unknown, unknown, R> => {
      const members = Object.fromEntries(
        items.slice(offset, offset + concurrency).map((item) => [item.id, card(item)])
      ) as Record<string, Node.Any>
      return Quarantine.all(members, { policy: "quarantine" })
    }
    const visit = (
      offset: number,
      gathered: Readonly<Record<string, Planned.Planned<unknown>>>
    ): Node.Node<unknown, unknown, R> => {
      if (offset >= items.length) return Node.succeed(gathered)
      const batched = ids.slice(offset, offset + concurrency)
      return Node.bindPlanned(
        batchAt(offset),
        Node.capture({ column: declared.name, offset, batched }, (reference) =>
          Node.andThen(
            Node.succeed(reference),
            visit(offset + concurrency, {
              ...gathered,
              ...Object.fromEntries(
                batched.map((id) => [id, (reference as Readonly<Record<string, Planned.Planned<unknown>>>)[id]!])
              )
            })
          ))
      )
    }
    return visit(0, {})
  }
  const { name, description } = Compose.label("kanban", { columns: names, items: ids.length, concurrency }, options)
  const body = (): Node.Node<unknown, unknown, R> => {
    const walk = (
      index: number,
      carried: Planned.Planned<Carried> | undefined,
      history: ReadonlyArray<unknown>
    ): Node.Node<unknown, unknown, R> =>
      Node.bindPlanned(
        column(index, carried),
        Node.capture({ ...captures, column: names[index] }, (values) => {
          const outcomes = [...history, values]
          if (index + 1 < columns.length) {
            const next = Node.map(
              Node.succeed({ values, rejected: carried === undefined ? [] : carried.rejected }),
              Node.capture(captures, (state: { readonly values: unknown; readonly rejected: ReadonlyArray<string> }) =>
                advance(state.values, state.rejected))
            )
            return Node.bindPlanned(
              next,
              Node.capture(
                { ...captures, column: names[index + 1] },
                (state: Planned.Planned<Carried>) =>
                  walk(index + 1, state, outcomes)
              )
            )
          }
          // The board is the same {@link Board} `run` returns for one pass.
          // `onComplete` sees it and its own answer is discarded, as in `run`.
          const board = Node.map(
            Node.succeed(outcomes),
            Node.capture(captures, (settled) =>
              completionBoard(settled as ReadonlyArray<unknown>, ids, names))
          )
          if (onComplete === undefined) return board
          return Node.bindPlanned(
            board,
            Node.capture(captures, (settled) =>
              Node.andThen(callMember(onComplete, { items, board: settled }), Node.succeed(settled)))
          )
        })
      )
    return walk(0, undefined, [])
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

// A card pairs the id `run` read at the call with the caller's own item
// record, so the board is keyed by a name that cannot move under it while the
// column still receives the object the caller handed over.
interface Carried {
  readonly previous: Readonly<Record<string, unknown>>
  readonly rejected: ReadonlyArray<string>
}

interface Card<It> {
  readonly id: string
  readonly item: It
}

const pass = <It extends Item, Out, E, R>(
  cards: ReadonlyArray<Card<It>>,
  columns: ReadonlyArray<RuntimeColumn<It, Out, E, R>>,
  concurrency: number
): Effect.Effect<Omit<Board<Out, E>, "iterations">, never, R> =>
  Effect.gen(function*() {
    const board = new Map<string, Map<string, Out>>()
    const failed: Array<Failure<E>> = []
    const latest = new Map<string, Out>()
    let active: ReadonlyArray<Card<It>> = cards
    for (const column of columns) {
      const outcomes = yield* Effect.forEach(
        active,
        (card) =>
          column.run({ item: card.item, column: column.name, previous: latest.get(card.id) }).pipe(
            Effect.map((output) => ({ ok: true, card, output } as const)),
            Effect.catch((error: E) => Effect.succeed({ ok: false, card, error } as const))
          ),
        { concurrency }
      )
      const next: Array<Card<It>> = []
      for (const outcome of outcomes) {
        if (outcome.ok) {
          const row = board.get(outcome.card.id) ?? new Map<string, Out>()
          row.set(column.name, outcome.output)
          board.set(outcome.card.id, row)
          latest.set(outcome.card.id, outcome.output)
          next.push(outcome.card)
        } else {
          failed.push({ id: outcome.card.id, column: column.name, error: outcome.error })
        }
      }
      active = next
    }
    return {
      board: Object.fromEntries(
        Array.from(board, ([id, columns]) => [id, Object.fromEntries(columns)])
      ),
      completed: active.map((card) => card.id),
      failed
    }
  })

/**
 * Moves every item through the columns in order.
 *
 * A column runs its items with `Effect.forEach` at `concurrency`, so at most
 * `concurrency` items are in flight in that column, and a column starts only
 * after the preceding column has settled for every item. An item a column
 * rejects is dropped from the board and listed in `failed`; the other items
 * keep moving. A column rejects an item by failing on the typed channel: a
 * card that throws raises a defect, which fails the pass and cancels the
 * cards beside it.
 *
 * The board runs `maxIterations` passes over the same items, one when the
 * option is absent. The old `<Kanban>` component defaulted that bound to five,
 * so a port that relied on the default must pass `maxIterations: 5`. `until`
 * stops the board early after the pass whose result satisfies the predicate. Each pass starts from an empty board, and the
 * returned board is the last pass's.
 *
 * `run` fails with a `PatternError` when two items share an id: the board is
 * keyed by item id, so a repeated id would run the same id twice and report
 * one row for both.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <It extends Item, Out, E = never, R = never, E2 = never, R2 = never>(
  items: ReadonlyArray<It>,
  options: RuntimeOptions<It, Out, E, R, E2, R2>
): Effect.Effect<Board<Out, E>, PatternError | E2, R | R2> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the arrays or the option object in between must not reach it.
  // Each item's id is read once here; the record itself stays the caller's.
  const columns = options.columns.map((column) => ({ name: column.name, run: column.run }))
  const cards = items.map((item): Card<It> => ({ id: item.id, item }))
  const snapshot: ReadonlyArray<It> = cards.map((card) => card.item)
  const concurrency = options.concurrency
  const until = options.until
  const onComplete = options.onComplete
  const maxIterations = options.maxIterations
  if (columns.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one column" }))
  }
  if (cards.length === 0) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban requires at least one item" }))
  }
  if (!bound(concurrency)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban concurrency must be a positive safe integer"
      })
    )
  }
  const ids = cards.map((card) => card.id)
  if (new Set(ids).size !== ids.length) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban item ids must be unique" }))
  }
  const names = columns.map((column) => column.name)
  if (new Set(names).size !== names.length) {
    return Effect.fail(new PatternError({ code: "invalid_decorator", message: "Kanban column names must be unique" }))
  }
  if (until !== undefined && maxIterations === undefined) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban until requires maxIterations"
      })
    )
  }
  if (maxIterations !== undefined && !bound(maxIterations)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Kanban maxIterations must be a positive safe integer"
      })
    )
  }
  const limit = maxIterations ?? 1
  return Effect.gen(function*() {
    let iterations = 0
    for (;;) {
      const settled = yield* pass(cards, columns, concurrency)
      iterations += 1
      const result: Board<Out, E> = { ...settled, iterations }
      const done = until !== undefined && until(result)
      if (done || iterations >= limit) {
        if (onComplete !== undefined) yield* onComplete({ items: snapshot, board: result })
        return result
      }
    }
  })
}

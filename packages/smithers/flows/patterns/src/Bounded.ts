/**
 * Bounded fan-out: a fixed set of members run at most `concurrency` at a time,
 * highest priority first.
 *
 * `Node.all` joins members without a width bound, which is the right default
 * for a handful of independent calls and the wrong one for fifty. {@link all}
 * keeps the same named-record shape and adds the bound as static topology: one
 * `Node.all` per batch, batches sequenced. {@link run} is the Effect form of
 * the same contract.
 *
 * @see https://smithers.sh/docs/concepts/ownership
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * Configuration for {@link all}.
 *
 * `priority` is the container's default: a member that carries its own
 * `Node.priority` keeps it, and every other member inherits this one.
 *
 * @category models
 * @since 0.1.0
 */
export interface AllOptions {
  readonly concurrency: number
  readonly priority?: number | undefined
}

/**
 * Configuration for {@link run}.
 *
 * `priorities` holds per-member priorities by name; `priority` is the default
 * for every member that names none.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions {
  readonly concurrency: number
  readonly priority?: number | undefined
  readonly priorities?: Readonly<Record<string, number>> | undefined
}

interface Ranked<Member> {
  readonly name: string
  readonly member: Member
  readonly rank: number
  readonly index: number
}

// Every refusal is minted once, as a value. `all` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
const widthRefusal = (concurrency: number): PatternError | undefined =>
  Compose.concurrencyRefusal("Bounded", concurrency)

const nonEmptyRefusal = (names: ReadonlyArray<string>): PatternError | undefined =>
  Compose.nonEmptyMembersRefusal("Bounded", names)

const width = (concurrency: number): void => {
  const refusal = widthRefusal(concurrency)
  if (refusal !== undefined) throw refusal
}

const nonEmpty = (names: ReadonlyArray<string>): void => {
  const refusal = nonEmptyRefusal(names)
  if (refusal !== undefined) throw refusal
}

const declaredPriority = (node: Node.Any): number | undefined => Node.declaredPriority(node.ast)

// Descending priority, declaration order among equals, so a plan built twice
// from the same record is identical.
const ranked = <Member>(
  members: Readonly<Record<string, Member>>,
  rank: (name: string, member: Member) => number
): ReadonlyArray<Ranked<Member>> =>
  Object.entries(members)
    .map(([name, member], index) => ({ name, member, rank: rank(name, member), index }))
    .sort((left, right) => right.rank - left.rank || left.index - right.index)

/**
 * Joins a record of members with a static width bound.
 *
 * Members are split into batches of `concurrency` in priority order and the
 * batches are sequenced, so the plan shows exactly how many calls can be in
 * flight. The result is one record carrying every member's value under its
 * declared name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const all = (
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions
): Node.Node<Readonly<Record<string, unknown>>, unknown, any> => {
  width(options.concurrency)
  const names = Object.keys(members)
  nonEmpty(names)
  const priorities = new Map<string, number>()
  for (const name of names) {
    const value = declaredPriority(members[name]!) ?? options.priority ?? 0
    const refusal = Compose.safeIntegerPriorityRefusal("Bounded", name, value)
    if (refusal !== undefined) throw refusal
    priorities.set(name, value)
  }
  const order = ranked(members, (name) => priorities.get(name)!)
  const batches: Array<Record<string, Node.Any>> = []
  for (let offset = 0; offset < order.length; offset += options.concurrency) {
    batches.push(
      Object.fromEntries(
        order.slice(offset, offset + options.concurrency).map((entry) => [
          entry.name,
          options.priority === undefined || declaredPriority(entry.member) !== undefined
            ? entry.member
            : Node.priority(entry.member, options.priority)
        ])
      ) as Record<string, Node.Any>
    )
  }
  // Each batch gates the next one, so the plan carries the width bound as
  // dependency edges rather than as a note a scheduler has to honour, and the
  // joined record is every member's planned reference under its declared name.
  // A planned result may be read by field and passed on, never computed on, so
  // the record is assembled from references instead of spread from values.
  const visit = (
    batch: number,
    carried: Readonly<Record<string, Planned.Planned<unknown>>>
  ): Node.Node<Readonly<Record<string, unknown>>, unknown, any> => {
    const members = batches[batch]
    if (members === undefined) return Node.succeed(carried)
    return Node.bindPlanned(
      Node.all(members),
      Node.capture({ batch, members: Object.keys(members) }, (reference) =>
        Node.andThen(
          Node.succeed(reference),
          visit(batch + 1, {
            ...carried,
            ...Object.fromEntries(
              Object.keys(members).map((name) => [
                name,
                (reference as Readonly<Record<string, Planned.Planned<unknown>>>)[name]!
              ])
            )
          })
        ))
    )
  }
  return visit(0, {})
}

/**
 * Runs a record of effects at most `concurrency` at a time, starting the
 * highest priority member first.
 *
 * Failure and interruption follow `Effect.forEach`: the first failure
 * interrupts the members still in flight. Use `Quarantine.run` when siblings
 * must finish instead.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <A, E, R>(
  members: Readonly<Record<string, Effect.Effect<A, E, R>>>,
  options: RuntimeOptions
): Effect.Effect<Readonly<Record<string, A>>, E | PatternError, R> => {
  // Snapshots taken at the call, ahead of the suspend: the effect may run
  // later, and a caller's edit to the record or the option object in between
  // must not reach it. Own entries only, so a prototype-shaped member name
  // stays a data property.
  const declared: Readonly<Record<string, Effect.Effect<A, E, R>>> = Object.fromEntries(Object.entries(members))
  const concurrency = options.concurrency
  const priority = options.priority
  const priorities = options.priorities === undefined
    ? undefined
    : Object.fromEntries(Object.entries(options.priorities))
  return Effect.suspend((): Effect.Effect<Readonly<Record<string, A>>, E | PatternError, R> => {
    const refusal = widthRefusal(concurrency) ?? nonEmptyRefusal(Object.keys(declared))
    if (refusal !== undefined) return Effect.fail(refusal)
    for (const name of Object.keys(priorities ?? {})) {
      if (!Object.hasOwn(declared, name)) {
        return Effect.fail(
          new PatternError({
            code: "invalid_decorator",
            message: `Bounded declares a priority for the unknown member "${name}"`
          })
        )
      }
    }
    const ranks = new Map<string, number>()
    for (const name of Object.keys(declared)) {
      const value: unknown = priorities !== undefined && Object.hasOwn(priorities, name)
        ? priorities[name]
        : priority ?? 0
      const invalid = Compose.safeIntegerPriorityRefusal("Bounded", name, value)
      if (invalid !== undefined) return Effect.fail(invalid)
      ranks.set(name, value as number)
    }
    const order = ranked(declared, (name) => ranks.get(name)!)
    return Effect.map(
      Effect.forEach(
        order,
        (entry) => Effect.map(entry.member, (value) => [entry.name, value] as const),
        { concurrency }
      ),
      (pairs) => Object.fromEntries(pairs) as Readonly<Record<string, A>>
    )
  })
}

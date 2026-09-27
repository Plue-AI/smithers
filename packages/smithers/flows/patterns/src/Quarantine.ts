/**
 * Continue-on-failure fan-out.
 *
 * `Node.all` and `Effect.all` fail the join on the first member failure and
 * interrupt the rest, which is right when the members are one unit of work and
 * wrong when they are independent errands. {@link all} isolates a failing
 * member instead: its siblings run to completion and the join returns a record
 * of explicit {@link Succeeded} and {@link Quarantined} outcomes.
 *
 * @see https://smithers.sh/docs/concepts/ownership
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Compose from "./internal/Compose.ts"
import { PatternError } from "./PatternError.ts"

/**
 * What a failing member does to its siblings.
 *
 * `quarantine` isolates it. `halt` is the ordinary join: the first failure
 * interrupts every sibling still running.
 *
 * @category models
 * @since 0.1.0
 */
export type Policy = "quarantine" | "halt"

/**
 * A member that failed and was isolated from its siblings.
 *
 * This is one arm of the structural wire envelope used for durable replay.
 * Successful member values are always nested in {@link Succeeded}, so user
 * values can never collide with this protocol tag.
 *
 * @category models
 * @since 0.1.0
 */
export interface Quarantined<E> {
  readonly _tag: "Quarantined"
  readonly member: string
  readonly error: E
}

/**
 * A member that completed successfully.
 *
 * The value is nested so a legitimate user value can have any shape,
 * including the complete `Quarantined` wire shape, without being mistaken for
 * protocol metadata.
 *
 * @category models
 * @since 1.0.0
 */
export interface Succeeded<A> {
  readonly _tag: "Succeeded"
  readonly member: string
  readonly value: A
}

/**
 * One unambiguous member outcome under the quarantine policy.
 *
 * @category models
 * @since 1.0.0
 */
export type Settled<A, E> = Succeeded<A> | Quarantined<E>

/**
 * Configuration for {@link all}.
 *
 * @category models
 * @since 0.1.0
 */
export interface AllOptions {
  readonly policy: Policy
}

/**
 * Configuration for {@link run}.
 *
 * `concurrency` bounds how many members run at once and defaults to
 * unbounded.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions {
  readonly policy: Policy
  readonly concurrency?: number | "unbounded" | undefined
}

/**
 * Tests whether a joined member was quarantined.
 *
 * The check reads the complete structural wire envelope without invoking
 * accessors. Successful user values are nested in {@link Succeeded}, so their
 * own shape is never interpreted as protocol metadata.
 *
 * @category refinements
 * @since 0.1.0
 */
export const isQuarantined = (value: unknown): value is Quarantined<unknown> => outcome(value, "Quarantined", "error")

/**
 * Tests whether a joined member completed successfully.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isSucceeded = (value: unknown): value is Succeeded<unknown> => outcome(value, "Succeeded", "value")

const data = (value: object, key: string): PropertyDescriptor | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor : undefined
  } catch {
    return undefined
  }
}

const outcome = (value: unknown, tag: "Succeeded" | "Quarantined", payload: "value" | "error"): boolean => {
  if (typeof value !== "object" || value === null) return false
  let keys: ReadonlyArray<string>
  try {
    keys = Object.keys(value)
  } catch {
    return false
  }
  if (keys.length !== 3 || !keys.includes("_tag") || !keys.includes("member") || !keys.includes(payload)) return false
  return data(value, "_tag")?.value === tag && typeof data(value, "member")?.value === "string" &&
    data(value, payload) !== undefined
}

const succeeded = <A>(member: string, value: A): Succeeded<A> => Object.freeze({ _tag: "Succeeded", member, value })

const quarantined = <E>(member: string, error: E): Quarantined<E> =>
  Object.freeze({ _tag: "Quarantined", member, error })

// Every refusal is minted once, as a value. `all` throws it, because a
// declaration is built eagerly and a broken one is a programming error. `run`
// FAILS with it, because `PatternError` is in its declared error channel and a
// caller composing it must be able to claim the refusal with `Effect.catchTag`.
// A thrown refusal inside `Effect.suspend` would be a defect no handler claims.
const nonEmptyRefusal = (names: ReadonlyArray<string>): PatternError | undefined =>
  Compose.nonEmptyMembersRefusal("Quarantine", names)

// `"unbounded"` is the declared way to ask for no bound, so only a numeric one
// is checked.
const widthRefusal = (concurrency: number | "unbounded"): PatternError | undefined =>
  concurrency === "unbounded" ? undefined : Compose.concurrencyRefusal("Quarantine", concurrency)

const nonEmpty = (names: ReadonlyArray<string>): void => {
  const refusal = nonEmptyRefusal(names)
  if (refusal !== undefined) throw refusal
}

/**
 * Joins a record of members under the declared failure policy.
 *
 * Under `quarantine` every member settles as an explicit {@link Settled}
 * envelope: success becomes {@link Succeeded} and failure becomes
 * {@link Quarantined}. The declaration shows one `Catch` per member and the
 * join can no longer fail on a member's behalf. Under `halt` the join is a
 * plain `Node.all` and preserves raw successful values.
 *
 * @category constructors
 * @since 0.1.0
 */
export function all(
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions & { readonly policy: "quarantine" }
): Node.Node<Readonly<Record<string, Settled<unknown, unknown>>>, never, any>
export function all(
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions & { readonly policy: "halt" }
): Node.Node<Readonly<Record<string, unknown>>, unknown, any>
export function all(
  members: Readonly<Record<string, Node.Any>>,
  options: AllOptions
): Node.Node<Readonly<Record<string, unknown | Settled<unknown, unknown>>>, unknown, any> {
  const names = Object.keys(members)
  nonEmpty(names)
  if (options.policy === "halt") return Node.all(members)
  const isolated = Object.fromEntries(
    names.map((member) => [
      member,
      Node.catch(
        Node.map(
          members[member]!,
          Node.capture({ member, outcome: "Succeeded" }, (value: unknown) => succeeded(member, value))
        ),
        {
          onFailure: Node.capture(
            { member, outcome: "Quarantined" },
            (error: unknown) => Node.succeed(quarantined(member, error))
          )
        }
      )
    ])
  ) as Record<string, Node.Any>
  return Node.all(isolated)
}

/**
 * Runs a record of effects under the declared failure policy.
 *
 * Under `quarantine` every member runs to completion and a typed failure becomes
 * a {@link Quarantined} entry in the result; no sibling is interrupted on its
 * behalf. A defect and an interruption still propagate: quarantine isolates
 * declared failures, not a broken process. Under `halt` the first failure interrupts the members still in
 * flight and the whole join fails.
 *
 * @category combinators
 * @since 0.1.0
 */
export function run<A, E, R>(
  members: Readonly<Record<string, Effect.Effect<A, E, R>>>,
  options: RuntimeOptions & { readonly policy: "quarantine" }
): Effect.Effect<Readonly<Record<string, Settled<A, E>>>, PatternError, R>
export function run<A, E, R>(
  members: Readonly<Record<string, Effect.Effect<A, E, R>>>,
  options: RuntimeOptions & { readonly policy: "halt" }
): Effect.Effect<Readonly<Record<string, A>>, E | PatternError, R>
export function run<A, E, R>(
  members: Readonly<Record<string, Effect.Effect<A, E, R>>>,
  options: RuntimeOptions
): Effect.Effect<Readonly<Record<string, A | Settled<A, E>>>, E | PatternError, R> {
  // Snapshots taken at the call, ahead of the suspend: the effect may run
  // later, and a caller's edit to the record or the option object in between
  // must not reach it. Own entries only, so a prototype-shaped member name
  // stays a data property.
  const declared: Readonly<Record<string, Effect.Effect<A, E, R>>> = Object.fromEntries(Object.entries(members))
  const policy = options.policy
  const concurrency = options.concurrency ?? "unbounded"
  return Effect.suspend((): Effect.Effect<Readonly<Record<string, A | Settled<A, E>>>, E | PatternError, R> => {
    const names = Object.keys(declared)
    const refusal = nonEmptyRefusal(names) ?? widthRefusal(concurrency)
    if (refusal !== undefined) return Effect.fail(refusal)
    return Effect.map(
      Effect.forEach(
        names,
        (member): Effect.Effect<readonly [string, A | Settled<A, E>], E, R> =>
          policy === "halt"
            ? Effect.map(declared[member]!, (value) => [member, value] as const)
            : Effect.match(declared[member]!, {
              onFailure: (error): readonly [string, Settled<A, E>] => [member, quarantined(member, error)],
              onSuccess: (value): readonly [string, Settled<A, E>] => [member, succeeded(member, value)]
            }),
        { concurrency }
      ),
      (pairs) => Object.fromEntries(pairs) as Readonly<Record<string, A | Settled<A, E>>>
    )
  })
}

/**
 * Turns a joined result into values, failing when any member was quarantined.
 *
 * Use it when the caller wants halt-after-join: every member got its chance to
 * run, and one failure still fails the step.
 *
 * Every entry has to be a complete {@link Succeeded} or {@link Quarantined}
 * envelope. A successful value is nested under `value`, so it can carry any
 * shape, including either complete wire shape, and settles unchanged. Callers
 * do not wrap their values. An entry that is neither envelope, such as a raw
 * success value, fails `PatternError` with code `invalid_input` naming the
 * offending members, and a quarantined entry fails with code `quarantined`.
 *
 * @category combinators
 * @since 0.1.0
 */
export const settle = <A, E>(
  result: Readonly<Record<string, Settled<A, E>>>
): Effect.Effect<Readonly<Record<string, A>>, PatternError> => {
  const names = Object.keys(result)
  const invalid = names.filter((member) => !isQuarantined(result[member]) && !isSucceeded(result[member]))
  if (invalid.length > 0) {
    return Effect.fail(
      new PatternError({
        code: "invalid_input",
        message: `Invalid quarantine outcomes: ${invalid.sort().join(", ")}`
      })
    )
  }
  const failures = names.filter((member) => isQuarantined(result[member])).sort()
  if (failures.length > 0) {
    return Effect.fail(
      new PatternError({
        code: "quarantined",
        message: `Quarantined members: ${failures.join(", ")}`,
        cause: failures.map((member) => {
          const entry = result[member] as Quarantined<E>
          return { member, error: entry.error }
        })
      })
    )
  }
  return Effect.succeed(
    Object.fromEntries(names.map((member) => [member, (result[member] as Succeeded<A>).value]))
  )
}

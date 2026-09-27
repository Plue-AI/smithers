/**
 * Merge-queue pattern: land a set of members in one prioritized order, at a
 * concurrency the queue owns rather than the members.
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
import type { Member as Callable } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"

/**
 * The priority a member gets when it does not declare one.
 *
 * It matches the priority the old `<MergeQueue>` component gave its
 * descendants, so a queue that relied on that default keeps its ordering.
 *
 * @category constants
 * @since 0.1.0
 */
export const DefaultPriority = 1000

/**
 * What a failing member does to the members behind it.
 *
 * @category models
 * @since 0.1.0
 */
export type FailurePolicy = "halt" | "quarantine"

/**
 * The declared form of a merge queue.
 *
 * @category models
 * @since 0.1.0
 */
export type MergeQueueFlow = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  any
>

/**
 * One declared member of the queue.
 *
 * @category models
 * @since 0.1.0
 */
export interface Member {
  readonly id: string
  readonly flow: Callable<any>
  readonly priority?: number | undefined
}

/**
 * Configuration for {@link make}.
 *
 * `concurrency` defaults to 1: a merge queue serializes landings unless a
 * caller widens it deliberately. Only a `quarantine` queue may widen it: a
 * `halt` queue promises that no member behind a failure lands, and a batch
 * starts its members before any of them has failed, so `halt` above
 * concurrency 1 is refused. `priority` sets the default a member without its
 * own priority receives. `members` land in the order {@link ordered}
 * resolves.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly members: ReadonlyArray<Member>
  readonly concurrency?: number | undefined
  readonly priority?: number | undefined
  readonly failurePolicy: FailurePolicy
}

/**
 * One member at runtime.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeMember<I, Out, E, R> {
  readonly id: string
  readonly priority?: number | undefined
  readonly run: (args: {
    readonly id: string
    readonly priority: number
    readonly position: number
    readonly input: I
  }) => Effect.Effect<Out, E, R>
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R> {
  readonly members: ReadonlyArray<RuntimeMember<I, Out, E, R>>
  readonly concurrency?: number | undefined
  readonly priority?: number | undefined
  readonly failurePolicy: FailurePolicy
}

/**
 * A member that landed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Landed<Out> {
  readonly id: string
  readonly output: Out
}

/**
 * A member the queue held back because it failed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Quarantined<E> {
  readonly id: string
  readonly error: E
}

/**
 * What a queue pass landed and what it held back.
 *
 * `order` is the order the queue used, so a caller can see the queue's
 * decision even when every member landed.
 *
 * @category models
 * @since 0.1.0
 */
export interface Result<Out, E> {
  readonly landed: ReadonlyArray<Landed<Out>>
  readonly quarantined: ReadonlyArray<Quarantined<E>>
  readonly order: ReadonlyArray<string>
}

/**
 * A member with its effective priority and queue position resolved.
 *
 * @category models
 * @since 0.1.0
 */
export interface Position<M> {
  readonly id: string
  readonly priority: number
  readonly position: number
  readonly member: M
}

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

/**
 * Resolves each member's effective priority and sorts the queue.
 *
 * Members land in descending priority, and members of equal priority land in
 * declaration order, so the queue's order is a function of the declaration
 * alone and never of which member became ready first.
 *
 * @category introspection
 * @since 0.1.0
 */
export const ordered = <M extends { readonly id: string; readonly priority?: number | undefined }>(
  members: ReadonlyArray<M>,
  priority: number
): ReadonlyArray<Position<M>> => {
  const refusal = priorityRefusal(members, priority)
  if (refusal !== undefined) throw refusal
  return members
    .map((member, index) => ({
      id: member.id,
      priority: member.priority ?? priority,
      position: index,
      member
    }))
    .sort((left, right) =>
      left.priority === right.priority ? left.position - right.position : right.priority - left.priority
    )
    .map((entry, index) => ({ ...entry, position: index }))
}

const priorityRefusal = (
  members: ReadonlyArray<{ readonly id: string; readonly priority?: number | undefined }>,
  priority: number
): PatternError | undefined => {
  for (const member of members) {
    const refusal = Compose.safeIntegerPriorityRefusal("MergeQueue", member.id, member.priority ?? priority)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

const validate = (
  members: ReadonlyArray<{ readonly id: string; readonly priority?: number | undefined }>,
  concurrency: number,
  priority: number,
  failurePolicy: FailurePolicy
): PatternError | undefined => {
  if (members.length === 0) {
    return new PatternError({ code: "invalid_decorator", message: "MergeQueue requires at least one member" })
  }
  const ids = members.map((member) => member.id)
  if (new Set(ids).size !== ids.length) {
    return new PatternError({ code: "invalid_decorator", message: "MergeQueue member ids must be unique" })
  }
  if (!bound(concurrency)) {
    return new PatternError({
      code: "invalid_decorator",
      message: "MergeQueue concurrency must be a positive safe integer"
    })
  }
  // A batch starts every member in it before any of them has failed, so a
  // halting queue wider than one member could land a member behind a
  // failure. The contract promises it never does, so halt stays serial.
  if (failurePolicy === "halt" && concurrency > 1) {
    return new PatternError({ code: "invalid_decorator", message: "MergeQueue halt requires concurrency 1" })
  }
  return priorityRefusal(members, priority)
}

/**
 * One landing as the declaration carries it: the member's output, or the
 * quarantine marker its recovery arm settled.
 */
type Outcome =
  | { readonly _tag: "Landed"; readonly output: unknown }
  | { readonly _tag: "Quarantined"; readonly id: string; readonly error: unknown }

/**
 * Builds the landing topology: the members in queue order, batched into
 * `Node.all` groups of `concurrency` members, with the batches sequenced.
 *
 * At the default concurrency of 1 the queue is a plain `Node.andThen` chain,
 * with no `Node.all` at all, so the declared plan admits exactly one landing at
 * a time. Each call carries `{ id, position, input }`, so a built graph names
 * each member's place in the queue.
 *
 * A member's effective priority reaches the plan as a `Node.priority`
 * annotation rather than as call input, which is what lets the scheduler start
 * the higher-priority ready landing first. Priority stays out of key material,
 * so raising a member's number without changing the resulting order re-uses the
 * same steps rather than re-landing the queue.
 *
 * `failurePolicy` picks the topology. Under `quarantine` every member gains a
 * recovery arm settling it as MergeQueue's `Quarantined` result, so a failing
 * member neither fails the chain nor interrupts the batch beside it: the
 * queue {@link run} lands. Under `halt` the chain has no continuation past a
 * failed member, and it is always the serial chain: a halting queue is refused
 * above concurrency 1, because a batch would start a member behind a failure
 * before the failure is known.
 *
 * Every landing settles to a tagged outcome, and one final map folds them in
 * queue order into the same {@link Result} {@link run} returns:
 * `{ landed, quarantined, order }`.
 *
 * `make` throws a `PatternError` when there are no members, when two members
 * share an id, when `concurrency` is not a positive safe integer, when
 * `failurePolicy` is `halt` and `concurrency` is above 1, or when `priority`
 * is not a safe integer.
 *
 * `make` snapshots `members`, each member's `id`, `flow`, and `priority`, and
 * every option at the call, so a later edit to the caller's array, records,
 * or option object does not change the declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): MergeQueueFlow => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's members or options again.
  const snapshot: ReadonlyArray<Member> = options.members.map((member) => ({
    id: member.id,
    flow: member.flow,
    priority: member.priority
  }))
  const concurrency = options.concurrency ?? 1
  const priority = options.priority ?? DefaultPriority
  const failurePolicy = options.failurePolicy
  const invalid = validate(snapshot, concurrency, priority, failurePolicy)
  if (invalid !== undefined) throw invalid
  const queue = ordered(snapshot, priority)
  // Priority is deliberately absent: it reaches the plan as an annotation, and
  // an annotation never enters key material. What it changes, the order and
  // therefore each member's position, is captured through `members`.
  const captures = {
    members: queue.map((entry) => entry.id),
    concurrency,
    failurePolicy
  }
  const { name, description } = Compose.label(
    "mergeQueue",
    { members: captures.members, concurrency, failurePolicy },
    options
  )
  // Each landing settles to a tagged outcome, so the final fold can tell a
  // landed member from a quarantined one whatever the member returned.
  const settled = (values: unknown): Result<unknown, unknown> => {
    const outcomes = values as Readonly<Record<string, Outcome>>
    const landed: Array<Landed<unknown>> = []
    const quarantined: Array<Quarantined<unknown>> = []
    for (const entry of queue) {
      const outcome = outcomes[entry.id]!
      if (outcome._tag === "Landed") landed.push({ id: entry.id, output: outcome.output })
      else quarantined.push({ id: entry.id, error: outcome.error })
    }
    return { landed, quarantined, order: captures.members }
  }
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, any> => {
    const landing = (entry: Position<Member>): Node.Node<unknown, unknown, any> => {
      const declared = Node.map(
        Node.priority(
          callMember(entry.member.flow, {
            id: entry.id,
            position: entry.position,
            input
          }),
          entry.priority
        ),
        Node.capture({ id: entry.id }, (output: unknown): Outcome => ({ _tag: "Landed", output }))
      )
      if (failurePolicy === "halt") return declared
      return Node.catch(declared, {
        onFailure: Node.capture(
          { id: entry.id },
          (error: unknown) => Node.succeed({ _tag: "Quarantined", id: entry.id, error })
        )
      })
    }
    const fold = (carried: Readonly<Record<string, Planned.Planned<unknown>>>): Node.Node<unknown, unknown, any> =>
      Node.map(Node.succeed(carried), Node.capture(captures, settled))
    if (concurrency === 1) {
      const walk = (
        index: number,
        carried: Readonly<Record<string, Planned.Planned<unknown>>>
      ): Node.Node<unknown, unknown, any> => {
        const entry = queue[index]
        if (entry === undefined) return fold(carried)
        return Node.bindPlanned(
          landing(entry),
          Node.capture({ ...captures, landed: entry.id }, (value) => walk(index + 1, { ...carried, [entry.id]: value }))
        )
      }
      return walk(0, {})
    }
    const batchAt = (offset: number): Node.Node<unknown, unknown, any> => {
      const group = Object.fromEntries(
        queue.slice(offset, offset + concurrency).map((entry) => [entry.id, landing(entry)])
      ) as Record<string, Node.Any>
      return Node.all(group)
    }
    const visit = (
      offset: number,
      carried: Readonly<Record<string, Planned.Planned<unknown>>>
    ): Node.Node<unknown, unknown, any> => {
      if (offset >= queue.length) return fold(carried)
      const batched = queue.slice(offset, offset + concurrency).map((entry) => entry.id)
      return Node.bindPlanned(
        batchAt(offset),
        Node.capture({ ...captures, offset, batched }, (reference) =>
          Node.andThen(
            Node.succeed(reference),
            visit(offset + concurrency, {
              ...carried,
              ...Object.fromEntries(
                batched.map((id) => [id, (reference as Readonly<Record<string, Planned.Planned<unknown>>>)[id]!])
              )
            })
          ))
      )
    }
    return visit(0, {})
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

/**
 * Lands the members in queue order at the queue's concurrency.
 *
 * At the default concurrency of 1 the members land strictly one at a time, in
 * descending priority and then declaration order.
 *
 * Under `failurePolicy: "halt"` a failing member fails the queue and no member
 * behind it lands, which is why `halt` runs only at concurrency 1: a wider
 * queue would have started the next member before the failure was known.
 * `run` fails with a `PatternError` for `halt` above concurrency 1, before
 * any member starts. Under `"quarantine"` the failure is recorded, the member
 * does not land, and the members behind it still do. A quarantined entry is
 * `{ id, error }`, untagged, because `landed` and `quarantined` are separate
 * arrays.
 *
 * Both policies read the typed failure channel. A member that throws raises a
 * defect, which fails the queue under either policy and cancels the landings
 * still in flight.
 *
 * `run` snapshots `members`, each member's `id`, `priority`, and `run`, and
 * every option at the call, so a later edit to the caller's array, records,
 * or option object does not alter that run.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Out, E = never, R = never>(
  input: I,
  options: RuntimeOptions<I, Out, E, R>
): Effect.Effect<Result<Out, E>, E | PatternError, R> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the array, a member record, or the option object in between must
  // not reach it.
  const members: ReadonlyArray<RuntimeMember<I, Out, E, R>> = options.members.map((member) => ({
    id: member.id,
    priority: member.priority,
    run: member.run
  }))
  const concurrency = options.concurrency ?? 1
  const priority = options.priority ?? DefaultPriority
  const failurePolicy = options.failurePolicy
  const invalid = validate(members, concurrency, priority, failurePolicy)
  if (invalid !== undefined) return Effect.fail(invalid)
  const queue = ordered(members, priority)
  return Effect.map(
    Effect.forEach(
      queue,
      (entry) => {
        const attempt = entry.member.run({
          id: entry.id,
          priority: entry.priority,
          position: entry.position,
          input
        })
        const landed = Effect.map(attempt, (output) => ({ landed: true, id: entry.id, output }) as const)
        return failurePolicy === "quarantine"
          ? Effect.catch(landed, (error: E) => Effect.succeed({ landed: false, id: entry.id, error } as const))
          : landed
      },
      { concurrency }
    ),
    (outcomes) => ({
      landed: outcomes.flatMap((outcome) => outcome.landed ? [{ id: outcome.id, output: outcome.output }] : []),
      quarantined: outcomes.flatMap((outcome) => outcome.landed ? [] : [{ id: outcome.id, error: outcome.error }]),
      order: queue.map((entry) => entry.id)
    })
  )
}

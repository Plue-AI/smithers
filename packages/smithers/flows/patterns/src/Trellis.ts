/**
 * Model-authored bounded delegation plans.
 *
 * A model returns a plan of nested `agent`, `sequence`, and `parallel` nodes.
 * This module validates that plan against an {@link Envelope}, compiles it into
 * ordinary flow calls, and executes it with bounded concurrency.
 *
 * `Recursion.recurse` needs a literal tree while the graph is being planned.
 * A Trellis plan is discovered at run time instead, so the two halves are
 * deliberately separate. {@link make} declares the conservative topology the
 * plan can never exceed, one leaf call per fuel unit. {@link run} executes the
 * plan a model actually authored. A durable host spends one
 * trampoline round per authored plan, handing off with the `To` outcome
 * `@smthrs/flow` defines, so each round is its own journal segment and a crash
 * resumes at the round boundary.
 *
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import type * as Recursion from "./Recursion.ts"

/**
 * Stable Trellis failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TrellisErrorCode = Schema.Literals([
  "invalid_envelope",
  "invalid_plan",
  "depth_exceeded",
  "fanout_exceeded",
  "fuel_exhausted",
  "leaf_failed"
])

/**
 * Stable Trellis failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type TrellisErrorCode = typeof TrellisErrorCode.Type

/**
 * A rejected plan, envelope, or failed leaf, naming its plan path.
 *
 * Trellis owns this failure rather than reusing `PatternError` because every
 * rejection carries a plan path, and a path is what an author has to read to
 * repair the plan. `cause` carries the reported execution residue. It never
 * carries the caller input.
 *
 * @category errors
 * @since 0.1.0
 */
export class TrellisError extends Schema.TaggedError<TrellisError>()("flows/patterns/TrellisError", {
  code: TrellisErrorCode,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * The bounds a plan is admitted under: total leaf calls, nesting depth, and
 * the width of any one container.
 *
 * @category models
 * @since 0.1.0
 */
export type Envelope = Recursion.Envelope

/**
 * One unit of delegated work a model asked for.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Agent = Schema.Struct({
  goal: Schema.NonEmptyString,
  seat: Schema.optional(Schema.String)
})

/**
 * A model-authored plan: one agent, an ordered sequence, or a parallel group.
 *
 * A container holds at least one member. An empty one names no work, costs no
 * fuel, and would let a trampoline round make no progress, so both the type and
 * the {@link Plan} codec refuse it.
 *
 * @category models
 * @since 0.1.0
 */
export type Plan =
  | {
    readonly agent: {
      readonly goal: string
      readonly seat?: string | undefined
    }
  }
  | { readonly sequence: readonly [Plan, ...ReadonlyArray<Plan>] }
  | { readonly parallel: readonly [Plan, ...ReadonlyArray<Plan>] }

const PlanSchema: Schema.Codec<Plan> = Schema.suspend(
  (): Schema.Codec<Plan> =>
    Schema.Union([
      Schema.Struct({
        agent: Agent,
        sequence: Schema.optionalKey(Schema.Never),
        parallel: Schema.optionalKey(Schema.Never)
      }),
      Schema.Struct({
        sequence: Schema.NonEmptyArray(PlanSchema),
        agent: Schema.optionalKey(Schema.Never),
        parallel: Schema.optionalKey(Schema.Never)
      }),
      Schema.Struct({
        parallel: Schema.NonEmptyArray(PlanSchema),
        agent: Schema.optionalKey(Schema.Never),
        sequence: Schema.optionalKey(Schema.Never)
      })
    ])
)

/**
 * Schema for a model-authored plan. Declare it as an author flow's output so
 * the model is shown the closed grammar it may answer in.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Plan = PlanSchema

/**
 * One compiled leaf: the goal a leaf flow is called with, the seat the model
 * asked for, and the plan path the leaf came from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Leaf {
  readonly goal: string
  readonly seat?: string | undefined
  readonly path: string
}

const container = (plan: Plan): ReadonlyArray<Plan> | undefined =>
  "sequence" in plan ? plan.sequence : "parallel" in plan ? plan.parallel : undefined

const childPath = (path: string, plan: Plan, index: number): string =>
  `${path}.${"sequence" in plan ? "sequence" : "parallel"}[${index}]`

/**
 * Lists a plan's leaves in plan order. The count is what the plan costs in
 * fuel, and the paths are the stable identifiers a caller keys leaf outputs by.
 *
 * @category introspection
 * @since 0.1.0
 */
export const leaves = (plan: Plan): ReadonlyArray<Leaf> => {
  const collected: Array<Leaf> = []
  const visit = (node: Plan, path: string): void => {
    const members = container(node)
    if (members === undefined) {
      const agent = (node as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
      collected.push(
        agent.seat === undefined ? { goal: agent.goal, path } : { goal: agent.goal, seat: agent.seat, path }
      )
      return
    }
    members.forEach((member, index) => visit(member, childPath(path, node, index)))
  }
  visit(plan, "root")
  return collected
}

const bounded = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

// The three bounds as own fields, so an effect or a declaration built now
// never reads a caller's envelope object again.
const copiedEnvelope = (envelope: Envelope): Envelope => ({
  fuel: envelope.fuel,
  depth: envelope.depth,
  fanout: envelope.fanout
})

// A structural copy of a plan, so an effect that runs later visits the leaves
// the plan named when the effect was built.
const copiedPlan = (plan: Plan): Plan => {
  const members = container(plan)
  if (members === undefined) {
    const agent = (plan as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
    return { agent: { goal: agent.goal, seat: agent.seat } }
  }
  const copies: readonly [Plan, ...ReadonlyArray<Plan>] = [copiedPlan(members[0]!), ...members.slice(1).map(copiedPlan)]
  return "sequence" in plan ? { sequence: copies } : { parallel: copies }
}

const admissionRefusal = (options: {
  readonly envelope?: Envelope | undefined
  readonly concurrency?: number | undefined
}): TrellisError | undefined => {
  const envelope = options.envelope
  if (
    envelope !== undefined &&
    (!bounded(envelope.fuel) || !bounded(envelope.depth) || !bounded(envelope.fanout))
  ) {
    return new TrellisError({
      code: "invalid_envelope",
      path: "root",
      message: "Trellis envelope fuel, depth, and fanout must be positive safe integers"
    })
  }
  const concurrency = options.concurrency
  if (concurrency !== undefined && !bounded(concurrency)) {
    return new TrellisError({
      code: "invalid_envelope",
      path: "root",
      message: `Trellis concurrency must be a positive safe integer, received ${concurrency}`
    })
  }
  return undefined
}

const shape = (value: unknown): "agent" | "sequence" | "parallel" | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const keys = Object.keys(value)
  if (keys.length !== 1) return undefined
  const key = keys[0]
  return key === "agent" || key === "sequence" || key === "parallel" ? key : undefined
}

const namesNoWork = (value: unknown, depth: number): boolean => {
  // Stop at the admission bound so validate can report an over-deep value.
  if (depth < 1) return false
  const kind = shape(value)
  if (kind === undefined || kind === "agent") return false
  const members = (value as { readonly [key: string]: unknown })[kind]
  return Array.isArray(members) && members.every((member) => namesNoWork(member, depth - 1))
}

/**
 * Checks a model-authored value against an envelope and returns every reason
 * it was refused, each naming the plan path it was found at. An accepted plan
 * returns no reasons.
 *
 * Fuel is charged per leaf and checked for the whole plan, so a plan is
 * admitted or refused as a unit and no leaf runs on a budget the plan already
 * overspent.
 *
 * @category validation
 * @since 0.1.0
 */
export const validate = (plan: unknown, envelope: Envelope): ReadonlyArray<TrellisError> => {
  const invalid = admissionRefusal({ envelope })
  if (invalid !== undefined) return [invalid]
  const found: Array<TrellisError> = []
  let leafCount = 0
  const visit = (value: unknown, path: string, depth: number): void => {
    const kind = shape(value)
    if (kind === undefined) {
      found.push(
        new TrellisError({
          code: "invalid_plan",
          path,
          message: "A plan node must be exactly one of agent, sequence, or parallel"
        })
      )
      return
    }
    if (depth > envelope.depth) {
      found.push(
        new TrellisError({
          code: "depth_exceeded",
          path,
          message: `Plan depth ${depth} exceeds the envelope depth ${envelope.depth}`
        })
      )
      return
    }
    if (kind === "agent") {
      const agent = (value as { readonly agent: unknown }).agent
      if (typeof agent !== "object" || agent === null) {
        found.push(
          new TrellisError({ code: "invalid_plan", path: `${path}.agent`, message: "agent must be an object" })
        )
        return
      }
      const goal = (agent as { readonly goal?: unknown }).goal
      const seat = (agent as { readonly seat?: unknown }).seat
      if (typeof goal !== "string" || goal.length === 0) {
        found.push(
          new TrellisError({
            code: "invalid_plan",
            path: `${path}.agent.goal`,
            message: "agent.goal must be a non-empty string"
          })
        )
      }
      if (seat !== undefined && typeof seat !== "string") {
        found.push(
          new TrellisError({ code: "invalid_plan", path: `${path}.agent.seat`, message: "agent.seat must be a string" })
        )
      }
      leafCount += 1
      return
    }
    const members = (value as { readonly [key: string]: unknown })[kind]
    if (!Array.isArray(members)) {
      found.push(
        new TrellisError({ code: "invalid_plan", path: `${path}.${kind}`, message: `${kind} must be an array` })
      )
      return
    }
    if (members.length === 0) {
      found.push(
        new TrellisError({
          code: "invalid_plan",
          path,
          message: `${kind} must hold at least one member`
        })
      )
      return
    }
    if (members.length > envelope.fanout) {
      found.push(
        new TrellisError({
          code: "fanout_exceeded",
          path,
          message: `${kind} declares ${members.length} members, above the envelope fan-out ${envelope.fanout}`
        })
      )
      return
    }
    members.forEach((member, index) => visit(member, `${path}.${kind}[${index}]`, depth + 1))
  }
  visit(plan, "root", 1)
  if (found.length === 0 && leafCount > envelope.fuel) {
    found.push(
      new TrellisError({
        code: "fuel_exhausted",
        path: "root",
        message: `Plan needs ${leafCount} leaf calls but only ${envelope.fuel} fuel remains`
      })
    )
  }
  return found
}

/**
 * Options accepted by {@link compile}.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompileOptions<R = never> {
  readonly leaf: Member<R>
}

const ordinal = (key: string): number => Number(key.slice(key.lastIndexOf("-") + 1))

/**
 * Compiles a validated plan into one static node: an agent becomes a leaf
 * call, a sequence becomes an ordered chain of member results, and a parallel
 * becomes a `Node.all` join returned in plan order.
 *
 * A sequence carries its members' planned references and hands them over as one
 * array when the chain settles, because a planned result may be read by field
 * and passed on but never spread into a new array while the graph builds.
 *
 * @category constructors
 * @since 0.1.0
 */
export const compile = <R = never>(plan: Plan, options: CompileOptions<R>): Node.Node<unknown, unknown, R> => {
  const visit = (node: Plan, path: string): Node.Node<unknown, unknown, R> => {
    const members = container(node)
    if (members === undefined) {
      const agent = (node as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
      const leaf: Leaf = agent.seat === undefined
        ? { goal: agent.goal, path }
        : { goal: agent.goal, seat: agent.seat, path }
      return callMember(options.leaf, leaf)
    }
    if ("parallel" in node) {
      const joined: Record<string, Node.Node<unknown, unknown, R>> = {}
      members.forEach((member, index) => {
        joined[`member-${index}`] = visit(member, childPath(path, node, index))
      })
      return Node.map(
        Node.all(joined),
        Node.capture({ members: members.length }, (values: Readonly<Record<string, unknown>>) =>
          Object.keys(values)
            .sort((left, right) => ordinal(left) - ordinal(right))
            .map((key) => values[key]))
      )
    }
    // Each member gates the next, so the chain runs in plan order, and the
    // settled array is built from the references the chain collected.
    const chain = (
      index: number,
      carried: ReadonlyArray<Planned.Planned<unknown>>
    ): Node.Node<unknown, unknown, R> => {
      const member = members[index]
      if (member === undefined) return Node.succeed(carried)
      return Node.bindPlanned(
        visit(member, childPath(path, node, index)),
        Node.capture({ index }, (value) => Node.andThen(Node.succeed(value), chain(index + 1, [...carried, value])))
      )
    }
    return chain(0, [])
  }
  return visit(plan, "root")
}

/**
 * Options accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly author: Member<R>
  readonly leaf: Member<R>
  readonly envelope: Envelope
}

/**
 * The declared form of a trellis.
 *
 * @category models
 * @since 1.0.0
 */
export type TrellisFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Declares the conservative topology every authored plan fits inside: one
 * author call followed by one leaf call per fuel unit.
 *
 * The leaf slots are sequenced because a plan-time declaration cannot know
 * which of them a plan will fan out. Use {@link run} to execute the plan a
 * model actually authored.
 * A very large envelope fuel bound builds a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): TrellisFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const envelope = copiedEnvelope(options.envelope)
  const author = options.author
  const leaf = options.leaf
  const invalid = admissionRefusal({ envelope })
  if (invalid !== undefined) throw invalid
  const captured = { fuel: envelope.fuel, depth: envelope.depth, fanout: envelope.fanout }
  const { name, description } = Compose.label("trellis", {
    fuel: envelope.fuel,
    depth: envelope.depth,
    fanout: envelope.fanout
  }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> =>
    Node.bindPlanned(
      callMember(author, input),
      Node.capture(captured, (plan) => {
        // A declaration cannot know the goals a plan will name, so the
        // authored plan stands in for the goal and the slot names the path.
        // The shape is the `Leaf` that `run` and `execute` hand a leaf flow.
        const slotLeaf = (slot: number): { readonly goal: unknown; readonly path: string } => ({
          goal: plan,
          path: `slot-${slot}`
        })
        let slots: Node.Node<unknown, unknown, R> = callMember(leaf, slotLeaf(0))
        for (let slot = 1; slot < envelope.fuel; slot++) {
          // Nothing reads the preceding slot's value; the slots are sequenced
          // so the declared topology spends its fuel one call at a time.
          slots = Node.andThen(slots, callMember(leaf, slotLeaf(slot)))
        }
        return slots
      })
    )
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and declared
    // no error schema. `@smthrs/flow` needs a real one, because the engine
    // encodes a typed failure through it, and a trellis fails with whatever the
    // author or leaf it called failed with.
    error: Schema.Unknown,
    body: Node.capture(captured, body)
  })
}

/**
 * What {@link run} hands an author on each round.
 *
 * @category models
 * @since 0.1.0
 */
export interface Authoring {
  readonly prompt: string
  readonly round: number
  readonly previous: unknown
  readonly remaining: number
}

/**
 * What {@link run} hands `continue` after a round settles.
 *
 * @category models
 * @since 0.1.0
 */
export interface Continuation {
  readonly plan: Plan
  readonly result: unknown
  readonly round: number
  readonly remaining: number
}

/**
 * One executed round: the plan the model authored and what it produced.
 *
 * @category models
 * @since 0.1.0
 */
export interface Round {
  readonly plan: Plan
  readonly result: unknown
}

/**
 * Every round {@link run} executed and the fuel left over.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunResult {
  readonly rounds: ReadonlyArray<Round>
  readonly remaining: number
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<E, R, E2, R2, E3, R3> {
  readonly author: (input: Authoring) => Effect.Effect<unknown, E, R>
  readonly leaf: (input: Leaf) => Effect.Effect<unknown, E2, R2>
  readonly envelope: Envelope
  /**
   * Requests another round. `undefined`, and any value whose only content is
   * empty `sequence` or `parallel` containers within the envelope depth,
   * terminates the trampoline even though the {@link Plan} codec and
   * {@link validate} refuse such a value as a plan. A continuation names work for another round, so one that names no
   * work is the same answer as no request.
   */
  readonly continue?: ((input: Continuation) => Effect.Effect<unknown, E3, R3>) | undefined
  readonly concurrency?: number | undefined
}

/**
 * Executes one validated plan, holding at most `concurrency` leaves in flight.
 *
 * Sequence members run in plan order; parallel members are started together
 * and admitted by a shared semaphore, so the bound holds across the whole
 * plan rather than per container.
 *
 * `execute` copies the plan and snapshots the options at the call, so a later
 * edit to either does not alter that execution.
 *
 * @category combinators
 * @since 0.1.0
 */
export const execute = <E, R>(
  plan: Plan,
  options: {
    readonly leaf: (input: Leaf) => Effect.Effect<unknown, E, R>
    readonly concurrency: number
  }
): Effect.Effect<unknown, E | TrellisError, R> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the plan or the option object in between must not reach it.
  const admitted = copiedPlan(plan)
  const runLeaf = options.leaf
  const concurrency = options.concurrency
  const invalid = admissionRefusal({ concurrency })
  if (invalid !== undefined) return Effect.fail(invalid)
  return Effect.flatMap(Semaphore.make(concurrency), (semaphore) => {
    const visit = (node: Plan, path: string): Effect.Effect<unknown, E, R> => {
      const members = container(node)
      if (members === undefined) {
        const agent = (node as { readonly agent: { readonly goal: string; readonly seat?: string | undefined } }).agent
        const leaf: Leaf = agent.seat === undefined
          ? { goal: agent.goal, path }
          : { goal: agent.goal, seat: agent.seat, path }
        return semaphore.withPermits(1)(runLeaf(leaf))
      }
      return Effect.forEach(
        members,
        (member, index) => visit(member, childPath(path, node, index)),
        { concurrency: "parallel" in node ? "unbounded" : 1 }
      )
    }
    return visit(admitted, "root")
  })
}

/**
 * Authors a plan, admits it, executes it, and re-authors while `continue`
 * returns another plan and fuel remains.
 *
 * Every authored plan is validated against the envelope and against the fuel
 * left over from earlier rounds, so a plan that overspends fails
 * `fuel_exhausted` before any of its leaves runs.
 *
 * Plan refusals include every validation reason in `cause.refusals`. Typed
 * leaf failures become `leaf_failed` with their original error in `cause.error`.
 * Both include completed `rounds` and `remaining` fuel. Fuel is charged only
 * after a round completes, so a failed round is absent from that residue.
 *
 * `run` snapshots every callback, the envelope's three bounds, and
 * `concurrency` at the call, so a later edit to the option object does not
 * alter that run.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <E, R, E2, R2, E3 = never, R3 = never>(
  prompt: string,
  options: RuntimeOptions<E, R, E2, R2, E3, R3>
): Effect.Effect<RunResult, E | E2 | E3 | TrellisError, R | R2 | R3> => {
  // Snapshots taken at the call, ahead of the suspend: the effect may run
  // later, and a caller's edit to the option object in between must not
  // reach it.
  const envelope = copiedEnvelope(options.envelope)
  const concurrency = options.concurrency ?? envelope.fanout
  const author = options.author
  const leaf = options.leaf
  const continuation = options.continue
  return Effect.suspend(() => {
    const invalid = admissionRefusal({ envelope, concurrency })
    if (invalid !== undefined) return Effect.fail(invalid)
    return Effect.gen(function*() {
      const rounds: Array<Round> = []
      let remaining = envelope.fuel
      let authored: unknown = yield* author({ prompt, round: 1, previous: undefined, remaining })
      for (let round = 1;; round++) {
        const refusals = validate(authored, envelope)
        if (refusals.length > 0) {
          const refusal = refusals[0] as TrellisError
          return yield* Effect.fail(
            new TrellisError({
              code: refusal.code,
              path: refusal.path,
              message: refusal.message,
              cause: { rounds: [...rounds], remaining, refusals }
            })
          )
        }
        const plan = authored as Plan
        const cost = leaves(plan).length
        if (cost > remaining) {
          return yield* Effect.fail(
            new TrellisError({
              code: "fuel_exhausted",
              path: "root",
              message: `Round ${round} needs ${cost} leaf calls but only ${remaining} fuel remains`,
              cause: { rounds: [...rounds], remaining }
            })
          )
        }
        const result = yield* execute(plan, {
          concurrency,
          leaf: (work) =>
            leaf(work).pipe(
              Effect.mapError((error) =>
                new TrellisError({
                  code: "leaf_failed",
                  path: work.path,
                  message: `Leaf ${work.path} failed in round ${round}`,
                  cause: { rounds: [...rounds], remaining, error }
                })
              )
            )
        })
        remaining -= cost
        rounds.push({ plan, result })
        if (continuation === undefined) return { rounds, remaining }
        const next = yield* continuation({ plan, result, round, remaining })
        // A continuation is a request for another round. Nothing, or a plan
        // that names no work, is the same answer: the trampoline is done. Every
        // other round costs at least one leaf, so `run` always terminates.
        if (next === undefined || namesNoWork(next, envelope.depth)) return { rounds, remaining }
        authored = next
      }
    })
  })
}

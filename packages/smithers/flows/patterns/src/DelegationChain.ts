/**
 * The fixed delegation chain: refine, plan, derisk, execute, review, settle.
 *
 * Nothing here is new machinery. The chain is assembled from the patterns that
 * already exist: {@link ReviewLoop} runs the derisk rounds, {@link Trellis}
 * admits and executes the derisked plan, {@link Escalation} walks the tier
 * ladder weakest first, and {@link WithRetry} spends the per-tier attempts.
 * This module owns the order those parts run in and the bounds they run under.
 *
 * {@link make} declares what {@link run} executes: every tier call it declares
 * carries the same `Work` a tier is run with, every leaf review carries the
 * tier that produced the output, and settle carries the keys `run` settles
 * with. The one payload that still differs is inside the derisk loop, which
 * `ReviewLoop` owns: it reviews with `{ output }` carrying the produced plan
 * and revises with `{ output, review, round }`, while `run` names the goal and
 * the round in both.
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
import * as Escalation from "./Escalation.ts"
import * as Compose from "./internal/Compose.ts"
import * as Decorate from "./internal/Decorate.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import { PatternError } from "./PatternError.ts"
import * as ReviewLoop from "./ReviewLoop.ts"
import * as Trellis from "./Trellis.ts"
import * as WithRetry from "./WithRetry.ts"

/**
 * Stable delegation-chain failure codes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DelegationErrorCode = Schema.Literals([
  "invalid_bounds",
  "missing_tier",
  "derisk_failed",
  "leaf_failed"
])

/**
 * Stable delegation-chain failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type DelegationErrorCode = typeof DelegationErrorCode.Type

/**
 * A refused chain declaration or a leaf no tier could settle.
 *
 * `path` names the plan path the failure belongs to, or `root` for a failure
 * of the chain itself. `cause` carries the reported error or per-tier
 * outcomes. It never carries the input that produced them.
 *
 * @category errors
 * @since 0.1.0
 */
export class DelegationError extends Schema.TaggedError<DelegationError>()("flows/patterns/DelegationError", {
  code: DelegationErrorCode,
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}

/**
 * The run budget threaded into every leaf call. A host that implements a
 * budget capability enforces it; the chain only carries it.
 *
 * A USD ceiling is not carried here: it is enforced where every model call is
 * made, by `@smthrs/agent`'s `Budget.make({ usd })`, which a chain's leaves
 * spend through like any other call.
 *
 * @category models
 * @since 0.1.0
 */
export interface Budget {
  readonly maxMinutes?: number | undefined
}

/**
 * The bounds every chain declares: the tier ladder, the depth of the plan, the
 * derisk rounds, and the attempts one tier may spend on one leaf.
 *
 * @category models
 * @since 0.1.0
 */
export interface Bounds {
  readonly tierOrder: ReadonlyArray<string>
  /**
   * The plan envelope and the number of declared leaf slots. A plan may hold at
   * most `maxDepth` leaves, nest `maxDepth` levels, and put `maxDepth` members
   * in one container.
   */
  readonly maxDepth: number
  readonly maxDeriskRounds: number
  readonly maxAttempts: number
  /**
   * The wait ladder between one tier's attempts. The default is immediate
   * retry: without a backoff a tier spends every attempt back to back.
   */
  readonly backoff?: WithRetry.Backoff | undefined
  /**
   * Error `_tag` values that end one tier's attempts at their first
   * occurrence, whatever `maxAttempts` allows. The ladder still admits the
   * next tier. The default retries every failure.
   */
  readonly nonRetryable?: ReadonlyArray<string> | undefined
}

/**
 * Configuration for {@link make}.
 *
 * `execute` supplies one flow per tier named in `tierOrder`, weakest first.
 * `review` is asked twice over: once about each escalation rung, and once
 * about the assembled leaf outputs.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> extends Bounds {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly refine: Member<R>
  readonly plan: Member<R>
  readonly derisk: Member<R>
  readonly execute: Readonly<Record<string, Member<R>>>
  readonly review: Member<R>
  readonly settle: Member<R>
  readonly budget?: Budget | undefined
}

/**
 * One delegated unit of work handed to a tier.
 *
 * @category models
 * @since 0.1.0
 */
export interface Work {
  readonly leaf: Trellis.Leaf
  readonly tier: string
  readonly goal: unknown
  readonly budget?: Budget | undefined
}

/**
 * What the review is asked about: one escalation rung, or the whole chain.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewRequest =
  | {
    readonly stage: "leaf"
    readonly leaf: Trellis.Leaf
    readonly tier: string
    readonly output: unknown
  }
  | {
    readonly stage: "chain"
    readonly goal: unknown
    readonly plan: Trellis.Plan
    readonly leaves: ReadonlyArray<unknown>
  }

/**
 * What the derisk review is asked about on each round.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeriskRequest {
  readonly goal: unknown
  readonly plan: unknown
  readonly round: number
}

/**
 * What the planner is asked for on each derisk round.
 *
 * @category models
 * @since 0.1.0
 */
export interface PlanRequest {
  readonly goal: unknown
  readonly round: number
  readonly previous?: unknown
  readonly derisk?: unknown
}

/**
 * What `settle` receives once every leaf has produced an output.
 *
 * @category models
 * @since 0.1.0
 */
export interface Settlement {
  readonly prompt: string
  readonly goal: unknown
  readonly plan: Trellis.Plan
  readonly leaves: ReadonlyArray<unknown>
  readonly review: unknown
  readonly deriskExhausted: boolean
}

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<Settled, E1, R1, E2, R2, E3, R3, E4, R4, E5, R5, E6, R6> extends Bounds {
  readonly refine: (input: { readonly prompt: string }) => Effect.Effect<unknown, E1, R1>
  readonly plan: (request: PlanRequest) => Effect.Effect<unknown, E2, R2>
  readonly derisk: (request: DeriskRequest) => Effect.Effect<unknown, E3, R3>
  readonly execute: Readonly<Record<string, (work: Work) => Effect.Effect<unknown, E4, R4>>>
  readonly review: (request: ReviewRequest) => Effect.Effect<unknown, E5, R5>
  readonly settle: (settlement: Settlement) => Effect.Effect<Settled, E6, R6>
  readonly budget?: Budget | undefined
  readonly concurrency?: number | undefined
}

const positive = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

// The bounds and the budget as own fields: the declared ladders and the
// running chain read them again long after the call, and a caller's edit in
// between must not reach them.
const copiedBounds = (bounds: Bounds): Bounds => ({
  tierOrder: [...bounds.tierOrder],
  maxDepth: bounds.maxDepth,
  maxDeriskRounds: bounds.maxDeriskRounds,
  maxAttempts: bounds.maxAttempts,
  backoff: bounds.backoff === undefined ? undefined : {
    initialMs: bounds.backoff.initialMs,
    factor: bounds.backoff.factor,
    maxMs: bounds.backoff.maxMs
  },
  nonRetryable: bounds.nonRetryable === undefined ? undefined : [...bounds.nonRetryable]
})

// The one retry policy the declared ladder and the running tier both spend, so
// a chain never declares a wait it does not take or a tag it does not honour.
const retryPolicy = (bounds: Bounds): WithRetry.Options => ({
  attempts: bounds.maxAttempts,
  backoff: bounds.backoff,
  nonRetryable: bounds.nonRetryable
})

const copiedBudget = (budget: Budget | undefined): Budget | undefined =>
  budget === undefined ? undefined : { ...budget }

const refuse = (code: DelegationErrorCode, message: string): DelegationError =>
  new DelegationError({ code, path: "root", message })

const isPatternError = (error: unknown): error is PatternError => error instanceof PatternError

const checkBounds = (
  bounds: Bounds & { readonly concurrency?: number | undefined },
  tiers: ReadonlyArray<string>
): DelegationError | undefined => {
  if (!positive(bounds.maxDepth) || !positive(bounds.maxDeriskRounds) || !positive(bounds.maxAttempts)) {
    return refuse("invalid_bounds", "maxDepth, maxDeriskRounds, and maxAttempts must be positive safe integers")
  }
  if (bounds.concurrency !== undefined && !positive(bounds.concurrency)) {
    return refuse(
      "invalid_bounds",
      `Delegation concurrency must be a positive safe integer, received ${bounds.concurrency}`
    )
  }
  const backoff = bounds.backoff
  if (
    backoff !== undefined &&
    (!Number.isFinite(backoff.initialMs) || backoff.initialMs <= 0 ||
      !Number.isFinite(backoff.factor) || backoff.factor < 1 ||
      !Number.isFinite(backoff.maxMs) || backoff.maxMs < backoff.initialMs)
  ) {
    return refuse(
      "invalid_bounds",
      "backoff must declare a positive initialMs, a factor of at least 1, and a maxMs of at least initialMs"
    )
  }
  if (bounds.tierOrder.length === 0) {
    return refuse("invalid_bounds", "tierOrder must name at least one tier, weakest first")
  }
  const missing = bounds.tierOrder.filter((tier) => !tiers.includes(tier))
  if (missing.length > 0) {
    return refuse("missing_tier", `execute has no flow for tier ${missing.join(", ")}`)
  }
  return undefined
}

/**
 * Reads the acceptance vocabulary both house patterns use: `true`,
 * `"approved"`, `{ approved: true }`, or `{ accepted: true }`.
 *
 * @category predicates
 * @since 0.1.0
 */
export const accepted = Compose.accepted

/**
 * The number of flow calls {@link make} declares, counting only the calls the
 * chain itself contributes.
 *
 * Four calls are fixed: refine, the derisk loop, the chain review, and settle.
 * The derisk loop adds two calls per round minus the revision the last round
 * never makes, and each of the `maxDepth` leaf slots adds a retry decorator and
 * a retry declaration, then, for each of the `maxAttempts` attempts the retry
 * declares, a tier ladder and one execute plus one review call per tier. A
 * supplied flow whose own body calls other flows adds those on top.
 *
 * @category introspection
 * @since 0.1.0
 */
export const bound = (options: Bounds): number =>
  4 + 2 * options.maxDeriskRounds + options.maxDepth * (2 + options.maxAttempts * (1 + 2 * options.tierOrder.length))

/**
 * The declared form of a delegation chain.
 *
 * @category models
 * @since 0.1.0
 */
export type DelegationChainFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * The leaf a slot declares. A declaration cannot know the goals a model has not
 * authored yet, so the authored plan stands in for the goal and the slot names
 * the path, which is the `Trellis.Leaf` shape {@link run} hands every tier.
 */
const slotLeaf = (slot: number, plan: unknown): { readonly goal: unknown; readonly path: string } => ({
  goal: plan,
  path: `slot-${slot}`
})

/**
 * One rung of a declared ladder: the tier call, then the review of what that
 * tier produced, then the next rung.
 *
 * The review's verdict is a `Node.branch`, so the plan carries the settled arm
 * and the next rung before anything runs and the decision is taken at run time
 * on the output the tier really produced. {@link run} spends the same rule.
 */
const rung = <R>(
  options: MakeOptions<R>,
  slot: number,
  leaf: { readonly goal: unknown; readonly path: string },
  goal: unknown,
  index: number
): Node.Node<unknown, unknown, R> => {
  const tier = options.tierOrder[index]
  if (tier === undefined) return Node.succeed({ accepted: false, exhausted: true })
  const work = {
    leaf,
    tier,
    goal,
    ...(options.budget === undefined ? {} : { budget: options.budget })
  }
  return Node.bindPlanned(
    callMember(options.execute[tier] as Member<R>, work),
    Node.capture({ slot, tier }, (output: Planned.Planned<unknown>) => {
      const approved = Node.capture({ slot, tier }, (decision: unknown) => accepted(decision))
      return Node.branch(callMember(options.review, { stage: "leaf", leaf, tier, output }), {
        if: approved,
        then: () => Node.succeed(output),
        else: () => rung(options, slot, leaf, goal, index + 1)
      })
    })
  )
}

/**
 * The payload one declared tier ladder takes: the leaf slot it settles.
 *
 * @since 0.1.0
 * @private
 */
const LadderPayload = Schema.Struct({ goal: Schema.Unknown, path: Schema.String })

/**
 * One slot's retried tier ladder.
 *
 * The ladder is declared here rather than with `Escalation.make` because that
 * constructor asks one shared `accept` flow about every rung, and the review
 * `run` performs carries the tier that produced the output. The topology is the
 * same: one call per rung, one review per rung, weakest first.
 */
const ladder = <R>(
  options: MakeOptions<R>,
  slot: number,
  leaf: { readonly goal: unknown; readonly path: string },
  goal: unknown
): Flow.Any =>
  WithRetry.withRetry(
    Flow.make(`delegationTiers(${options.tierOrder.join(" -> ")})`, {
      payload: LadderPayload,
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: Node.capture(
        { slot, tierOrder: [...options.tierOrder] },
        () => rung(options, slot, leaf, goal, 0)
      )
    }),
    retryPolicy(options)
  )

/**
 * Declares the conservative chain topology.
 *
 * The declaration is what the plan can never exceed: the derisk loop is
 * unrolled to `maxDeriskRounds`, and execution declares `maxDepth` tier ladders
 * because a declaration cannot know how wide the plan a model has not authored
 * yet will be. Each declared call carries the payload {@link run} sends, with
 * the authored plan standing in for the leaf goals nothing knows yet.
 *
 * Use {@link run} to execute the real chain. Very large depth and derisk-round
 * bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(caller: MakeOptions<R>): DelegationChainFlow<R> => {
  // The body runs when the graph builds, later than this call, and the
  // ladders it declares read the options again then, so every stage below
  // reads this snapshot and never the caller's options.
  const options: MakeOptions<R> = {
    ...copiedBounds(caller),
    refine: caller.refine,
    plan: caller.plan,
    derisk: caller.derisk,
    execute: { ...caller.execute },
    review: caller.review,
    settle: caller.settle,
    budget: copiedBudget(caller.budget)
  }
  const refusal = checkBounds(options, Object.keys(options.execute))
  if (refusal !== undefined) throw refusal
  const derisk = ReviewLoop.make<R>({
    produce: options.plan,
    review: options.derisk,
    revise: options.plan,
    maxRounds: options.maxDeriskRounds
  })
  const captured = {
    tierOrder: [...options.tierOrder],
    maxDepth: options.maxDepth,
    maxDeriskRounds: options.maxDeriskRounds,
    maxAttempts: options.maxAttempts,
    budget: options.budget ?? null
  }
  const { name, description } = Compose.label("delegationChain", {
    tierOrder: captured.tierOrder,
    maxDepth: captured.maxDepth
  }, caller)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> =>
    Node.bindPlanned(
      callMember(options.refine, { prompt: input }),
      Node.capture(captured, (goal: Planned.Planned<unknown>) =>
        Node.bindPlanned(
          // The derisk loop states its own seed as one `input` field, so the
          // planner it wraps is still handed `{ goal, round }` unchanged.
          callMember(derisk, { input: { goal, round: 1 } }),
          Node.capture(captured, (plan: Planned.Planned<unknown>) => {
            const call = (index: number): Node.Node<unknown, unknown, R> =>
              Decorate.call<R>(ladder(options, index, slotLeaf(index, plan), goal), slotLeaf(index, plan))
            let slots: Node.Node<unknown, unknown, R> = call(0)
            for (let index = 1; index < options.maxDepth; index++) {
              slots = Node.andThen(slots, call(index))
            }
            return Node.bindPlanned(
              slots,
              Node.capture(captured, (leaves: Planned.Planned<unknown>) =>
                Node.bindPlanned(
                  callMember(options.review, { stage: "chain", goal, plan, leaves }),
                  Node.capture(captured, (review: Planned.Planned<unknown>) =>
                    callMember(options.settle, {
                      prompt: input,
                      goal,
                      plan,
                      leaves,
                      review,
                      // A declaration cannot know whether the derisk loop ran
                      // out of rounds. `run` settles with the answer it saw.
                      deriskExhausted: false
                    }))
                ))
            )
          })
        ))
    )
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and
    // declared no error schema. `@smthrs/flow` needs a real one, because the
    // engine encodes a typed failure through it, and a chain fails with
    // whatever the stage it called failed with.
    error: Schema.Unknown,
    body: Node.capture(captured, body)
  })
}

type Attempt =
  | {
    readonly tier: string
    readonly failed: true
    readonly error: unknown
  }
  | {
    readonly tier: string
    readonly failed: false
    readonly output: unknown
    readonly rejected: boolean
  }

const attemptCause = (attempts: ReadonlyArray<Attempt>): ReadonlyArray<Readonly<Record<string, unknown>>> =>
  attempts.map((attempt) =>
    attempt.failed
      ? { tier: attempt.tier, error: attempt.error }
      : { tier: attempt.tier, rejected: attempt.rejected }
  )

/**
 * Runs the chain: refine the prompt into a goal, plan and derisk it, execute
 * every leaf through the tier ladder, review the assembled outputs, settle.
 *
 * The derisk loop stops at the first approved round. Each leaf climbs the tier
 * ladder weakest first, spending `maxAttempts` retries on a tier before the
 * next one is admitted; a tier whose result the review rejects escalates the
 * same way a tier that failed does. Those attempts are immediate unless
 * `backoff` declares the waits between them, and a failure whose `_tag` is
 * listed in `nonRetryable` ends that tier at once and admits the next. Only a reached rung contributes its
 * `result.output`; an exhausted ladder fails `leaf_failed` naming the leaf's
 * plan path, and no later stage runs.
 *
 * `maxDepth` is the whole plan envelope: the derisked plan may hold at most
 * `maxDepth` leaves, nest `maxDepth` levels, and put `maxDepth` members in one
 * container. A wider plan is refused with the `Trellis` code that names the
 * bound it broke.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <Settled, E1, R1, E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>(
  prompt: string,
  caller: RuntimeOptions<Settled, E1, R1, E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>
): Effect.Effect<
  Settled,
  E1 | E2 | E3 | E5 | E6 | DelegationError | Trellis.TrellisError,
  R1 | R2 | R3 | R4 | R5 | R6
> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const options: typeof caller = {
    ...copiedBounds(caller),
    refine: caller.refine,
    plan: caller.plan,
    derisk: caller.derisk,
    execute: { ...caller.execute },
    review: caller.review,
    settle: caller.settle,
    budget: copiedBudget(caller.budget),
    concurrency: caller.concurrency
  }
  const retry = retryPolicy(options)
  return Effect.gen(function*() {
    const refusal = checkBounds(options, Object.keys(options.execute))
    if (refusal !== undefined) return yield* Effect.fail(refusal)
    const envelope: Trellis.Envelope = {
      fuel: options.maxDepth,
      depth: options.maxDepth,
      fanout: options.maxDepth
    }
    const goal = yield* options.refine({ prompt })
    const derisked = yield* ReviewLoop.run(goal, {
      maxRounds: options.maxDeriskRounds,
      produce: () => options.plan({ goal, round: 1 }),
      review: (plan, round) => options.derisk({ goal, plan, round }),
      revise: ({ output, review, round }) => options.plan({ goal, round: round + 1, previous: output, derisk: review })
    }).pipe(
      Effect.catchIf(
        isPatternError,
        (error) => Effect.fail(refuse("derisk_failed", error.message))
      )
    )
    const exhausted = derisked._tag === "Exhausted"
    const authored = derisked.output
    const refusals = Trellis.validate(authored, envelope)
    if (refusals.length > 0) {
      const refusal = refusals[0] as Trellis.TrellisError
      return yield* Effect.fail(
        new Trellis.TrellisError({
          code: refusal.code,
          path: refusal.path,
          message: refusal.message,
          cause: { rounds: [], remaining: envelope.fuel, refusals }
        })
      )
    }
    const plan = authored as Trellis.Plan
    const outputs = new Map<string, unknown>()
    yield* Trellis.execute(plan, {
      concurrency: options.concurrency ?? options.maxDepth,
      leaf: (leaf) => {
        const attempts: Array<Attempt> = []
        return Escalation.run<Trellis.Leaf, Attempt, E5, R4 | R5, never, never>(leaf, {
          rungs: options.tierOrder.map((tier) => (work: Trellis.Leaf) =>
            Effect.matchEffect(
              WithRetry.retryEffect(
                (options.execute[tier] as (work: Work) => Effect.Effect<unknown, E4, R4>)({
                  leaf: work,
                  tier,
                  goal,
                  ...(options.budget === undefined ? {} : { budget: options.budget })
                }),
                retry
              ),
              {
                onFailure: (error) => Effect.succeed<Attempt>({ tier, failed: true, error }),
                onSuccess: (output) =>
                  Effect.map(
                    options.review({ stage: "leaf", leaf, tier, output }),
                    (decision): Attempt => ({ tier, failed: false, output, rejected: !accepted(decision) })
                  )
              }
            ).pipe(
              Effect.tap((attempt) => Effect.sync(() => attempts.push(attempt)))
            )
          ),
          accept: (attempt) => Effect.succeed(!attempt.failed && !attempt.rejected)
        }).pipe(
          Effect.flatMap((reached) =>
            reached.exhausted
              ? Effect.fail(
                new DelegationError({
                  code: "leaf_failed",
                  path: leaf.path,
                  message: `No tier settled the leaf at ${leaf.path} within ${options.maxAttempts} attempts each`,
                  cause: attemptCause(attempts)
                })
              )
              : Effect.succeed(reached.result)
          ),
          // The preceding acceptance predicate admits exactly the successful,
          // non-rejected member of `Attempt`. Escalation's generic predicate
          // cannot carry that refinement into its result type, so retain the
          // proven branch here instead of pretending a failed attempt can pass.
          Effect.tap((attempt) =>
            Effect.sync(() => outputs.set(leaf.path, (attempt as Extract<Attempt, { readonly failed: false }>).output))
          ),
          Effect.catchTag(
            "flows/patterns/PatternError",
            (error) =>
              Effect.fail(
                new DelegationError({
                  code: "leaf_failed",
                  path: leaf.path,
                  message: `No tier settled the leaf at ${leaf.path} within ${options.maxAttempts} attempts each`,
                  cause: error
                })
              )
          )
        )
      }
    })
    const leaves = Trellis.leaves(plan).map((leaf) => outputs.get(leaf.path))
    const review = yield* options.review({ stage: "chain", goal, plan, leaves })
    return yield* options.settle({
      prompt,
      goal,
      plan,
      leaves,
      review,
      deriskExhausted: exhausted
    })
  })
}

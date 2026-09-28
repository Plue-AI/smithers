/**
 * Supervisor pattern: one boss plans, workers execute in parallel, the boss
 * reviews, and only the tasks the review calls retriable are re-delegated.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */

import * as Flow from "@smthrs/flow/Flow"
import * as Stall from "@smthrs/flow/Stall"
import * as Node from "@smthrs/plan/Node"
import type * as Planned from "@smthrs/plan/Planned"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Compose from "./internal/Compose.ts"
import type { Member } from "./internal/Member.ts"
import { call as callMember } from "./internal/Member.ts"
import { OpaqueInput } from "./internal/Payload.ts"
import * as Stalling from "./internal/Stalling.ts"
import { PatternError } from "./PatternError.ts"

/**
 * One unit of delegated work named by the plan.
 *
 * `workerType` selects which worker performs the task; `id` is the identity a
 * review names when it asks for the task to be re-delegated.
 *
 * @category models
 * @since 0.1.0
 */
export interface Task {
  readonly id: string
  readonly workerType: string
}

/**
 * A plan the supervisor delegates from.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly tasks: ReadonlyArray<Task>
}

/**
 * Configuration for {@link make}.
 *
 * Workers are held in a record so their declared keys are stable worker-type
 * identities. The topology comes from the plan's task list, which the flow
 * input carries as `tasks`, and each task is routed to the worker its
 * `workerType` names. Rounds are unrolled at declaration time, so the plan
 * declares `maxRounds` rounds of one call per task and `maxRounds` reviews;
 * {@link run} performs the value-dependent short circuit.
 *
 * `stall` ends the supervision once `stall.rounds` unaccepted rounds in a row
 * left every task with the same outcome (`@smthrs/flow/Stall`): `stop` and
 * `park` settle {@link Exhausted} with `stalled` set, `escalate` fails
 * `PatternError` `stalled`.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly plan: Member<R>
  readonly workers: Readonly<Record<string, Member<R>>>
  readonly review: Member<R>
  readonly finalize: Member<R>
  readonly maxRounds: number
  /** The most tasks one input may name; a longer task list is refused before any call. */
  readonly maxTasks: number
  readonly concurrency: number
  readonly stall?: Stall.Options | undefined
}

/**
 * The result of one worker attempt.
 *
 * A worker failure is captured rather than propagated so the review sees every
 * task's outcome and can decide what to re-delegate.
 *
 * @category models
 * @since 0.1.0
 */
export type Outcome<Out> =
  | {
    readonly _tag: "Done"
    readonly id: string
    readonly workerType: string
    readonly round: number
    readonly output: Out
  }
  | {
    readonly _tag: "Failed"
    readonly id: string
    readonly workerType: string
    readonly round: number
    readonly error: unknown
  }

/**
 * Operational callbacks for {@link run}.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, P extends Plan, Out, Review, Final, E, R, E2, R2, E3, R3, E4, R4> {
  readonly plan: (input: I) => Effect.Effect<P, E, R>
  readonly worker: (args: {
    readonly task: Task
    readonly plan: P
    readonly round: number
    readonly input: I
  }) => Effect.Effect<Out, E2, R2>
  readonly review: (args: {
    readonly plan: P
    readonly results: ReadonlyArray<Outcome<Out>>
    readonly round: number
    readonly input: I
  }) => Effect.Effect<Review, E3, R3>
  readonly finalize: (args: {
    readonly plan: P
    readonly results: ReadonlyArray<Outcome<Out>>
    readonly review: Review
    readonly rounds: number
    readonly input: I
  }) => Effect.Effect<Final, E4, R4>
  readonly maxRounds: number
  /** The most tasks the boss plan may name; a longer plan is refused before any worker runs. */
  readonly maxTasks: number
  readonly concurrency: number
  readonly stall?: Stalling.RuntimeOptions<ReadonlyArray<Outcome<Out>>> | undefined
}

/**
 * A supervision that reached an accepted review and finalized.
 *
 * @category models
 * @since 0.1.0
 */
export interface Completed<Final> {
  readonly exhausted: false
  readonly rounds: number
  readonly final: Final
}

/**
 * A supervision that ran out of rounds, whose last review named nothing to
 * re-delegate, or that stalled (`stalled` set). `finalize` is not called.
 *
 * @category models
 * @since 0.1.0
 */
export interface Exhausted<Review> {
  readonly exhausted: true
  readonly rounds: number
  readonly review: Review
  readonly stalled?: Stall.Stalled | undefined
}

/**
 * The declared form of a supervision.
 *
 * @category models
 * @since 1.0.0
 */
export type SupervisorFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

// Own properties only: an inherited `allDone` or `retriable` is not the
// review's verdict.
const done = (value: unknown): boolean => value === true || Compose.ownTrue(value, "allDone")

const retriable = (value: unknown): ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, "retriable")) return []
  const ids = (value as { readonly retriable: unknown }).retriable
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []
}

/**
 * A round's output signal: every task's latest outcome, without the round it
 * ran in, and an `Error` failure by its name and message, since it has no
 * canonical form to hash.
 */
const unrounded = (results: unknown): unknown =>
  (results as ReadonlyArray<Outcome<unknown>>).map((outcome) => {
    if (outcome._tag === "Done") {
      return { _tag: "Done", id: outcome.id, workerType: outcome.workerType, output: outcome.output }
    }
    const error = outcome.error instanceof Error ? `${outcome.error.name}: ${outcome.error.message}` : outcome.error
    return { _tag: "Failed", id: outcome.id, workerType: outcome.workerType, error }
  })

const unroundedSignal: Stalling.Signal = { name: "unrounded", read: unrounded }

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

// Task lists come from the flow input or from the plan a boss returned, so a
// malformed one is a data fault, not a declaration fault.
const invalid = (message: string): PatternError => new PatternError({ code: "invalid_input", message })

const validateTasks = (input: unknown, maxTasks: number): ReadonlyArray<Task> | PatternError => {
  if (typeof input !== "object" || input === null || !Object.hasOwn(input, "tasks")) {
    return invalid("Supervisor input must contain a tasks array")
  }
  const tasks = (input as { readonly tasks: unknown }).tasks
  if (!Array.isArray(tasks)) return invalid("Supervisor input must contain a tasks array")
  if (tasks.length === 0) return invalid("Supervisor input must contain at least one task")
  // Checked before any task is read or dispatched: a plan is model output, and
  // every task costs one worker call per round.
  if (tasks.length > maxTasks) {
    return invalid(`Supervisor plan names ${tasks.length} tasks, more than maxTasks ${maxTasks}`)
  }
  const snapshot: Array<Task> = []
  for (const task of tasks) {
    const candidate = task as { readonly id?: unknown; readonly workerType?: unknown }
    if (
      typeof task !== "object" || task === null ||
      typeof candidate.id !== "string" || typeof candidate.workerType !== "string"
    ) {
      return invalid("Supervisor tasks must each carry a string id and a string workerType")
    }
    snapshot.push({ id: candidate.id, workerType: candidate.workerType })
  }
  return snapshot
}

const planned = (input: unknown, maxTasks: number): ReadonlyArray<Task> => {
  const result = validateTasks(input, maxTasks)
  if (result instanceof PatternError) throw result
  return result
}

// Only a round after the first reads this, and what it reads is the planned
// reference to the preceding review, so the read always lands on a reference
// and records the path `retriable`.
/** One round's settled state: the latest outcome per task, and the review's view of it. */
interface Round {
  readonly latest: Readonly<Record<string, Outcome<unknown>>>
  readonly results: ReadonlyArray<Outcome<unknown>>
}

/** What one round folds: its batches, the outcomes before it, and who was pending. */
interface Folding {
  readonly batched: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly latest: Readonly<Record<string, Outcome<unknown>>>
  readonly pending: ReadonlyArray<string> | null
}

const retriableOf = (review: unknown): unknown => (review as { readonly retriable?: unknown }).retriable

/**
 * Builds the supervision topology: one plan call, then per round one call per
 * planned task bounded by `concurrency`, one review, and the finalize call the
 * review's accepted arm makes.
 *
 * The task list comes from the flow input's `tasks`, so it is known while
 * planning, and each task is routed to the worker its `workerType` names. Every
 * round after the first carries the preceding review and its `retriable` ids
 * into each worker call, so the graph shows which review a re-delegation
 * depends on.
 *
 * Every call carries a `phase` so a built graph names what each node does.
 * The plan is a superset of any single execution, and every run-time decision
 * is a `Node.branch` on the real value, so an executed declaration makes the
 * calls {@link run} makes and settles to the same result: a typed worker
 * failure is a `Failed` outcome, only the tasks a review names retriable run
 * again, and an accepted review finalizes to `{ exhausted: false, rounds,
 * final }` while a spent bound or a review naming nothing retriable settles
 * `{ exhausted: true, rounds, review }` without finalizing.
 *
 * Building the flow throws a `PatternError` with code `invalid_input` when
 * the input carries no `tasks` array, when it is empty or longer than
 * `maxTasks`, when a task is missing a string `id` or `workerType`, when two
 * tasks share an id, or when a `workerType` names no declared worker. A bound out of range or an empty
 * worker record is refused with `invalid_decorator`.
 *
 * `make` snapshots the boss flows, the worker record, and every bound at the
 * call, so a later edit to the caller's options does not change the
 * declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): SupervisorFlow<R> => {
  const workers = Object.entries(options.workers)
  if (workers.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "Supervisor requires at least one worker" })
  }
  if (!bound(options.maxRounds)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Supervisor maxRounds must be a positive safe integer"
    })
  }
  if (!bound(options.concurrency)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Supervisor concurrency must be a positive safe integer"
    })
  }
  if (!bound(options.maxTasks)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "Supervisor maxTasks must be a positive safe integer"
    })
  }
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again. The worker record
  // is copied as own data properties, so a prototype-shaped worker type still
  // routes.
  const boss = { plan: options.plan, review: options.review, finalize: options.finalize }
  const routes: Readonly<Record<string, Member<R>>> = Object.fromEntries(workers)
  const maxRounds = options.maxRounds
  const maxTasks = options.maxTasks
  const concurrency = options.concurrency
  const names = workers.map(([name]) => name)
  const stall = Stalling.resolve("Supervisor", options.stall)
  if (stall instanceof PatternError) throw stall
  const captures = stall === undefined
    ? { maxRounds, concurrency, workers: names }
    : { maxRounds, concurrency, workers: names, stall }
  const { name, description } = Compose.label(
    "supervisor",
    { workers: names, maxRounds, concurrency, stall: Stalling.labelOf(stall) },
    options
  )
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const tasks = planned(input, maxTasks)
    const ids = tasks.map((task) => task.id)
    if (new Set(ids).size !== ids.length) throw invalid("Supervisor task ids must be unique")
    for (const task of tasks) {
      if (!Object.hasOwn(routes, task.workerType)) {
        throw invalid(`Supervisor has no worker named "${task.workerType}"`)
      }
    }
    return Node.bindPlanned(
      callMember(boss.plan, { phase: "plan", input }),
      Node.capture({ ...captures, tasks: ids }, (plan) => {
        const work = (task: Task, round: number, review: unknown): Record<string, unknown> =>
          round === 1
            ? { phase: "work", task, round, plan, input }
            : { phase: "work", task, round, plan, input, review, retriable: retriableOf(review) }
        const batches: Array<ReadonlyArray<Task>> = []
        for (let offset = 0; offset < tasks.length; offset += concurrency) {
          batches.push(tasks.slice(offset, offset + concurrency))
        }
        // One attempt settles to the same `Outcome` `run` records: a typed
        // worker failure is a `Failed` outcome, not the supervision's failure.
        // After round one, the call is the live arm of a branch on the real
        // pending set, so only the tasks the review named retriable run again.
        const attempt = (
          task: Task,
          round: number,
          review: unknown,
          pending: Planned.Planned<ReadonlyArray<string>> | undefined
        ): Node.Node<unknown, unknown, R> => {
          const tagged = { round, task: task.id }
          const settled = Node.catch(
            Node.map(
              callMember(routes[task.workerType]!, work(task, round, review)),
              Node.capture(tagged, (output: unknown): Outcome<unknown> => ({
                _tag: "Done",
                id: task.id,
                workerType: task.workerType,
                round,
                output
              }))
            ),
            {
              onFailure: Node.capture(
                tagged,
                (error: unknown) =>
                  Node.succeed({ _tag: "Failed", id: task.id, workerType: task.workerType, round, error })
              )
            }
          )
          if (pending === undefined) return settled
          return Node.branch(Node.succeed(pending), {
            if: Node.capture(tagged, (ids: ReadonlyArray<string>) => ids.includes(task.id)),
            then: () => settled,
            else: () => Node.succeed(null)
          })
        }
        const delegate = (
          round: number,
          review: unknown,
          pending: Planned.Planned<ReadonlyArray<string>> | undefined
        ): Node.Node<unknown, unknown, R> => {
          const visitBatch = (
            index: number,
            carried: ReadonlyArray<Planned.Planned<Readonly<Record<string, unknown>>>>
          ): Node.Node<unknown, unknown, R> => {
            const batch = batches[index]
            if (batch === undefined) return Node.succeed(carried)
            const members = Object.fromEntries(
              batch.map((task) => [task.id, attempt(task, round, review, pending)])
            ) as Record<string, Node.Node<unknown, unknown, R>>
            return Node.bindPlanned(
              Node.all(members),
              Node.capture({ round, batch: index }, (reference) =>
                Node.andThen(
                  Node.succeed(reference),
                  visitBatch(index + 1, [...carried, reference])
                ))
            )
          }
          return visitBatch(0, [])
        }
        // Folds a round's batches over the latest outcome of every task: a
        // task that did not run this round keeps its earlier outcome.
        const fold = (
          round: number,
          batched: unknown,
          latest: unknown,
          pending: unknown
        ): Node.Node<Round, unknown, R> =>
          Node.map(
            // Planned references resolve to the real values at run time.
            Node.succeed({ batched, latest, pending } as Folding),
            Node.capture({ ...captures, round, fold: true }, (state: Folding): Round => {
              const merged = new Map(Object.entries(state.latest))
              for (const outcomes of state.batched) {
                for (const id of Object.keys(outcomes)) {
                  if (state.pending === null || state.pending.includes(id)) {
                    merged.set(id, outcomes[id] as Outcome<unknown>)
                  }
                }
              }
              return {
                latest: Object.fromEntries(merged),
                results: ids.map((id) => merged.get(id)!)
              }
            })
          )
        const visit = (
          round: number,
          previous: unknown,
          pending: Planned.Planned<ReadonlyArray<string>> | undefined,
          latest: unknown,
          streaks: unknown
        ): Node.Node<unknown, unknown, R> =>
          Node.bindPlanned(
            delegate(round, previous, pending),
            Node.capture({ ...captures, round }, (batched) =>
              Node.bindPlanned(
                fold(round, batched, latest, pending ?? null),
                Node.capture({ ...captures, round }, (state: Planned.Planned<Round>) =>
                  Node.branch(
                    callMember(boss.review, { phase: "review", round, plan, results: state.results, input }),
                    {
                      if: Node.capture({ ...captures, round }, (review: unknown) => done(review)),
                      then: (review) =>
                        Node.bindPlanned(
                          callMember(boss.finalize, {
                            phase: "finalize",
                            rounds: round,
                            plan,
                            results: state.results,
                            review,
                            input
                          }),
                          Node.capture(
                            { ...captures, round },
                            (final) => Node.succeed({ exhausted: false, rounds: round, final })
                          )
                        ),
                      else: (review) => {
                        const exhausted = (): Node.Node<unknown, unknown, R> =>
                          Node.succeed({ exhausted: true, rounds: round, review })
                        if (round >= maxRounds) return exhausted()
                        const redelegate = (carried: unknown): Node.Node<unknown, unknown, R> => {
                          const next = Node.map(
                            Node.succeed(review),
                            Node.capture(
                              { ...captures, round, retriable: true },
                              (value: unknown) => ids.filter((id) => retriable(value).includes(id))
                            )
                          )
                          return Node.bindPlanned(
                            next,
                            Node.capture({ ...captures, round }, (named: Planned.Planned<ReadonlyArray<string>>) =>
                              Node.branch(Node.succeed(named), {
                                if: Node.capture(
                                  { ...captures, round, retriable: true },
                                  (value: ReadonlyArray<string>) => value.length === 0
                                ),
                                then: exhausted,
                                else: () => visit(round + 1, review, named, state.latest, carried)
                              }))
                          )
                        }
                        if (stall === undefined) return redelegate(streaks)
                        // The round's results are the stall signal, compared
                        // without the round each outcome ran in.
                        return Stalling.guard(
                          "Supervisor",
                          stall,
                          { ...captures, round },
                          state.results,
                          streaks as Stall.State,
                          unroundedSignal,
                          {
                            settle: (stalled) =>
                              Node.succeed({ exhausted: true, rounds: round, review, stalled }),
                            next: redelegate
                          }
                        )
                      }
                    }
                  ))
              ))
          )
        return visit(1, undefined, undefined, {}, Stall.initial)
      })
    )
  }
  return Flow.make(name, {
    ...(description === undefined ? {} : { description }),
    payload: OpaqueInput,
    success: Schema.Unknown,
    // `@smthrs/core` carried its error type as a phantom parameter and declared
    // no error schema. `@smthrs/flow` needs a real one, because the engine
    // encodes a typed failure through it, and a supervision fails with whatever
    // the boss or worker it called failed with.
    error: Schema.Unknown,
    body: Node.capture(captures, body)
  })
}

/**
 * Runs a supervision: plan once, then per round delegate the pending tasks
 * with bounded concurrency, review every task's latest outcome, and either
 * finalize or re-delegate the tasks the review named retriable.
 *
 * A typed worker failure is captured as a `Failed` outcome instead of failing
 * the supervision, so the review decides whether the task is worth another
 * round. Only a typed failure is an outcome: a worker defect, like an
 * interruption, fails the supervision and cancels the workers still in flight.
 * The supervision ends as {@link Exhausted} when the round bound is reached or
 * when an unaccepted review names no retriable task, because nothing is left
 * to re-delegate.
 *
 * `run` fails with a `PatternError` when the plan is malformed, empty, names
 * more than `maxTasks` tasks (checked before any worker runs), or repeats a
 * task id. Outcomes are keyed by task id, so a repeated id would
 * delegate twice and hand the review the same outcome twice.
 *
 * `run` snapshots every callback and every bound at the call, so a later
 * edit to the option object does not alter that run. The plan a `plan`
 * callback returns is copied task by task when it is validated.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, P extends Plan, Out, Review, Final, E, R, E2, R2, E3, R3, E4, R4>(
  input: I,
  options: RuntimeOptions<I, P, Out, Review, Final, E, R, E2, R2, E3, R3, E4, R4>
): Effect.Effect<Completed<Final> | Exhausted<Review>, E | E3 | E4 | PatternError, R | R2 | R3 | R4> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the option object in between must not reach it.
  const boss = { plan: options.plan, review: options.review, finalize: options.finalize }
  const worker = options.worker
  const maxRounds = options.maxRounds
  const maxTasks = options.maxTasks
  const concurrency = options.concurrency
  if (!bound(maxRounds) || !bound(maxTasks) || !bound(concurrency)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "Supervisor maxRounds, maxTasks and concurrency must be positive safe integers"
      })
    )
  }
  const stall = Stalling.resolve("Supervisor", options.stall)
  if (stall instanceof PatternError) return Effect.fail(stall)
  const signals = options.stall?.signals ?? ((results: ReadonlyArray<Outcome<Out>>) => ({ output: unrounded(results) }))
  return Effect.gen(function*() {
    const observe = Stalling.tracker(stall, signals)
    const plan = yield* boss.plan(input)
    const tasks = validateTasks(plan, maxTasks)
    if (tasks instanceof PatternError) return yield* Effect.fail(tasks)
    const ids = tasks.map((task) => task.id)
    if (new Set(ids).size !== ids.length) {
      return yield* Effect.fail(
        invalid("Supervisor task ids must be unique")
      )
    }
    const latest = new Map<string, Outcome<Out>>()
    const supervise = (
      pending: ReadonlyArray<Task>,
      round: number
    ): Effect.Effect<Completed<Final> | Exhausted<Review>, E3 | E4 | PatternError, R2 | R3 | R4> =>
      Effect.gen(function*() {
        const outcomes = yield* Effect.forEach(
          pending,
          (task) =>
            worker({ task, plan, round, input }).pipe(
              Effect.map((output): Outcome<Out> => ({
                _tag: "Done",
                id: task.id,
                workerType: task.workerType,
                round,
                output
              })),
              Effect.catch((error): Effect.Effect<Outcome<Out>> =>
                Effect.succeed({
                  _tag: "Failed",
                  id: task.id,
                  workerType: task.workerType,
                  round,
                  error
                })
              )
            ),
          { concurrency }
        )
        for (const outcome of outcomes) latest.set(outcome.id, outcome)
        // Round one visits every task and later rounds only replace entries,
        // so `latest` contains one outcome for every validated task here.
        const results = tasks.map((task) => latest.get(task.id)!)
        const review = yield* boss.review({ plan, results, round, input })
        if (done(review)) {
          const final = yield* boss.finalize({ plan, results, review, rounds: round, input })
          return { exhausted: false, rounds: round, final } satisfies Completed<Final>
        }
        if (round === maxRounds) return { exhausted: true, rounds: round, review } satisfies Exhausted<Review>
        const stalled = observe(results)
        if (stalled !== undefined) {
          if (stalled.on === "escalate") return yield* Effect.fail(Stalling.escalated("Supervisor", stalled.rounds))
          return { exhausted: true, rounds: round, review, stalled } satisfies Exhausted<Review>
        }
        const ids = retriable(review)
        const next = tasks.filter((task) => ids.includes(task.id))
        if (next.length === 0) return { exhausted: true, rounds: round, review } satisfies Exhausted<Review>
        return yield* supervise(next, round + 1)
      })
    return yield* supervise(tasks, 1)
  })
}

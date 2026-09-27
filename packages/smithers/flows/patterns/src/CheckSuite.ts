/**
 * Check-suite pattern: run independent checks with bounded concurrency and
 * reduce their rows to one verdict.
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
 * How per-check outcomes reduce to one verdict.
 *
 * @category models
 * @since 0.1.0
 */
export type Strategy = "all-pass" | "majority" | "any-pass"

/**
 * The declared form of a check suite.
 *
 * @category models
 * @since 0.1.0
 */
export type CheckSuiteFlow<R = never> = Flow.Flow<
  string,
  typeof OpaqueInput,
  typeof Schema.Unknown,
  typeof Schema.Unknown,
  R
>

/**
 * Configuration for {@link make}.
 *
 * `checks` is keyed by check id, so two checks cannot share an id, and the
 * checks run in the record's key order.
 *
 * `continueOnFail` changes the declared topology as well as the run: a
 * tolerant suite joins its checks with {@link Quarantine.all} under the
 * `quarantine` policy, so the declaration carries one recovery arm per check
 * and the join cannot fail on a check's behalf. The option is captured too, so
 * a tolerant suite and a fail-fast suite have different step identity.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
  readonly name?: string | undefined
  readonly description?: string | undefined
  readonly checks: Readonly<Record<string, Member<R>>>
  readonly strategy: Strategy
  readonly concurrency: number
  readonly continueOnFail: boolean
}

/**
 * One check's classified outcome, with its original error when available.
 *
 * @category models
 * @since 0.1.0
 */
export interface CheckResult {
  readonly id: string
  readonly passed: boolean
  readonly error?: unknown
}

/**
 * The reduced suite outcome. `errors` retains errors by check id, including
 * falsy tolerated errors; checks without an error have no entry. Diagnostics
 * do not affect the verdict decision.
 *
 * @category models
 * @since 0.1.0
 */
export interface Verdict {
  readonly passed: ReadonlyArray<string>
  readonly failed: ReadonlyArray<string>
  readonly errors: Readonly<Record<string, unknown>>
  readonly strategy: Strategy
  readonly verdict: boolean
}

/**
 * Operational callbacks for {@link run}.
 *
 * `checks` is keyed by check id, so two checks cannot share an id, and the
 * checks run in the record's key order.
 *
 * @category models
 * @since 0.1.0
 */
export interface RuntimeOptions<I, Out, E, R> {
  readonly checks: Readonly<Record<string, (input: I) => Effect.Effect<Out, E, R>>>
  readonly strategy: Strategy
  readonly concurrency: number
  readonly continueOnFail: boolean
}

/**
 * Classifies one check's row as a pass.
 *
 * A missing row is a failure: the check produced nothing. A
 * object row fails when it carries `passed: false`, `ok: false`, `failed: true`, or an
 * `error` other than `undefined`, `null`, or `false`. Anything else passes.
 * Quarantine protocol envelopes are interpreted by {@link rows}, where the
 * caller explicitly declares that the record came from a tolerant join.
 *
 * @category introspection
 * @since 0.1.0
 */
export const passed = (row: unknown): boolean => {
  if (row === null || row === undefined) return false
  if (typeof row !== "object") return true
  const record = row as Record<string, unknown>
  if (record.passed === false || record.ok === false || record.failed === true) return false
  return record.error === undefined || record.error === null || record.error === false
}

const classify = (id: string, row: unknown): CheckResult => {
  const result = { id, passed: passed(row) }
  const error = typeof row === "object" && row !== null ? (row as Record<string, unknown>).error : undefined
  return error === undefined || error === null || error === false ? result : { ...result, error }
}

/**
 * Classifies the record a batch of check calls produces.
 *
 * Results follow declaration order, not completion order, so the verdict does
 * not depend on which check finished first.
 *
 * `quarantineOutcomes` defaults to `false`, treating values as plain check
 * rows. Use `rows(values, ids, true)` for {@link Quarantine.all} output under
 * the `quarantine` policy: successful envelopes are unwrapped and quarantined
 * failures retain their original error, including falsy errors. Plain rows
 * retain an `error` other than `undefined`, `null`, or `false`.
 *
 * @category introspection
 * @since 0.1.0
 */
export const rows = (
  values: unknown,
  ids: ReadonlyArray<string>,
  quarantineOutcomes = false
): ReadonlyArray<CheckResult> => {
  const record = (typeof values === "object" && values !== null ? values : {}) as Record<string, unknown>
  return ids.map((id) => {
    if (!Object.hasOwn(record, id)) return { id, passed: false }
    const row = record[id]
    if (!quarantineOutcomes) return classify(id, row)
    if (Quarantine.isSucceeded(row)) return classify(id, row.value)
    if (Quarantine.isQuarantined(row)) return { id, passed: false, error: row.error }
    return { id, passed: false }
  })
}

/**
 * Reduces classified check results to one verdict under a strategy.
 *
 * An empty suite never passes: `all-pass` has nothing to pass, and `any-pass`
 * and `majority` have no passing check to point at.
 *
 * @category combinators
 * @since 0.1.0
 */
export const verdict = (results: ReadonlyArray<CheckResult>, strategy: Strategy): Verdict => {
  const passing = results.filter((result) => result.passed).map((result) => result.id)
  const failing = results.filter((result) => !result.passed).map((result) => result.id)
  const total = results.length
  const decided = strategy === "any-pass"
    ? passing.length > 0
    : strategy === "majority"
    ? passing.length * 2 > total && total > 0
    : total > 0 && passing.length === total
  const errors = Object.fromEntries(
    results.filter((result) => Object.hasOwn(result, "error")).map((result) => [result.id, result.error])
  )
  return { passed: passing, failed: failing, errors, strategy, verdict: decided }
}

const bound = (value: number): boolean => Number.isSafeInteger(value) && value >= 1

/**
 * Builds the check-suite topology: one call per check, batched into `Node.all`
 * groups of `concurrency` members, then one pure verdict map.
 *
 * Every declared check reaches the graph, so `make` throws a `PatternError`
 * when the record is empty, when an id is the empty string, or when
 * `concurrency` is not a positive safe integer. Keying `checks` by id is what
 * rules out a duplicate: a repeated id could otherwise overwrite the earlier
 * check's member and drop it from the plan.
 *
 * `continueOnFail` picks the join. A tolerant suite joins each batch with
 * {@link Quarantine.all} under the `quarantine` policy: every check gains a
 * recovery arm, and every check settles in an explicit
 * {@link Quarantine.Settled} envelope. {@link rows} unwraps successful rows
 * and classifies quarantined failures. A fail-fast suite joins under `halt`,
 * which is the plain `Node.all` that fails on the first failing member and
 * interrupts the rest.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = <R = never>(options: MakeOptions<R>): CheckSuiteFlow<R> => {
  // The body runs when the graph builds, later than this call, so it reads
  // these snapshots and never the caller's options again.
  const declared = Object.entries(options.checks)
  const strategy = options.strategy
  const concurrency = options.concurrency
  const continueOnFail = options.continueOnFail
  if (declared.length === 0) {
    throw new PatternError({ code: "invalid_decorator", message: "CheckSuite requires at least one check" })
  }
  if (!bound(concurrency)) {
    throw new PatternError({
      code: "invalid_decorator",
      message: "CheckSuite concurrency must be a positive safe integer"
    })
  }
  const ids = declared.map(([id]) => id)
  if (ids.some((id) => id === "")) {
    throw new PatternError({ code: "invalid_decorator", message: "CheckSuite check ids must not be empty" })
  }
  const captures = {
    checks: ids,
    strategy,
    concurrency,
    continueOnFail
  }
  const { name, description } = Compose.label("checkSuite", { checks: ids, strategy, concurrency }, options)
  const body = ({ input }: { readonly input: unknown }): Node.Node<unknown, unknown, R> => {
    const batchAt = (offset: number): Node.Node<unknown, unknown, R> => {
      const members = Object.fromEntries(
        declared.slice(offset, offset + concurrency).map(([id, check]) => [
          id,
          callMember(check, { check: id, input })
        ])
      ) as Record<string, Node.Any>
      return continueOnFail
        ? Quarantine.all(members, { policy: "quarantine" })
        : Quarantine.all(members, { policy: "halt" })
    }
    // Each batch gates the next, and the rows a batch produced are carried on
    // as planned field references: a batch's result does not exist while the
    // graph builds, so the suite assembles the record the verdict reads rather
    // than merging two symbols.
    const visit = (
      offset: number,
      carried: Readonly<Record<string, Planned.Planned<unknown>>>
    ): Node.Node<unknown, unknown, R> => {
      if (offset >= declared.length) {
        return Node.map(
          Node.succeed(carried),
          Node.capture(captures, (values) => verdict(rows(values, ids, continueOnFail), strategy))
        )
      }
      const batched = ids.slice(offset, offset + concurrency)
      return Node.bindPlanned(
        batchAt(offset),
        Node.capture({ offset, batched }, (reference) =>
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
 * Runs the checks with bounded concurrency and returns the verdict.
 *
 * With `continueOnFail: false` the first failing check fails the suite and the
 * remaining checks do not run. With `continueOnFail: true` every check runs and
 * a failed one is listed in the verdict's `failed`, with its original error
 * retained in `errors` under its id. A check that succeeds but
 * returns a failure row is always listed in `failed`; it does not fail the
 * suite, because the row is the check's answer, not an error.
 *
 * `continueOnFail` tolerates a typed check failure. A check that throws
 * raises a defect, which fails the suite under either setting and cancels
 * the checks still in flight.
 *
 * `run` rejects the same suites `make` rejects, and it rejects them before any
 * check runs: an empty record, an empty check id, and a `concurrency` that is
 * not a positive safe integer each fail with a `PatternError`. An empty record
 * would otherwise return a false verdict, which reads like a failing suite
 * rather than like a misconfigured one. Keying `checks` by id rules out a
 * duplicate, which would otherwise list the same check twice in the verdict.
 *
 * @category combinators
 * @since 0.1.0
 */
export const run = <I, Out, E, R>(
  input: I,
  options: RuntimeOptions<I, Out, E, R>
): Effect.Effect<Verdict, E | PatternError, R> => {
  // Snapshots taken at the call: the effect may run later, and a caller's
  // edit to the record or the option object in between must not reach it.
  const declared = Object.entries(options.checks)
  const strategy = options.strategy
  const concurrency = options.concurrency
  const continueOnFail = options.continueOnFail
  if (declared.length === 0) {
    return Effect.fail(
      new PatternError({ code: "invalid_decorator", message: "CheckSuite requires at least one check" })
    )
  }
  if (!bound(concurrency)) {
    return Effect.fail(
      new PatternError({
        code: "invalid_decorator",
        message: "CheckSuite concurrency must be a positive safe integer"
      })
    )
  }
  if (declared.some(([id]) => id === "")) {
    return Effect.fail(
      new PatternError({ code: "invalid_decorator", message: "CheckSuite check ids must not be empty" })
    )
  }
  return Effect.map(
    Effect.forEach(
      declared,
      ([id, check]): Effect.Effect<CheckResult, E, R> => {
        const attempt = Effect.map(check(input), (row) => classify(id, row))
        return continueOnFail
          ? Effect.catch(attempt, (error) => Effect.succeed({ id, passed: false, error }))
          : attempt
      },
      { concurrency }
    ),
    (results) => verdict(results, strategy)
  )
}

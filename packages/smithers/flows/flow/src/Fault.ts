/**
 * One typed fault for every failure, and the one response table that reads it.
 *
 * Each owner of an error union registers its codes here with a class, so a
 * failure crosses every seam as `{ class, tag }` rather than as prose. The
 * control plane stamps it on a failed run, the gateway carries it to the
 * worker, and every surface reads the same record.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"
import type { HumanAnswerInvalid, HumanTaskFailed } from "./HumanTask.ts"
import { errorTag } from "./RetryPolicy.ts"

/**
 * Whose problem a failure is. The first five are the wire registry; `factory`
 * (the factory's own work failed and a replan may fix it) and `policy` (a cap
 * stopped it) are the factory's.
 *
 * @category models
 * @since 1.0.0
 */
export const Class = Schema.Literals(["user", "wait", "infra", "dependency", "bug", "factory", "policy"])

/**
 * The decoded form of {@link Class}.
 *
 * @category models
 * @since 1.0.0
 */
export type Class = typeof Class.Type

/**
 * What happens next. `very_hard` is a ladder state the worker reaches, not a class.
 *
 * @category models
 * @since 1.0.0
 */
export const Response = Schema.Literals(["retry", "backup", "park", "replan", "very_hard", "help", "close", "stop"])

/**
 * The decoded form of {@link Response}.
 *
 * @category models
 * @since 1.0.0
 */
export type Response = typeof Response.Type

/**
 * The record stamped on a failed run. `tag` is `<_tag>/<code>`, or `<_tag>`
 * for an error without a code.
 *
 * @category models
 * @since 1.0.0
 */
export const Fault = Schema.Struct({ class: Class, tag: Schema.String })

/**
 * The decoded form of {@link Fault}.
 *
 * @category models
 * @since 1.0.0
 */
export type Fault = typeof Fault.Type

/**
 * One class per code of an owner's union. `satisfies Rows<Code>` at the owner
 * makes a new code without a class a compile error.
 *
 * @category models
 * @since 1.0.0
 */
export type Rows<Code extends string> = Readonly<Record<Code, Class>>

interface Row {
  readonly table: Class | Readonly<Record<string, Class>>
  readonly field: string
}

/*
 * One registry per process, not per module instance: a process that loads
 * both the ESM and the CommonJS build still reads every owner's rows.
 */
const rows: Map<string, Row> = ((globalThis as { [key: symbol]: Map<string, Row> | undefined })[
  Symbol.for("@smthrs/flow/Fault/rows")
] ??= new Map())

const same = (left: Row, right: Row): boolean =>
  left.field === right.field && JSON.stringify(left.table) === JSON.stringify(right.table)

/** Reads a property without running a throwing getter or proxy trap into the caller. */
const read = (value: object, key: string): unknown => {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

/**
 * Registers an owner's error tag: one class for the whole tag, or one per
 * value of its `field` (`code` unless the union names it otherwise). A value
 * the table does not name is `bug`. Registering a tag again with the same
 * rows is a no-op (a module loaded twice); with different rows it throws,
 * because two owners disagreeing about one tag is a defect.
 *
 * @category constructors
 * @since 1.0.0
 */
export const register = <Code extends string>(tag: string, table: Class | Rows<Code>, field = "code"): void => {
  const row: Row = { table, field }
  const existing = rows.get(tag)
  if (existing !== undefined && !same(existing, row)) {
    throw new Error(`Fault: ${tag} is already registered with different rows`)
  }
  rows.set(tag, row)
}

const classOf = (row: Row, code: string | undefined): Class =>
  typeof row.table === "string" ? row.table : code !== undefined && Object.hasOwn(row.table, code)
    ? row.table[code]!
    : "bug"

/**
 * Every tag registered so far. The sweep test reads it.
 *
 * @category getters
 * @since 1.0.0
 */
export const registered = (): ReadonlySet<string> => new Set(rows.keys())

/**
 * The fault of a failure. Walks `cause` and answers the innermost registered
 * tag, because a wrapper names where a failure surfaced and its cause names
 * why: a harness `model_failed` over a model `quota_exceeded` is a wait. A
 * failure no owner registered is a `bug`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const of = (error: unknown): Fault => {
  let found: Fault = { class: "bug", tag: "unregistered" }
  let current: unknown = error
  const seen = new Set<unknown>()
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null && !seen.has(current); depth++) {
    seen.add(current)
    const tag = errorTag(current)
    const row = tag === undefined ? undefined : rows.get(tag)
    if (row !== undefined) {
      const value = read(current, row.field)
      const code = typeof value === "string" ? value : undefined
      found = { class: classOf(row, code), tag: code === undefined ? tag! : `${tag}/${code}` }
    }
    current = read(current, "cause")
  }
  return found
}

/**
 * What the responder knows when it picks a response.
 *
 * @category models
 * @since 1.0.0
 */
export interface State {
  /** The action attempt that just failed. */
  readonly attempt: number
  /** Seats not tried in this frame and not cooling. */
  readonly seatsLeft: number
  /** Quota parks left before the run stops (`QuotaPolicy.defaultMaxParks` less those spent). */
  readonly parksLeft: number
  /** Replans spent: the worker's attempt minus one. */
  readonly replans: number
  /** Whether the item already had its very-hard continuation. */
  readonly veryHard: boolean
}

/**
 * The one ladder. A new class does not compile until it has a row.
 *
 * @category constructors
 * @since 1.0.0
 */
export const respond = (fault: Fault, state: State): Response =>
  ({
    wait: state.seatsLeft > 0 ? "backup" : state.parksLeft > 0 ? "park" : "stop",
    dependency: state.seatsLeft > 0 ? "backup" : state.attempt < 3 ? "retry" : "stop",
    infra: state.attempt < 3 ? "retry" : "park",
    factory: state.replans < 2 ? "replan" : !state.veryHard ? "very_hard" : "help",
    user: fault.tag === "coding/Error/declined" ? "close" : "help",
    policy: "stop",
    bug: "stop"
  } as const satisfies Record<Class, Response>)[fault.class]

register("@smthrs/flow/InfraInterrupt", "infra")
register("@smthrs/flow/InfraInterruptRetriesExhausted", "infra")
register(
  "@smthrs/flow/HumanTaskFailed",
  {
    rejected: "user",
    timeout: "factory",
    request_invalid: "bug"
  } satisfies Rows<HumanTaskFailed["code"]>
)
register(
  "@smthrs/flow/HumanAnswerInvalid",
  {
    answer_invalid: "user",
    answer_not_open: "user"
  } satisfies Rows<HumanAnswerInvalid["code"]>
)
// A spent polling or retry budget is the thing polled not answering in time.
register("@smthrs/flow/PollExhausted", "dependency")
register("@smthrs/flow/RetryAttemptsExhausted", "dependency")
register("@smthrs/flow/RetryPolicyExpired", "dependency")
// Invariant refusals: the program, not the person or the platform, is wrong.
for (
  const tag of [
    "MaxRoundsExceeded",
    "IrreversibleRetryRequiresIdempotencyKey",
    "WaitForRequestInvalid",
    "SleepRequestInvalid",
    "DurableDeferred/TokenInvalid",
    "ExecutionIdRequired",
    "FlowCycleDetected",
    "CancelRequestFailed",
    "Action/DuplicateImplementation",
    "ConcurrentKeylessDispatch",
    "FlowExecutionNotFound",
    "ImplementationVersionMismatch",
    "UncanonicalIdempotencyKey",
    "InterpreterError"
  ]
) register(`@smthrs/flow/${tag}`, "bug")

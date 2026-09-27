/**
 * Cancellation attribution as the control plane reads it back.
 *
 * A cancellation is durable but anonymous. `flows_runs.cancel_requested_at_ms`
 * records that somebody asked, and nothing in the row records who, why, or
 * whether the run was asked at all rather than swept up in an ancestor's
 * cascade. Three journals hold the missing halves: the control plane's own
 * `control.run.cancel-requested`, the engine's `flows.engine.interrupted`, and
 * the ancestry the run store already keeps. This module folds them into one
 * answer per run.
 *
 * The fold is pure and scope-independent: it reads whatever evidence it is
 * handed and never issues a query, so the caller chooses how much to read.
 * `SqlControlRuntime` uses two scopes. A listing folds the whole database,
 * because every row is going to be answered for anyway. A single-run read
 * folds only that run and its ancestor chain, which is the smallest scope that
 * can still answer the question: cascade is a fact about a run's ancestors, so
 * it cannot be decided one row at a time — a child's cancellation is
 * attributed to whoever asked for its nearest cancelled ancestor's, however
 * many rounds up that is.
 *
 * The two foreign event types are named as strings rather than imported,
 * exactly as in {@link Lineage}: a control plane reads journals, not engines.
 *
 * @since 0.1.0
 */

import type { Cancellation, Principal } from "./ControlSchema.ts"

/**
 * The journal event type the control plane records an attributed cancel under.
 *
 * @category constants
 * @since 0.1.0
 */
export const requestedEventType = "control.run.cancel-requested"

/**
 * The journal event type the engine records an interruption under.
 *
 * @category constants
 * @since 0.1.0
 */
export const interruptedEventType = "flows.engine.interrupted"

/**
 * One attributed cancel request, as the control plane journaled it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Request {
  readonly requestedAt: number
  readonly principal?: Principal | undefined
  readonly reason?: string | undefined
}

/**
 * What one run row discloses about its own cancellation.
 *
 * `cancelRequestedAt` is the run store's unfenced request column, and
 * `cancelledAt` is the moment the engine journaled the interruption. Either
 * one alone is evidence that this run was cancelled, and so is an attributed
 * request naming the run: a control plane that cancels a run it owns
 * interrupts the fiber rather than asking the column, and the journal entry it
 * wrote is the whole record.
 *
 * @category models
 * @since 0.1.0
 */
export interface Evidence {
  readonly runId: string
  readonly parentRunId?: string | undefined
  readonly cancelRequestedAt?: number | undefined
  readonly cancelledAt?: number | undefined
}

/**
 * Everything the fold reads.
 *
 * @category models
 * @since 0.1.0
 */
export interface Input {
  readonly runs: ReadonlyArray<Evidence>
  /** Attributed requests the control plane journaled, by run id. */
  readonly requests: ReadonlyMap<string, Request>
}

const cancelled = (evidence: Evidence, requests: Input["requests"]): boolean =>
  evidence.cancelRequestedAt !== undefined || evidence.cancelledAt !== undefined ||
  requests.has(evidence.runId)

const requestedAtOf = (evidence: Evidence, request: Request | undefined): number => {
  /* v8 ignore next -- the trailing zero is unreachable: a run is attributed only once one of the three sources above exists, which is exactly what `cancelled` reads */
  return request?.requestedAt ?? evidence.cancelRequestedAt ?? evidence.cancelledAt ?? 0
}

const attributed = (
  source: Cancellation["source"],
  requestedAt: number,
  request: Request | undefined,
  cascadedFrom?: string
): Cancellation => ({
  requestedAt,
  source,
  ...(request?.principal === undefined ? {} : { principal: request.principal }),
  ...(request?.reason === undefined ? {} : { reason: request.reason }),
  ...(cascadedFrom === undefined ? {} : { cascadedFrom })
})

/**
 * Attributes every cancelled run in one pass.
 *
 * Three sources, in the order a run's own evidence outranks its ancestors':
 *
 * 1. A `control.run.cancel-requested` entry names this run. Somebody asked for
 *    this run by name, and the entry says who and why.
 * 2. A cancelled ancestor exists. The run was swept up in that cancellation,
 *    so it reports `cascade`, names the ancestor whose request started it, and
 *    inherits that request's principal and reason — the honest answer to "who
 *    cancelled this child" is the operator who cancelled its parent.
 * 3. Neither. The engine cancelled the run on its own account: a lease
 *    expiry, a budget, a supervisor. There is no principal to report, and
 *    inventing one would be worse than saying nothing.
 *
 * The ancestor walk carries a visited set. A cyclic parent chain is not
 * reachable through the engine's cycle detection, but a projection that hung
 * on corrupt ancestry would take the control plane down with it.
 *
 * @param input the run evidence and the attributed requests
 * @category projections
 * @since 0.1.0
 */
export const attribute = (input: Input): ReadonlyMap<string, Cancellation> => {
  const evidence = new Map(input.runs.map((run) => [run.runId, run]))
  const result = new Map<string, Cancellation>()
  for (const run of input.runs) {
    if (!cancelled(run, input.requests)) continue
    const own = input.requests.get(run.runId)
    const requestedAt = requestedAtOf(run, own)
    if (own !== undefined) {
      result.set(run.runId, attributed("control", requestedAt, own))
      continue
    }
    const visited = new Set<string>([run.runId])
    let ancestorId = run.parentRunId
    let cascadedFrom: string | undefined
    let origin: Request | undefined
    while (ancestorId !== undefined && !visited.has(ancestorId)) {
      visited.add(ancestorId)
      const ancestor = evidence.get(ancestorId)
      if (ancestor === undefined) break
      if (cancelled(ancestor, input.requests)) {
        // The nearest cancelled ancestor is the run this one was swept up
        // with; the request that started it may be further up still, because
        // a cascade cascades.
        if (cascadedFrom === undefined) cascadedFrom = ancestorId
        origin = input.requests.get(ancestorId)
        if (origin !== undefined) break
      }
      ancestorId = ancestor.parentRunId
    }
    result.set(
      run.runId,
      cascadedFrom === undefined
        ? attributed("engine", requestedAt, undefined)
        : attributed("cascade", requestedAt, origin, cascadedFrom)
    )
  }
  return result
}

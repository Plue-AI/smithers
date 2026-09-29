/**
 * Deterministic fixed-suite execution and bound scorer evaluation.
 *
 * A run executes every case through the injected {@link CaseExecutor}, then
 * grades each execution with the scorers bound to the flow it executed. The
 * timestamp and the run identity come from the caller, so two runs of the same
 * suite over the same inputs produce byte-identical observations.
 *
 * @since 0.1.0
 */

import * as ScorerRunner from "@smthrs/scorers/Runner"
import * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
import type * as ScoreStore from "@smthrs/scorers/ScoreStore"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { CaseExecutor, type Execution, type Service as CaseExecutorService } from "./CaseExecutor.ts"
import { EvalError } from "./EvalError.ts"
import { flattenControlCharacters } from "./internal/controlCharacters.ts"
import { scorerLabel } from "./internal/scorerLabel.ts"
import { tupleKey } from "./internal/tupleKey.ts"
import type { Binding, Case, Suite } from "./Suite.ts"
import * as Trials from "./Trials.ts"

/**
 * One score observation emitted by a suite run.
 *
 * `scorer` is the scorer key, a digest of the scorer's own declaration, which
 * is what a baseline matches on. `scorerName` is the human name from the same
 * declaration, carried alongside so a report can be read without grepping for
 * the digest. `at` is the run's timestamp, not the scorer's: a run's
 * observations all carry one instant so a baseline stays reproducible.
 *
 * @category models
 * @since 0.1.0
 */
export type Observation =
  & {
    readonly case: string
    readonly scorer: string
    readonly scorerName?: string | undefined
    readonly stepKey: string
    readonly at: string
  }
  & (
    | {
      readonly kind: "score"
      readonly score: number
      readonly reason?: string | undefined
      readonly meta?: unknown
    }
    | { readonly kind: "inconclusive"; readonly reason: string; readonly meta?: unknown }
  )

/**
 * A request sent to the scorers batch runner.
 *
 * @category models
 * @since 0.1.0
 */
export interface ScoreRequest {
  readonly case: string
  readonly stepKey: string
  readonly binding: Binding
  readonly input: {
    readonly input: unknown
    readonly output: unknown
    readonly groundTruth?: unknown
    readonly context?: unknown
    readonly latencyMs?: number
  }
}

/**
 * A blocking scorer job, matching the `Runner` module of `@smthrs/scorers`.
 *
 * @category models
 * @since 0.1.0
 */
export type ScoreJob = ScorerRunner.Job

/**
 * Structural adapter for `@smthrs/scorers`' blocking batch runner.
 *
 * A runner that implements `runBatchCorrelated` tags every observation with
 * its job identity and may return results in any order. A runner that implements
 * only `runBatch` is correlated positionally: it must return exactly one
 * observation per job, in order, and each observation must echo its job's
 * `targetStepKey` and `scorerKey`. A run refuses the order-only protocol before
 * scoring when two jobs share that pair, because their results could not be
 * attributed to a case.
 *
 * A run fails with `scorer_protocol` when either protocol is broken.
 * `@smthrs/scorers`' `Runner.Service` implements `runBatchCorrelated`, so its
 * service value can be used directly and `ambiguous_score_job` never applies
 * to it.
 *
 * @category services
 * @since 0.1.0
 */
export interface ScoreBatchRunner {
  readonly runBatch: (
    jobs: ReadonlyArray<ScoreJob>,
    options?: { readonly concurrency?: number | undefined }
  ) => Effect.Effect<ReadonlyArray<ScoreObservation>, unknown>
  readonly runBatchCorrelated?:
    | ((
      jobs: ReadonlyArray<ScoreJob>,
      options?: { readonly concurrency?: number | undefined }
    ) => Effect.Effect<ReadonlyArray<BatchResult>, unknown>)
    | undefined
}

/**
 * A score result aligned with a {@link ScoreRequest}.
 *
 * @category models
 * @since 0.1.0
 */
export type ScoreObservation = ScoreStore.Observation

/**
 * A batch result tagged with the identity of the job that produced it.
 *
 * @category models
 * @since 0.1.0
 */
export interface BatchResult {
  readonly identity: string
  readonly observation: ScoreObservation
}

/**
 * Per-case result retained by the deterministic runner.
 *
 * @category models
 * @since 0.1.0
 */
export interface CaseResult {
  readonly case: string
  readonly execution?: Execution | undefined
  readonly error?: EvalError | undefined
  readonly observations: ReadonlyArray<Observation>
  readonly trials?: Trials.Summary | undefined
}

/**
 * Stable result of a suite run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunResult {
  readonly runId: string
  readonly suite: string
  readonly cases: ReadonlyArray<CaseResult>
  readonly observations: ReadonlyArray<Observation>
  readonly trials?: Trials.Aggregate | undefined
  readonly k?: number | undefined
}

/**
 * Options for a deterministic suite run.
 *
 * @category models
 * @since 0.1.0
 */
export interface RunOptions {
  readonly scorer?: ScoreBatchRunner | undefined
  readonly runId: string
  readonly sampleId?: string | undefined
  readonly trials?: number | undefined
  readonly k?: number | undefined
  readonly at: string
}

/**
 * Injectable batch-runner service used when a caller wants a reusable adapter.
 *
 * {@link run} does not require it: a run scores with `options.scorer` when one
 * is passed, otherwise with this service when one is provided, otherwise
 * in process through {@link makeInline}.
 *
 * @category services
 * @since 0.1.0
 */
export class Runner extends Context.Service<Runner, ScoreBatchRunner>()("flows/evals/Runner") {}

/** The longest cause summary a public reason carries. */
const maxReasonLength = 2048

const boundedReason = (reason: string): string =>
  reason.length <= maxReasonLength ? reason : `${reason.slice(0, maxReasonLength)}[truncated]`

const scorerKeyOf = (binding: Binding): string => binding.scorer.scorerKey

// A scorer is a flow and every flow carries a name, so a run always has one to
// report. A stored observation may still lack it, which is why `scorerLabel`
// and the `Observation` field both keep the absent case.
const scorerNameOf = (binding: Binding): string => binding.scorer.name

const label = (binding: Binding): string =>
  scorerLabel({ scorer: scorerKeyOf(binding), scorerName: scorerNameOf(binding) })

const inconclusive = (request: ScoreRequest, reason: string, at: string): Observation => {
  return {
    case: request.case,
    scorer: scorerKeyOf(request.binding),
    scorerName: scorerNameOf(request.binding),
    stepKey: request.stepKey,
    kind: "inconclusive",
    reason,
    at
  }
}

// A case failure always locates itself. An executor that named the offending
// value keeps its own path; one that named nothing still gets the case, because
// a failure with no path leaves a caller nothing to branch on but prose.
const casePath = (name: string): string => `cases['${name}']`

// The executor boundary handles every non-interruption cause, not only typed
// failures: an executor that wraps a parser in `Effect.sync` dies with a
// defect, and one case's defect must not abort its siblings or the report.
// The wrapped message is flattened because a gate prints it to a CI log, where
// a newline from the target would let it forge a workflow command; the
// original message survives untouched on `cause`.
const caseError = (suiteCase: Case, cause: Cause.Cause<unknown>): EvalError => {
  const reason = Cause.squash(cause)
  return reason instanceof EvalError
    ? new EvalError({
      code: reason.code,
      message: flattenControlCharacters(`Target failed for case '${suiteCase.name}': ${reason.message}`),
      path: reason.path ?? casePath(suiteCase.name),
      cause: reason
    })
    : new EvalError({
      code: "executor",
      message: flattenControlCharacters(`Target failed for case '${suiteCase.name}': ${String(reason)}`),
      path: casePath(suiteCase.name),
      cause: reason
    })
}

// A step key is a runtime value the target returns, so unlike a suite name it
// is flattened rather than rejected: it reaches baselines, reports and the
// gate summary, and a control character in any of them corrupts a CI log line.
const runCase = (executor: CaseExecutorService, suiteCase: Case): Effect.Effect<CaseResult> =>
  Effect.suspend(() => executor.run(structuredClone(suiteCase))).pipe(
    Effect.map((execution): CaseResult => ({
      case: suiteCase.name,
      execution: { ...execution, stepKey: flattenControlCharacters(execution.stepKey) },
      observations: []
    })),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed<CaseResult>({ case: suiteCase.name, error: caseError(suiteCase, cause), observations: [] })
    ),
    Effect.withSpan("Eval.case", { attributes: { case: suiteCase.name } })
  )

// A declared case value is ground truth even when it is `null`, `false`, `0`
// or the empty string; only an absent `expected` defers to the binding.
const groundTruthFor = (suiteCase: Case, binding: Binding): { readonly groundTruth?: unknown } => {
  const groundTruth = suiteCase.expected !== undefined ? suiteCase.expected : binding.groundTruth
  return groundTruth === undefined ? {} : { groundTruth: structuredClone(groundTruth) }
}

const requestFor = (suiteCase: Case, execution: Execution, binding: Binding): ScoreRequest => ({
  case: suiteCase.name,
  stepKey: execution.stepKey,
  binding: {
    ...structuredClone({
      sampling: binding.sampling,
      ...(binding.groundTruth === undefined ? {} : { groundTruth: binding.groundTruth }),
      ...(binding.context === undefined ? {} : { context: binding.context })
    }),
    scorer: binding.scorer,
    appliesTo: binding.appliesTo
  },
  input: {
    input: structuredClone(suiteCase.input),
    output: execution.output,
    ...(groundTruthFor(suiteCase, binding)),
    ...(binding.context === undefined ? {} : { context: structuredClone(binding.context) }),
    latencyMs: execution.latencyMs
  }
})

const observationFor = (request: ScoreRequest, result: ScoreObservation, at: string): Observation => {
  const source = result as {
    readonly kind: unknown
    readonly score?: unknown
    readonly reason?: unknown
    readonly meta?: unknown
  }
  const kind = source.kind
  if (kind !== "score" && kind !== "inconclusive") {
    return inconclusive(
      request,
      boundedReason(`Scorer ${label(request.binding)} returned an unusable observation kind '${String(kind)}'`),
      at
    )
  }
  const reason = source.reason
  if (kind === "inconclusive") {
    return inconclusive(
      request,
      typeof reason === "string" && reason.length > 0
        ? boundedReason(reason)
        : boundedReason(`Scorer ${label(request.binding)} returned an inconclusive observation with no reason`),
      at
    )
  }
  const score = source.score
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
    return inconclusive(
      request,
      boundedReason(`Scorer ${label(request.binding)} returned a score outside [0, 1]: ${String(score)}`),
      at
    )
  }
  const meta = source.meta
  return {
    case: request.case,
    scorer: scorerKeyOf(request.binding),
    scorerName: scorerNameOf(request.binding),
    stepKey: request.stepKey,
    kind: "score",
    score,
    ...(typeof reason === "string" ? { reason: boundedReason(reason) } : {}),
    ...(meta === undefined ? {} : { meta }),
    at
  }
}

const executeInline = (job: ScoreJob): Effect.Effect<ScoreObservation> =>
  job.score.pipe(
    Effect.flatMap(Scorer.validate),
    Effect.map((result): ScoreStore.ScoreObservation => ({
      ...job.observation,
      kind: "score",
      score: result.score,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.meta === undefined ? {} : { meta: result.meta }),
      at: job.at
    })),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed(ScorerRunner.inconclusive(job, cause))
    )
  )

/**
 * Builds the in-process batch runner a run scores with by default.
 *
 * Each job's scorer runs in the current process, its result is checked by
 * `@smthrs/scorers`' own `Scorer.validate`, and a scorer that fails becomes an
 * inconclusive observation naming its cause rather than failing the run. It
 * honours the {@link ScoreBatchRunner} protocol, so it is also the reference
 * a custom adapter can be compared against.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeInline = (): ScoreBatchRunner => {
  const runBatchCorrelated = (
    jobs: ReadonlyArray<ScoreJob>,
    options?: { readonly concurrency?: number | undefined }
  ): Effect.Effect<ReadonlyArray<BatchResult>> =>
    Effect.forEach(
      jobs,
      (job) => executeInline(job).pipe(Effect.map((observation) => ({ identity: job.identity, observation }))),
      { concurrency: options?.concurrency ?? 1 }
    )
  return {
    runBatchCorrelated,
    runBatch: (jobs, options) =>
      runBatchCorrelated(jobs, options).pipe(Effect.map((results) => results.map((result) => result.observation)))
  }
}

/**
 * Provides the in-process batch runner built by {@link makeInline}.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerInline: Layer.Layer<Runner> = Layer.succeed(Runner)(makeInline())

interface ScoreContext {
  readonly at: string
  readonly runId: string
  readonly sampleId: string
  readonly concurrency: number
}

const buildJobs = (
  cases: ReadonlyArray<CaseResult>,
  suite: Suite,
  { at, runId, sampleId, concurrency }: ScoreContext
): Effect.Effect<
  { readonly requests: ReadonlyArray<ScoreRequest>; readonly jobs: ReadonlyArray<ScoreJob> },
  EvalError
> =>
  Effect.gen(function*() {
    // `cases` is the result of one `Effect.forEach` over `suite.cases`, so the
    // two arrays are index-aligned by construction; nothing here has to look a
    // case back up by name.
    const candidates = cases.flatMap((caseResult, index) => {
      const execution = caseResult.execution
      if (execution === undefined) return []
      const suiteCase = suite.cases[index]!
      return suite.bindings.flatMap((binding, bindingIndex) =>
        binding.appliesTo === execution.target
          ? [{ request: requestFor(suiteCase, execution, binding), bindingIndex }]
          : []
      )
    })
    const sampled = yield* Effect.forEach(
      candidates,
      ({ request, bindingIndex }) =>
        Sampling.decide(
          request.binding.sampling,
          request.stepKey,
          scorerKeyOf(request.binding)
        ).pipe(
          Effect.map((selected) => selected ? request : undefined),
          Effect.mapError((cause) =>
            new EvalError({
              code: "invalid_suite",
              message: `Invalid sampling policy for scorer ${label(request.binding)}`,
              path: `bindings[${bindingIndex}].sampling`,
              cause
            })
          )
        ),
      { concurrency }
    )
    const requests = sampled.filter((request): request is ScoreRequest => request !== undefined)
    const jobs: Array<ScoreJob> = requests.map((request, index) => ({
      identity: tupleKey(
        suite.name,
        runId,
        sampleId,
        request.case,
        request.stepKey,
        scorerKeyOf(request.binding),
        `${index}`
      ),
      observation: { targetStepKey: request.stepKey, scorerKey: scorerKeyOf(request.binding) },
      score: Effect.suspend(() => request.binding.scorer.score(request.input)),
      at: Date.parse(at)
    }))
    return { requests, jobs }
  })

const batchFallback = (
  jobs: ReadonlyArray<ScoreJob>,
  cause: Cause.Cause<unknown>
): Effect.Effect<ReadonlyArray<ScoreObservation>> =>
  Cause.hasInterrupts(cause)
    ? Effect.interrupt
    : Effect.succeed(jobs.map((job) => ScorerRunner.inconclusive(job, cause)))

const scoreCorrelated = (
  jobs: ReadonlyArray<ScoreJob>,
  scorer: ScoreBatchRunner,
  runBatchCorrelated: NonNullable<ScoreBatchRunner["runBatchCorrelated"]>,
  { concurrency }: ScoreContext
): Effect.Effect<ReadonlyArray<ScoreObservation>, EvalError> =>
  Effect.gen(function*() {
    const batchResults = yield* Effect.suspend(() => runBatchCorrelated.call(scorer, jobs, { concurrency })).pipe(
      Effect.catchCause((cause) =>
        batchFallback(jobs, cause).pipe(
          Effect.map((observations) =>
            observations.map((observation, index) => ({
              identity: jobs[index]!.identity,
              observation
            }))
          )
        )
      )
    )
    if (batchResults.length !== jobs.length) {
      return yield* Effect.fail(
        new EvalError({
          code: "scorer_protocol",
          message:
            `Correlated scorer batch returned ${batchResults.length} results for ${jobs.length} jobs; a batch runner must return exactly one result per job identity`,
          path: "runBatchCorrelated"
        })
      )
    }
    const jobIndexByIdentity = new Map(jobs.map((job, index) => [job.identity, index] as const))
    const byIdentity = new Map<string, ScoreObservation>()
    let unknown: { readonly identity: string; readonly index: number } | undefined
    for (const [index, result] of batchResults.entries()) {
      const jobIndex = jobIndexByIdentity.get(result.identity)
      if (jobIndex !== undefined && byIdentity.has(result.identity)) {
        return yield* Effect.fail(
          new EvalError({
            code: "scorer_protocol",
            message:
              `Correlated scorer batch returned duplicate identity '${result.identity}' for job ${jobIndex} at result index ${index}`,
            path: `runBatchCorrelated[${index}]`
          })
        )
      }
      if (jobIndex === undefined) unknown = { identity: result.identity, index }
      byIdentity.set(result.identity, result.observation)
    }
    if (unknown !== undefined) {
      const missingJobIndex = jobs.findIndex((job) => !byIdentity.has(job.identity))
      const missingIdentity = jobs[missingJobIndex]!.identity
      return yield* Effect.fail(
        new EvalError({
          code: "scorer_protocol",
          message:
            `Correlated scorer batch returned unknown identity '${unknown.identity}' at result index ${unknown.index}; job ${missingJobIndex} identity '${missingIdentity}' is absent`,
          path: `runBatchCorrelated[${unknown.index}]`
        })
      )
    }
    return jobs.map((job) => byIdentity.get(job.identity)!)
  })

const scoreOrderOnly = (
  jobs: ReadonlyArray<ScoreJob>,
  requests: ReadonlyArray<ScoreRequest>,
  scorer: ScoreBatchRunner,
  { concurrency }: ScoreContext
): Effect.Effect<ReadonlyArray<ScoreObservation>, EvalError> =>
  Effect.gen(function*() {
    const pairIndexes = new Map<string, number>()
    for (const [index, job] of jobs.entries()) {
      const pair = tupleKey(job.observation.targetStepKey, job.observation.scorerKey)
      const previous = pairIndexes.get(pair)
      if (previous !== undefined) {
        const first = requests[previous]!
        const second = requests[index]!
        return yield* Effect.fail(
          new EvalError({
            code: "ambiguous_score_job",
            message:
              `Cannot attribute score jobs for cases '${first.case}' and '${second.case}': both use step key '${job.observation.targetStepKey}' and scorer ${
                label(second.binding)
              }. Give each case its own step key, or provide a batch runner that implements runBatchCorrelated`,
            path: "runBatch"
          })
        )
      }
      pairIndexes.set(pair, index)
    }
    const results = yield* Effect.suspend(() => scorer.runBatch(jobs, { concurrency })).pipe(
      Effect.catchCause((cause) => batchFallback(jobs, cause))
    )
    if (results.length !== jobs.length) {
      return yield* Effect.fail(
        new EvalError({
          code: "scorer_protocol",
          message:
            `Scorer batch returned ${results.length} observations for ${jobs.length} jobs; a batch runner must return exactly one observation per job, in order`,
          path: "runBatch"
        })
      )
    }
    return results
  })

const score = (
  cases: ReadonlyArray<CaseResult>,
  suite: Suite,
  scorer: ScoreBatchRunner,
  context: ScoreContext
): Effect.Effect<ReadonlyArray<CaseResult>, EvalError> =>
  Effect.gen(function*() {
    const { requests, jobs } = yield* buildJobs(cases, suite, context)
    if (requests.length === 0) return cases
    const runBatchCorrelated = scorer.runBatchCorrelated
    const protocol = runBatchCorrelated === undefined ? "runBatch" : "runBatchCorrelated"
    const results = yield* runBatchCorrelated === undefined
      ? scoreOrderOnly(jobs, requests, scorer, context)
      : scoreCorrelated(jobs, scorer, runBatchCorrelated, context)
    const { at } = context
    const observations: Array<Observation> = []
    for (const [index, request] of requests.entries()) {
      const result = results[index]!
      if (result.targetStepKey !== request.stepKey || result.scorerKey !== scorerKeyOf(request.binding)) {
        return yield* Effect.fail(
          new EvalError({
            code: "scorer_protocol",
            message: protocol === "runBatchCorrelated"
              ? `Correlated scorer batch identity '${
                jobs[index]!.identity
              }' returned step '${result.targetStepKey}' and scorer '${result.scorerKey}' where job ${index} asked for scorer '${
                scorerKeyOf(request.binding)
              }' at step '${request.stepKey}'`
              : `Scorer batch returned an observation for '${result.scorerKey}' at step '${result.targetStepKey}' where job ${index} asked for '${
                scorerKeyOf(request.binding)
              }' at step '${request.stepKey}'; results must stay aligned with their jobs`,
            path: `${protocol}[${index}]`
          })
        )
      }
      observations.push(observationFor(request, result, at))
    }
    const byCase = new Map<string, Array<Observation>>()
    for (const observation of observations) {
      const bucket = byCase.get(observation.case)
      if (bucket === undefined) byCase.set(observation.case, [observation])
      else bucket.push(observation)
    }
    return cases.map((caseResult) => ({
      ...caseResult,
      observations: byCase.get(caseResult.case) ?? []
    }))
  })

/**
 * Runs a fixed suite with bounded execution and declaration-order results.
 *
 * Cases run through the provided {@link CaseExecutor} at the suite's
 * concurrency and are returned in declaration order. Each executor receives
 * its own mutable case copy. Each scorer receives independent copies of the
 * original case input, expected value, and binding data. Every execution is then
 * graded by the bindings whose `appliesTo` is the flow the execution reports as
 * its target, matched by reference identity, so a binding attached to another
 * flow contributes no observations.
 *
 * Scoring goes through `options.scorer` when the caller passes one, the
 * {@link Runner} service when one is provided, and {@link makeInline}
 * otherwise. A case whose target failed keeps its typed error, locates itself
 * with the executor's own `path` or with `cases['<name>']`, and produces no
 * observations; a scorer that failed produces an inconclusive observation. The
 * run itself fails only with `invalid_run_options` for a non-canonical run
 * identity or timestamp, `invalid_suite` for an unusable sampling policy,
 * `ambiguous_score_job` when an order-only runner cannot distinguish two jobs,
 * or `scorer_protocol` for a batch runner that broke the
 * {@link ScoreBatchRunner} contract.
 *
 * @category constructors
 * @since 0.1.0
 */
export const run = (
  suite: Suite,
  options: RunOptions
): Effect.Effect<RunResult, EvalError, CaseExecutor> =>
  Effect.gen(function*() {
    const executor = yield* CaseExecutor
    const injected = yield* Effect.serviceOption(Runner)
    const scorer = options.scorer ?? (injected._tag === "Some" ? injected.value : makeInline())
    const atMillis = Date.parse(options.at)
    if (options.runId.trim().length === 0) {
      return yield* Effect.fail(
        new EvalError({
          code: "invalid_run_options",
          message: "Deterministic runs require a non-empty runId",
          path: "options.runId"
        })
      )
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(options.at) ||
      !Number.isFinite(atMillis) ||
      new Date(atMillis).toISOString() !== options.at
    ) {
      return yield* Effect.fail(
        new EvalError({
          code: "invalid_run_options",
          message:
            `Deterministic runs require a canonical UTC timestamp such as 2026-01-01T00:00:00.000Z, got '${options.at}'`,
          path: "options.at"
        })
      )
    }
    const n = options.trials ?? suite.trials ?? 1
    const k = options.k ?? 1
    if (!Number.isSafeInteger(n) || n < 1 || n > 1000 || !Number.isSafeInteger(k) || k < 1 || k > n) {
      return yield* Effect.fail(
        new EvalError({
          code: "invalid_trials",
          message: "trials must be an integer from 1 to 1000 and k must be an integer from 1 to trials",
          path: "options.trials"
        })
      )
    }
    const at = options.at
    const runId = options.runId
    const sampleId = options.sampleId ?? "default"
    // Await each batch before starting the next: concurrency within a trial is
    // bounded by the suite, and neither scheduling nor scorer latency reorders trials.
    const batches = yield* Effect.forEach(Array.from({ length: n }, (_, index) => index), (index) =>
      Effect.gen(function*() {
        const cases = yield* Effect.forEach(suite.cases, (suiteCase) =>
          runCase(executor, suiteCase), {
          concurrency: suite.concurrency,
          discard: false
        })
        return yield* score(cases, suite, scorer, {
          concurrency: suite.concurrency,
          at,
          runId,
          sampleId: n === 1 ? sampleId : tupleKey(sampleId, String(index))
        })
      }), { concurrency: 1 })
    const outcomes: Record<string, Array<boolean>> = {}
    const cases = suite.cases.map((suiteCase, index) => {
      const attempts = batches.map((batch) =>
        batch[index]!
      )
      const passed = attempts.map((attempt) =>
        attempt.error === undefined && attempt.observations.length > 0 &&
        attempt.observations.every((observation) => observation.kind === "score" && observation.score === 1)
      )
      outcomes[suiteCase.name] = passed
      return {
        ...attempts[0]!,
        error: attempts.find((attempt) => attempt.error !== undefined)?.error,
        observations: attempts.flatMap((attempt) => attempt.observations),
        trials: Trials.summarize(passed, k)
      }
    })
    return {
      runId,
      suite: suite.name,
      cases,
      observations: cases.flatMap((caseResult) => caseResult.observations),
      trials: Trials.aggregate(outcomes, k),
      k
    }
  }).pipe(Effect.withSpan("Eval.run", { attributes: { suite: suite.name, runId: options.runId } }))

/**
 * Provides a batch runner that is never available.
 *
 * Every bound score under this layer becomes an inconclusive observation, which
 * a gate grades as an undecidable run rather than a red. Provide it to state
 * that a suite must not score, and {@link layerInline} to score in process.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<Runner> = Layer.sync(Runner)(() => {
  const unavailable = new EvalError({ code: "scorer_unavailable", message: "No scorer batch runner is available" })
  return {
    runBatch: () => Effect.fail(unavailable),
    runBatchCorrelated: (jobs) =>
      Effect.succeed(jobs.map((job) => ({
        identity: job.identity,
        observation: ScorerRunner.inconclusive(job, unavailable)
      })))
  }
})

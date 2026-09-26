/**
 * Fixed-suite evaluation tools for flows.
 *
 * The pipeline runs in one direction: a {@link Suite} declares fixed cases and
 * the scorers bound to them, a {@link Runner} executes them through an injected
 * {@link CaseExecutor} and grades the executions, {@link Baseline} records what
 * a run scored, {@link Regression} compares the next run with that record,
 * {@link Report} renders the comparison, and {@link Gate} turns it into a CI
 * exit code.
 *
 * @since 0.1.0
 */

/**
 * Typed evaluation failures and the stable codes a caller branches on.
 *
 * @since 0.1.0
 * @category errors
 */
export * as EvalError from "./EvalError.ts"
/**
 * Fixed suite declarations and their JSON Lines fixture format.
 *
 * @since 0.1.0
 * @category suites
 */
export * as Suite from "./Suite.ts"
/**
 * The injectable boundary that executes one case against a target flow.
 *
 * @since 0.1.0
 * @category services
 */
export * as CaseExecutor from "./CaseExecutor.ts"
/**
 * Deterministic suite execution and bound scorer evaluation.
 *
 * @since 0.1.0
 * @category runners
 */
export * as Runner from "./Runner.ts"
/**
 * Committed baselines: what a suite used to score.
 *
 * @since 0.1.0
 * @category baselines
 */
export * as Baseline from "./Baseline.ts"
/**
 * Step-key-aware comparison of a run against a baseline.
 *
 * @since 0.1.0
 * @category regression
 */
export * as Regression from "./Regression.ts"
/**
 * Canonical JSON and Markdown renderings of a comparison.
 *
 * @since 0.1.0
 * @category reports
 */
export * as Report from "./Report.ts"
/**
 * Score thresholds and the CI exit grade a comparison earns.
 *
 * @since 0.1.0
 * @category gates
 */
export * as Gate from "./Gate.ts"
/**
 * Repeated-run statistics for live evaluations: pass@k and pass^k.
 *
 * @since 0.1.0
 * @category statistics
 */
export * as Trials from "./Trials.ts"

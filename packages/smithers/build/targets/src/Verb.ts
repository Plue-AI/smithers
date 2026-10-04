/**
 * The CLI verbs a generated pipeline may run across a target graph.
 *
 * A pipeline declaration names verbs, not target kinds: `smithers-build test '//...'`
 * is one command a CI job runs, the same verb-and-pattern shape Bazel's own CI
 * uses for `bazel test //...`. Before this module a PACKAGE.ts file named them
 * with bare strings, so the authoring surface was four quoted words whose
 * spelling nothing checked at the call site and whose meaning the attr name did
 * not explain.
 *
 * This module gives each verb a value. `Verb.Build`, `Verb.Test`, `Verb.Lint`,
 * `Verb.Docs`, and `Verb.Review` are declarations a PACKAGE.ts file
 * references by name, so a misspelling is an unresolved identifier rather than
 * a string the renderer rejects at plan time.
 *
 * `run` is available only to explicit deploy steps with an environment and
 * successful gate dependencies. It is never part of the aggregate CI verb.
 *
 * `review` IS here, and it is not in {@link all}. A pipeline may declare a job
 * that runs the model reviews, and that job is the only thing that plans them:
 * the aggregate `ci` verb does not.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import type * as Target from "./Target.ts"

/**
 * Schema for the `build` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BuildVerb = Schema.Struct({ name: Schema.Literal("build") })

/**
 * The `build` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type BuildVerb = typeof BuildVerb.Type

/**
 * Schema for the `test` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestVerb = Schema.Struct({ name: Schema.Literal("test") })

/**
 * The `test` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type TestVerb = typeof TestVerb.Type

/**
 * Schema for the `lint` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LintVerb = Schema.Struct({ name: Schema.Literal("lint") })

/**
 * The `lint` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type LintVerb = typeof LintVerb.Type

/**
 * Schema for the `docs` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const DocsVerb = Schema.Struct({ name: Schema.Literal("docs") })

/**
 * The `docs` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type DocsVerb = typeof DocsVerb.Type

/**
 * Schema for the `review` verb.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ReviewVerb = Schema.Struct({ name: Schema.Literal("review") })

/**
 * The `review` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewVerb = typeof ReviewVerb.Type

/**
 * Schema for the aggregate `ci` verb.
 *
 * `ci` is not a {@link Target.Kind}: it is the CLI's own name for planning every
 * kind over one pattern in a single invocation. It has a value here so a
 * pipeline declaration can ask for the aggregate without restating the four
 * verbs it stands for.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CiVerb = Schema.Struct({ name: Schema.Literal("ci") })

/**
 * The aggregate `ci` verb.
 *
 * @category models
 * @since 0.1.0
 */
export type CiVerb = typeof CiVerb.Type

/** Schema for an explicit outward invocation in a deploy workflow.
 * @category schemas
 * @since 1.0.0
 */
export const RunVerb = Schema.Struct({ name: Schema.Literal("run") })

/** One explicit outward invocation, never aggregated by `ci`.
 * @category constructors
 * @since 1.0.0
 */
export const Run = RunVerb.make({ name: "run" })

/**
 * Schema for one verb a generated pipeline may run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Verb = Schema.Union([BuildVerb, TestVerb, LintVerb, DocsVerb, ReviewVerb])

/**
 * One verb a generated pipeline may run.
 *
 * @category models
 * @since 0.1.0
 */
export type Verb = typeof Verb.Type

/**
 * Builds every target in the pattern.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // Runs `smithers-build build '//...'`
 * export const verbs = [Smithers.Verb.Build]
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Build: BuildVerb = BuildVerb.make({ name: "build" })

/**
 * Runs every test target in the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Test: TestVerb = TestVerb.make({ name: "test" })

/**
 * Runs every lint target in the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Lint: LintVerb = LintVerb.make({ name: "lint" })

/**
 * Runs the documentation-parity check over the pattern.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Docs: DocsVerb = DocsVerb.make({ name: "docs" })

/**
 * Runs the model-assisted review targets in the pattern.
 *
 * Deliberately its own verb rather than a flavour of `lint`. A review target
 * diffs the checkout against a base revision and spawns a model CLI, so it
 * needs a full-history checkout, a model binary, and a credential that no
 * ordinary lint job has. Kept under `lint` it was planned by every wildcard
 * `lint` and by the aggregate `ci`, and both died at plan time on a shallow
 * pull-request checkout where `origin/main` does not exist. A job that wants
 * the reviews asks for them by name.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Review: ReviewVerb = ReviewVerb.make({ name: "review" })

/**
 * The verbs the aggregate `ci` command runs, in the order it aggregates them.
 *
 * A pipeline declaring exactly this set is the aggregate `ci` command, so the
 * renderer collapses it to one step. {@link Review} is not here and never
 * will be: `ci` is the unattended, hermetic verb, and a model call is neither.
 *
 * @category constants
 * @since 0.1.0
 */
export const all: ReadonlyArray<Verb> = [Build, Test, Lint, Docs]

/**
 * Plans and runs every verb over one pattern in a single invocation.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * // Runs `smithers-build ci '//packages/...'`
 * export const verb = Smithers.Verb.Ci
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Ci: CiVerb = CiVerb.make({ name: "ci" })

/**
 * Schema for one verb a generated pipeline step may run, aggregate included.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PipelineVerb = Schema.Union([BuildVerb, TestVerb, LintVerb, DocsVerb, ReviewVerb, CiVerb, RunVerb])

/**
 * One verb a generated pipeline step may run, aggregate included.
 *
 * @category models
 * @since 0.1.0
 */
export type PipelineVerb = typeof PipelineVerb.Type

/**
 * Checks whether a value is a pipeline verb.
 *
 * @category guards
 * @since 0.1.0
 */
export const isVerb: (value: unknown) => value is Verb = Schema.is(Verb)

/**
 * Checks whether a value is a verb a generated pipeline step may run.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPipelineVerb: (value: unknown) => value is PipelineVerb = Schema.is(PipelineVerb)

/**
 * The CLI subcommand one pipeline verb names.
 *
 * @category accessors
 * @since 0.1.0
 */
export const command = (verb: PipelineVerb): string => verb.name

/**
 * The target kind one verb selects.
 *
 * The return type is what keeps this module and {@link Target.Kind} from
 * drifting: a verb whose name is not a kind the CLI has would not typecheck
 * here.
 *
 * @category accessors
 * @since 0.1.0
 */
export const kind = (verb: Verb): Target.Kind => verb.name

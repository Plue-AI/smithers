/**
 * Model-review lint macros, anchored to the package that declares them.
 *
 * One `lint/PACKAGE.ts` once declared these reviews as workspace-wide targets
 * whose `include` list named every covered package by hand, so putting a
 * package under a rubric meant editing a file in a directory that package
 * does not own. Each rubric is a macro here instead: a package's own
 * PACKAGE.ts declares the review it opts into, and the macro supplies the
 * rubric, the prompt framing, the engine, the model tier, the batch size, and
 * the failure threshold.
 *
 * Every glob a macro emits is workspace-rooted. The review matches its
 * `include` patterns against workspace-relative paths that `git diff` listed
 * and expands `context` against the workspace. A PACKAGE.ts writes in a
 * package-relative frame, so the macro resolves each declared pattern against
 * `cwd` and re-roots it. The diff itself is narrowed to the same patterns, so
 * one package's review re-keys on that package's changes alone.
 *
 * This module holds what the rubrics share: the prompt framing, the options,
 * the result type, and the helper that applies one rubric. Each macro lives in
 * its own module beside it.
 *
 * @since 0.1.0
 */

import * as Input from "@smthrs/targets/Input"
import { LlmLint } from "@smthrs/targets/LlmLint"
import type { Engine } from "@smthrs/targets/LlmLint"
import type * as Target from "@smthrs/targets/Target"

/** The base revision a review diffs against when the caller names none. */
const defaultBase = "origin/main"

/** The cheap fast codex tier the reviews run on when the caller names none. */
const defaultModel = "gpt-6-luna"

/**
 * The framing every review rubric is prepended with.
 *
 * @category constants
 * @since 0.1.0
 */
export const smithersReviewPrompt = "You are reviewing a diff in `smithers`, an Effect v4 coding-agent harness written from " +
  "scratch. Report only violations of the rubric below. Judgment calls that the rubric does not " +
  "cover are not findings. Prefer no finding over a speculative one."

/**
 * Options accepted by every macro in this module.
 *
 * `cwd` is the workspace-relative package directory the default globs, and any
 * package-relative glob a caller passes, resolve against. It is required: every
 * default glob is package-shaped, so a package-level declaration passes its own
 * directory, for example `packages/smithers/flows/journal`, and a workspace-wide
 * declaration passes `"."` beside its `//`-rooted globs.
 *
 * `engine` selects the CLI the review runs through and `model` is an id that
 * engine accepts. Omitted, the review runs on `codex` with `gpt-6-luna`; a
 * Codex review names another Codex tier such as `gpt-6-sol`. Any other engine
 * has no default model, so a `claude` review must name a Claude id.
 *
 * @category models
 * @since 0.1.0
 */
export type Options = BaseOptions & EngineOptions

/** The engine and the model id it runs, paired so a model reaches its own CLI. */
type EngineOptions =
  | {
    /** @default "codex" */
    readonly engine?: "codex" | undefined
    /** A Codex model id. @default "gpt-6-luna" */
    readonly model?: string | undefined
  }
  | {
    readonly engine: Exclude<Engine, "codex">
    /** A model id the selected engine's CLI accepts. */
    readonly model: string
  }

/** The options that do not depend on the engine. */
interface BaseOptions {
  readonly cwd: string
  /**
   * The changed paths this review covers. Patterns are package-relative unless
   * they carry the `//` workspace-root prefix. Each macro documents its own
   * default.
   */
  readonly include?: ReadonlyArray<Input.Glob> | undefined
  /**
   * Files read into every batch prompt whether or not they changed. Patterns
   * resolve the same way `include` does, but execution crosses package boundaries.
   * A nonempty declaration must match at least one file and fit LlmLint's
   * 512-file and 2 MiB aggregate context limits.
   */
  readonly context?: ReadonlyArray<Input.Glob> | undefined
  /** @default [] */
  readonly deps?: ReadonlyArray<Target.AnyTarget> | undefined
  /** @default "origin/main" */
  readonly base?: string | undefined
  readonly summary?: string | undefined
  /** @default false */
  readonly featured?: boolean | undefined
}

/**
 * The target every macro in this module returns.
 *
 * @category models
 * @since 0.1.0
 */
export type ReviewLint = ReturnType<typeof LlmLint>

/** Re-roots one declared glob so it matches the paths `git diff` lists. */
const anchor = (cwd: string, declaration: Input.Glob): Input.Glob =>
  Input.Glob.make({
    pattern: `//${Input.resolvePath(cwd, declaration.pattern)}`,
    exclude: declaration.exclude.map((entry) => `//${Input.resolvePath(cwd, entry)}`)
  })

/**
 * One rubric's fixed half: everything a caller does not choose.
 *
 * @category models
 * @since 0.1.0
 */
export interface Rubric {
  readonly summary: string
  readonly rubric: string
  readonly batchSize: number
  readonly failOn: "error" | "warning"
  readonly include: ReadonlyArray<Input.Glob>
  readonly context: ReadonlyArray<Input.Glob>
}

/**
 * Applies one rubric to one package's options.
 *
 * It returns the declaration synchronously and runs no review. See "Failure
 * contracts" in the package README for declaration and execution failures.
 *
 * @category constructors
 * @since 0.1.0
 */
export const review = (options: Options, rubric: Rubric): ReviewLint => {
  const cwd = options.cwd
  const include = (options.include ?? rubric.include).map((entry) => anchor(cwd, entry))
  const context = (options.context ?? rubric.context).map((entry) => anchor(cwd, entry))
  return LlmLint({
    summary: options.summary ?? rubric.summary,
    featured: options.featured ?? false,
    // `paths` is key material only: it keeps this package's review out of the
    // digest of every unrelated commit, while `include` is what the executor
    // filters the reviewed set with.
    changes: Input.gitDiff({
      base: options.base ?? defaultBase,
      paths: include.map((entry) => entry.pattern.slice(2))
    }),
    include,
    context,
    deps: options.deps ?? [],
    prompt: smithersReviewPrompt,
    rubric: rubric.rubric,
    engine: options.engine ?? "codex",
    model: options.model ?? defaultModel,
    batchSize: rubric.batchSize,
    failOn: rubric.failOn
  })
}

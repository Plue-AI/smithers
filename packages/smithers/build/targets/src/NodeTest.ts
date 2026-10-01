/**
 * JavaScript test programs as declared targets.
 *
 * A repository's shell-script gates — `node --test scripts/pack-release.test.mjs`,
 * `node scripts/browser-check.mjs`, `bun e2e/run.ts` — are all the same thing: a
 * program whose exit code is the verdict. Bazel spells that `nodejs_test`, and
 * this target is modelled on it. The deviation is the runner union below: Bazel
 * hands the entry point to a launcher and lets the program pick its own harness,
 * while this target names the three forms explicitly so the interpreter flag
 * never has to be written by a PACKAGE.ts author.
 *
 * The interpreter is the declared {@link Runtime}, never a hardcoded `node`, so
 * the same declaration runs under Bun by editing one line in the root PACKAGE.ts.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Runtime from "./Runtime.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/**
 * Maximum number of arguments one declared program may receive.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumArguments = 64

/**
 * Schema for a run of the runtime's own test runner.
 *
 * `tests` are the files the runner is handed. They are {@link Input.File}
 * declarations rather than strings, so each one is digested as key material and
 * a test file that moves re-keys the target instead of silently running nothing.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestRunner = Schema.Struct({
  name: Schema.Literal("test-runner"),
  tests: Schema.NonEmptyArray(Input.File)
})

/**
 * A run of the runtime's own test runner.
 *
 * @category models
 * @since 0.1.0
 */
export type TestRunner = typeof TestRunner.Type

/**
 * Schema for a run of the runtime's own test runner over the suites under the
 * named directories.
 *
 * `paths` are directories the runner discovers test files under, relative to
 * `cwd` — the shape of a package's whole unit suite (`bun test src`,
 * `node --test src`). They are path filters, not key material: the declared
 * `srcs` are what re-key the target, the same division the Vitest target draws
 * between its `cwd` and its declared inputs.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TestSuite = Schema.Struct({
  name: Schema.Literal("suite"),
  paths: Schema.NonEmptyArray(Schema.NonEmptyString).check(Schema.isMaxLength(maximumArguments))
})

/**
 * A run of the runtime's own test runner over the suites under the named
 * directories.
 *
 * @category models
 * @since 0.1.0
 */
export type TestSuite = typeof TestSuite.Type

/**
 * Schema for a run of one program that gates on its exit code.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Entrypoint = Schema.Struct({
  name: Schema.Literal("entrypoint"),
  entry: Input.File,
  args: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(maximumArguments))
})

/**
 * A run of one program that gates on its exit code.
 *
 * @category models
 * @since 0.1.0
 */
export type Entrypoint = typeof Entrypoint.Type

/**
 * Schema for how a declared test program is started.
 *
 * A discriminated union, so the fields a form does not have are fields a
 * PACKAGE.ts file cannot write: there is no argument list on a test-runner run and
 * no file list on an entry-point run.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Runner = Schema.Union([TestRunner, TestSuite, Entrypoint])

/**
 * How a declared test program is started.
 *
 * @category models
 * @since 0.1.0
 */
export type Runner = typeof Runner.Type

/**
 * Declares a run of the runtime's own test runner over the given files.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runner = Smithers.testRunner([Smithers.file("//scripts/pack-release.test.mjs")])
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const testRunner = (tests: readonly [Input.File, ...Array<Input.File>]): TestRunner =>
  TestRunner.make({ name: "test-runner", tests })

/**
 * Declares a run of the runtime's own test runner over the suites under the
 * given directories.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const runner = Smithers.testSuite(["src"])
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const testSuite = (paths: readonly [string, ...Array<string>]): TestSuite =>
  TestSuite.make({ name: "suite", paths })

/**
 * Declares a run of one program that gates on its exit code.
 *
 * @category constructors
 * @since 0.1.0
 */
export const entrypoint = (entry: Input.File, args: ReadonlyArray<string> = []): Entrypoint =>
  Entrypoint.make({ name: "entrypoint", entry, args })

/**
 * Attributes for {@link NodeTest}.
 *
 * `cwd` is the workspace-relative directory the program runs in and defaults to
 * the workspace root. `srcs` are the files the program reads beyond its own
 * entry point; they complete the key material so a gate re-runs when what it
 * measures changes.
 *
 * `deps` accepts a subtree selector as well as a target, the same shape
 * `NodeBinary` accepts. A gate that spawns a program built by another
 * package has to order itself after that package's build, and the package that
 * owns the build is often reached by selector rather than by import.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  runtime: Schema.optional(Runtime.Runtime),
  runner: Runner,
  /** Explicit deadline for a measured long-running gate; omitted targets retain Exec's ten-minute default. */
  timeout: Schema.optional(Shell.Duration),
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Dependency),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("."))),
  /**
   * Puts the gate in the exclusive tier: wildcard `test` and `ci` selections
   * omit it unless `--include-exclusive` is set, a pattern that names it keeps
   * it, and once selected it runs alone in its executor invocation. Declare
   * it on slow browser and end-to-end tiers that CI selects by label.
   */
  exclusive: Schema.optional(Schema.Boolean),
  /**
   * Replays a green verdict from the result cache. Set it only when `srcs` and
   * `deps` cover everything the program reads: an undeclared input cannot
   * re-key the target. The runtime executable, lockfile, and build
   * implementation are key material either way.
   */
  cache: Schema.optional(Schema.Boolean)
})

/**
 * Attributes for {@link NodeTest}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the run argv from decoded attrs at plan time.
 *
 * Every spelling difference between the supported interpreters is resolved by
 * {@link Runtime}, so this function names files and arguments only.
 *
 * @category rendering
 * @since 0.1.0
 */
export const runArgv = (attrs: Attrs): ReadonlyArray<string> => {
  switch (attrs.runner.name) {
    case "test-runner":
      return Runtime.test(attrs.runtime, attrs.runner.tests.map((test) => Input.rootRelative(attrs.cwd, test.path)))
    case "suite":
      return Runtime.test(attrs.runtime, attrs.runner.paths.map((path) => Input.rootRelative(attrs.cwd, path)))
    case "entrypoint":
      return Runtime.run(attrs.runtime, [Input.rootRelative(attrs.cwd, attrs.runner.entry.path), ...attrs.runner.args])
  }
}

/**
 * Runs one declared JavaScript program as a test gate.
 *
 * The plan runs the program in `cwd` through the shared {@link Exec.Exec}
 * action. Success carries the {@link Exec.Result} run summary; the target
 * declares no output directories, because a gate's product is its exit code.
 * The entry point, the declared sources, the runtime declaration, and the
 * environment are the key material. The target is cacheable only when its
 * declaration sets `cache: true`. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const NodeTest = Target.make("NodeTest", {
  attrs: Attrs,
  workspaceAttrs: ["runtime"],
  kinds: ["test"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: (attrs) => attrs.cache === true,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      argv: runArgv(attrs),
      env: attrs.env,
      ...(attrs.timeout === undefined ? {} : { timeoutMs: Shell.durationMs(attrs.timeout) })
    })
})

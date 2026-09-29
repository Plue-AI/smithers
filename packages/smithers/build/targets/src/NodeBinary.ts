/**
 * JavaScript build programs as declared targets.
 *
 * The build-verb counterpart of {@link NodeTest}: one program, run under the
 * declared {@link Runtime}, that produces files rather than a verdict. Bazel
 * spells this `nodejs_binary`. The deviation is that a target here declares no
 * output tree: these programs write through the package manager or a compiler,
 * outside anything the build system can digest as a hermetic output, so the
 * dependency edge to the program that consumes the result is the contract.
 *
 * The two types are separate because a target's participating verbs are fixed by
 * its type: the planner selects by kind, so one type covering both would put a
 * release-packing program in the graph of `smithers-build test`.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as NodeTest from "./NodeTest.ts"
import * as Runtime from "./Runtime.ts"
import * as Shell from "./Shell.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link NodeBinary}.
 *
 * `cwd` is the workspace-relative directory the program runs in and defaults to
 * the workspace root. `srcs` are the files the program reads beyond its own
 * entry point; they complete the key material. `destinations` names the hosts
 * a program that downloads on first run reaches, so an environment builder
 * that runs it ahead of time opens exactly those hosts.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  runtime: Schema.optional(Runtime.Runtime),
  entry: Input.File,
  args: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(NodeTest.maximumArguments)),
  srcs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Dependency),
  /** Explicit deadline for a long-running build; omitted targets retain Exec's ten-minute default. */
  timeout: Schema.optional(Shell.Duration),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("."))),
  destinations: Schema.optional(Attr.Destinations)
})

/**
 * Attributes for {@link NodeBinary}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Builds the run argv from decoded attrs at plan time.
 *
 * @category rendering
 * @since 0.1.0
 */
export const runArgv = (attrs: Attrs): ReadonlyArray<string> =>
  Runtime.run(attrs.runtime, [Input.rootRelative(attrs.cwd, attrs.entry.path), ...attrs.args])

/**
 * Runs one declared JavaScript program under the build verb.
 *
 * The plan runs the program in `cwd` through the shared {@link Exec.Exec}
 * action. Success carries the {@link Exec.Result} run summary. The entry point,
 * the declared sources, the runtime declaration, the arguments, and the
 * environment are the key material. Results are never replayed: these programs
 * reach outside their declared inputs — a release pack shells out to the package
 * manager, a wasm rebuild consults an installed compiler — so a stored result
 * would not identify what produced it. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const NodeBinary = Target.make("NodeBinary", {
  attrs: Attrs,
  workspaceAttrs: ["runtime"],
  kinds: ["build"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      argv: runArgv(attrs),
      env: attrs.env,
      ...(attrs.timeout === undefined ? {} : { timeoutMs: Shell.durationMs(attrs.timeout) })
    })
})

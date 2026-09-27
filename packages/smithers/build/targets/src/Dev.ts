/**
 * Long-lived development processes.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link Dev}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  inputs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  cwd: Schema.NonEmptyString,
  /**
   * Always `null`.
   *
   * A readiness marker would be a promise this rule cannot keep: the shared
   * exec action has no readiness probe, so a string here re-keyed the target
   * on a semantic nothing observed. `Shell.Serve` models real readiness
   * through `Attr.Readiness` and is the rule to reach for instead.
   */
  readyWhen: Schema.Null
})

/**
 * Attributes for {@link Dev}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans a long-lived development or watch command.
 *
 * The body records one {@link Exec.Exec} node spawning `command` with `args`
 * from `cwd`. The spawn is a pass-through: the node succeeds when the process
 * exits cleanly and interrupting the fiber kills it. It has no time deadline.
 * `readyWhen` is `null`: the shared exec action has no readiness probe, and a
 * declaration that names
 * one is refused rather than silently ignored. The
 * target is non-cacheable because it stays live. This models tevm's `dev`
 * targets and common watch-process prior art. Executing the plan requires
 * {@link Exec.ExecLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const Dev = Target.make("Dev", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  implementation: (attrs) =>
    Exec.runTool({
      cwd: attrs.cwd,
      argv: [attrs.command, ...attrs.args],
      timeoutMs: "unbounded"
    })
})

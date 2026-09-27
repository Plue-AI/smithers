/**
 * Irreversible one-shot external operations.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { ExecIrreversible } from "./Changesets.ts"
import * as Exec from "./Exec.ts"
import * as Input from "./Input.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * Attributes for {@link ToolRun}.
 *
 * `command` is the executable, spawned directly with `args` and never through
 * a shell. `env` is non-secret environment merged over the confined base;
 * `secrets` names environment variables whose values the substituting proxy
 * supplies at spawn, so a credential is never placed in the recorded plan or
 * in key material. `expectedExitCodes` lists the codes treated as success and
 * defaults to `[0]`. `timeoutMs`, when set, overrides the shared exec runner's
 * ten-minute bound. `cwd` defaults to the workspace root.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Attrs = Schema.Struct({
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  inputs: Schema.Array(Input.Declared),
  deps: Schema.Array(Target.Target),
  env: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withConstructorDefault(Effect.succeed({}))
  ),
  secrets: Schema.Array(Secret.HttpCredential).pipe(
    Schema.withConstructorDefault(Effect.succeed([]))
  ),
  expectedExitCodes: Exec.ExpectedExitCodes.pipe(
    Schema.withConstructorDefault(Effect.succeed([0]))
  ),
  timeoutMs: Schema.optional(Exec.TimeoutMs),
  cwd: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(".")))
})

/**
 * Attributes for {@link ToolRun}.
 *
 * @category models
 * @since 0.1.0
 */
export type Attrs = typeof Attrs.Type

/**
 * Plans one irreversible external operation.
 *
 * `ToolRun` is the run-kind sibling of {@link import("./ToolBuild.ts").ToolBuild}:
 * `ToolBuild` produces cached file outputs, while `ToolRun` performs a side
 * effect that has none. The body records one {@link ExecIrreversible} node
 * spawning `command` with `args` from `cwd`. Because it is declared through the
 * irreversible action, the engine never retries it blindly and no
 * verification, replay, or cache-population path may execute it; `cache` is
 * `false` for the same reason. Its `run` verb gate keeps it out of build,
 * test, and lint graphs, including as a transitive dependency, so a side effect
 * never rides along with a `ci` run. `secrets` reach the child through the
 * substituting proxy, so a declared credential never enters the plan or the
 * content key. Prefer a purpose-built target type (the release targets
 * {@link import("./NpmPublish.ts").NpmPublish} and
 * {@link import("./JsrPublish.ts").JsrPublish} are examples) when the operation
 * has a stable identity; reach for `ToolRun` for a one-off external command.
 * Executing the plan requires {@link import("./Changesets.ts").ExecIrreversibleLive}.
 *
 * @category targets
 * @since 0.1.0
 */
export const ToolRun = Target.make("ToolRun", {
  attrs: Attrs,
  kinds: ["run"],
  success: Exec.Result,
  error: Exec.ExecError,
  cache: false,
  verbGate: ["run"],
  implementation: (attrs) =>
    ExecIrreversible.call({
      cwd: attrs.cwd,
      argv: [attrs.command, ...attrs.args],
      env: attrs.env,
      secrets: attrs.secrets,
      expectedExitCodes: attrs.expectedExitCodes,
      ...(attrs.timeoutMs === undefined ? {} : { timeoutMs: attrs.timeoutMs })
    })
})

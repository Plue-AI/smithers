/**
 * shell_command flow declaration and portable handler.
 *
 * A Codex CLI clone of the `shell_command` tool: string command, `workdir`,
 * `timeout_ms`, and the Codex output format (`Exit code:` / `Wall time:` /
 * `Output:` with middle token-budget truncation).
 *
 * Codex's `sandbox_permissions` / `justification` / `prefix_rule` approval
 * parameters are deliberately absent: the permission kernel owns
 * sandboxing and escalation in this harness.
 *
 * @since 1.0.0
 */

import * as Flow from "@smthrs/core/Flow"
import type * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { formatExecOutputForModel } from "./internal/CodexText.ts"
import { capability, envelope } from "./internal/Declaration.ts"
import * as Exec from "./internal/Exec.ts"
import type * as StdError from "./StdError.ts"

/**
 * Registry name for the shell_command flow. Matches the Codex CLI tool name.
 *
 * @category identifiers
 * @since 1.0.0
 */
export const name = "shell_command"

/**
 * Model-facing description of the shell_command flow. Matches the Codex CLI
 * (non-Windows) description.
 *
 * @category descriptions
 * @since 1.0.0
 */
export const description = "Runs a shell command and returns its output.\n" +
  "- Always set the `workdir` param when using the shell_command function. Do not use `cd` unless absolutely necessary."

/**
 * Default command timeout in milliseconds, matching Codex.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Maximum bytes retained from each stream while a shell command executes.
 *
 * This is far above the 10,000-token model budget because
 * `formatExecOutputForModel` keeps the head and tail while the capture bound
 * keeps only the tail. Commands below this bound therefore render byte for
 * byte as before, while larger output costs the bound instead of its full size.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_CAPTURE_BYTES = 8_000_000

/**
 * Default output token budget, matching Codex.
 *
 * @category constants
 * @since 1.0.0
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000

/**
 * Timeout exit code reported to the model, matching Codex exec.
 *
 * @category constants
 * @since 1.0.0
 */
export const TIMEOUT_EXIT_CODE = 124

/**
 * Input schema for the shell_command flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Input = Schema.Struct({
  command: Schema.String.annotate({ description: "Shell script to run in the user's default shell." }),
  workdir: Schema.optional(
    Schema.String.annotate({ description: "Working directory for the command. Defaults to the turn cwd." })
  ),
  timeout_ms: Schema.optional(
    Schema.Number.annotate({ description: "Maximum command runtime. Defaults to 10000 ms." })
  )
})

/**
 * Decoded input accepted by the `shell_command` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Input = typeof Input.Type

/**
 * Output schema for the shell_command flow.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Output = Schema.Struct({
  output: Schema.String.annotate({
    description: "Codex-formatted result: exit code, wall time, and possibly middle-truncated output"
  }),
  exitCode: Schema.Number.annotate({ description: "Command exit code; 124 when the command timed out" })
})

/**
 * Decoded output returned by the `shell_command` flow.
 *
 * @category models
 * @since 1.0.0
 */
export type Output = typeof Output.Type

/**
 * Static conservative effect envelope for the shell_command flow.
 *
 * @category effects
 * @since 1.0.0
 */
export const effects = envelope({ tier: "irreversible", mode: "expected", reads: [], writes: [] })

/**
 * Narrows the effect envelope for a decoded invocation.
 *
 * A command line carries no declared envelope, so an invocation says nothing
 * the registry-time worst case does not already say.
 *
 * @category effects
 * @since 1.0.0
 */
export const effectsFor = (_input: typeof Input.Type) => effects

/**
 * Capabilities required by the shell_command flow.
 *
 * @category capabilities
 * @since 1.0.0
 */
export const capabilities = [capability("proc:spawn", "*")]

/**
 * Declaration-only shell_command flow.
 *
 * @category flows
 * @since 1.0.0
 */
export const flow = Flow.make({ name, description, input: Input, output: Output, capabilities, effects })

/**
 * Executes a shell command through the permission-aware kernel service and
 * renders the Codex model-facing output format.
 *
 * Non-zero exit codes and timeouts remain successful values, exactly as in
 * Codex; only host and permission failures use the typed error channel.
 *
 * @category handlers
 * @since 1.0.0
 */
export const run = Effect.fn("ShellCommand.run")(function*(
  input: typeof Input.Type
): Effect.fn.Return<typeof Output.Type, StdError.StdError, ChildProcessSpawner.ChildProcessSpawner> {
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  const result = yield* Exec.exec(input.command, {
    ...(input.workdir === undefined ? {} : { cwd: input.workdir }),
    timeoutMs,
    maxCaptureBytes: MAX_CAPTURE_BYTES
  }).pipe(
    Effect.map((value) => ({ timedOut: false, value })),
    Effect.catch((error) =>
      error.code === "timeout"
        ? Effect.succeed({ timedOut: true, value: { exitCode: TIMEOUT_EXIT_CODE, stderr: "", stdout: "" } })
        : Effect.fail(Exec.toStdError(input.command, error))
    )
  )
  const durationSeconds = (Date.now() - startedAt) / 1_000
  const aggregated = result.value.stderr === ""
    ? result.value.stdout
    : result.value.stdout === ""
    ? result.value.stderr
    : `${result.value.stdout}${result.value.stderr}`
  return {
    exitCode: result.value.exitCode,
    output: formatExecOutputForModel({
      durationSeconds,
      exitCode: result.value.exitCode,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      output: aggregated,
      ...(result.timedOut ? { timedOutAfterMs: timeoutMs } : {})
    })
  }
})

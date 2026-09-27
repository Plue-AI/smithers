/**
 * Per-invocation command status, shared by the CLI and its MCP host.
 *
 * @since 1.0.0
 */

import { Context, Effect } from "effect"

/**
 * Sink for a command's process-style exit status.
 * @category services
 * @since 1.0.0
 */
export const CommandStatus = Context.Reference<(code: number) => void>("/cli/CommandStatus", {
  defaultValue: () => (code) => {
    process.exitCode = code
  }
})

/**
 * Records a command status through the current sink.
 * @category constructors
 * @since 1.0.0
 */
export const set = (code: number): Effect.Effect<void> =>
  Effect.flatMap(CommandStatus, (write) => Effect.sync(() => write(code)))

/**
 * Recorded-history commands mounted on the durable runs namespace.
 * @since 1.0.0
 */

import { type Cli, z } from "incur"
import * as Environment from "../Environment.ts"
import * as History from "../history/History.ts"
import * as Verify from "../history/Verify.ts"
import * as Project from "../Project.ts"
import * as Bridge from "./ControlBridge.ts"
import * as Presentation from "./Presentation.ts"

const args = z.object({ run: z.string().min(1).describe("Durable run ID") })
const options = Bridge.connectionOptions.extend({
  at: z.number().int().nonnegative().optional().describe("Journal sequence to inspect; defaults to the latest frame"),
  lineage: z.string().optional().describe("Lineage ID; defaults to the lineage recorded at the frame"),
  limit: z.number().int().positive().default(10_000).describe("Maximum journal entries to read")
})
const verifyArgs = z.object({
  run: z.string().min(1).optional().describe("Durable run ID; omitted, every run the store holds")
})
const verifyOptions = Bridge.connectionOptions.extend({
  against: z.string().min(1).optional().describe(
    "Engine store to verify, with the control.db beside it; defaults to the project's .flows/engine.db"
  )
})
const parameters = (parsed: z.output<typeof options>): History.Options => ({ ...parsed, sequence: parsed.at })

const refusal = { code: "history_failed" } as const

/**
 * Mount the history inspection commands on an existing runs group.
 * @since 1.0.0
 * @category constructors
 */
export const appendHistoryCommands = (cli: Cli.Cli, runtime: Bridge.Runtime = {}) =>
  cli
    .command("inspect", {
      description: "Inspect the state and event counts recorded at one historical frame",
      mcp: { annotations: { readOnlyHint: true } },
      args,
      options,
      run(c) {
        return Presentation.guard(
          c,
          () =>
            History.read(
              Project.localRoot(c.options, runtime.environment ?? process.env),
              c.args.run,
              parameters(c.options),
              false,
              runtime.signal
            ),
          refusal
        )
      }
    })
    .command("replay", {
      description: "Replay committed history and sealed results without re-executing any actions",
      mcp: { annotations: { readOnlyHint: true } },
      args,
      options,
      run(c) {
        return Presentation.guard(
          c,
          () =>
            History.read(
              Project.localRoot(c.options, runtime.environment ?? process.env),
              c.args.run,
              parameters(c.options),
              true,
              runtime.signal
            ),
          refusal
        )
      }
    })
    .command("verify", {
      description: "Report which recorded steps the current flow code would replay and which it would execute again",
      mcp: { annotations: { readOnlyHint: true } },
      args: verifyArgs,
      options: verifyOptions,
      run(c) {
        return Presentation.guard(c, async () => {
          const root = Project.localRoot(c.options, runtime.environment ?? process.env)
          const against = c.options.against === undefined ? {} : { against: c.options.against }
          if (c.args.run === undefined) {
            const summary = await Verify.verifyAll(root, against, runtime.signal)
            if (summary.verdict === "divergent") throw Verify.storeDivergence(summary)
            return summary
          }
          const report = await Verify.verify(root, c.args.run, against, runtime.signal)
          if (report.verdict === "divergent") throw Verify.divergence(report)
          return report
        })
      }
    })

/**
 * Reconciles local history before a normal runs list/show query.
 * @since 1.0.0
 * @category constructors
 */
export const reconcileHistory = async (
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime = {}
): Promise<void> => {
  if (
    connection.remote !== undefined ||
    Environment.read(runtime.environment ?? process.env, "SMITHERS_REMOTE") !== undefined
  ) return
  await History.reconcile(Project.localRoot(connection, runtime.environment ?? process.env))
}

/**
 * Resolves the worktree passed through Bridge.Runtime before a local resume.
 * @since 1.0.0
 * @category constructors
 */
export const prepareHistoryRun = async (
  runId: string,
  connection: Bridge.ConnectionOptions,
  runtime: Bridge.Runtime = {}
): Promise<{ executionRoot?: string }> => {
  if (
    connection.remote !== undefined ||
    Environment.read(runtime.environment ?? process.env, "SMITHERS_REMOTE") !== undefined
  ) return {}
  return History.prepare(Project.localRoot(connection, runtime.environment ?? process.env), runId)
}

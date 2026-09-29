/**
 * Public fixed-suite evaluation commands.
 *
 * @since 1.0.0
 */

import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { Cli, z } from "incur"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import * as Presentation from "../cli/Presentation.ts"
import * as CliError from "../CliError.ts"
import * as Project from "../Project.ts"
import * as Evaluation from "./Evaluation.ts"

/** Options shared by evaluation commands that load local modules. */
const localOptions = {
  root: z.string().optional().describe("Smithers project directory"),
  remote: z.string().optional().describe("Not supported: evaluations execute local modules")
}
const runArgument = z.object({ run: z.string().describe("Evaluation run ID or saved run JSON file") })
const next = [{ command: "eval compare --help", description: "Compare results with a baseline" }]

/**
 * Builds the fixed-suite evaluation command group.
 * @category constructors
 * @since 1.0.0
 */
export const createEvalCli = (runtime: RuntimeConfig = {}) =>
  Cli.create("eval", {
    description: "Run fixed evaluation suites and compare committed score baselines"
  })
    .command("list", {
      description: "List evals/**/*.eval.ts modules without executing them",
      mcp: { annotations: { readOnlyHint: true } },
      options: z.object(localOptions),
      run: (context) =>
        Presentation.guard(context, async () => ({
          suites: await Evaluation.list(Project.localRoot(context.options, runtime.environment ?? process.env))
        }), { code: "eval_list_failed", next })
    })
    .command("run", {
      description: "Execute a suite's CaseExecutor and bound scorers, then persist its results",
      // Running imports a project module and executes its flows with the
      // operator's host privileges, so it stays off the MCP tool surface.
      mcp: false,
      args: z.object({ suite: z.string().describe("Discovered suite name or module file") }),
      options: z.object({
        ...localOptions,
        runId: z.string().optional().describe("Explicit run identity; defaults to a UUID"),
        at: z.string().datetime().optional().describe("Explicit observation timestamp for reproducible runs"),
        trials: z.coerce.number().int().min(1).max(1000).optional().describe("Runs per case (default: 1)"),
        k: z.coerce.number().int().min(1).optional().describe("Number of samples for pass@k (default: 1)"),
        output: z.string().optional().describe("Additional output JSON path; refuses overwriting existing files")
      }),
      async run(context) {
        let result: Evaluation.RunArtifact
        let file: string
        try {
          const root = Project.localRoot(context.options, runtime.environment ?? process.env)
          const runId = context.options.runId ?? randomUUID()
          file = Evaluation.runPath(root, runId)
          const loaded = await Evaluation.load(root, context.args.suite, runtime)
          result = await Evaluation.execute(loaded.suite, loaded.executor, {
            runId,
            at: context.options.at ?? new Date().toISOString(),
            ...(context.options.trials === undefined ? {} : { trials: context.options.trials }),
            ...(context.options.k === undefined ? {} : { k: context.options.k })
          }, runtime)
          runtime.signal?.throwIfAborted()
          const source = `${JSON.stringify(result, null, 2)}\n`
          await Evaluation.writeJson(file, source, false, runtime.signal)
          if (context.options.output !== undefined) {
            const output = resolve(root, context.options.output)
            if (output !== file) await Evaluation.writeJson(output, source, false, runtime.signal)
          }
        } catch (cause) {
          return Presentation.fail(context, cause, { code: "eval_run_failed", exitCode: 5 })
        }
        const failed = result.cases.some((entry) => entry.error !== undefined) ||
          result.observations.some((entry) => entry.kind === "inconclusive") || result.observations.length === 0
        if (failed) {
          return context.error({
            code: "eval_inconclusive",
            exitCode: 5,
            message: `Evaluation is inconclusive; results saved to ${file}`
          })
        }
        return Presentation.finish(context, {
          file,
          ...result,
          ...(result.trials === undefined ? {} : {
            summary: `pass@1=${result.trials.passAt1}; pass@${result.k ?? 1}=${result.trials.passAtK}; pass^${
              result.k ?? 1
            }=${result.trials.passHatK}; stderr=${
              Object.values(result.trials.perCase).reduce((sum, item) => sum + item.stderr, 0) / result.trials.cases
            }`
          })
        }, { next })
      }
    })
    .command("baseline", {
      description: "Write a committed baseline from a saved evaluation run",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgument,
      options: z.object({
        ...localOptions,
        output: z.string().optional().describe("Baseline file; defaults to evals/<suite>.baseline.json"),
        force: z.boolean().default(false).describe("Replace an existing baseline")
      }),
      run: (context) =>
        Presentation.guard(context, async () => {
          const root = Project.localRoot(context.options, runtime.environment ?? process.env)
          const run = await Evaluation.readRun(root, context.args.run)
          if (
            run.cases.some((entry) => entry.error !== undefined) || run.observations.length === 0 ||
            run.observations.some((entry) => entry.kind !== "score")
          ) {
            throw new CliError.Refused({
              fault: "user",
              code: "eval_run_incomplete",
              message: "Cannot commit an incomplete or inconclusive evaluation as a baseline"
            })
          }
          const file = context.options.output === undefined
            ? Evaluation.defaultBaselinePath(root, run.suite)
            : resolve(root, context.options.output)
          await Evaluation.writeJson(file, await Evaluation.baseline(run), context.options.force, runtime.signal)
          return { file, suite: run.suite, runId: run.runId, observations: run.observations.length }
        }, { code: "eval_baseline_failed", next })
    })
    .command("compare", {
      description: "Compare a saved run with a baseline; exit 1 for regressions and 5 for inconclusive results",
      mcp: { annotations: { readOnlyHint: false } },
      args: runArgument,
      options: z.object({
        ...localOptions,
        baseline: z.string().optional().describe("Committed baseline file"),
        mean: z.number().min(0).max(1).optional().describe("Required mean score"),
        min: z.number().min(0).max(1).optional().describe("Required minimum score"),
        output: z.string().optional().describe("Save the complete comparison JSON to a new file")
      }),
      async run(context) {
        let result: Awaited<ReturnType<typeof Evaluation.compare>>
        try {
          const root = Project.localRoot(context.options, runtime.environment ?? process.env)
          const run = await Evaluation.readRun(root, context.args.run)
          const file = context.options.baseline === undefined
            ? Evaluation.defaultBaselinePath(root, run.suite)
            : resolve(root, context.options.baseline)
          result = await Evaluation.compare(run, await Evaluation.readBaseline(file), {
            mean: context.options.mean,
            min: context.options.min
          })
          if (context.options.output !== undefined) {
            await Evaluation.writeJson(
              resolve(root, context.options.output),
              `${JSON.stringify(result, null, 2)}\n`,
              false,
              runtime.signal
            )
          }
        } catch (cause) {
          return Presentation.fail(context, cause, { code: "eval_compare_failed", exitCode: 5 })
        }
        if (result.exitCode !== 0) {
          return context.error({
            code: result.exitCode === 1 ? "eval_regression" : "eval_inconclusive",
            exitCode: result.exitCode,
            message:
              `${result.summary}; regressions=${result.report.regressions.length}, nondeterminism=${result.report.nondeterminism.length}, missing=${result.report.missing.length}; use --output to save the full report`
          })
        }
        return Presentation.finish(context, result, { next })
      }
    })

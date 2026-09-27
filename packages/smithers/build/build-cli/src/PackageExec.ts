/**
 * PACKAGE.ts planning and execution facade.
 *
 * @since 0.1.0
 */

import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import type * as Executor from "./Executor.ts"
import type { PlanReport, RunOptions } from "./internal/PackageOptions.ts"
import { plan } from "./internal/PackagePlanner.ts"
import { execute, sandboxRequest } from "./internal/PackageRunner.ts"
export type {
  CrateRow,
  ExecuteOptions,
  LaneData,
  Mode,
  PackageNode,
  PackagePlan,
  PackageVerb,
  PlanReport,
  RunOptions,
  TestOperandPlan
} from "./internal/PackageOptions.ts"
export {
  closureResultDigest,
  graphKeySentinel,
  keyMaterialWithGraph,
  PACKAGE_EXECUTION_FORMAT,
  plan,
  takesExclusiveTreePermit,
  workspaceRootToken
} from "./internal/PackagePlanner.ts"
export { execute } from "./internal/PackageRunner.ts"

/**
 * Plans and, unless `--plan` asked for the inert report, executes one
 * PACKAGE.ts invocation.
 *
 * The result follows the `plan` option: a literal `true` yields the
 * `PlanReport`, an omitted or literal `false` plan yields the executor
 * `Summary`, and only a runtime `boolean` keeps the union, so a caller that
 * already chose reads `Summary.ok` without an assertion.
 *
 * @category execution
 * @since 0.1.0
 */
export function run(options: RunOptions & { readonly plan: true }): Promise<PlanReport>
export function run(options: RunOptions & { readonly plan?: false }): Promise<Executor.Summary>
export function run(options: RunOptions): Promise<Executor.Summary | PlanReport>
export async function run(options: RunOptions): Promise<Executor.Summary | PlanReport> {
  const planned = await plan(options)
  if (options.plan === true) {
    return {
      verb: options.verb,
      pattern: options.patterns.join(" "),
      roots: planned.roots,
      targets: planned.workList.map((node) => ({
        label: node.label,
        rule: node.rule,
        mode: node.mode,
        key: node.keyPreview,
        cacheable: node.cacheable,
        dependencies: node.dependencies,
        ...(node.argv === undefined ? {} : { argv: node.argv }),
        ...(node.shards === 1 ? {} : { shards: node.shards }),
        ...(node.lane?.kind === "cargo" && node.argv === undefined ? { commands: node.lane.commands } : {}),
        // Every tool-running node reports its confinement: the declared policy
        // (the default confinement when none is declared) and whether this
        // host enforces it. Execution fails a confined node the host cannot
        // enforce, so a false here is a run that will not proceed.
        ...(node.argv === undefined && node.sandbox === undefined
          ? {}
          : {
            sandbox: node.sandbox ?? {},
            sandboxEnforced: ExecSandbox.enforceable(
              sandboxRequest(node, planned.nodes, options.index.workspace, options.cacheDirectory),
              ExecSandbox.host()
            )
          }),
        ...(node.refusal === undefined ? {} : { refusal: node.refusal })
      }))
    }
  }
  return execute(planned, options)
}

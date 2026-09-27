/**
 * Reduces a validated Fetch declaration to its complete execution contract.
 * @since 1.0.0
 */

import * as FetchTarget from "@smthrs/targets/Fetch"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import * as Diagnostic from "../../Diagnostic.ts"
import type * as Rule from "../RuleContract.ts"

/** The intrinsic network policy of the existing Fetch backend.
 * @category policies
 * @since 1.0.0
 */
export const sandbox = { network: true } as const

/** Reduces schema-validated attrs without reading remote bytes or the filesystem.
 * Output validation is repeated at the actual package boundary.
 * @category planning
 * @since 1.0.0
 */
export const planAttrs = (options: {
  readonly packagePath: string
  readonly attrs: FetchTarget.FetchAttrs
}): Rule.PlanResult<Rule.Fetch> => {
  const attrs = options.attrs
  if (attrs.out.startsWith("//")) {
    return { ok: false, refusal: `Fetch output ${JSON.stringify(attrs.out)} must be package-relative` }
  }
  const failure = Target.declaredOutputsFailure({ cwd: options.packagePath, paths: [attrs.out] })
  if (failure !== undefined) return { ok: false, refusal: `Fetch ${failure}` }
  try {
    return {
      ok: true,
      value: {
        family: "fetch",
        rule: "Fetch",
        lane: { kind: "fetch", url: attrs.url, sha256: attrs.sha256 },
        mode: "execute",
        declaredInputs: [],
        declaredOutputs: { cwd: ".", paths: [attrs.out] },
        serviceDeps: [],
        argv: undefined,
        bunTemplate: undefined,
        outDirs: [],
        outFiles: [Input.resolvePath(options.packagePath, attrs.out)],
        sandbox
      }
    }
  } catch (cause) {
    return { ok: false, refusal: `Fetch output is invalid: ${Diagnostic.describe(cause)}` }
  }
}

/** Plans the schema-backed declaration at the package lowering boundary.
 * @category planning
 * @since 1.0.0
 */
export const plan = (options: {
  readonly packagePath: string
  readonly target: Target.AnyTarget
}): Rule.PlanResult<Rule.Fetch> =>
  planAttrs({ packagePath: options.packagePath, attrs: FetchTarget.fetchAttrsOf(options.target) })

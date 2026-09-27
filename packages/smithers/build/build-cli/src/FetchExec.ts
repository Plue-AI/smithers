/**
 * Package-mode planning and execution for digest-pinned `S.Fetch` targets.
 *
 * Planning resolves the single declared output against the declaring package
 * and records the network capability that is intrinsic to a fetch. Execution
 * retrieves bytes through Effect's Node `HttpClient`, streams them into a
 * same-directory temporary file, verifies the declared sha256, and publishes
 * the verified file by atomic rename without disturbing the destination first.
 * CAS capture and replay remain owned by the shared package executor.
 *
 * @since 0.1.0
 */

import * as FetchTarget from "@smthrs/targets/Fetch"
import type * as Target from "@smthrs/targets/Target"
import * as FetchExecutor from "./internal/rules/FetchExecutor.ts"
import * as FetchPlan from "./internal/rules/FetchPlan.ts"

// Public names retain their existing identity; their implementation has one owner.
export { fetchDeadlineMs, FetchError, maximumFetchBytes, redactUrl } from "./internal/rules/FetchExecutor.ts"
export type { Result } from "./internal/rules/FetchExecutor.ts"

/**
 * The network policy intrinsic to every `S.Fetch` declaration.
 *
 * @category policies
 * @since 0.1.0
 */
export const sandbox = FetchPlan.sandbox

/**
 * The fields a Fetch target contributes to the shared package plan.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly outFiles: ReadonlyArray<string>
  readonly sandbox: typeof sandbox
  readonly refusal?: string | undefined
}

/**
 * Resolves and revalidates a Fetch output at the workspace boundary.
 *
 * The constructor already applies the declared-output law relative to its
 * package. Planning applies the same law again with the actual package path,
 * and separately rejects `//` because Fetch outputs are package-relative,
 * never workspace-root aliases.
 *
 * @category planning
 * @since 0.1.0
 */
export const planAttrs = (options: {
  readonly packagePath: string
  readonly attrs: FetchTarget.FetchAttrs
}): Plan => {
  const planned = FetchPlan.planAttrs(options)
  return planned.ok
    ? { outFiles: planned.value.outFiles, sandbox }
    : { outFiles: [], sandbox, refusal: planned.refusal }
}

/**
 * Plans a validated Fetch declaration from its target metadata.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = (options: {
  readonly packagePath: string
  readonly target: Target.AnyTarget
}): Plan => planAttrs({ packagePath: options.packagePath, attrs: FetchTarget.fetchAttrsOf(options.target) })

/**
 * Downloads, verifies, and atomically publishes one Fetch target.
 *
 * The response streams into a same-directory temporary file while sha256 is
 * updated incrementally. Digest verification is complete before that file is
 * renamed over the destination. A mismatch therefore cannot create or disturb
 * the destination, and the typed failure carries both hashes.
 *
 * @category execution
 * @since 0.1.0
 */
export const execute = async (options: {
  readonly root: string
  readonly target: Target.AnyTarget
  readonly outFile: string
  readonly signal?: AbortSignal | undefined
  /** Internal test seam; production callers use {@link maximumFetchBytes}. */
  readonly limitBytes?: number | undefined
}): Promise<FetchExecutor.Result> => {
  const attrs = FetchTarget.fetchAttrsOf(options.target)
  return FetchExecutor.download({ ...options, url: attrs.url, sha256: attrs.sha256 })
}

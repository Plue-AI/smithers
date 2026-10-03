/**
 * Lazy host adapter loading shared by repository construction and application.
 *
 * @since 1.0.0
 */

import type * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"
import { MergeError } from "./Outcome.ts"

// Keep browser/provider imports independent of Node until host work is requested.
const adapter = "@smthrs/jj/node/NodeJj"

/**
 * Builds a lazy loader sharing pending and successful imports, retrying rejections.
 *
 * @category utils
 * @since 1.0.0
 */
export const makeHostAdapterLoader = (
  importer: () => Promise<typeof NodeJj>
): Effect.Effect<typeof NodeJj, MergeError> => {
  let loading: Promise<typeof NodeJj> | undefined
  return Effect.tryPromise({
    try: () =>
      loading ??= importer().catch((cause) => {
        loading = undefined
        throw cause
      }),
    catch: (cause) => new MergeError({ reason: "vcs_failed", message: "could not load the host jj adapter", cause })
  })
}

/**
 * Loads the host adapter once, retrying resolution after a rejected import.
 *
 * @category utils
 * @since 1.0.0
 */
export const loadHostAdapter = makeHostAdapterLoader(() => import(adapter) as Promise<typeof NodeJj>)

/**
 * The no-op artifact store: the honest refusal a composition gets when it has
 * no artifact store at all, with per-method overrides.
 *
 * @since 1.0.0-rc.0
 */

import * as Effect from "effect/Effect"
import type { Service } from "./ArtifactStore.ts"
import { ArtifactStoreError } from "./ArtifactStoreError.ts"

/**
 * Builds an artifact store whose every operation fails as unavailable, with
 * per-method overrides.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 * @slop
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string) =>
    Effect.fail(new ArtifactStoreError({ code: "unavailable", message: `${method} is unavailable` }))
  return {
    put: Effect.fn("ArtifactStore.put")(() => unavailable("put")),
    get: Effect.fn("ArtifactStore.get")(() => unavailable("get")),
    has: Effect.fn("ArtifactStore.has")(() => unavailable("has")),
    findMissing: Effect.fn("ArtifactStore.findMissing")(() => unavailable("findMissing")),
    ...overrides
  }
}

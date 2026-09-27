/**
 * The authenticated identity of one sync request.
 *
 * The principal is a `Context.Reference` whose default is
 * {@link anonymous}, which is what makes the read path fail closed: code
 * that never authenticates runs as anonymous, and the server refuses
 * anonymous access to every non-branch run. The only ways to become the
 * workspace principal are a workspace capability verified by
 * `SyncAuth.layer` at the RPC boundary, or an in-process caller that
 * provides the reference itself — which is the sanctioned path for code
 * already holding the journal, and never for a transport.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Layer from "effect/Layer"

/**
 * A request that presented no credential. It may still read branch runs
 * through per-request branch share capabilities.
 *
 * @category models
 * @since 0.1.0
 */
export interface Anonymous {
  readonly _tag: "Anonymous"
}

/**
 * A request authenticated for the workspace's non-branch runs.
 * `capabilityId` names the credential for auditing; in-process callers name
 * themselves.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workspace {
  readonly _tag: "Workspace"
  readonly capabilityId: string
  /**
   * When the credential that established this principal stops authorizing,
   * in epoch milliseconds, or `Infinity` for an in-process owner that
   * presented no credential at all.
   *
   * A signed expiry is this package's ONLY revocation mechanism, and an open
   * subscription is not a sequence of requests: it is authorized once, at
   * open, and then streams. Without the expiry on the identity itself,
   * nothing downstream could tell a live subscription to stop, so a holder of
   * an expired capability kept reading for as long as it declined to
   * disconnect.
   */
  readonly expiresAtMs: number
}

/**
 * Any authenticated identity a sync request can carry.
 *
 * @category models
 * @since 0.1.0
 */
export type Principal = Anonymous | Workspace

/**
 * The unauthenticated principal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const anonymous: Principal = { _tag: "Anonymous" }

/**
 * Constructs the workspace principal for a named credential.
 *
 * `expiresAtMs` defaults to `Infinity`, which is the honest answer for an
 * in-process owner that already holds the journal: it presented no credential,
 * so no credential can expire under it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const workspace = (
  capabilityId: string,
  expiresAtMs: number = Number.POSITIVE_INFINITY
): Principal => ({ _tag: "Workspace", capabilityId, expiresAtMs })

/**
 * Returns `true` when a principal may read non-branch runs.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isWorkspace = (principal: Principal): principal is Workspace => principal._tag === "Workspace"

/**
 * The current request's principal, defaulting to {@link anonymous}.
 *
 * @category references
 * @since 0.1.0
 */
export const SyncPrincipal: Context.Reference<Principal> = Context.Reference<Principal>(
  "@smthrs/sync/SyncPrincipal",
  { defaultValue: () => anonymous }
)

/**
 * Provides the workspace principal directly, bypassing credential
 * verification. For in-process callers that already own the journal — a
 * transport boundary must authenticate through `SyncAuth.layer` instead.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWorkspace = (capabilityId: string): Layer.Layer<never> =>
  Layer.succeed(SyncPrincipal, workspace(capabilityId))

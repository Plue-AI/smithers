/**
 * The sync read path's connection authentication: implementations of the
 * `SyncRpcs.SyncAuth` RPC middleware.
 *
 * A connection presents a {@link WorkspaceShare.WorkspaceCapability} in the
 * {@link capabilityHeader} request header. {@link layer} verifies it against
 * the workspace's {@link WorkspaceShare.WorkspaceShare} authority and runs
 * the handler as the workspace principal. A request with no header runs as
 * the anonymous principal — branch share capabilities carried in request
 * payloads still authorize branch reads — and the server refuses anonymous
 * access to every non-branch run. A request whose header is present but
 * malformed, forged, expired, or signed by an unknown key is refused
 * outright: presence of a credential is a claim, and a false claim is never
 * downgraded to anonymity.
 *
 * There is deliberately no trusted pass-through implementation here: the only
 * sanctioned bypass is an in-process caller providing `SyncPrincipal` itself,
 * never a transport.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Headers from "effect/unstable/http/Headers"
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware"
import { causeText } from "./internal/CauseText.ts"
import * as shareSigner from "./internal/ShareSigner.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncPrincipal from "./SyncPrincipal.ts"
import { SyncAuth } from "./SyncRpcs.ts"
import * as WorkspaceShare from "./WorkspaceShare.ts"

/**
 * The request header a connection presents its workspace capability in.
 *
 * @category constants
 * @since 0.1.0
 */
export const capabilityHeader = "flows-sync-workspace"

const denied = shareSigner.unauthorized

/**
 * Renders a workspace capability as its header value: unpadded base64url of
 * the schema-encoded capability JSON.
 *
 * @category encoding
 * @since 0.1.0
 */
export const encodeCapability = (
  capability: WorkspaceShare.WorkspaceCapability
): Effect.Effect<string, SyncError> => {
  const encoded = Schema.encodeUnknownResult(WorkspaceShare.WorkspaceCapability)(capability)
  return Result.isFailure(encoded)
    ? Effect.fail(
      new SyncError({
        code: "invalid_request",
        message: "The workspace capability does not encode",
        // The rendering, never the parse failure itself: a schema issue
        // carries the value it rejected, and the value here is a credential.
        cause: causeText(encoded.failure)
      })
    )
    : Effect.succeed(Encoding.encodeBase64Url(JSON.stringify(encoded.success)))
}

/**
 * Decodes a capability header value. Every malformation folds to the same
 * `unauthorized` refusal so the header is not a parsing oracle.
 *
 * @category encoding
 * @since 0.1.0
 */
export const decodeCapability = (value: string): Effect.Effect<WorkspaceShare.WorkspaceCapability, SyncError> => {
  const text = Encoding.decodeBase64UrlString(value)
  if (Result.isFailure(text)) {
    return Effect.fail(denied("The workspace capability header is not a capability"))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.success)
  } catch {
    return Effect.fail(denied("The workspace capability header is not a capability"))
  }
  const decoded = Schema.decodeUnknownResult(WorkspaceShare.WorkspaceCapability)(parsed)
  return Result.isFailure(decoded)
    ? Effect.fail(denied("The workspace capability header is not a capability"))
    : Effect.succeed(decoded.success)
}

/**
 * Provides the workspace-capability authentication middleware: no header
 * runs the handler as anonymous, a verified header runs it as the workspace
 * principal, and anything else refuses the request. Verification faults
 * (Web Crypto failing) propagate as their own error rather than as a
 * refusal.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<SyncAuth, never, WorkspaceShare.WorkspaceShare> = Layer.effect(
  SyncAuth,
  Effect.gen(function*() {
    const share = yield* WorkspaceShare.WorkspaceShare
    const middleware: RpcMiddleware.RpcMiddleware<never, SyncError, never> = (effect, options) => {
      const header = Headers.get(options.headers, capabilityHeader)
      if (header._tag === "None") {
        return Effect.provideService(effect, SyncPrincipal.SyncPrincipal, SyncPrincipal.anonymous)
      }
      return decodeCapability(header.value).pipe(
        Effect.flatMap((capability) => share.verify(capability, { access: "read" })),
        Effect.flatMap((claims) =>
          Effect.provideService(
            effect,
            SyncPrincipal.SyncPrincipal,
            // The signed expiry travels WITH the identity. A handler that
            // opens a stream authorizes once; reducing the verified claims to
            // a capability id here left the stream with nothing to expire on.
            SyncPrincipal.workspace(claims.capabilityId, claims.expiresAtMs)
          )
        )
      )
    }
    return middleware
  })
)

/**
 * Stamps every outgoing request from a generated RPC client with the given
 * workspace capability.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerClient = (
  capability: WorkspaceShare.WorkspaceCapability
): Layer.Layer<RpcMiddleware.ForClient<SyncAuth>, SyncError> =>
  RpcMiddleware.layerClient(
    SyncAuth,
    Effect.map(encodeCapability(capability), (header) => ({ next, request }) =>
      next({ ...request, headers: Headers.set(request.headers, capabilityHeader, header) }))
  )

/**
 * Deterministic grant-store layers for tests.
 *
 * @since 1.0.0-rc.0
 */

import { GrantStoreError, permissionDenied } from "@smthrs/capability/Permission"
import { Effect, Layer } from "effect"
import { emptyPolicy as closedPolicy } from "../GrantStore.ts"
import { GrantStore, layerNoop, type Resolution, type Service } from "../GrantStore.ts"

/**
 * An allow-all grant store.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerAllow: Layer.Layer<GrantStore> = layerNoop

/**
 * Provides a grant store that denies every capability.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerDeny = (reason = "denied by test"): Layer.Layer<GrantStore> => {
  const service = GrantStore.of({
    policy: closedPolicy,
    check: Effect.fn("GrantStore.check")((capability) => Effect.fail(permissionDenied(capability, reason))),
    reply: Effect.fn("GrantStore.reply")(() => Effect.fail(new GrantStoreError({ code: "request_not_found" }))),
    list: Effect.fn("GrantStore.list")(() => Effect.succeed([]))(),
    grantEnvelope: Effect.fn("GrantStore.grantEnvelope")(() => Effect.void)
  })
  return Layer.succeed(GrantStore)(service)
}

/**
 * Provides a grant store whose checks consume a deterministic sequence of
 * attended-style replies. `once`, `run`, and `remembered` allow the check;
 * `deny` rejects it. Exhausting the script rejects further checks.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerScripted = (
  replies: ReadonlyArray<Resolution>
): Layer.Layer<GrantStore> =>
  Layer.effect(
    GrantStore,
    Effect.sync(() => {
      let index = 0
      const service: Service = GrantStore.of({
        policy: closedPolicy,
        check: Effect.fn("GrantStore.check")((capability) =>
          Effect.suspend(() => {
            const reply = replies[index++]
            return reply !== undefined && reply !== "deny"
              ? Effect.void
              : Effect.fail(
                permissionDenied(
                  capability,
                  reply === undefined ? "permission reply script exhausted" : "permission request denied"
                )
              )
          })
        ),
        reply: Effect.fn("GrantStore.reply")(() => Effect.fail(new GrantStoreError({ code: "request_not_found" }))),
        list: Effect.fn("GrantStore.list")(() => Effect.succeed([]))(),
        grantEnvelope: Effect.fn("GrantStore.grantEnvelope")(() => Effect.void)
      })
      return service
    })
  )

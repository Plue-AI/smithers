/**
 * Anvil fork service target declarations.
 *
 * A forked Anvil is a service, not a command: it is acquired through the
 * supervisor, readiness-gated on its RPC port, and released when the last
 * consumer settles. The fork URL is a declared secret that resolves at
 * spawn, and a `"latest"` fork block opts every consumer out of caching
 * because the upstream state moves.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * Attrs for one forked Anvil JSON-RPC service.
 *
 * @category attrs
 * @since 0.1.0
 */
export const ForkAttrs = Schema.Struct({
  forkUrl: Secret.Declaration,
  forkBlockNumber: Schema.Union([Schema.Number, Schema.Literal("latest")]),
  port: Schema.Number
})

const definition = Target.make("Anvil.Fork", {
  attrs: ForkAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Anvil.Fork")
})

/**
 * Declares a scoped, readiness-gated Anvil fork service.
 *
 * @category targets
 * @since 0.1.0
 */
export const Fork = definition

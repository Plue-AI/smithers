/**
 * The injected table that says where a placed flow runs.
 *
 * A flow declares where it wants to run with the serializable
 * `Flow.Placement` annotation, which never names a machine. The host that
 * composes the engine maps each placement's `target` to a binding. With no
 * table, every placement runs here, as it always has.
 *
 * @since 1.0.0
 */

import type * as Placement from "@smthrs/plan/Placement"
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type * as Rpc from "effect/unstable/rpc/Rpc"
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup"

/**
 * Where one placement runs.
 *
 * - `Here`: this engine drives the execution.
 * - `Proxy`: another engine drives it under the caller's execution id, reached
 *   through that engine's served `FlowProxy` group. This engine keeps one
 *   leaf; the remote engine keeps the plan, the attempts, and the result.
 *   `connect` opens an RPC client for the group it is given, for example
 *   `RpcClient.make(group)` over an HTTP protocol.
 *
 * @category models
 * @since 1.0.0
 */
export type Binding =
  | { readonly _tag: "Here" }
  | {
    readonly _tag: "Proxy"
    readonly connect: (group: RpcGroup.RpcGroup<Rpc.Any>) => Effect.Effect<unknown, never, Scope.Scope>
  }

/**
 * Resolves a flow's placement to a binding.
 *
 * @category models
 * @since 1.0.0
 */
export interface Service {
  readonly resolve: (placement: Placement.Placement | undefined) => Binding
}

const here: Binding = { _tag: "Here" }

/**
 * The placement table. The default runs everything here.
 *
 * @category services
 * @since 1.0.0
 */
export const Hosts = Context.Reference<Service>("@smthrs/engine/Hosts", {
  defaultValue: () => ({ resolve: () => here })
})

/**
 * A table keyed by placement `target`. `Local` and `Client` placements, an
 * absent placement, and a target the table does not name run `fallback`,
 * which is here by default.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = (table: Readonly<Record<string, Binding>>, fallback: Binding = here) =>
  Layer.succeed(Hosts)({
    resolve: (placement) =>
      placement === undefined || placement._tag === "flows/core/Placement/Local" ||
        placement._tag === "flows/core/Placement/Client" || placement.target === undefined
        ? fallback
        : Object.hasOwn(table, placement.target)
        ? table[placement.target]!
        : fallback
  })

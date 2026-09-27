/**
 * The typed hook surface: hook kinds, the hook entry shape, and the shared
 * kernel's base hook catalog.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}. The shared catalog is limited to
 * `config` and `configResolved`;
 * `@smthrs/agent` adds only `cellRegistry`, `cellFlows`, and
 * `cellModelRequest`. Durable-core lifecycle policy is not a hook catalog.
 *
 * `FlowsHooks` is **open for augmentation, closed for dispatch**: a host
 * declares its hooks with `declare module "@smthrs/plugin"`, supplies the
 * matching runtime catalog, and dispatches only that bounded set.
 *
 * @since 1.0.0-rc.0
 */

import type * as Effect from "effect/Effect"

/**
 * Dispatch semantics of a hook, fixed by the core.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type HookKind = "sequential" | "parallel" | "first" | "waterfall"

declare const HookTypeId: unique symbol

/**
 * Phantom carrier that records a hook's kind and handler type in the type
 * system without adding anything at runtime.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HookMeta<K extends HookKind, F> {
  readonly [HookTypeId]?: { readonly kind: K; readonly handler: F }
}

/**
 * The object form of a hook entry: Vite's per-hook ordering object, verbatim.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface HookObject<F> {
  readonly order?: "pre" | "post" | undefined
  readonly handler: F
}

/**
 * A hook entry is either the bare handler or `{ order?, handler }`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type HookEntry<K extends HookKind, F> = (F | HookObject<F>) & HookMeta<K, F>

/**
 * Every handler runs, in resolved order, one at a time.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type SequentialHook<F> = HookEntry<"sequential", F>

/**
 * Every handler runs concurrently; results are ignored and failures are
 * returned to the caller rather than failing it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ParallelHook<F> = HookEntry<"parallel", F>

/**
 * Handlers run in order until one returns `Option.some`.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FirstHook<F> = HookEntry<"first", F>

/**
 * Each handler receives the previous handler's output.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type WaterfallHook<F> = HookEntry<"waterfall", F>

/**
 * Extracts the declared kind of a hook entry type.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type KindOf<T> = T extends HookMeta<infer K, any> ? K : never

/**
 * The runtime catalog a host supplies for a hook interface: each hook name
 * mapped to its kind. A name declared in `H` must carry the kind its type
 * declares. Names outside `H` are admitted with any kind, because the type
 * system cannot enumerate an augmentable interface; resolution checks them
 * at runtime and dispatch refuses a kind that disagrees with the catalog.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type HookCatalog<H> =
  & { readonly [K in keyof H & string]?: KindOf<H[K]> }
  & { readonly [name: string]: HookKind | undefined }

/**
 * Extracts the handler type of a hook entry type.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type HandlerOf<T> = T extends HookMeta<any, infer F> ? F : never

/**
 * Selects the hook names of a given kind from a hook interface.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type KeysOfKind<H, K extends HookKind> =
  & {
    [P in keyof H]: KindOf<H[P]> extends K ? P : never
  }[keyof H]
  & string

/**
 * Extracts the positional argument tuple accepted by a hook entry.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type ArgsOf<T> = HandlerOf<T> extends (...args: infer A) => any ? A : never

/**
 * Extracts the Effect returned by a hook entry.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type ReturnOf<T> = HandlerOf<T> extends (...args: any) => infer R ? R : never

/**
 * Extracts the success value returned by a hook entry's Effect.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type SuccessOf<T> = ReturnOf<T> extends Effect.Effect<infer A, any, any> ? A : never

/**
 * Extracts the context required by a hook entry's Effect.
 *
 * @category type-level
 * @since 1.0.0-rc.0
 */
export type ContextOf<T> = ReturnOf<T> extends Effect.Effect<any, any, infer R> ? R : never

/**
 * Runtime catalog of the shared kernel's hook names and kinds.
 *
 * The type system cannot enumerate an augmentable interface, so this constant
 * is what the `unknown_hook` guard checks against. A host passes its own
 * superset to {@link resolve}. The cell harness adds only the hooks it
 * dispatches; lifecycle and engine-policy hooks do not belong here.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
const sharedHooks: { config: "waterfall"; configResolved: "parallel" } = Object.create(null)
Object.defineProperties(sharedHooks, {
  config: { value: "waterfall", enumerable: true },
  configResolved: { value: "parallel", enumerable: true }
})
/**
 * Frozen runtime catalog for the shared configuration hooks.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const engineHooks: Readonly<{
  readonly config: "waterfall"
  readonly configResolved: "parallel"
}> = Object.freeze(sharedHooks)

/**
 * Normalizes a hook entry to its handler.
 *
 * @category utils
 * @since 1.0.0-rc.0
 */
export const handlerOf = (entry: unknown): (...args: Array<any>) => unknown =>
  typeof entry === "function"
    ? entry as (...args: Array<any>) => unknown
    : (entry as HookObject<(...args: Array<any>) => unknown>).handler

/**
 * Reads the per-hook `order` of a hook entry.
 *
 * @category utils
 * @since 1.0.0-rc.0
 */
export const orderOf = (entry: unknown): "pre" | "post" | undefined =>
  typeof entry === "function" ? undefined : (entry as HookObject<unknown>).order

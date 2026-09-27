/**
 * The dispatcher: a plain service over a resolved plugin list, generic over the
 * hook interface.
 *
 * The public package contract is documented at
 * {@link https://smithers.sh/docs/reference/api/plugin}. Each host holds an instance over its
 * augmented `FlowsHooks` and may dispatch only the runtime catalog it supplied.
 * The shipped cell host owns the three
 * waterfalls declared in `packages/smithers/agent/src/CellPlugin.ts`; there is
 * no engine-wide lifecycle dispatcher.
 *
 * Cancellation is fiber interruption via scope closure; nothing here threads an
 * `AbortSignal`.
 *
 * @since 1.0.0-rc.0
 */

import * as ImmutableMap from "@smthrs/canonical/ReadonlyMap"
import type * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { ArgsOf, ContextOf, HookKind, KeysOfKind, SuccessOf } from "./Hooks.ts"
import { engineHooks } from "./Hooks.ts"
import type { FlowsHooks } from "./index.ts"
import { PluginError } from "./PluginError.ts"
import { defaultParallelConcurrency, type HandlerRecord, type Resolved } from "./Resolve.ts"

const empty: ReadonlyArray<HandlerRecord> = Object.freeze([])

// The typed catalog and the runtime catalog can only drift when a host casts
// around `KeysOfKind`; refuse before any handler runs rather than execute a
// hook under semantics its declaration never promised.
const kindMismatch = (resolved: Resolved<unknown>, hook: string, kind: HookKind): PluginError | undefined => {
  if (!Object.hasOwn(resolved.kinds, hook)) return undefined
  const declared = resolved.kinds[hook]
  if (declared === kind) return undefined
  return new PluginError({
    code: "hook_kind_mismatch",
    message: `hook "${hook}" is declared ${JSON.stringify(declared)} in the runtime catalog but was dispatched as ${
      JSON.stringify(kind)
    }`,
    hook
  })
}

const runHandler = (
  record: HandlerRecord,
  args: ReadonlyArray<unknown>
): Effect.Effect<unknown, PluginError, any> => {
  const onCause = (cause: Cause.Cause<unknown>) =>
    Effect.fail(
      new PluginError({
        code: "hook_failed",
        message: `hook "${record.hook}" failed in plugin "${record.plugin}"`,
        plugin: record.plugin,
        hook: record.hook,
        cause
      })
    )

  return Effect.sync(() => record.handler(...args)).pipe(
    Effect.catchCause(onCause),
    Effect.flatMap((result) =>
      Effect.isEffect(result)
        ? result.pipe(Effect.catchCause(onCause))
        : Effect.fail(
          new PluginError({
            code: "hook_failed",
            message: `hook "${record.hook}" in plugin "${record.plugin}" returned a non-Effect (${typeof result})`,
            plugin: record.plugin,
            hook: record.hook
          })
        )
    )
  )
}

/**
 * The dispatch surface.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Service<H = FlowsHooks> {
  /** The resolved list this dispatcher walks. */
  readonly resolved: Resolved<H>
  /** Frozen, ordered handler records for a hook. */
  readonly handlers: (hook: string) => ReadonlyArray<HandlerRecord>
  /** Runs every handler in resolved order, one at a time. */
  readonly sequential: <K extends KeysOfKind<H, "sequential">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<ReadonlyArray<SuccessOf<H[K]>>, PluginError, ContextOf<H[K]>>
  /**
   * Runs every handler concurrently, ignoring results. Never fails: handler
   * failures are returned so the caller can report them at its own boundary.
   */
  readonly parallel: <K extends KeysOfKind<H, "parallel">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<ReadonlyArray<PluginError>, never, ContextOf<H[K]>>
  /** Runs handlers in order until one returns `Option.some`. */
  readonly first: <K extends KeysOfKind<H, "first">>(
    hook: K,
    ...args: ArgsOf<H[K]>
  ) => Effect.Effect<SuccessOf<H[K]>, PluginError, ContextOf<H[K]>>
  /** Threads a value through every handler, merging each returned patch. */
  readonly waterfall: <K extends KeysOfKind<H, "waterfall">>(
    hook: K,
    initial: ArgsOf<H[K]>[0],
    merge: (previous: ArgsOf<H[K]>[0], patch: Exclude<SuccessOf<H[K]>, void>) => ArgsOf<H[K]>[0]
  ) => Effect.Effect<ArgsOf<H[K]>[0], PluginError, ContextOf<H[K]>>
}

/**
 * Builds a dispatcher over an already resolved plugin list.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = <H = FlowsHooks>(resolved: Resolved<H>): Service<H> => {
  const handlers = (hook: string): ReadonlyArray<HandlerRecord> => resolved.handlers.get(hook) ?? empty

  const sequential = ((hook: string, ...args: Array<unknown>) =>
    Effect.gen(function*() {
      const mismatch = kindMismatch(resolved, hook, "sequential")
      if (mismatch !== undefined) return yield* Effect.fail(mismatch)
      const results: Array<unknown> = []
      for (const record of handlers(hook)) {
        results.push(yield* runHandler(record, args))
      }
      return results
    })) as Service<H>["sequential"]

  const parallel = ((hook: string, ...args: Array<unknown>) => {
    const mismatch = kindMismatch(resolved, hook, "parallel")
    if (mismatch !== undefined) return Effect.succeed([mismatch])
    return Effect.forEach(
      handlers(hook),
      (record) =>
        runHandler(record, args).pipe(
          Effect.match({ onFailure: (error) => [error], onSuccess: () => [] as Array<PluginError> })
        ),
      { concurrency: resolved.parallelConcurrency }
    ).pipe(Effect.map((chunks) => chunks.flat()))
  }) as Service<H>["parallel"]

  const first = ((hook: string, ...args: Array<unknown>) =>
    Effect.gen(function*() {
      const mismatch = kindMismatch(resolved, hook, "first")
      if (mismatch !== undefined) return yield* Effect.fail(mismatch)
      for (const record of handlers(hook)) {
        const result = yield* runHandler(record, args)
        if (!Option.isOption(result)) {
          return yield* Effect.fail(
            new PluginError({
              code: "invalid_hook_result",
              message: `first hook "${record.hook}" in plugin "${record.plugin}" did not return an Option`,
              plugin: record.plugin,
              hook: record.hook
            })
          )
        }
        if (Option.isSome(result)) return result
      }
      return Option.none()
    })) as unknown as Service<H>["first"]

  const waterfall =
    ((hook: string, initial: unknown, merge: (previous: unknown, patch: unknown) => unknown) =>
      Effect.gen(function*() {
        const mismatch = kindMismatch(resolved, hook, "waterfall")
        if (mismatch !== undefined) return yield* Effect.fail(mismatch)
        let value = initial
        for (const record of handlers(hook)) {
          const patch = yield* runHandler(record, [value])
          if (patch !== undefined) {
            value = yield* Effect.try({
              try: () => merge(value, patch),
              catch: (cause) =>
                cause instanceof PluginError
                  ? new PluginError({
                    code: cause.code,
                    message: cause.message,
                    plugin: record.plugin,
                    hook: record.hook,
                    path: cause.path
                  })
                  : new PluginError({
                    code: "config_invalid",
                    message: `waterfall hook "${record.hook}" in plugin "${record.plugin}" returned an invalid patch`,
                    plugin: record.plugin,
                    hook: record.hook
                  })
            })
          }
        }
        return value
      })) as Service<H>["waterfall"]

  return Object.freeze({ resolved, handlers, sequential, parallel, first, waterfall })
}

/**
 * A dispatcher with no plugins at all.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeNoop = <H = FlowsHooks>(): Service<H> =>
  make<H>(Object.freeze({
    plugins: Object.freeze([]),
    handlers: ImmutableMap.make<string, ReadonlyArray<HandlerRecord>>(),
    kinds: engineHooks,
    parallelConcurrency: defaultParallelConcurrency
  }))

/**
 * The shared dispatcher, as a service tag.
 *
 * This tag holds one dispatcher over the process-wide augmented `FlowsHooks`.
 * `declare module "@smthrs/plugin"` augmentation is the supported extension
 * mechanism for values placed in the tag. A host typed against a separate hook
 * interface holds its `Service<H>` directly, as `@smthrs/agent` does, and does
 * not use this tag or its layers.
 *
 * @category context
 * @since 1.0.0-rc.0
 */
export class Plugins extends Context.Service<Plugins, Service>()("flows/plugin/Plugins") {}

/**
 * Layer providing a dispatcher over an already resolved plugin list.
 *
 * This layer targets the shared augmented `FlowsHooks` catalog only. A host
 * with a separate hook interface holds its `Service<H>` directly.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (resolved: Resolved): Layer.Layer<Plugins> => Layer.succeed(Plugins)(make(resolved))

/**
 * Layer providing a dispatcher with no plugins.
 *
 * This layer targets the shared augmented `FlowsHooks` catalog only. A host
 * with a separate hook interface holds its `Service<H>` directly.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerNoop: Layer.Layer<Plugins> = Layer.succeed(Plugins)(makeNoop())

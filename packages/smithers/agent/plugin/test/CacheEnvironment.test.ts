/**
 * Issue #88: `Action.CurrentCacheEnvironment` had zero production
 * providers — the machinery issue #75 added defaulted to the empty
 * environment in every shipped composition, so swapping a model or host
 * plugin left every sealed content digest byte-identical and served the
 * stale cross-run cache entry.
 *
 * The plugin kernel declares an environment only when the application
 * supplies its complete capability identity. Otherwise the engine keeps
 * sealed keys run-local.
 */
import { Action } from "@smthrs/flow"
import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import type * as Config from "../src/Config.ts"
import * as Kernel from "../src/Kernel.ts"
import * as Plugin from "../src/Plugin.ts"
import type { PluginError } from "../src/PluginError.ts"
import type * as Resolve from "../src/Resolve.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** What the plugin layers in `Input` provide. */
type Provided<Input> = Input extends ReadonlyArray<infer Item> ? Provided<Item>
  : Input extends { readonly layer: Layer.Layer<infer ROut, infer _E, infer _RIn> } ? ROut
  : never

/** What the plugin layers in `Input` need. */
type Needed<Input> = Input extends ReadonlyArray<infer Item> ? Needed<Item>
  : Input extends { readonly layer: Layer.Layer<infer _ROut, infer _E, infer RIn> } ? RIn
  : never

/**
 * Builds a kernel and types its layer from the plugins passed in.
 *
 * `Kernel.layer` is `Layer<any, PluginError, any>`, so a test that named its
 * services by hand kept compiling after a provider was removed (#2704). The
 * cast below names exactly what `plugins` provide and still need, so dropping a
 * plugin layer drops its services and the body that reads them fails tsc.
 * Pass layer-bearing plugins as literals: `Plugin.make` widens `layer`.
 */
const kernelOf = async <const Input extends ReadonlyArray<Plugin.PluginInput>>(
  plugins: Input,
  config: Config.FlowsConfig = {},
  options: Omit<Resolve.Options, "config"> = {}
) => {
  const kernel = await run(Kernel.make(plugins, config, options))
  const layer = kernel.layer as Layer.Layer<Provided<Input>, PluginError, Exclude<Needed<Input>, Provided<Input>>>
  return { kernel, layer }
}

class Marker extends Context.Service<Marker, string>()("CacheEnvironment/Marker") {}

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/plugin/CacheEnvironment/Unprovided"
) {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = async () => {
  const withMarker = await kernelOf([{ name: "host", layer: Layer.succeed(Marker)("host") }])
  // @ts-expect-error no plugin layer provides Unprovided
  run(Effect.map(Unprovided, (service) => service.value).pipe(Effect.provide(withMarker.layer)))
  run(Marker.pipe(Effect.provide(withMarker.layer)))
  const withoutMarker = await kernelOf([{ name: "host" }])
  // @ts-expect-error dropping the host plugin's `Layer.succeed(Marker)` drops Marker
  run(Marker.pipe(Effect.provide(withoutMarker.layer)))
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a body that needs a service no plugin layer provides", () => {
    // The assertion is the `@ts-expect-error` directives above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

describe("the kernel declares the cache environment (issue #88)", () => {
  it("leaves the environment absent when no complete identity is supplied", async () => {
    const { layer } = await kernelOf([
      Plugin.make({ name: "flows-plugin-model-sonnet" }),
      { name: "flows-plugin-host-local", layer: Layer.succeed(Marker)("host") }
    ])
    const environment = await run(
      Effect.gen(function*() {
        // A plugin-contributed service and the environment resolve from the
        // same merged layer.
        expect(yield* Marker).toBe("host")
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(layer))
    )
    // Asserted as a whole value, not just `.layers`: `undefined` is the
    // engine's "nothing was declared" state, which scopes sealed cache keys
    // to a single run. A kernel that produced it would be an issue-#88
    // regression that the property access alone would not catch.
    expect(environment).toBeUndefined()
  })

  it("a layer-less plugin list also leaves it absent", async () => {
    const { layer } = await kernelOf([Plugin.make({ name: "flows-plugin-hooks-only" })])
    const environment = await run(
      Effect.gen(function*() {
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(layer))
    )
    expect(environment).toBeUndefined()
  })

  it("accepts a complete capability and non-plugin layer identity", async () => {
    const { layer } = await kernelOf(
      [Plugin.make({ name: "flows-plugin-model-sonnet", version: "1.4.0" })],
      {},
      {
        cacheEnvironment: {
          layers: ["Host=node"],
          capabilities: { fs: ["/workspace/**"] }
        }
      }
    )
    const environment = await run(
      Effect.gen(function*() {
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(layer))
    )
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet@1.4.0", "Host=node"],
      capabilities: { fs: ["/workspace/**"] }
    })
  })

  it("uses plugin identities when the additional layer list is empty", async () => {
    const { layer } = await kernelOf(
      [Plugin.make({ name: "flows-plugin-model-sonnet", version: "1.4.0" })],
      {},
      { cacheEnvironment: { layers: [], capabilities: {} } }
    )
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(layer)))
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet@1.4.0"],
      capabilities: {}
    })
  })

  it("changes the declared layers when only a selected plugin version changes", async () => {
    const resolveLayers = async (version: string) => {
      const kernel = await run(Kernel.make(
        [Plugin.make({ name: "flows-plugin-model-sonnet", version })],
        {},
        { cacheEnvironment: { layers: ["Host=node"], capabilities: {} } }
      ))
      return kernel.plugins.resolved.cacheEnvironment?.layers
    }

    const versionOne = await resolveLayers("1.4.0")
    const versionTwo = await resolveLayers("2.0.0")
    expect(versionOne).toEqual(["flows-plugin-model-sonnet@1.4.0", "Host=node"])
    expect(versionTwo).toEqual(["flows-plugin-model-sonnet@2.0.0", "Host=node"])
    expect(versionOne).not.toEqual(versionTwo)
  })

  it("escapes identity delimiters injectively while leaving ordinary identities readable", async () => {
    const resolveLayers = async (name: string, version: string) => {
      const kernel = await run(Kernel.make(
        [Plugin.make({ name, version })],
        {},
        { cacheEnvironment: { layers: [], capabilities: {} } }
      ))
      return kernel.plugins.resolved.cacheEnvironment?.layers
    }

    const delimiterInName = await resolveLayers("flows-plugin-a@b", "c")
    const delimiterInVersion = await resolveLayers("flows-plugin-a", "b@c")
    expect(delimiterInName).toEqual(["flows-plugin-a%40b@c"])
    expect(delimiterInVersion).toEqual(["flows-plugin-a@b%40c"])
    expect(delimiterInName).not.toEqual(delimiterInVersion)
    expect(await resolveLayers("flows-plugin-a", "1.0.0")).toEqual(["flows-plugin-a@1.0.0"])
    expect(await resolveLayers("flows-plugin-a%40b", "c")).toEqual(["flows-plugin-a%2540b@c"])
    expect(await resolveLayers("@smthrs/x", "1.0.0")).toEqual(["%40smthrs/x@1.0.0"])
  })

  it("refuses to declare a cache environment for a versionless selected plugin", async () => {
    const error = await run(
      Kernel.make(
        [Plugin.make({ name: "flows-plugin-model-sonnet" })],
        {},
        { cacheEnvironment: { layers: [], capabilities: {} } }
      ).pipe(Effect.flip)
    )
    expect(error).toMatchObject({
      code: "cache_environment_invalid",
      plugin: "flows-plugin-model-sonnet",
      path: "$.version"
    })
    expect(error.message).toContain("flows-plugin-model-sonnet")
  })
})

describe("a plugin layer cannot replace the sealed cache environment", () => {
  const forged = Action.layerCacheEnvironment({ layers: ["forged"], capabilities: {} })

  it("keeps the declared environment when a plugin layer provides a forged one", async () => {
    const { layer } = await kernelOf(
      [{ name: "evil", version: "1", layer: forged }],
      {},
      { cacheEnvironment: { layers: ["Host=node"], capabilities: {} } }
    )
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(layer)))
    expect(environment).toEqual({ layers: ["evil@1", "Host=node"], capabilities: {} })
  })

  it("keeps the environment absent when a plugin layer declares one the host did not", async () => {
    const { layer } = await kernelOf([{ name: "evil", layer: forged }])
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(layer)))
    expect(environment).toBeUndefined()
  })

  it("still lets plugin layers read the declared environment while they build", async () => {
    const { layer } = await kernelOf(
      [
        {
          name: "reader",
          version: "1",
          layer: Layer.effect(Marker)(Effect.map(Action.CurrentCacheEnvironment, (env) => env?.layers.join(",") ?? ""))
        }
      ],
      {},
      { cacheEnvironment: { layers: ["Host=node"], capabilities: {} } }
    )
    const marker = await run(Effect.provide(Marker, layer))
    expect(marker).toBe("reader@1,Host=node")
  })
})

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
import * as Kernel from "../src/Kernel.ts"
import * as Plugin from "../src/Plugin.ts"
import type { PluginError } from "../src/PluginError.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

// Plugin layers type their requirements as `any`; these fixtures require no services.
const closed = <ROut = never>(layer: Layer.Layer<any, PluginError, any>) => layer as Layer.Layer<ROut, PluginError>

class Marker extends Context.Service<Marker, string>()("CacheEnvironment/Marker") {}

describe("the kernel declares the cache environment (issue #88)", () => {
  it("leaves the environment absent when no complete identity is supplied", async () => {
    const kernel = await run(Kernel.make([
      Plugin.make({ name: "flows-plugin-model-sonnet" }),
      Plugin.make({
        name: "flows-plugin-host-local",
        layer: Layer.succeed(Marker)("host")
      })
    ]))
    const environment = await run(
      Effect.gen(function*() {
        // A plugin-contributed service and the environment resolve from the
        // same merged layer.
        expect(yield* Marker).toBe("host")
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(closed<Marker>(kernel.layer)))
    )
    // Asserted as a whole value, not just `.layers`: `undefined` is the
    // engine's "nothing was declared" state, which scopes sealed cache keys
    // to a single run. A kernel that produced it would be an issue-#88
    // regression that the property access alone would not catch.
    expect(environment).toBeUndefined()
  })

  it("a layer-less plugin list also leaves it absent", async () => {
    const kernel = await run(Kernel.make([Plugin.make({ name: "flows-plugin-hooks-only" })]))
    const environment = await run(
      Effect.gen(function*() {
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(closed(kernel.layer)))
    )
    expect(environment).toBeUndefined()
  })

  it("accepts a complete capability and non-plugin layer identity", async () => {
    const kernel = await run(Kernel.make(
      [Plugin.make({ name: "flows-plugin-model-sonnet", version: "1.4.0" })],
      {},
      {
        cacheEnvironment: {
          layers: ["Host=node"],
          capabilities: { fs: ["/workspace/**"] }
        }
      }
    ))
    const environment = await run(
      Effect.gen(function*() {
        return yield* Action.CurrentCacheEnvironment
      }).pipe(Effect.provide(closed(kernel.layer)))
    )
    expect(environment).toEqual({
      layers: ["flows-plugin-model-sonnet@1.4.0", "Host=node"],
      capabilities: { fs: ["/workspace/**"] }
    })
  })

  it("uses plugin identities when the additional layer list is empty", async () => {
    const kernel = await run(Kernel.make(
      [Plugin.make({ name: "flows-plugin-model-sonnet", version: "1.4.0" })],
      {},
      { cacheEnvironment: { layers: [], capabilities: {} } }
    ))
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(closed(kernel.layer))))
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
    const kernel = await run(Kernel.make(
      [Plugin.make({ name: "evil", version: "1", layer: forged })],
      {},
      { cacheEnvironment: { layers: ["Host=node"], capabilities: {} } }
    ))
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(closed(kernel.layer))))
    expect(environment).toEqual({ layers: ["evil@1", "Host=node"], capabilities: {} })
  })

  it("keeps the environment absent when a plugin layer declares one the host did not", async () => {
    const kernel = await run(Kernel.make([Plugin.make({ name: "evil", layer: forged })]))
    const environment = await run(Action.CurrentCacheEnvironment.pipe(Effect.provide(closed(kernel.layer))))
    expect(environment).toBeUndefined()
  })

  it("still lets plugin layers read the declared environment while they build", async () => {
    const kernel = await run(Kernel.make(
      [
        Plugin.make({
          name: "reader",
          version: "1",
          layer: Layer.effect(Marker)(Effect.map(Action.CurrentCacheEnvironment, (env) => env?.layers.join(",") ?? ""))
        })
      ],
      {},
      { cacheEnvironment: { layers: ["Host=node"], capabilities: {} } }
    ))
    const marker = await run(Effect.provide(Marker, closed<Marker>(kernel.layer)))
    expect(marker).toBe("reader@1,Host=node")
  })
})

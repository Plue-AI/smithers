import { Context, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import * as Hooks from "../src/Hooks.ts"
import type { FlowsPlugin, PluginInput } from "../src/index.ts"
import { PluginError } from "../src/PluginError.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

const observer = (name: string, sink: Array<string>, extra: Partial<FlowsPlugin> = {}): FlowsPlugin => ({
  name,
  hooks: { configResolved: () => Effect.sync(() => void sink.push(name)) },
  ...extra
})

const namesFor = (resolved: Resolve.Resolved, hook: string): ReadonlyArray<string> =>
  (resolved.handlers.get(hook) ?? []).map((record) => record.plugin)

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
 * Resolves `plugins` and types the merged layer from the plugins passed in.
 *
 * `Resolve.layer` is `Layer<any, PluginError, any>`, so a test that named its
 * services by hand kept compiling after a provider was removed (#2704). The
 * cast below names exactly what `plugins` provide and still need, so dropping a
 * plugin layer drops its services and the body that reads them fails tsc.
 */
const resolvedLayer = async <const Input extends ReadonlyArray<PluginInput>>(plugins: Input) => {
  const resolved = await run(Resolve.resolve(plugins))
  return Resolve.layer(resolved) as Layer.Layer<Provided<Input>, PluginError, Exclude<Needed<Input>, Provided<Input>>>
}

class Alpha extends Context.Service<Alpha, { readonly value: string }>()("test/Alpha") {}

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/plugin/Resolve/Unprovided"
) {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = async () => {
  const withAlpha = await resolvedLayer([{ name: "alpha", layer: Layer.succeed(Alpha)({ value: "alpha" }) }])
  // @ts-expect-error no plugin layer provides Unprovided
  run(Effect.map(Unprovided, (service) => service.value).pipe(Effect.provide(withAlpha)))
  run(Effect.map(Alpha, (alpha) => alpha.value).pipe(Effect.provide(withAlpha)))
  const withoutAlpha = await resolvedLayer([{ name: "alpha" }])
  // @ts-expect-error dropping the alpha plugin's layer drops Alpha
  run(Effect.map(Alpha, (alpha) => alpha.value).pipe(Effect.provide(withoutAlpha)))
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a body that needs a service no plugin layer provides", () => {
    // The assertion is the `@ts-expect-error` directives above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})

describe("Resolve.resolve", () => {
  it("flattens nested arrays and drops falsy entries", async () => {
    const sink: Array<string> = []
    const resolved = await run(Resolve.resolve([
      observer("a", sink),
      false,
      [observer("b", sink), null, [undefined, observer("c", sink)]]
    ]))
    expect(resolved.plugins.map((plugin) => plugin.name)).toEqual(["a", "b", "c"])
    expect(namesFor(resolved, "configResolved")).toEqual(["a", "b", "c"])
  })

  it("accepts a single plugin, and yields no handler entry for an unused hook", async () => {
    const resolved = await run(Resolve.resolve(observer("solo", [])))
    expect(resolved.plugins).toHaveLength(1)
    expect(resolved.handlers.has("config")).toBe(false)
  })

  it("orders pre, then normal, then post, stably within each partition", async () => {
    const sink: Array<string> = []
    const resolved = await run(Resolve.resolve([
      observer("n1", sink),
      observer("p1", sink, { enforce: "post" }),
      observer("e1", sink, { enforce: "pre" }),
      observer("n2", sink),
      observer("p2", sink, { enforce: "post" }),
      observer("e2", sink, { enforce: "pre" })
    ]))
    expect(namesFor(resolved, "configResolved")).toEqual(["e1", "e2", "n1", "n2", "p1", "p2"])
  })

  it("re-partitions within a single hook by per-hook order, leaving other hooks alone", async () => {
    const nothing = () => Effect.void
    const resolved = await run(Resolve.resolve([
      { name: "a", hooks: { configResolved: { order: "post", handler: nothing }, config: nothing } },
      { name: "b", hooks: { configResolved: nothing, config: nothing } },
      { name: "c", hooks: { configResolved: { order: "pre", handler: nothing }, config: nothing } }
    ]))
    expect(namesFor(resolved, "configResolved")).toEqual(["c", "b", "a"])
    expect(namesFor(resolved, "config")).toEqual(["a", "b", "c"])
  })

  it("lets per-hook order re-partition across enforce groups, as Vite does", async () => {
    const nothing = () => Effect.void
    const resolved = await run(Resolve.resolve([
      {
        name: "post-plugin-pre-hook",
        enforce: "post",
        hooks: { configResolved: { order: "pre", handler: nothing } }
      },
      {
        name: "pre-plugin-post-hook",
        enforce: "pre",
        hooks: { configResolved: { order: "post", handler: nothing } }
      }
    ]))
    // `enforce` sorts the plugin list once; the per-hook `order` then re-partitions
    // that list for this hook alone, so a `pre` hook on a `post` plugin still runs
    // first. This mirrors Vite's getSortedPluginsByHook and is the published rule.
    expect(namesFor(resolved, "configResolved")).toEqual(["post-plugin-pre-hook", "pre-plugin-post-hook"])
  })

  it("fails with duplicate_name instead of last-wins", async () => {
    const exit = await Effect.runPromiseExit(Resolve.resolve([observer("dup", []), observer("dup", [])]))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await run(Resolve.resolve([observer("dup", []), observer("dup", [])]).pipe(Effect.flip))
    expect(error).toBeInstanceOf(PluginError)
    expect(error.code).toBe("duplicate_name")
    expect(error.plugin).toBe("dup")
  })

  it("fails with unknown_hook for a dynamically built plugin", async () => {
    const rogue = { name: "rogue", hooks: { nopeNotAHook: () => Effect.void } } as unknown as FlowsPlugin
    const error = await run(Resolve.resolve([rogue]).pipe(Effect.flip))
    expect(error.code).toBe("unknown_hook")
    expect(error.hook).toBe("nopeNotAHook")
  })

  it("accepts a host-supplied hook catalog for the unknown_hook guard", async () => {
    const rogue = { name: "extra", hooks: { toolCall: () => Effect.void } } as unknown as FlowsPlugin
    const resolved = await run(
      Resolve.resolve([rogue], { hooks: { ...Hooks.engineHooks, toolCall: "sequential" } })
    )
    expect(namesFor(resolved, "toolCall")).toEqual(["extra"])
  })

  it("filters by string apply against the target host", async () => {
    const list = [observer("core", []), observer("agent", [], { apply: "harness" }), {
      name: "explicit-engine",
      apply: "engine" as const
    }]
    const engine = await run(Resolve.resolve(list))
    expect(engine.plugins.map((plugin) => plugin.name)).toEqual(["core", "explicit-engine"])
    const harness = await run(Resolve.resolve(list, { target: "harness" }))
    expect(harness.plugins.map((plugin) => plugin.name)).toEqual(["core", "agent"])
  })

  it("filters by predicate apply against the pre-resolution config", async () => {
    const list = [
      observer("fast", [], { apply: (config) => config["mode"] === "fast" }),
      observer("slow", [], { apply: (config) => config["mode"] !== "fast" })
    ]
    const wide = await run(Resolve.resolve(list, { config: { mode: "fast" } }))
    expect(wide.plugins.map((plugin) => plugin.name)).toEqual(["fast"])
    const narrow = await run(Resolve.resolve(list))
    expect(narrow.plugins.map((plugin) => plugin.name)).toEqual(["slow"])
  })

  it("refuses options.config when a positional override is supplied", async () => {
    const error = await run(
      Resolve.resolve([], { config: { mode: "fast" } }, { mode: "slow" }).pipe(Effect.flip)
    )
    expect(error).toMatchObject({ code: "invalid_plugin", path: "$options.config" })
  })

  it("refuses undefined and null hook entries because declarations must be callable", async () => {
    const sparse = {
      name: "sparse",
      hooks: { config: undefined }
    } as unknown as FlowsPlugin
    const undefinedError = await run(Resolve.resolve([sparse]).pipe(Effect.flip))
    expect(undefinedError).toMatchObject({ code: "invalid_plugin", path: "$[0].hooks.config" })
    expect(undefinedError.message).toContain("function or a hook object")

    const nullError = await run(
      Resolve.resolve([{
        name: "null-hook",
        hooks: { configResolved: null }
      } as unknown as FlowsPlugin]).pipe(Effect.flip)
    )
    expect(nullError).toMatchObject({ code: "invalid_plugin", path: "$[0].hooks.configResolved" })
  })

  it("freezes the resolved plugin list and each hook's handler list", async () => {
    const resolved = await run(Resolve.resolve([observer("a", [])]))
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.plugins)).toBe(true)
    expect(Object.isFrozen(resolved.handlers.get("configResolved"))).toBe(true)
  })
})

describe("Resolve.layer", () => {
  const alphaLayer = Layer.succeed(Alpha)({ value: "alpha" })

  it("is empty when no plugin contributes a layer", async () => {
    const merged = await resolvedLayer([observer("a", [])])
    await run(Effect.void.pipe(Effect.provide(merged)))
  })

  it("merges layers left to right so earlier services are visible to later ones", async () => {
    const built: Array<string> = []
    const first = Layer.effectDiscard(Effect.sync(() => void built.push("first")))
    const second = Layer.effectDiscard(Effect.sync(() => void built.push("second")))
    const merged = await resolvedLayer([
      { name: "late", layer: second },
      { name: "early", enforce: "pre", layer: first }
    ])
    await run(Effect.void.pipe(Effect.provide(merged)))
    expect(built).toEqual(["first", "second"])
  })

  it("provides a plugin's services to consumers", async () => {
    const merged = await resolvedLayer([{ name: "alpha", layer: alphaLayer }])
    const value = await run(
      Alpha.pipe(
        Effect.map((alpha) => alpha.value),
        Effect.provide(merged)
      )
    )
    expect(value).toBe("alpha")
  })

  it("uses the later resolved plugin when two layers provide the same service tag", async () => {
    const merged = await resolvedLayer([
      { name: "first", layer: Layer.succeed(Alpha)({ value: "first" }) },
      { name: "second", layer: Layer.succeed(Alpha)({ value: "second" }) }
    ])
    const value = await run(
      Alpha.pipe(
        Effect.map((alpha) => alpha.value),
        Effect.provide(merged)
      )
    )
    // This pins the current layer-collision decision for plugin authors.
    expect(value).toBe("second")
  })

  it("wraps a failing layer as layer_failed", async () => {
    const broken = Layer.effectDiscard(Effect.fail("boom" as const))
    const merged = await resolvedLayer([{ name: "broken", layer: broken }])
    const exit = await Effect.runPromiseExit(Effect.void.pipe(Effect.provide(merged)))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await run(
      Effect.void.pipe(
        Effect.provide(merged),
        Effect.flip
      )
    )
    expect(error.code).toBe("layer_failed")
    expect(error.plugin).toBe("broken")
  })
})

describe("Hooks entry helpers", () => {
  it("reads bare handlers and ordering objects alike", () => {
    const handler = () => Effect.void
    expect(Hooks.handlerOf(handler)).toBe(handler)
    expect(Hooks.orderOf(handler)).toBeUndefined()
    expect(Hooks.handlerOf({ handler })).toBe(handler)
    expect(Hooks.orderOf({ order: "pre", handler })).toBe("pre")
  })

  it("declares every catalogued hook exactly once", () => {
    const kind: "waterfall" = Hooks.engineHooks.config
    expect(Object.isFrozen(Hooks.engineHooks)).toBe(true)
    expect(kind).toBe("waterfall")
    expect(Hooks.engineHooks).toEqual({ config: "waterfall", configResolved: "parallel" })
  })

  it("keeps the base hook names in a host catalog built by spreading it", () => {
    // Reproduces how `@smthrs/agent` builds its catalog. A widened annotation on
    // `engineHooks` would drop `config` and `configResolved` from this type, so
    // the two literal reads below are the assertion that matters.
    const hostCatalog = Object.freeze({ ...Hooks.engineHooks, cellRegistry: "waterfall" } as const)
    const config: "waterfall" = hostCatalog.config
    const configResolved: "parallel" = hostCatalog.configResolved
    expect([config, configResolved]).toEqual(["waterfall", "parallel"])
    expect(Object.keys(hostCatalog)).toEqual(["config", "configResolved", "cellRegistry"])
  })
})

describe("Plugins.makeNoop", () => {
  it("dispatches nothing and answers none", async () => {
    const dispatcher = Plugins.makeNoop()
    expect(dispatcher.handlers("configResolved")).toEqual([])
    expect(await run(dispatcher.parallel("configResolved", Config.defaults))).toEqual([])
    expect(await run(dispatcher.waterfall("config", {}, Config.merge))).toEqual({})
  })
})

import { Context, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import type { ResolvedConfig } from "../src/Config.ts"
import type { HookCatalog, ParallelHook, WaterfallHook } from "../src/Hooks.ts"
import type { FlowsHooks, FlowsPlugin } from "../src/index.ts"
import * as Kernel from "../src/Kernel.ts"
import type { PluginError } from "../src/PluginError.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("Config.merge", () => {
  it("deep-merges JSON records and replaces arrays and scalars", () => {
    expect(Config.merge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } })).toEqual({ a: { b: 1, c: 3, d: 4 } })
    expect(Config.merge({ a: [1] }, { a: [2] })).toEqual({ a: [2] })
    expect(Config.merge({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(Config.merge({ a: { b: 1 } }, { a: 5 })).toEqual({ a: 5 })
  })

  // 0.x dropped an `undefined` patch member: `merge({ a: 1 }, { a: undefined })`
  // returned `{ a: 1 }`. rc.0 configuration is strict JSON, so the member is
  // refused with its path instead. This is a decision, not an oversight: a
  // plugin that means "leave this unset" omits the key or writes null, and a
  // silent drop hid a typo behind a value the next handler never saw.
  it("refuses an undefined member instead of dropping it", () => {
    let thrown: unknown
    try {
      Config.merge({ a: 1 }, { a: undefined })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: "config_invalid", path: "$.a" })
    expect((thrown as { readonly message: string }).message).toContain("must contain only JSON values")
  })
})

describe("Kernel.runConfig", () => {
  it("detaches and recursively freezes the config before the first hook", async () => {
    const source = { feature: { flags: [{ enabled: true }] } }
    const seen: Array<Config.FlowsConfig> = []
    const resolved = await run(Resolve.resolve([
      {
        name: "inspect",
        hooks: {
          config: (config) => {
            seen.push(config)
            return Effect.void
          }
        }
      }
    ]))

    await run(Kernel.runConfig(Plugins.make(resolved), source))

    const initial = seen[0] as typeof source
    expect(initial).toEqual(source)
    expect(initial).not.toBe(source)
    expect(initial.feature).not.toBe(source.feature)
    expect(initial.feature.flags).not.toBe(source.feature.flags)
    expect(initial.feature.flags[0]).not.toBe(source.feature.flags[0])
    expect(Object.isFrozen(initial)).toBe(true)
    expect(Object.isFrozen(initial.feature)).toBe(true)
    expect(Object.isFrozen(initial.feature.flags)).toBe(true)
    expect(Object.isFrozen(initial.feature.flags[0])).toBe(true)
    expect(Object.isFrozen(source)).toBe(false)
    expect(Object.isFrozen(source.feature)).toBe(false)
  })

  it("prevents a mutation-attempting hook from changing caller state", async () => {
    const source = { feature: { enabled: true } }
    const mutations: Array<boolean> = []
    const resolved = await run(Resolve.resolve([
      {
        name: "mutate",
        hooks: {
          config: (config) =>
            Effect.sync(() => {
              mutations.push(Reflect.set(config["feature"] as object, "enabled", false))
            })
        }
      }
    ]))

    const result = await run(Kernel.runConfig(Plugins.make(resolved), source))

    expect(source.feature.enabled).toBe(true)
    expect(mutations).toEqual([false])
    expect(result).toEqual({ feature: { enabled: true } })
  })

  it("keeps a detached frozen snapshot after an Effect.void handler", async () => {
    const source = { feature: { enabled: true } }
    const seen: Array<Config.FlowsConfig> = []
    const resolved = await run(Resolve.resolve([
      {
        name: "silent",
        hooks: {
          config: (config) => {
            seen.push(config)
            return Effect.void
          }
        }
      },
      {
        name: "next",
        hooks: {
          config: (config) => {
            seen.push(config)
            return Effect.void
          }
        }
      }
    ]))

    await run(Kernel.runConfig(Plugins.make(resolved), source))

    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(seen[0])
    expect(seen[1]).not.toBe(source)
    expect(Object.isFrozen(seen[1])).toBe(true)
    expect(Object.isFrozen(seen[1]?.["feature"])).toBe(true)
  })

  it.each(["non-JSON", "accessor", "reserved"])("refuses %s config before hook 1 executes", async (kind) => {
    let calls = 0
    let getterReads = 0
    const source = kind === "non-JSON"
      ? { feature: new Date() }
      : kind === "reserved"
      ? { engine: {} }
      : Object.defineProperty({}, "feature", {
        enumerable: true,
        get: () => {
          getterReads++
          return { enabled: true }
        }
      })
    const resolved = await run(Resolve.resolve([
      {
        name: "inspect",
        hooks: {
          config: (config) => {
            calls++
            void config["feature"]
            return Effect.void
          }
        }
      }
    ]))

    const error = await run(Kernel.runConfig(Plugins.make(resolved), source as Config.FlowsConfig).pipe(Effect.flip))

    expect(error).toMatchObject({ code: "config_invalid", path: kind === "reserved" ? "$.engine" : "$.feature" })
    expect(calls).toBe(0)
    expect(getterReads).toBe(0)
  })
})

describe("Kernel.make", () => {
  it("accepts pre-resolution config only through the positional argument", async () => {
    const error = await run(
      // @ts-expect-error Kernel options must not accept a second config source.
      Kernel.make([], {}, { config: {} }).pipe(Effect.flip)
    )
    expect(error).toMatchObject({ code: "invalid_plugin", path: "$options.config" })
    expect((await run(Kernel.make([], { plugin: { enabled: true } }))).config).toEqual({
      plugin: { enabled: true }
    })
  })

  it("threads the config waterfall, freezes the result, then notifies observers", async () => {
    const captured: Array<ResolvedConfig> = []
    const seen: Array<unknown> = []
    const kernel = await run(Kernel.make(
      [
        {
          name: "widen",
          hooks: {
            config: (config) => {
              seen.push(config["cell"])
              return Effect.succeed({ cell: { maxConcurrency: 32 } })
            }
          }
        },
        {
          name: "retry-tweak",
          hooks: {
            config: (config) => {
              seen.push(config["cell"])
              return Effect.succeed({ model: { maxAttempts: 9 } })
            },
            configResolved: (config) => Effect.sync(() => void captured.push(config))
          }
        },
        { name: "silent", hooks: { config: () => Effect.void } }
      ],
      { cell: { maxConcurrency: 2 } }
    ))

    // each handler saw the previous handler's output
    expect(seen).toEqual([{ maxConcurrency: 2 }, { maxConcurrency: 32 }])
    expect(kernel.config["cell"]).toEqual({ maxConcurrency: 32 })
    expect(kernel.config["model"]).toEqual({ maxAttempts: 9 })
    expect(Object.isFrozen(kernel.config)).toBe(true)
    expect(Object.isFrozen(kernel.config["cell"])).toBe(true)
    expect(captured).toEqual([kernel.config])
    expect(kernel.observerErrors).toEqual([])
  })

  it("reports configResolved observer failures without failing startup", async () => {
    const kernel = await run(Kernel.make([
      { name: "noisy", hooks: { configResolved: () => Effect.fail("boom") } }
    ]))
    expect(kernel.observerErrors.map((error) => error.plugin)).toEqual(["noisy"])
  })

  it("fails with config_invalid when the post-waterfall config does not decode", async () => {
    const bad: FlowsPlugin = {
      name: "bad-config",
      hooks: { config: () => Effect.succeed({ bad: new Date() } as never) }
    }
    const error = await run(Kernel.make([bad]).pipe(Effect.flip))
    expect(error.code).toBe("config_invalid")
  })

  it("fails with hook_failed when a config handler fails", async () => {
    const error = await run(
      Kernel.make([{ name: "broken", hooks: { config: () => Effect.fail("no") } }]).pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.hook).toBe("config")
  })

  it("propagates resolution failures", async () => {
    const error = await run(Kernel.make([{ name: "x" }, { name: "x" }]).pipe(Effect.flip))
    expect(error.code).toBe("duplicate_name")
  })

  it("filters plugins by apply against the raw config it was given", async () => {
    const kernel = await run(Kernel.make(
      [
        { name: "only-wide", apply: (config) => config["mode"] === "wide" },
        { name: "always" }
      ],
      { mode: "narrow" }
    ))
    expect(kernel.plugins.resolved.plugins.map((plugin) => plugin.name)).toEqual(["always"])
  })

  it("defaults the whole config when nothing is supplied", async () => {
    const kernel = await run(Kernel.make([]))
    expect(kernel.config).toEqual(Config.defaults)
    expect(kernel.layer).toBeDefined()
  })

  it("carries plugin-contributed config namespaces through resolution", async () => {
    // Issue #15: a namespace a plugin adds via the config waterfall must
    // survive decode/defaults/freeze so configResolved (and the plugin
    // itself) can read it back.
    const captured: Array<ResolvedConfig> = []
    const kernel = await run(Kernel.make(
      [
        {
          name: "my-plugin",
          hooks: {
            config: () => Effect.succeed({ myPlugin: { endpoint: "https://example.test" } }),
            configResolved: (config) => Effect.sync(() => void captured.push(config))
          }
        }
      ],
      { cellPolicy: { maxConcurrency: 2 }, otherNamespace: { flag: true } }
    ))
    expect(kernel.config["myPlugin"]).toEqual({ endpoint: "https://example.test" })
    expect(kernel.config["otherNamespace"]).toEqual({ flag: true })
    expect(Object.isFrozen(kernel.config["myPlugin"])).toBe(true)
    expect(captured[0]?.["myPlugin"]).toEqual({ endpoint: "https://example.test" })
    expect(kernel.config["cellPolicy"]).toEqual({ maxConcurrency: 2 })
  })

  it("rejects values outside strict JSON", async () => {
    const error = await run(
      Config.resolve({ myPlugin: { invalid: new Map() } } as never).pipe(Effect.flip)
    )
    expect(error.code).toBe("config_invalid")
  })

  it("refuses runtime-policy keys the plugin kernel does not apply", async () => {
    for (const key of ["engine", "retry", "store", "plugins"] as const) {
      const error = await run(Kernel.make([], { [key]: {} }).pipe(Effect.flip))
      expect(error).toMatchObject({ code: "config_invalid", path: `$.${key}` })
    }
  })
})

describe("Config.deepFreeze", () => {
  it("leaves primitives alone and freezes nested structures", () => {
    expect(Config.deepFreeze(1)).toBe(1)
    expect(Config.deepFreeze(null)).toBe(null)
    const value = Config.deepFreeze({ a: { b: 1 } })
    expect(Object.isFrozen(value.a)).toBe(true)
  })
})

describe("Kernel startup context", () => {
  class Settings extends Context.Service<Settings, { readonly enabled: boolean }>()("test/Settings") {}

  it("refuses a shared config hook that requires a service at the type level", () => {
    const plugin: FlowsPlugin = {
      name: "needs-settings",
      hooks: {
        // @ts-expect-error the shared startup hooks are context-free; a service requirement does not compile.
        config: () => Settings.pipe(Effect.map((settings) => ({ feature: settings.enabled })))
      }
    }
    expect(plugin.name).toBe("needs-settings")
  })

  it("still refuses an untyped service-reading startup hook at runtime, attributed to the hook", async () => {
    const plugin = {
      name: "needs-settings",
      hooks: { config: () => Settings.pipe(Effect.map((settings) => ({ feature: settings.enabled }))) }
    } as unknown as FlowsPlugin
    const error = await run(Kernel.make([plugin]).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "hook_failed", plugin: "needs-settings", hook: "config" })
  })

  it("surfaces a custom catalog's startup requirements in the startup Effect", async () => {
    interface ServiceHooks {
      readonly config: WaterfallHook<
        (config: Config.FlowsConfig) => Effect.Effect<Partial<Config.FlowsConfig> | void, never, Settings>
      >
      readonly configResolved: ParallelHook<(config: ResolvedConfig) => Effect.Effect<void, never, Settings>>
    }
    const seen: Array<unknown> = []
    const startup = Kernel.make<ServiceHooks>(
      {
        name: "reads-settings",
        hooks: {
          config: () => Settings.pipe(Effect.map((settings) => ({ feature: { enabled: settings.enabled } }))),
          configResolved: (config) =>
            Settings.pipe(Effect.map((settings) => void seen.push(config.feature, settings.enabled)))
        }
      },
      {},
      { hooks: { config: "waterfall", configResolved: "parallel" } }
    )
    // @ts-expect-error the startup Effect requires Settings, so it is not context-free.
    const contextFree: Effect.Effect<Kernel.Kernel<ServiceHooks>, PluginError, never> = startup
    expect(contextFree).toBe(startup)
    const kernel = await Effect.runPromise(startup.pipe(Effect.provideService(Settings, { enabled: true })))
    expect(kernel.config.feature).toEqual({ enabled: true })
    expect(seen).toEqual([{ enabled: true }, true])
  })

  it("refuses a catalog that labels a shared startup hook with another kind before any hook runs", async () => {
    let ran = false
    const catalog = { config: "parallel", configResolved: "parallel" } as unknown as HookCatalog<FlowsHooks>
    const error = await run(
      Kernel.make(
        { name: "catalog-mismatch", hooks: { config: () => Effect.sync(() => void (ran = true)) } },
        {},
        { hooks: catalog }
      ).pipe(Effect.flip)
    )
    expect(error).toMatchObject({ code: "hook_kind_mismatch", hook: "config", path: "$options.hooks.config" })
    expect(ran).toBe(false)
  })
})

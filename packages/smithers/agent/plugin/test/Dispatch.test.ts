import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import type { FirstHook, ParallelHook, SequentialHook } from "../src/Hooks.ts"
import * as Hooks from "../src/Hooks.ts"
import type { FlowsHooks, FlowsPlugin } from "../src/index.ts"
import type { PluginError } from "../src/PluginError.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

type Decision = "transient" | "permanent" | { readonly shareable: true }

interface StandaloneHooks {
  readonly isolated: SequentialHook<(value: number) => Effect.Effect<number>>
}

declare module "../src/index.ts" {
  interface FlowsHooks {
    readonly testSequential: SequentialHook<(value: string) => Effect.Effect<unknown, any>>
    readonly testParallel: ParallelHook<(value: string) => Effect.Effect<void, any>>
    readonly testFirst: FirstHook<(value: string) => Effect.Effect<Option.Option<Decision>, any>>
  }
}

const dispatchHooks = {
  ...Hooks.engineHooks,
  testSequential: "sequential",
  testParallel: "parallel",
  testFirst: "first"
} as const satisfies Record<string, Hooks.HookKind>

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const dispatcherFor = async (plugins: ReadonlyArray<FlowsPlugin<FlowsHooks>>) =>
  Plugins.make(await run(Resolve.resolve(plugins, { hooks: dispatchHooks })))

describe("Plugins layers", () => {
  it("provides a dispatcher over a resolved list, and a plugin-free one", async () => {
    const seen: Array<string> = []
    const resolved = await run(Resolve.resolve([
      { name: "a", hooks: { testParallel: () => Effect.sync(() => void seen.push("a")) } }
    ], { hooks: dispatchHooks }))
    const program = Plugins.Plugins.pipe(
      Effect.flatMap((dispatcher) => dispatcher.parallel("testParallel", "value"))
    )
    expect(await run(program.pipe(Effect.provide(Plugins.layer(resolved))))).toEqual([])
    expect(seen).toEqual(["a"])
    expect(await run(program.pipe(Effect.provide(Plugins.layerNoop)))).toEqual([])
    expect(seen).toEqual(["a"])
  })

  it("holds a dispatcher for a standalone hook interface directly", async () => {
    const resolved = await run(Resolve.resolve<StandaloneHooks>(
      { name: "standalone", hooks: { isolated: (value) => Effect.succeed(value * 2) } },
      { hooks: { isolated: "sequential" } }
    ))
    const dispatcher = Plugins.make<StandaloneHooks>(resolved)
    expect(await run(dispatcher.sequential("isolated", 21))).toEqual([42])
  })
})

describe("sequential dispatch", () => {
  it("runs every handler in resolved order, one at a time, collecting results", async () => {
    const trace: Array<string> = []
    const verdict = (name: string, answer: "fail" | "tolerate"): FlowsPlugin<FlowsHooks> => ({
      name,
      hooks: {
        testSequential: () =>
          Effect.sync(() => {
            trace.push(`enter:${name}`)
            return answer
          }).pipe(Effect.tap(() => Effect.sync(() => trace.push(`exit:${name}`))))
      }
    })
    const dispatcher = await dispatcherFor([verdict("a", "tolerate"), verdict("b", "fail"), verdict("c", "tolerate")])
    const results = await run(
      dispatcher.sequential("testSequential", "value")
    )
    expect(results).toEqual(["tolerate", "fail", "tolerate"])
    // every handler observes the event, and none interleaves with another
    expect(trace).toEqual(["enter:a", "exit:a", "enter:b", "exit:b", "enter:c", "exit:c"])
    expect(results.includes("fail")).toBe(true)
  })

  it("fails the caller with hook_failed and stops at the failing handler", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      { name: "ok", hooks: { testSequential: () => Effect.sync(() => void seen.push("ok")) } },
      { name: "bad", hooks: { testSequential: () => Effect.die(new Error("boom")) } },
      { name: "never", hooks: { testSequential: () => Effect.sync(() => void seen.push("never")) } }
    ])
    const error = await run(
      dispatcher.sequential("testSequential", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.plugin).toBe("bad")
    expect(error.hook).toBe("testSequential")
    expect(seen).toEqual(["ok"])
  })

  it("wraps a synchronous throw inside a handler", async () => {
    const dispatcher = await dispatcherFor([
      {
        name: "thrower",
        hooks: {
          testSequential: (() => {
            throw new Error("sync boom")
          }) as never
        }
      }
    ])
    const error = await run(
      dispatcher.sequential("testSequential", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
    expect(error.plugin).toBe("thrower")
  })

  it("propagates a typed failure from a sequential handler", async () => {
    const dispatcher = await dispatcherFor([
      { name: "veto", hooks: { testSequential: () => Effect.fail("nope") } }
    ])
    const error = await run(
      dispatcher.sequential("testSequential", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
  })

  it("interrupts a suspended handler, runs its finalizer, and skips later handlers", async () => {
    const seen: Array<string> = []
    await run(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const dispatcher = yield* Effect.promise(() =>
        dispatcherFor([
          {
            name: "active",
            hooks: {
              testSequential: () =>
                Effect.gen(function*() {
                  seen.push("active")
                  yield* Deferred.succeed(entered, undefined)
                  yield* Effect.never
                }).pipe(Effect.onInterrupt(() => Effect.sync(() => void seen.push("finalized"))))
            }
          },
          { name: "later", hooks: { testSequential: () => Effect.sync(() => void seen.push("later")) } }
        ])
      )
      const fiber = yield* dispatcher.sequential("testSequential", "value").pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
    }))
    expect(seen).toEqual(["active", "finalized"])
  })
})

describe("parallel dispatch", () => {
  it("runs every observer and isolates a failing one", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      { name: "a", hooks: { testParallel: () => Effect.sync(() => void seen.push("a")) } },
      { name: "b", hooks: { testParallel: () => Effect.fail("observer boom") } },
      { name: "c", hooks: { testParallel: () => Effect.sync(() => void seen.push("c")) } }
    ])
    const errors = await run(dispatcher.parallel("testParallel", "value"))
    expect(seen.sort()).toEqual(["a", "c"])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.code).toBe("hook_failed")
    expect(errors[0]?.plugin).toBe("b")
  })

  it("surfaces every failure and never fails the caller", async () => {
    const dispatcher = await dispatcherFor([
      { name: "a", hooks: { testParallel: () => Effect.fail("x") } },
      { name: "b", hooks: { testParallel: () => Effect.die("y") } }
    ])
    const errors = await run(dispatcher.parallel("testParallel", "value"))
    expect(errors.map((error) => error.plugin).sort()).toEqual(["a", "b"])
  })

  it("honors the configured concurrency bound while preserving error order", async () => {
    let active = 0
    let maximum = 0
    const plugins = Array.from({ length: 6 }, (_, index): FlowsPlugin<FlowsHooks> => ({
      name: `observer-${index}`,
      hooks: {
        testParallel: () =>
          Effect.gen(function*() {
            active += 1
            maximum = Math.max(maximum, active)
            yield* Effect.sleep("5 millis")
            active -= 1
            if (index % 2 === 0) return yield* Effect.fail(index)
          })
      }
    }))
    const resolved = await run(Resolve.resolve(plugins, { hooks: dispatchHooks, parallelConcurrency: 2 }))
    const errors = await run(Plugins.make(resolved).parallel("testParallel", "value"))
    expect(maximum).toBe(2)
    expect(errors.map((error) => error.plugin)).toEqual(["observer-0", "observer-2", "observer-4"])
  })

  it("interrupts bounded parallel work, runs its finalizer, and skips queued handlers", async () => {
    const seen: Array<string> = []
    await run(Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const resolved = yield* Resolve.resolve([
        {
          name: "active",
          hooks: {
            testParallel: () =>
              Effect.gen(function*() {
                seen.push("active")
                yield* Deferred.succeed(entered, undefined)
                yield* Effect.never
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => void seen.push("finalized"))))
          }
        },
        { name: "later", hooks: { testParallel: () => Effect.sync(() => void seen.push("later")) } }
      ], { hooks: dispatchHooks, parallelConcurrency: 1 })
      const fiber = yield* Plugins.make(resolved).parallel("testParallel", "value").pipe(
        Effect.forkChild({ startImmediately: true })
      )
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true)
    }))
    expect(seen).toEqual(["active", "finalized"])
  })
})

describe("first dispatch", () => {
  const classifier = (name: string, answer: Option.Option<Decision>, seen: Array<string>): FlowsPlugin<FlowsHooks> => ({
    name,
    hooks: {
      testFirst: () =>
        Effect.sync(() => {
          seen.push(name)
          return answer
        })
    }
  })

  it("stops at the first Option.some", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      classifier("a", Option.none(), seen),
      classifier("b", Option.some("permanent"), seen),
      classifier("c", Option.some("transient"), seen)
    ])
    const result = await run(dispatcher.first("testFirst", "value"))
    expect(result).toEqual(Option.some("permanent"))
    expect(seen).toEqual(["a", "b"])
  })

  it("returns none so the caller can apply its core default", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([classifier("a", Option.none(), seen)])
    const result = await run(dispatcher.first("testFirst", "value"))
    const classification = Option.getOrElse(result, (): Decision => "transient")
    expect(classification).toBe("transient")
    expect(seen).toEqual(["a"])
  })

  it("respects per-hook order when choosing the winner", async () => {
    const seen: Array<string> = []
    const dispatcher = await dispatcherFor([
      classifier("normal", Option.some("transient"), seen),
      {
        name: "override",
        hooks: {
          testFirst: {
            order: "pre",
            handler: () =>
              Effect.sync(() => {
                seen.push("override")
                return Option.some<Decision>("permanent")
              })
          }
        }
      }
    ])
    const result = await run(dispatcher.first("testFirst", "value"))
    expect(result).toEqual(Option.some("permanent"))
    expect(seen).toEqual(["override"])
  })

  it("refuses a non-Option answer with handler attribution", async () => {
    const dispatcher = await dispatcherFor([
      { name: "rogue", hooks: { testFirst: () => Effect.succeed("nonsense" as never) } },
      { name: "sane", hooks: { testFirst: () => Effect.succeed(Option.some({ shareable: true } as const)) } }
    ])
    const error = await run(dispatcher.first("testFirst", "value").pipe(Effect.flip))
    expect(error).toMatchObject({ code: "invalid_hook_result", plugin: "rogue", hook: "testFirst" })
  })

  it("fails with hook_failed when a first handler fails", async () => {
    const dispatcher = await dispatcherFor([
      { name: "bad", hooks: { testFirst: () => Effect.fail("nope") } }
    ])
    const error = await run(
      dispatcher.first("testFirst", "value").pipe(Effect.flip)
    )
    expect(error.code).toBe("hook_failed")
  })
})

describe("waterfall dispatch", () => {
  it("attributes an invalid patch to the handler that returned it", async () => {
    const dispatcher = await dispatcherFor([
      { name: "invalid-patch", hooks: { config: () => Effect.succeed({ value: new Date() } as never) } }
    ])
    const error = await run(dispatcher.waterfall("config", {}, Config.merge).pipe(Effect.flip))
    expect(error).toMatchObject({ code: "config_invalid", plugin: "invalid-patch", hook: "config" })
  })

  it("wraps a merge callback that throws an untyped exception", async () => {
    const dispatcher = await dispatcherFor([
      { name: "merge-throw", hooks: { config: () => Effect.succeed({ value: 1 }) } }
    ])
    const error = await run(
      dispatcher.waterfall("config", {}, () => {
        throw new Error("merge failed")
      }).pipe(Effect.flip)
    )
    expect(error).toMatchObject({ code: "config_invalid", plugin: "merge-throw", hook: "config" })
  })
})

describe("Plugins runtime catalog kinds", () => {
  // Bypasses `KeysOfKind` the way a host casting around its catalog would.
  const loose = (dispatcher: Plugins.Service<StandaloneHooks>) =>
    dispatcher as unknown as {
      readonly sequential: (hook: string, ...args: Array<unknown>) => Effect.Effect<ReadonlyArray<unknown>, PluginError>
      readonly parallel: (hook: string, ...args: Array<unknown>) => Effect.Effect<ReadonlyArray<PluginError>>
      readonly first: (hook: string, ...args: Array<unknown>) => Effect.Effect<unknown, PluginError>
      readonly waterfall: (
        hook: string,
        initial: unknown,
        merge: (previous: unknown, patch: unknown) => unknown
      ) => Effect.Effect<unknown, PluginError>
    }

  it("types the catalog against the hook interface", () => {
    // @ts-expect-error `isolated` is a sequential hook; the catalog cannot label it first.
    const wrong: Resolve.Options<StandaloneHooks> = { hooks: { isolated: "first" } }
    // @ts-expect-error the shared config hook is fixed to waterfall.
    const shared: Resolve.Options = { hooks: { config: "parallel" } }
    const extra: Resolve.Options = { hooks: { ...Hooks.engineHooks, harnessOnly: "sequential" } }
    expect([wrong, shared, extra]).toHaveLength(3)
  })

  it("carries the admitted catalog as frozen kinds", async () => {
    const shared = await run(Resolve.resolve([]))
    expect(shared.kinds).toEqual({ config: "waterfall", configResolved: "parallel" })
    expect(Object.isFrozen(shared.kinds)).toBe(true)
    const custom = await run(Resolve.resolve<StandaloneHooks>([], { hooks: { isolated: "sequential" } }))
    expect(custom.kinds).toEqual({ isolated: "sequential" })
    expect(Plugins.makeNoop().resolved.kinds).toEqual(Hooks.engineHooks)
  })

  it("refuses a dispatch whose kind differs from the catalog before running a handler", async () => {
    let ran = 0
    const plugin: FlowsPlugin<StandaloneHooks> = {
      name: "standalone",
      hooks: { isolated: (value) => Effect.sync(() => (ran += 1, value)) }
    }
    const asSequential = loose(Plugins.make<StandaloneHooks>(
      await run(Resolve.resolve<StandaloneHooks>(plugin, { hooks: { isolated: "sequential" } }))
    ))
    const refused = { code: "hook_kind_mismatch", hook: "isolated" }
    expect(await run(asSequential.first("isolated", 1).pipe(Effect.flip))).toMatchObject(refused)
    expect(await run(asSequential.waterfall("isolated", 1, (_previous, patch) => patch).pipe(Effect.flip)))
      .toMatchObject(refused)
    expect(await run(asSequential.parallel("isolated", 1))).toMatchObject([refused])
    expect(ran).toBe(0)
    expect(await run(asSequential.sequential("isolated", 21))).toEqual([21])
    expect(ran).toBe(1)

    const catalog = { isolated: "first" } as unknown as Hooks.HookCatalog<StandaloneHooks>
    const asFirst = loose(Plugins.make<StandaloneHooks>(
      await run(Resolve.resolve<StandaloneHooks>(plugin, { hooks: catalog }))
    ))
    expect(await run(asFirst.sequential("isolated", 21).pipe(Effect.flip))).toMatchObject(refused)
    expect(ran).toBe(1)
  })
})

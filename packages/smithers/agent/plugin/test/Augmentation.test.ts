import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import type { ParallelHook, SequentialHook } from "../src/Hooks.ts"
import * as Hooks from "../src/Hooks.ts"
import type { FlowsPlugin } from "../src/index.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"

interface ToolCallContext {
  readonly tool: string
}
interface ToolOverride {
  readonly replaceWith: string
}
interface TurnContext {
  readonly turn: number
}

// The harness seam: exactly the `declare module` form the spec documents,
// pointed at this package's entry module.
declare module "../src/index.ts" {
  interface FlowsHooks {
    readonly toolCall: SequentialHook<(ctx: ToolCallContext) => Effect.Effect<Option.Option<ToolOverride>>>
    readonly agentTurnStart: ParallelHook<(turn: TurnContext) => Effect.Effect<void>>
  }
}

const harnessHooks = {
  ...Hooks.engineHooks,
  toolCall: "sequential",
  agentTurnStart: "parallel"
} as const satisfies Record<string, Hooks.HookKind>

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("module augmentation", () => {
  it("lets one plugin object carry kernel and host hooks in one bounded catalog", async () => {
    const trace: Array<string> = []
    const both: FlowsPlugin = {
      name: "flows-plugin-both",
      hooks: {
        configResolved: () => Effect.sync(() => void trace.push("kernel:configResolved")),
        toolCall: (ctx) =>
          Effect.sync(() => {
            trace.push(`harness:toolCall:${ctx.tool}`)
            return Option.some({ replaceWith: "safe-tool" })
          }),
        agentTurnStart: (turn) => Effect.sync(() => void trace.push(`harness:turn:${turn.turn}`))
      }
    }

    // The base catalog contains only the config lifecycle, so host keys are a
    // startup error unless the host declares its bounded catalog.
    const rejected = await run(Resolve.resolve([both]).pipe(Effect.flip))
    expect(rejected.code).toBe("unknown_hook")

    // A host that declares the augmented catalog resolves the same object.
    const resolved = await run(Resolve.resolve([both], { hooks: harnessHooks }))

    const kernel = Plugins.make(resolved)
    await run(kernel.parallel("configResolved", Config.defaults))

    const harness = Plugins.make(resolved)
    const override = await run(harness.sequential("toolCall", { tool: "bash" }))
    await run(harness.parallel("agentTurnStart", { turn: 1 }))

    expect(override).toEqual([Option.some({ replaceWith: "safe-tool" })])
    expect(trace).toEqual(["kernel:configResolved", "harness:toolCall:bash", "harness:turn:1"])
  })
})

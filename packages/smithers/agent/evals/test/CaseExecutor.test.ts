import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"

const target = { name: "case-executor-target" } as const
const execution = { output: 1, stepKey: "step", latencyMs: 0, target }
const suiteCase = { name: "a", input: 1 }

describe("CaseExecutor", () => {
  it("runs a case through its callback", async () => {
    const executor = CaseExecutor.make(() => Effect.succeed(execution))
    expect(await Effect.runPromise(executor.run(suiteCase))).toEqual(execution)
  })

  // A callback is the one construction form; the `{ run }` and `{ execute }`
  // object aliases are gone.
  it("refuses the retired object forms", () => {
    // @ts-expect-error `make` takes the callback itself.
    expect(() => CaseExecutor.make({ run: () => Effect.succeed(execution) })).toThrow(
      "CaseExecutor.make needs a callback"
    )
    // @ts-expect-error `make` takes the callback itself.
    expect(() => CaseExecutor.make({ execute: () => Effect.succeed(execution) })).toThrow(TypeError)
    expect("CaseInput" in CaseExecutor).toBe(false)
    expect("Implementation" in CaseExecutor).toBe(false)
  })

  // Degrading to the unavailable executor turned one wiring mistake into a
  // whole suite of cases failing with `executor`, which reads as a broken
  // target rather than a missing one.
  it("refuses a missing callback", () => {
    expect(() => CaseExecutor.make(undefined as unknown as CaseExecutor.Run)).toThrow(
      "CaseExecutor.make needs a callback"
    )
  })

  it("fails every case with a typed executor error when no executor is available", async () => {
    const error = await Effect.runPromise(Effect.flip(CaseExecutor.makeNoop().run(suiteCase)))
    expect(error.code).toBe("executor")
    expect(error.message).toBe("No executor is available for case 'a'")
    expect(error.path).toBe("cases['a']")
  })

  it("provides the unavailable executor as a layer", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(CaseExecutor.CaseExecutor, (service) => service.run(suiteCase)).pipe(
        Effect.provide(CaseExecutor.layerNoop)
      )
    )
    expect(exit._tag).toBe("Failure")
  })
})

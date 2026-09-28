import { describe, expect, it } from "@effect/vitest"
import * as ContainerSandbox from "../src/ContainerSandbox/index.ts"
import type { ResourceLimits } from "../src/Sandbox/index.ts"
import { untouchable } from "./helpers/untouchable.ts"

// Every provider validates limits through one helper at construction, so a
// malformed ceiling fails before the provider touches its engine.
describe("ResourceLimits", () => {
  const make = (limits: unknown) => {
    const deps = untouchable<never>()
    const run = () => ContainerSandbox.make({ spawner: deps.value, image: "img", limits: limits as ResourceLimits })
    return { deps, run }
  }

  it("refuses limits that are not an object", () => {
    for (const limits of [null, 2, "1"]) {
      const { deps, run } = make(limits)
      expect(run).toThrow("container-sandbox: limits must be { cpus?, memoryMib?, timeoutSecs? }")
      expect(deps.touched).toEqual([])
    }
  })

  it("refuses non-positive, non-finite, and fractional whole-number ceilings", () => {
    for (
      const [limits, message] of [
        [{ cpus: 0 }, "limits.cpus must be a positive number: 0"],
        [{ cpus: Number.POSITIVE_INFINITY }, "limits.cpus must be a positive number: Infinity"],
        [{ cpus: "1" }, "limits.cpus must be a positive number: 1"],
        [{ memoryMib: 1.5 }, "limits.memoryMib must be a positive integer: 1.5"],
        [{ timeoutSecs: -1 }, "limits.timeoutSecs must be a positive integer: -1"]
      ] as const
    ) {
      const { deps, run } = make(limits)
      expect(run).toThrow(message)
      expect(deps.touched).toEqual([])
    }
  })
})

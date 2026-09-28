import { Effect } from "effect"
import { expect, it } from "vitest"
import * as Container from "../src/Container.ts"

it("builds the plan from the argument snapshot that passed admission", async () => {
  const args: Array<string> = ["initial"]
  let reads = 0
  Object.defineProperty(args, "0", {
    configurable: true,
    get: () => {
      reads++
      delete args[0]
      return "validated"
    }
  })
  const plan = await Effect.runPromise(
    Container.makeCommand().exec({ container: "worker", file: "printf", args, stdin: false })
  )
  expect(reads).toBe(1)
  expect(Object.hasOwn(args, 0)).toBe(false)
  expect(plan).toEqual({ file: "docker", args: ["exec", "--", "worker", "printf", "validated"] })
})

it("owns the accepted argument values before the effect runs", async () => {
  const args = ["accepted"]
  const execution = Container.makeCommand().exec({ container: "worker", file: "printf", args, stdin: false })
  args[0] = "later"
  const plan = await Effect.runPromise(execution)
  expect(plan).toEqual({ file: "docker", args: ["exec", "--", "worker", "printf", "accepted"] })
})

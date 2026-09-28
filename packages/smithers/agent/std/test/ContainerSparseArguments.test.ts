import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Container from "../src/Container.ts"

describe("container argv admission", () => {
  it.each([0, 1, 2])(
    "refuses a genuine sparse argument at index %i instead of publishing undefined argv",
    async (missing) => {
      const args = new Array<string>(3)
      for (let index = 0; index < args.length; index++) if (index !== missing) args[index] = `argument-${index}`
      expect(Object.hasOwn(args, missing)).toBe(false)
      const result = await Effect.runPromise(
        Container.makeCommand().exec({
          container: "worker",
          file: "printf",
          args,
          stdin: false
        }).pipe(Effect.match({
          onFailure: (error) => ({ status: "failure" as const, error }),
          onSuccess: (plan) => ({ status: "success" as const, plan })
        }))
      )
      expect(result.status).toBe("failure")
      if (result.status === "failure") expect(result.error.code).toBe("invalid_input")
    }
  )

  it.each([
    { args: [], expected: ["exec", "--", "worker", "printf"] },
    { args: [""], expected: ["exec", "--", "worker", "printf", ""] },
    { args: ["%s", "a b", "'quoted'"], expected: ["exec", "--", "worker", "printf", "%s", "a b", "'quoted'"] }
  ])("preserves the dense argument vector $args as distinct literal argv", async ({ args, expected }) => {
    const plan = await Effect.runPromise(
      Container.makeCommand().exec({ container: "worker", file: "printf", args, stdin: false })
    )
    expect(plan).toEqual({ file: "docker", args: expected })
  })
})

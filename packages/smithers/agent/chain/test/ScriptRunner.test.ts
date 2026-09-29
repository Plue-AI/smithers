import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type * as Outcome from "../src/Outcome.ts"
import * as Script from "../src/Script.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import { runOn } from "./harness.ts"

const echo = (request: ScriptRunner.Request): Effect.Effect<unknown> =>
  Effect.succeed({ name: request.name, payload: request.payload })

describe("ScriptRunner", () => {
  it("fails as noop and accepts overrides", async () => {
    const noop = ScriptRunner.makeNoop()
    const error = await Effect.runPromise(
      Effect.flip(noop.run(Script.make("return done(null)"), echo))
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runner_unavailable")

    const overridden = ScriptRunner.makeNoop({
      run: () => Effect.succeed({ _tag: "Done", value: "canned" } as Outcome.Outcome)
    })
    const outcome = await Effect.runPromise(overridden.run(Script.make(""), echo))
    expect(outcome).toEqual({ _tag: "Done", value: "canned" })
  })

  it("rejects calls issued after an abort (in-process scripts outlive the fiber)", async () => {
    const calls: Array<string> = []
    const handler = (request: ScriptRunner.Request) => {
      calls.push(request.name)
      return request.name === "boom" ? Effect.fail("handler down") : echo(request)
    }
    const error = await runOn(
      ScriptRunner.layerInProcess,
      Effect.flip(
        Effect.flatMap(
          ScriptRunner.ScriptRunner,
          (runner) =>
            runner.run(
              Script.make(
                [
                  `try { await ctx.call("boom") } catch (first) {`,
                  `  try { await ctx.call("after-abort") } catch (second) {}`,
                  `}`,
                  `return done("swallowed")`
                ].join("\n")
              ),
              handler
            )
        )
      )
    )
    expect(error).toBe("handler down")
    expect(calls).toEqual(["boom"])
  })
})

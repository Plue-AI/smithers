import { Cause, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as GitHubClient from "../src/github/GitHubClient.ts"

// A bad config used to throw out of `Layer.sync`, which dies as a defect that
// `catchTag` and `Effect.flip` cannot see, behind a `Layer<Client>` type that
// promised no failure.
describe("client layers", () => {
  it.each(
    [
      ["GitHub", GitHubClient.layer({ apiBaseUrl: "not a url" }, {}), "INTEGRATION_ERROR"]
    ] as const
  )("fails the %s layer build with a typed error for a bad config", async (_name, layer, code) => {
    const failure = await Effect.runPromise(
      Effect.flip(Effect.scoped(Layer.build(layer as Layer.Layer<unknown, unknown>)))
    )
    expect(failure).toMatchObject({ code })
  })

  // Only a config error is a typed failure; anything else make throws is a bug
  // and stays a defect.
  it.each(
    [
      ["GitHub", () => GitHubClient.layer(null as never, {})]
    ] as const
  )("keeps a non-config throw from the %s layer a defect", async (_name, layer) => {
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer() as Layer.Layer<unknown, unknown>)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasDies(exit.cause)).toBe(true)
  })

  it("builds the layer for a valid config", async () => {
    const client = await Effect.runPromise(
      Effect.provide(Effect.service(GitHubClient.GitHubClient), GitHubClient.layer({ token: "t" }, {}))
    )
    expect(typeof client.request).toBe("function")
  })
})

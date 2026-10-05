/** Real subscription seat resolution and provider turn, without reading vendor credentials. */
import * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Effect, Stream } from "effect"
import { expect, it } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"
import * as Providers from "../src/Providers.ts"

it("resolves a logged-in ChatGPT seat and completes a real subscription turn", async (ctx) => {
  if (process.env["SMITHERS_LIVE_MODEL_TESTS"] !== "1") {
    if (process.env["SMITHERS_REQUIRE_LIVE_CREDENTIALS"] === "1") {
      throw new Error("Required live evidence needs SMITHERS_LIVE_MODEL_TESTS=1")
    }
    ctx.skip("live provider tests require SMITHERS_LIVE_MODEL_TESTS=1")
  }
  const environment = { ...process.env }
  const login = await Providers.codexLogin(environment)
  if (login?.loggedIn !== true) {
    if (process.env["SMITHERS_REQUIRE_LIVE_CREDENTIALS"] === "1") {
      throw new Error("Live Codex evidence requires an installed vendor CLI logged in using ChatGPT")
    }
    ctx.skip("Codex CLI must be logged in using ChatGPT")
  }
  const executor = { execute: () => Effect.die("A Codex subscription must not use the HTTP transport") } as never
  for (const declared of ["codex:sol", "openai:gpt-6.1-sol", "sol"]) {
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const seat = yield* NodeControl.seatResolver({ ...environment, SMITHERS_OPENAI_AUTH: "chatgpt" }, executor)
        .resolve(declared)
      expect(seat.id).toBe(declared)
      expect(seat.modelId).toBe("gpt-6.1-sol")
      const prepared = yield* seat.route.prepare(ModelRequest.ModelRequest.make({
        modelId: seat.modelId,
        system: [],
        messages: [ModelRequest.Message.user("Reply exactly LIVE_OK")],
        tools: [],
        params: {}
      }))
      expect(prepared.routeId).toBe("codex")
      const events = yield* Stream.runCollect(seat.model.stream(ModelRequest.ModelRequest.make({
        modelId: seat.modelId,
        system: [],
        messages: [ModelRequest.Message.user("Reply exactly LIVE_OK")],
        tools: [],
        params: {}
      })))
      const settled = ModelEvent.ModelEvent.settledMessage(events)
      expect(settled.message.stopReason).toBe("stop")
      expect(settled.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        .toContain("LIVE_OK")
      expect(settled.usage.outputTokens).toBeGreaterThan(0)
    })))
  }
}, 180_000)

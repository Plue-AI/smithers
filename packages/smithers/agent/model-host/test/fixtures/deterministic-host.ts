import * as Model from "@smthrs/model/Model"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { Deferred, Effect, Stream } from "effect"
import { environmentModelResolver } from "../../src/EnvironmentResolver.ts"
import { createModelTurnHandler, MODEL_HOST_PROTOCOL } from "../../src/HostServer.ts"

const authorization = process.env.SMITHERS_CHAT_HOST_TOKEN ?? ""
const callbackBaseUrl = process.env.SMITHERS_CHAT_CALLBACK_URL ?? ""
const credential = "fixture-secret-do-not-persist"
const release = await Effect.runPromise(Deferred.make<void>())

const events: ReadonlyArray<ModelEvent.ModelEvent> = [
  { type: "text-delta", id: "text", text: "deterministic fixture-sec" },
  { type: "text-delta", id: "text", text: "ret-do-not-persist safe" },
  { type: "tool-call-start", id: "call-1", name: "inspect" },
  { type: "tool-call-delta", id: "call-1", arguments: "{\"path\":" },
  { type: "tool-call-end", id: "call-1", arguments: "{\"path\":\"README.md\"}" },
  { type: "settle", stopReason: "tool-calls" }
]
const modelOrigin = process.env.SMITHERS_FIXTURE_MODEL_ORIGIN
const handler = createModelTurnHandler({
  authorization,
  callbackBaseUrl,
  resolve: modelOrigin === undefined ? (grant) => {
    const content = grant.request.messages.flatMap((message) =>
      "role" in message && message.role === "user" ? [message.content] : []
    )[0]
    const stream = content === "__block__"
      ? Stream.never
      : content === "__held__"
      ? Stream.fromEffect(Deferred.await(release)).pipe(Stream.flatMap(() =>
        Stream.fromIterable(events)
      ))
      : Stream.fromIterable(events)
    return Effect.succeed({
      model: Model.make({ stream: () => stream }),
      options: { modelId: "deterministic-fixture", credential }
    })
  } : environmentModelResolver({
    binding: { protocol: "openai-chat", baseUrl: modelOrigin, modelId: "recording-coding", credential: "FIXTURE" },
    env: { SMITHERS_MODEL_KEY_FIXTURE: credential, SMITHERS_MODEL_KEY_FIXTURE_ORIGIN: modelOrigin }
  })
})

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.SMITHERS_CHAT_HOST_PORT ?? "0"),
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/fixture/release" && request.method === "POST") {
      return Effect.runPromise(Deferred.succeed(release, undefined)).then(() => new Response(null, { status: 204 }))
    }
    return handler(request)
  }
})
process.stdout.write(`${JSON.stringify({ origin: server.url.origin, protocol: MODEL_HOST_PROTOCOL })}\n`)
const close = () => {
  void server.stop(true)
}
process.on("SIGTERM", close)
process.on("SIGINT", close)

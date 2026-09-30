/**
 * Stream a response directly through the model package.
 *
 * `ask` accepts a question, model ID, compatible endpoint, and redacted API key. It
 * constructs a route, calls `Model.stream`, and collects response text. This
 * isolates model transport from the agent's cell loop and structured completion
 * protocol.
 *
 * Usage: `node examples/src/15-model-layer-smoke.ts [modelId] [baseUrl]`.
 * Running the file directly contacts the selected endpoint. The defaults are
 * `qwen2.5-coder:1.5b` and `http://localhost:11434`.
 *
 * Supply credentials through `SMITHERS_EXAMPLE_API_KEY` in the environment,
 * populated by your secret manager or a hidden shell prompt. The key is wrapped
 * in `Redacted` as it is read and defaults to the non-secret value `local` when
 * unset. Positional keys are rejected. The regression tests use a local HTTP
 * fixture and require no provider credentials.
 *
 * @since 0.1.0
 */
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Message, ModelRequest } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import * as EgressHttpClient from "@smthrs/platform-node/EgressHttpClient"
import { Effect, Layer, Redacted, Stream } from "effect"

/**
 * The real HTTP transport: the kernel's guarded client (always-allow, since
 * this is a standalone smoke test with no grant policy to enforce) over
 * Node's real undici-backed client.
 *
 * @category layers
 * @since 0.1.0
 */
export const executorLayer = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(EgressHttpClient.layer(process.env))
)

/**
 * Sends one prompt to a real `openaiChatCompatible` endpoint and returns the
 * concatenated text of the response, with nothing but `packages/smithers/agent/model`
 * between the caller and the wire.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ask = (question: string, modelId: string, baseUrl: string, apiKey: Redacted.Redacted<string>) =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(Route.openaiChatCompatible({ id: "smoke", providerName: "openai", baseUrl, apiKey }))
    const model = yield* Route.toModel(routeConfig)
    const request = ModelRequest.make({
      modelId,
      system: [],
      messages: [Message.user(question)],
      tools: [],
      params: {}
    })
    const chunks: Array<string> = []
    yield* model.stream(request).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "text-delta") chunks.push(event.text)
        })
      )
    )
    return chunks.join("")
  }).pipe(Effect.provide(executorLayer))

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 4) {
    console.error("API keys must not be passed as positional arguments. Set SMITHERS_EXAMPLE_API_KEY in the environment.")
    console.error("Usage: node examples/src/15-model-layer-smoke.ts [modelId] [baseUrl]")
    process.exitCode = 1
  } else {
    const [, , modelId = "qwen2.5-coder:1.5b", baseUrl = "http://localhost:11434"] = process.argv
    const apiKey = Redacted.make(process.env.SMITHERS_EXAMPLE_API_KEY ?? "local")
    Effect.runPromise(ask("What is the capital of France? Answer in one word.", modelId, baseUrl, apiKey)).then(
      (answer) => {
        console.log("ANSWER:", answer)
      },
      (error) => {
        console.error("FAILED:", error)
        process.exitCode = 1
      }
    )
  }
}

import * as Action from "@smthrs/flow/Action"
import * as FlowRuntime from "@smthrs/flow/FlowRuntime"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Effect, Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { test } from "node:test"
import * as MeteredDispatch from "../../packages/smithers/src/internal/MeteredDispatch.ts"
import { attribute, header, layer } from "../coding/metered-steps.ts"

const proxy = "http://127.0.0.1:4100/model-proxy"
const sent: Array<HttpClientRequest.HttpClientRequest> = []
const recording: RequestExecutor.RequestExecutor = {
  execute: (request) =>
    Effect.sync(() => {
      sent.push(request)
      return HttpClientResponse.fromWeb(request, new Response("{}"))
    })
}
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const instance = (executionId: string) => ({ executionId }) as unknown as FlowRuntime.FlowInstance["Service"]

/** The header `executor` put on one request to `url`, inside the given dispatch. */
const send = (executor: RequestExecutor.RequestExecutor, url: string, executionId?: string, key?: string) => {
  sent.length = 0
  let effect = Effect.scoped(executor.execute(HttpClientRequest.post(url), { modelId: "gpt-oss-120b" }))
  if (key !== undefined) effect = effect.pipe(Effect.provideService(Action.CurrentInvocationKey, key))
  if (executionId !== undefined) {
    effect = effect.pipe(Effect.provideService(FlowRuntime.FlowInstance, instance(executionId)))
  }
  Effect.runSync(effect)
  assert.equal(sent.length, 1)
  return sent[0]!.headers[header.toLowerCase()]
}

test("a proxy call names the engine dispatch it ran under", () => {
  const executor = attribute(recording, proxy)
  assert.equal(
    send(executor, `${proxy}/cerebras/v1/chat/completions`, "run-1", "dispatch-key"),
    `run-1:${sha256("dispatch-key")}`
  )
  assert.equal(
    send(attribute(recording, `${proxy}/`), `${proxy}/openai/v1/responses`, "8719d667", "k"),
    `8719d667:${sha256("k")}`
  )
})

test("other origins, calls outside a dispatch and unnamed executions are sent unchanged", () => {
  const executor = attribute(recording, proxy)
  assert.equal(send(executor, "https://api.cerebras.ai/v1/chat/completions", "run-1", "k"), undefined)
  assert.equal(send(executor, `${proxy}-other/cerebras/v1`, "run-1", "k"), undefined)
  assert.equal(send(executor, `${proxy}/cerebras/v1`, undefined, "k"), undefined)
  assert.equal(send(executor, `${proxy}/cerebras/v1`, "run-1", undefined), undefined)
  assert.equal(send(executor, `${proxy}/cerebras/v1`, "has space", "k"), undefined)
  assert.equal(attribute(recording, undefined), recording)
  assert.equal(attribute(recording, " "), recording)
})

test("the layer attributes the composed executor only when a proxy is named", () => {
  const base = Layer.succeed(RequestExecutor.RequestExecutor, recording)
  assert.equal(layer(base, undefined), base)
  const executor = Effect.runSync(
    Effect.scoped(Effect.provide(Effect.service(RequestExecutor.RequestExecutor), layer(base, proxy)))
  )
  assert.equal(send(executor, `${proxy}/cerebras/v1`, "run-1", "k"), `run-1:${sha256("k")}`)
})

test("the judge's HTTP client names the dispatch on proxy requests too", () => {
  const seen: Array<string | undefined> = []
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      seen.push(request.headers[header.toLowerCase()])
      return HttpClientResponse.fromWeb(request, new Response("{}"))
    })
  )
  const judge = MeteredDispatch.attributeClient(client, proxy)
  const post = (url: string) =>
    Effect.runSync(
      Effect.scoped(judge.execute(HttpClientRequest.post(url))).pipe(
        Effect.provideService(Action.CurrentInvocationKey, "judge-key"),
        Effect.provideService(FlowRuntime.FlowInstance, instance("run-1"))
      )
    )
  post(`${proxy}/vercel/v4/ai/evaluation-model`)
  post("https://ai-gateway.vercel.sh/v4/ai/evaluation-model")
  assert.deepEqual(seen, [`run-1:${sha256("judge-key")}`, undefined])
  assert.equal(MeteredDispatch.attributeClient(client, undefined), client)
})

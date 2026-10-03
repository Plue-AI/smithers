/** Standalone flow hosts share the native Jev judge and subscription backup. */
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Layer } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientError from "effect/unstable/http/HttpClientError"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { hostEvaluator as releaseEvaluator } from "../release-support/runtime.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { hostEvaluator as wikiEvaluator } from "../wiki/runtime.ts"

const unavailableJev = Layer.succeed(HttpClient.HttpClient)(
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: "fixture Jev outage" })
      })
    )
  )
)

const evaluate = (layer: Layer.Layer<Evaluator.Evaluator>) =>
  Effect.runPromise(
    Effect.result(
      Effect.flatMap(Evaluator.Evaluator, (judge) =>
        judge.evaluate({
          state: { evidence: "verified" },
          questions: { complete: Evaluator.BooleanQuestion.of({ instructions: "Complete?" }) }
        })).pipe(Effect.provide(layer))
    )
  )

for (
  const [name, compose] of Object.entries({
    wiki: wikiEvaluator,
    release: releaseEvaluator,
    repository: evaluatorLayer
  })
) {
  test(`${name}: Jev answers through its own client before Luna`, async () => {
    const seen: string[] = []
    const jevHttp = HttpClient.make((request) => {
      seen.push(request.url)
      assert.equal(request.headers.authorization, "Bearer fixture-jev")
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        Response.json({
          answers: { complete: { type: "boolean", probability: 0.9 } }
        })
      ))
    })
    const result = await evaluate(compose({
      AI_GATEWAY_API_KEY: "fixture-jev",
      CODEX_HOME: "/nonexistent"
    }, Layer.succeed(HttpClient.HttpClient)(jevHttp)))
    assert.equal(result._tag, "Success")
    if (result._tag === "Success") {
      assert.deepEqual(result.success.answers.complete, { type: "boolean", probability: 0.9 })
    }
    assert.deepEqual(seen, [Evaluator.defaultBaseUrl])
  })

  test(`${name}: Jev outage uses the subscription Luna backup`, async () => {
    const seen: string[] = []
    let answer = JSON.stringify({ answers: { complete: { type: "boolean", probability: 0.95 } } })
    let available = true
    let refused = false
    const server = createServer((request, response) => {
      seen.push(request.url!)
      assert.equal(request.headers.authorization, "Bearer fixture-host")
      if (refused) {
        response.writeHead(401).end()
        return
      }
      if (request.url === "/routes") {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ routes: available ? ["chatgpt"] : [] }))
        return
      }
      assert.equal(request.url, "/chatgpt/codex/responses")
      const events = [
        { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: answer },
        { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
      ]
      response.setHeader("content-type", "text/event-stream")
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    try {
      const environment = {
        AI_GATEWAY_API_KEY: "fixture-jev",
        SMITHERS_ACCOUNT_POOL_URL: `http://127.0.0.1:${port}`,
        SMITHERS_ACCOUNT_POOL_KEY: "fixture-host",
        SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
        CODEX_HOME: "/nonexistent",
        NO_PROXY: "*"
      }
      const layer = compose(environment, unavailableJev)
      const result = await evaluate(layer)
      assert.equal(result._tag, "Success")
      if (result._tag === "Success") {
        assert.deepEqual(result.success.answers.complete, { type: "boolean", probability: 0.95 })
      }
      assert.deepEqual(seen, ["/routes", "/chatgpt/codex/responses"])

      answer = "{\"answers\":{\"complete\":{\"type\":\"boolean\",\"probability\":2}}}"
      const invalid = await evaluate(layer)
      assert.equal(invalid._tag, "Failure")
      if (invalid._tag === "Failure") assert.equal(invalid.failure.code, "invalid_answer")

      available = false
      seen.length = 0
      const missing = await evaluate(layer)
      assert.equal(missing._tag, "Failure")
      if (missing._tag === "Failure") {
        assert.equal(missing.failure.code, "unreachable")
        assert.equal(Evaluator.publicMessage(missing.failure), Evaluator.unreachableMessage)
      }
      assert.deepEqual(seen, ["/routes"], "an empty pool cannot fall back to another provider")

      refused = true
      const failed = await evaluate(layer)
      assert.equal(failed._tag, "Failure")
      if (failed._tag === "Failure") {
        assert.equal(failed.failure.code, "unreachable", "an unreadable pool fails closed with a transport failure")
        assert.equal(Evaluator.publicMessage(failed.failure), Evaluator.unreachableMessage)
      }
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test(`${name}: missing Jev key fails before consulting a configured subscription pool`, async () => {
    const result = await evaluate(compose({
      SMITHERS_ACCOUNT_POOL_URL: "http://127.0.0.1:1",
      SMITHERS_ACCOUNT_POOL_KEY: "fixture-host",
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
      CODEX_HOME: "/nonexistent"
    }))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "unconfigured")
      assert.match(result.failure.message, /AI_GATEWAY_API_KEY/)
    }
  })

  test(`${name}: provider keys cannot substitute for a missing backup subscription`, async () => {
    const result = await evaluate(compose({
      OPENAI_API_KEY: "unused",
      ANTHROPIC_API_KEY: "unused",
      CODEX_HOME: "/nonexistent"
    }))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "unconfigured")
      assert.equal(Evaluator.publicMessage(result.failure), result.failure.message)
      assert.match(result.failure.message, /AI_GATEWAY_API_KEY/)
    }
  })
}

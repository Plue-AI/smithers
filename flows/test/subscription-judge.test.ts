/** Standalone flow hosts share the native subscription judge and fail closed. */
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, type Layer } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { hostEvaluator as releaseEvaluator } from "../release-support/runtime.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import { hostEvaluator as wikiEvaluator } from "../wiki/runtime.ts"

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
  test(`${name}: subscription judgments need no gateway or provider key`, async () => {
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
        SMITHERS_ACCOUNT_POOL_URL: `http://127.0.0.1:${port}`,
        SMITHERS_ACCOUNT_POOL_KEY: "fixture-host",
        SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
        CODEX_HOME: "/nonexistent",
        NO_PROXY: "*"
      }
      const layer = compose(environment)
      const result = await evaluate(layer)
      assert.equal(result._tag, "Success")
      if (result._tag === "Success") {
        assert.deepEqual(result.success.answers.complete, { type: "boolean", probability: 0.95 })
      }
      assert.deepEqual(seen, ["/routes", "/routes", "/chatgpt/codex/responses"])

      answer = "{\"answers\":{\"complete\":{\"type\":\"boolean\",\"probability\":2}}}"
      const invalid = await evaluate(layer)
      assert.equal(invalid._tag, "Failure")
      if (invalid._tag === "Failure") assert.equal(invalid.failure.code, "invalid_answer")

      available = false
      seen.length = 0
      const missing = await evaluate(layer)
      assert.equal(missing._tag, "Failure")
      if (missing._tag === "Failure") assert.equal(missing.failure.code, "unreachable")
      assert.deepEqual(seen, ["/routes"], "an empty pool cannot fall back to another provider")

      refused = true
      const failed = await evaluate(layer)
      assert.equal(failed._tag, "Failure")
      if (failed._tag === "Failure") assert.equal(failed.failure.code, "unreachable")
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  test(`${name}: API keys cannot substitute for a missing subscription`, async () => {
    const result = await evaluate(compose({
      AI_GATEWAY_API_KEY: "unused",
      OPENAI_API_KEY: "unused",
      ANTHROPIC_API_KEY: "unused",
      CODEX_HOME: "/nonexistent"
    }))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "unreachable")
      assert.match(result.failure.message, /Connect a subscription seat/)
    }
  })
}

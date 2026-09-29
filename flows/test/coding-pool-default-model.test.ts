import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test, type TestContext } from "node:test"
import { platform } from "../../packages/smithers/src/internal/NodeControlHost.ts"
import * as Host from "../coding/host.ts"
import { makeHostJudge } from "./fixtures/scripted-judge.ts"

type Environment = Readonly<Record<string, string | undefined>>

// Use the production request executor against the local pool fixture.
const optionsFromEnv = (environment: Environment) =>
  Effect.runPromise(Host.optionsFromEnv(environment).pipe(Effect.provide(platform.requestExecutor)))

const hostOptions = (implementationModel: string) => ({
  repositoryPath: "/unused",
  gatewayId: "11111111-1111-4111-8111-111111111111",
  credential: "operator-key",
  implementationModel
})

interface PoolAnswer {
  readonly status: number
  readonly body: string
}

const pool = async (t: TestContext, initial: PoolAnswer = { status: 200, body: "{\"routes\":[\"chatgpt\"]}" }) => {
  let answer = initial
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization
    })
    response.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() =>
    new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
  )
  const { port } = server.address() as AddressInfo
  const environment: Environment = {
    SMITHERS_ACCOUNT_POOL_URL: `http://127.0.0.1:${port}/provider-pool/`,
    SMITHERS_ACCOUNT_POOL_KEY: "fixture-host",
    SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic,chatgpt"
  }
  return {
    environment,
    requests,
    answer: (next: PoolAnswer) => {
      answer = next
    }
  }
}

test("chooses a coding model from the pool routes when none is pinned", async (t) => {
  const connected = await pool(t)
  const options = await optionsFromEnv(connected.environment)
  Host.layer({ ...platform, evaluator: makeHostJudge().layer }, hostOptions(options.implementationModel))
  assert.equal(options.implementationModel, "openai:gpt-6-luna")
  assert.deepEqual(connected.requests, [{
    method: "GET",
    url: "/provider-pool/routes",
    authorization: "Bearer fixture-host"
  }])
  const seat = await Effect.runPromise(
    Effect.flatMap(SeatResolver.SeatResolver, (seats) => seats.resolve("coding/implement")).pipe(
      Effect.provide(
        Host.roleSeats(hostOptions(options.implementationModel))(connected.environment).pipe(
          Layer.provide(platform.requestExecutor)
        )
      )
    )
  )
  assert.equal(seat.id, "coding/implement")
  assert.equal(seat.modelId, "gpt-6-luna")
})

test("ignores an anthropic pool route when chatgpt has no connected account", async (t) => {
  const connected = await pool(t, { status: 200, body: "{\"routes\":[\"anthropic\"]}" })
  const options = await optionsFromEnv(connected.environment)
  assert.equal(options.implementationModel, "")
  assert.deepEqual(connected.requests.map((request) => request.url), ["/provider-pool/routes"])
})

test("keeps an explicit coding model pin without asking the pool", async (t) => {
  const connected = await pool(t, { status: 503, body: "unavailable" })
  const options = await optionsFromEnv({
    ...connected.environment,
    SMITHERS_CODING_IMPLEMENT_MODEL: "openai:gpt-6-sol"
  })
  assert.equal(options.implementationModel, "openai:gpt-6-sol")
  assert.deepEqual(connected.requests, [])
})

test("chooses the chatgpt pool route or the platform fallback", async (t) => {
  const connected = await pool(t)
  for (
    const { routes, fallback, expected } of [
      { routes: "[\"chatgpt\"]", fallback: "anthropic:claude-sonnet-4-6", expected: "openai:gpt-6-luna" },
      { routes: "[\"anthropic\"]", fallback: "openai:gpt-6-luna", expected: "openai:gpt-6-luna" }
    ]
  ) {
    connected.answer({ status: 200, body: `{"routes":${routes}}` })
    const options = await optionsFromEnv({
      ...connected.environment,
      SMITHERS_CODING_FALLBACK_MODEL: fallback
    })
    assert.equal(options.implementationModel, expected)
  }
  assert.deepEqual(connected.requests.map((request) => request.url), ["/provider-pool/routes", "/provider-pool/routes"])
})

test("uses the platform fallback after pool accounts disappear or lookup fails", async (t) => {
  const connected = await pool(t, { status: 200, body: "{\"routes\":[]}" })
  const environment = {
    ...connected.environment,
    SMITHERS_CODING_FALLBACK_MODEL: "anthropic:claude-sonnet-4-6"
  }
  assert.equal((await optionsFromEnv(environment)).implementationModel, "anthropic:claude-sonnet-4-6")
  const beforeFailure = connected.requests.length
  assert.equal(beforeFailure, 1)
  connected.answer({ status: 503, body: "unavailable" })
  assert.equal((await optionsFromEnv(environment)).implementationModel, "anthropic:claude-sonnet-4-6")
  assert.ok(connected.requests.length > beforeFailure, "failed routes must still be queried")
  assert.ok(connected.requests.every((request) => request.url === "/provider-pool/routes"))
})

test("resolves direct API keys or the model proxy when pool accounts are absent", async (t) => {
  const connected = await pool(t, { status: 200, body: JSON.stringify({ routes: [] }) })
  for (
    const [provider, model, key, path] of [
      ["anthropic", "claude-sonnet-4-6", "ANTHROPIC_API_KEY", "/v1/messages"],
      ["openai", "gpt-6-luna", "OPENAI_API_KEY", "/v1/responses"]
    ] as const
  ) {
    const environment = {
      ...connected.environment,
      SMITHERS_CODING_FALLBACK_MODEL: `${provider}:${model}`,
      SMITHERS_MODEL_PROXY_URL: "http://127.0.0.1:9911/model-proxy",
      SMITHERS_MODEL_PROXY_PROVIDERS: provider,
      [key]: "platform-fixture-key"
    }
    const options = await optionsFromEnv(environment)
    assert.equal(options.implementationModel, `${provider}:${model}`)
    const resolve = (environment: Environment) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const seats = yield* SeatResolver.SeatResolver
          const seat = yield* seats.resolve("coding/implement")
          return yield* seat.route.prepare({
            modelId: seat.modelId,
            system: [],
            messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            tools: [],
            params: {}
          } as never)
        }).pipe(Effect.provide(
          Host.roleSeats(hostOptions(options.implementationModel))(environment).pipe(
            Layer.provide(platform.requestExecutor)
          )
        ))
      )
    assert.equal((await resolve(environment)).url, `http://127.0.0.1:9911/model-proxy/${provider}${path}`)
    const overrides = [
      { SMITHERS_MODEL_PROXY_URL: undefined },
      { SMITHERS_MODEL_PROXY_PROVIDERS: "cerebras" },
      { SMITHERS_CODING_FALLBACK_MODEL: `${provider}:different-model` }
    ]
    if (provider === "anthropic") {
      const directUrl = `https://api.${provider}.com${path}`
      assert.equal((await resolve({ ...environment, ...overrides[0] })).url, directUrl)
      assert.equal((await resolve({ ...environment, ...overrides[1] })).url, directUrl)
      assert.equal(
        (await resolve({ ...environment, ...overrides[2] })).url,
        `http://127.0.0.1:9911/model-proxy/${provider}${path}`
      )
    } else {
      for (const override of overrides) {
        await assert.rejects(resolve({ ...environment, ...override }), {
          _tag: "@smthrs/agent/Seat/SeatUnresolved"
        })
      }
    }
  }
})

test("explicit pins, including blank, outrank the pool and platform fallback", async (t) => {
  const connected = await pool(t)
  for (const pin of ["openai:gpt-6-sol", ""]) {
    const options = await optionsFromEnv({
      ...connected.environment,
      SMITHERS_CODING_IMPLEMENT_MODEL: pin,
      SMITHERS_CODING_FALLBACK_MODEL: "anthropic:claude-sonnet-4-6"
    })
    assert.equal(options.implementationModel, pin)
  }
  assert.deepEqual(connected.requests, [])
})

test("uses the platform fallback when no pool is configured", async () => {
  const options = await optionsFromEnv({ SMITHERS_CODING_FALLBACK_MODEL: "openai:gpt-6-luna" })
  assert.equal(options.implementationModel, "openai:gpt-6-luna")
})

test("asks again on the next host start after an account is connected", async (t) => {
  const connected = await pool(t, { status: 200, body: "{\"routes\":[]}" })
  const before = await optionsFromEnv(connected.environment)
  assert.equal(before.implementationModel, "")
  assert.throws(
    () => Host.layer({ ...platform, evaluator: makeHostJudge().layer }, hostOptions(before.implementationModel)),
    /Set SMITHERS_CODING_IMPLEMENT_MODEL/
  )

  connected.answer({ status: 200, body: "{\"routes\":[\"chatgpt\"]}" })
  const after = await optionsFromEnv(connected.environment)
  assert.equal(after.implementationModel, "openai:gpt-6-luna")
  assert.deepEqual(connected.requests.map((request) => request.url), ["/provider-pool/routes", "/provider-pool/routes"])
})

test("does not invent a model for empty, unoffered, or failed pool routes", async (t) => {
  const connected = await pool(t, { status: 200, body: "{\"routes\":[]}" })
  for (
    const answer of [
      { status: 200, body: "{\"routes\":[]}" },
      { status: 200, body: "{\"routes\":[\"other\"]}" },
      { status: 401, body: "{\"routes\":[\"chatgpt\"]}" },
      { status: 503, body: "unavailable" },
      { status: 200, body: "{\"routes\":null}" },
      { status: 200, body: "not-json" }
    ]
  ) {
    connected.answer(answer)
    const before = connected.requests.length
    const options = await optionsFromEnv(connected.environment)
    assert.equal(options.implementationModel, "", `pool answer ${answer.body}`)
    assert.ok(connected.requests.length > before, "a failed lookup must not suppress the next lookup")
  }
})

test("uses chatgpt only when the host allowlist permits it", async (t) => {
  const connected = await pool(t, { status: 200, body: "{\"routes\":[\"anthropic\",\"chatgpt\"]}" })
  assert.equal((await optionsFromEnv(connected.environment)).implementationModel, "openai:gpt-6-luna")
  assert.equal(
    (await optionsFromEnv({
      ...connected.environment,
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic"
    })).implementationModel,
    ""
  )
  connected.answer({ status: 200, body: "{\"routes\":[\"chatgpt\"]}" })
  assert.equal(
    (await optionsFromEnv({
      ...connected.environment,
      SMITHERS_ACCOUNT_POOL_PROVIDERS: "anthropic"
    })).implementationModel,
    ""
  )
})

test("does not ask an absent or incompletely configured pool", async (t) => {
  const connected = await pool(t)
  assert.equal((await optionsFromEnv({})).implementationModel, "")
  for (
    const variable of ["SMITHERS_ACCOUNT_POOL_URL", "SMITHERS_ACCOUNT_POOL_KEY", "SMITHERS_ACCOUNT_POOL_PROVIDERS"]
  ) {
    assert.equal((await optionsFromEnv({ ...connected.environment, [variable]: "" })).implementationModel, "")
  }
  assert.deepEqual(connected.requests, [])
})

test("preserves aliases and blank or invalid explicit pins without fallback", async (t) => {
  const connected = await pool(t)
  for (const pin of ["luna", "", "invalid-model"]) {
    const options = await optionsFromEnv({ ...connected.environment, SMITHERS_CODING_IMPLEMENT_MODEL: pin })
    assert.equal(options.implementationModel, pin)
    if (pin !== "luna") {
      assert.throws(
        () => Host.layer({ ...platform, evaluator: makeHostJudge().layer }, hostOptions(options.implementationModel)),
        /Set SMITHERS_CODING_IMPLEMENT_MODEL/
      )
    }
  }
  assert.deepEqual(connected.requests, [])
})

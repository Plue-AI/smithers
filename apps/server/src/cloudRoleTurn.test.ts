import { describe, expect, test } from "bun:test"
import { cloudRole } from "@smthrs/rpc/AgentRoles"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { TestClock } from "effect/testing"
import { CLIENT_DISCONNECTED_STATUS, runRequest } from "./Boundary"
import { testConfig, testConfigLayer } from "./Config"
import type { ServerConfigShape } from "./Config"
import { transportLayer } from "./Http"
import {
  CLOUD_ROLE_MAX_TOKENS,
  CLOUD_ROLE_REASONING_EFFORT,
  CLOUD_ROLE_TIMEOUT_MS,
  cloudRoleMessages,
  cloudRoleModel,
  handleCloudRoleTurn,
  isCloudRoleTurn,
  turnHints
} from "./cloudRoleTurn"
import type { TurnRequest } from "./cloudRoleTurn"

const body: TurnRequest = {
  runId: "run-lib-1",
  messages: [{ role: "user", content: "Where are triggers registered?" }],
  instructions: "You are the Librarian.",
  role: "librarian",
  purpose: "librarian"
}

const completion = (content: string, model = "gpt-oss-120b"): Response =>
  Response.json({ model, choices: [{ message: { content } }] })

/** Stand in for the network: `answer` serves the provider, and every call is recorded. */
const recording = (answer: (request: Request) => Response | Promise<Response>) => {
  const calls: Array<Request> = []
  return {
    calls,
    layer: transportLayer(async (input, init) => {
      const request = new Request(input, init)
      calls.push(request)
      return answer(request)
    })
  }
}

const KEY: Partial<ServerConfigShape> = { cerebrasApiKey: Redacted.make("csk-test") }

const headers = { "x-test": "1" }

/** Serve one turn with the network and configuration injected. */
const serve = (
  turn: TurnRequest,
  network: ReturnType<typeof recording>,
  config: Partial<ServerConfigShape> = KEY
): Promise<Response> =>
  Effect.runPromise(handleCloudRoleTurn(turn, headers).pipe(Effect.provide(Layer.mergeAll(network.layer, testConfigLayer(config)))))

describe("the turn hints", () => {
  test("keeps the two tiers, a purpose under 200 characters and a role id under 40; drops everything else silently", () => {
    expect(turnHints({ tier: "cheap", purpose: "recommend", role: "explainer" })).toEqual({
      tier: "cheap",
      purpose: "recommend",
      role: "explainer"
    })
    expect(turnHints({})).toEqual({})
    expect(turnHints({ tier: "gold", purpose: 7, role: ["librarian"] })).toEqual({})
    expect(turnHints({ purpose: "x".repeat(201) })).toEqual({})
    expect(turnHints({ purpose: "x".repeat(200) })).toEqual({ purpose: "x".repeat(200) })
    expect(turnHints({ role: `l${"o".repeat(40)}` })).toEqual({})
    expect(turnHints({ role: "Librarian" })).toEqual({})
    expect(turnHints({ role: "--model" })).toEqual({})
    expect(turnHints({ role: "librarian", purpose: "" })).toEqual({ role: "librarian" })
  })

  test("a cloud role turn is exactly a body whose role is a cloud role id", () => {
    expect(isCloudRoleTurn(body)).toBe(true)
    expect(isCloudRoleTurn({ ...body, role: "flows" })).toBe(true)
    expect(isCloudRoleTurn({ ...body, role: "explainer" })).toBe(false)
    expect(isCloudRoleTurn({ ...body, role: undefined })).toBe(false)
  })
})

describe("the cloud role messages", () => {
  test("renders the composed instructions as the system message and the transcript after it", () => {
    const messages = cloudRoleMessages({
      ...body,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "again" }]
    })
    expect(messages).toEqual([
      { role: "system", content: "You are the Librarian." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "again" }
    ])
  })

  test("a tool-loop continuation item has no rendering: the cloud role cannot continue a call", () => {
    expect(cloudRoleMessages({
      ...body,
      messages: [
        { role: "user", content: "run it" },
        { type: "function_call", call_id: "c1", name: "commands", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "done" }
      ]
    })).toBeUndefined()
  })

  test("the served model is the table default, or the role's configured override", () => {
    expect(cloudRoleModel(cloudRole("librarian"), testConfig())).toBe("qwen-3.8-27b")
    expect(cloudRoleModel(cloudRole("flows"), testConfig())).toBe("qwen-3.8-27b")
    expect(cloudRoleModel(cloudRole("flows"), testConfig({ cerebrasModelFlows: "gpt-oss-120b" }))).toBe("gpt-oss-120b")
    expect(cloudRoleModel(cloudRole("librarian"), testConfig({ cerebrasModelFlows: "gpt-oss-120b" }))).toBe("qwen-3.8-27b")
    expect(cloudRoleModel(cloudRole("librarian"), testConfig({ cerebrasModelLibrarian: "gpt-oss-120b" }))).toBe("gpt-oss-120b")
  })
})

describe("serving a cloud role turn", () => {
  test("one completion becomes one text delta and a done frame tagged with the body's runId, on the role's model", async () => {
    const network = recording(() => completion("Triggers are registered in flows/triggers.ts."))
    const response = await serve(body, network)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/x-ndjson")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-test")).toBe("1")
    const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(frames).toEqual([
      { runId: "run-lib-1", type: "delta", kind: "text", text: "Triggers are registered in flows/triggers.ts." },
      { runId: "run-lib-1", type: "done", reason: "stop" }
    ])
    expect(network.calls.length).toBe(1)
    expect(network.calls[0]!.url).toBe("https://api.cerebras.ai/v1/chat/completions")
    expect(network.calls[0]!.headers.get("authorization")).toBe("Bearer csk-test")
    const sent = (await network.calls[0]!.json()) as {
      model: string
      max_tokens: number
      reasoning_effort?: string
      messages: Array<{ role: string; content: string }>
      response_format?: unknown
      tools?: unknown
    }
    expect(sent.model).toBe("qwen-3.8-27b")
    expect(sent.max_tokens).toBe(CLOUD_ROLE_MAX_TOKENS)
    // Never the provider's own default, which on Cerebras is `high`.
    expect(sent.reasoning_effort).toBe(CLOUD_ROLE_REASONING_EFFORT)
    expect(sent.response_format).toBeUndefined()
    expect(sent.tools).toBeUndefined()
    expect(sent.messages[0]).toEqual({ role: "system", content: "You are the Librarian." })
  })

  test("the flows role reads its own model, and the configured override wins", async () => {
    const network = recording(() => completion("Run /review."))
    const response = await serve({ ...body, role: "flows", purpose: "flows" }, network, { ...KEY, cerebrasModelFlows: "gpt-oss-120b" })
    expect(response.status).toBe(200)
    await response.text()
    expect(((await network.calls[0]!.json()) as { model: string }).model).toBe("gpt-oss-120b")
  })

  test("a body that names no cloud role is refused with 400", async () => {
    const network = recording(() => completion("never"))
    const response = await serve({ ...body, role: "explainer" }, network)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toBe("Not a cloud role turn.")
    expect(network.calls.length).toBe(0)
  })

  test("a tool-bearing body is refused with 400 before any provider byte is spent", async () => {
    const network = recording(() => completion("never"))
    const tools = [{ type: "function" as const, name: "commands", description: "the one tool", parameters: {} }]
    const response = await serve({ ...body, tools }, network)
    expect(response.status).toBe(400)
    expect(((await response.json()) as { message: string }).message).toContain("runs no tools")
    expect(network.calls.length).toBe(0)
  })

  test("a tool-loop continuation is refused with 400 too", async () => {
    const network = recording(() => completion("never"))
    const response = await serve({
      ...body,
      messages: [{ type: "function_call_output", call_id: "c1", output: "done" }]
    }, network)
    expect(response.status).toBe(400)
    expect(network.calls.length).toBe(0)
  })

  test("an empty tools list is not a tool-bearing body", async () => {
    const network = recording(() => completion("ok"))
    const response = await serve({ ...body, tools: [] }, network)
    expect(response.status).toBe(200)
    await response.text()
    expect(network.calls.length).toBe(1)
  })

  test("no key is an honest 503 that never names the variable or calls a provider", async () => {
    const network = recording(() => completion("never"))
    const response = await serve(body, network, {})
    expect(response.status).toBe(503)
    expect(((await response.json()) as { message: string }).message).toBe("The Librarian isn't available on this deployment.")
    expect(network.calls.length).toBe(0)
  })

  test("a provider limit stays 429, another provider failure is 502, and neither leaks the provider's body", async () => {
    const limited = recording(() => new Response("{\"error\":\"slow down\"}", { status: 429 }))
    const refused = await serve(body, limited)
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { message: string }).message).toBe("The Librarian's model service answered HTTP 429.")

    const broken = recording(() => new Response("<html>oops</html>", { status: 500 }))
    const failed = await serve(body, broken)
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { message: string }).message).not.toContain("oops")

    const unreachable = recording(() => {
      throw new TypeError("fetch failed")
    })
    const down = await serve(body, unreachable)
    expect(down.status).toBe(502)
    expect(((await down.json()) as { message: string }).message).toBe("The Librarian's model service can't be reached right now. Try again in a moment.")

    const wordless = recording(() => Response.json({ choices: [] }))
    const empty = await serve(body, wordless)
    expect(empty.status).toBe(502)
    expect(((await empty.json()) as { message: string }).message).toBe("The Librarian's model service sent no answer.")
  })

  test("a completion with no text is a done frame that says so, not a silent empty stream", async () => {
    const network = recording(() => completion("   "))
    const response = await serve(body, network)
    expect(response.status).toBe(200)
    const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(frames).toEqual([{ runId: "run-lib-1", type: "done", reason: "stop", error: "The Librarian answered with no text." }])
  })

  test("a provider that never answers is a 504 at the deadline, and the call is aborted", async () => {
    let aborted = false
    const network = recording((request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("aborted", "AbortError"))
        })
      })
    )
    const response = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(handleCloudRoleTurn(body, headers))
        while (network.calls.length === 0) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)))
        yield* TestClock.adjust(CLOUD_ROLE_TIMEOUT_MS)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(Layer.mergeAll(network.layer, testConfigLayer(KEY), TestClock.layer())))
    )
    expect(response.status).toBe(504)
    expect(((await response.json()) as { message: string }).message).toBe("The Librarian did not answer within 30s.")
    expect(aborted).toBe(true)
  })

  test("the client leaving interrupts the provider call and the boundary answers 499", async () => {
    // The turn is run as the Worker runs it: the request's signal interrupts
    // the fiber, the interruption aborts the fetch, and nothing here maps it
    // to an error of its own.
    const controller = new AbortController()
    let aborted = false
    const network = recording((request) =>
      new Promise<Response>((_, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true
          reject(new DOMException("aborted", "AbortError"))
        })
        // The client leaves once the provider call is in flight.
        setTimeout(() => controller.abort(), 0)
      })
    )
    const response = await runRequest(
      handleCloudRoleTurn(body, headers).pipe(Effect.provide(Layer.mergeAll(network.layer, testConfigLayer(KEY)))),
      controller.signal
    )
    expect(response.status).toBe(CLIENT_DISCONNECTED_STATUS)
    expect(response.status).toBe(499)
    expect(aborted).toBe(true)
  })
})

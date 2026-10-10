import type { ConfiguredModel, ModelCallInput, ModelCredentialListing } from "@smthrs/rpc/ConfiguredModel"
import { Redacted } from "effect"
import { describe, expect, test, vi } from "vitest"
import type { ModelCredentials } from "../src/LocalModel.ts"
import { createModelProbe } from "../src/ModelProbe.ts"

type Fetch = typeof globalThis.fetch
const fetchOf = (impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): Fetch =>
  Object.assign(impl, { preconnect() {} })

const KEY = "sk-probe-REDACTME-0123456789"
const ORIGIN = "http://127.0.0.1:9"
const env = { SMITHERS_MODEL_KEY_LAB: KEY, SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN }
const generator: ConfiguredModel = {
  id: "lab",
  protocol: "openai-chat",
  baseUrl: ORIGIN,
  modelId: "lab",
  credential: "LAB"
}
const decider: ConfiguredModel = {
  id: "judge",
  protocol: "evaluation",
  baseUrl: ORIGIN,
  modelId: "judge",
  credential: "LAB"
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${
    JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 1,
      model: "lab",
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
  }\n\n`
const sse = (...frames: ReadonlyArray<string>) =>
  fetchOf(async () => new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }))
const answering = (body: unknown) => fetchOf(async () => Response.json(body))

const probe = (fetch: Fetch, deadlineMs?: number) =>
  createModelProbe({ env, egress: false, fetch, ...(deadlineMs === undefined ? {} : { deadlineMs }) })

describe("a generation Test", () => {
  test("passes with the generated words, the credential cut out", async () => {
    const fetch = vi.fn<Fetch>(
      sse(chunk({ content: `hello ${KEY}` }), chunk({}, "stop"), "data: [DONE]\n\n")
    )
    const result = await probe(fetch).test(generator)
    expect(result).toMatchObject({ ok: true, output: { kind: "generation", text: "hello " } })
    expect(JSON.stringify(result)).not.toContain(KEY)
    const body = JSON.parse(new TextDecoder().decode(fetch.mock.calls[0]?.[1]?.body as Uint8Array)) as Record<
      string,
      unknown
    >
    expect(body).not.toHaveProperty("temperature")
  })

  test("sends a composed system prompt and temperature", async () => {
    const fetch = vi.fn<Fetch>(sse(chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n"))
    const input: ModelCallInput = {
      kind: "generation",
      system: "be brief",
      prompt: "hi",
      maxTokens: 8,
      temperature: 0.5
    }
    expect(await probe(fetch).test(generator, input)).toMatchObject({ ok: true, output: { text: "ok" } })
    const body = JSON.parse(new TextDecoder().decode(fetch.mock.calls[0]?.[1]?.body as Uint8Array)) as {
      messages: ReadonlyArray<{ role: string }>
      temperature: number
    }
    expect(body.messages[0]?.role).toBe("system")
    expect(body.temperature).toBe(0.5)
  })

  test("a stream that never settles is a protocol mismatch", async () => {
    expect(await probe(sse(chunk({ content: "partial" }))).test(generator)).toMatchObject({
      ok: false,
      failure: { code: "invalid", field: "protocol" }
    })
  })

  test("refuses a redirect instead of following it", async () => {
    const fetch = fetchOf(async () =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } })
    )
    expect(await probe(fetch).test(generator)).toMatchObject({ ok: false, failure: { code: "refused", status: 307 } })
  })

  test("times out at its one deadline", async () => {
    const fetch =
      (async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        })) as typeof globalThis.fetch
    expect(await probe(fetch, 20).test(generator)).toMatchObject({
      ok: false,
      failure: { code: "timeout", deadlineMs: 20 }
    })
  })

  test("maps a provider refusal to its status", async () => {
    const fetch = fetchOf(async () => Response.json({ error: { message: "no" } }, { status: 401 }))
    expect(await probe(fetch).test(generator)).toMatchObject({ ok: false, failure: { code: "refused", status: 401 } })
  })
})

describe("a decision Test", () => {
  test("passes with the classifier's typed answers", async () => {
    const result = await probe(answering({ answers: { ok: { type: "boolean", probability: 0.9 } } })).test(decider)
    expect(result).toMatchObject({
      ok: true,
      output: { kind: "decision", answers: { ok: { type: "boolean", value: true, probability: 0.9 } } }
    })
  })

  test("an answer the classifier refuses is a protocol mismatch", async () => {
    expect(await probe(answering({ answers: { ok: { type: "choice", choice: "a" } } })).test(decider)).toMatchObject({
      ok: false,
      failure: { code: "invalid", field: "protocol" }
    })
  })

  test("a defect is dropped as unreachable", async () => {
    const questions = new Proxy({}, {
      ownKeys: () => {
        throw new Error(KEY)
      }
    })
    const input = { kind: "decision", state: [], questions } as unknown as ModelCallInput
    const result = await probe(answering({})).test(decider, input)
    expect(result).toMatchObject({ ok: false, failure: { code: "unreachable" } })
    expect(JSON.stringify(result)).not.toContain(KEY)
  })
})

describe("before any call", () => {
  const never = fetchOf(async () => {
    throw new Error("dialed")
  })

  test("refuses a binding the planner refuses", async () => {
    expect(await probe(never).test({ ...generator, baseUrl: "https://elsewhere.test" })).toMatchObject({
      ok: false,
      failure: { code: "endpoint_forbidden" }
    })
  })

  test("names a missing credential", async () => {
    const result = await createModelProbe({
      env: { SMITHERS_MODEL_KEY_LAB_ORIGIN: ORIGIN },
      egress: false,
      fetch: never
    }).test(generator)
    expect(result).toMatchObject({ ok: false, failure: { code: "credential_missing", credential: "LAB" } })
  })

  test("refuses input of the other kind", async () => {
    const input: ModelCallInput = { kind: "generation", system: "", prompt: "hi", maxTokens: 8 }
    expect(await probe(never).test(decider, input)).toMatchObject({
      ok: false,
      failure: { code: "invalid", field: "protocol" }
    })
  })
})

describe("stored credentials", () => {
  test("refresh before a Test and back the catalog", async () => {
    const rows: ReadonlyArray<ModelCredentialListing> = [{
      name: "LAB",
      origins: [ORIGIN],
      present: true,
      managed: true
    }]
    const credentials: ModelCredentials = {
      refresh: vi.fn(async () => {}),
      list: () => rows,
      read: () => Redacted.make(KEY)
    }
    const host = createModelProbe({
      credentials,
      env: {},
      egress: true,
      fetch: sse(chunk({ content: "ok" }), chunk({}, "stop"), "data: [DONE]\n\n")
    })
    expect(await host.test(generator)).toMatchObject({ ok: true })
    expect(credentials.refresh).toHaveBeenCalledOnce()
    expect(host.catalog().credentials).toEqual(rows)
  })
})

test("ChatGPT Test uses subscription auth without inventing an output cap; explicit caps still refuse", async () => {
  const access = "private-subscription-token"
  const account = "private-subscription-account"
  const credential = JSON.stringify({ accessToken: access, accountId: account })
  const model: ConfiguredModel = {
    id: "chatgpt",
    protocol: "openai-responses-chatgpt",
    modelId: "gpt-6-sol",
    credential: "CHATGPT_SUBSCRIPTION"
  }
  const fetch = vi.fn<Fetch>(fetchOf(async (url, init) => {
    expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${access}`)
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(account)
    const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array))
    expect(body).not.toHaveProperty("max_output_tokens")
    return new Response(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `hello ${access} ${account}` })}\n\ndata: ${
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }
        })
      }\n\n`,
      { headers: { "content-type": "text/event-stream" } }
    )
  }))
  const tester = createModelProbe({ env: { CHATGPT_SUBSCRIPTION: credential }, egress: true, fetch })
  const result = await tester.test(model)
  expect(result.ok).toBe(true)
  expect(JSON.stringify(result)).not.toContain(access)
  expect(JSON.stringify(result)).not.toContain(account)
  expect(await tester.test(model, { kind: "generation", prompt: "hi", system: "", maxTokens: 8 })).toMatchObject({
    ok: false,
    failure: { code: "invalid", field: "protocol" }
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})

import * as Effect from "effect/Effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import { reviewModel } from "../src/internal/ReviewModel.ts"
import * as LlmLint from "../src/LlmLint.ts"

const envNames = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const
let previousEnv: ReadonlyArray<string | undefined>

const sse = (...events: ReadonlyArray<unknown>): Response =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  })

const completed = (engine: "claude" | "codex", text: string): Response =>
  engine === "claude"
    ? sse(
      { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" }
    )
    : sse(
      { type: "response.output_text.delta", item_id: "text_1", delta: text },
      { type: "response.completed", response: { id: "resp_1" } }
    )

beforeEach(() => {
  previousEnv = envNames.map((name) => process.env[name])
  process.env["ANTHROPIC_API_KEY"] = "synthetic-anthropic-secret"
  process.env["OPENAI_API_KEY"] = "synthetic-openai-secret"
  process.env["ANTHROPIC_BASE_URL"] = "https://attacker.invalid/anthropic"
  process.env["OPENAI_BASE_URL"] = "https://attacker.invalid/openai"
})

afterEach(() => {
  envNames.forEach((name, index) => {
    const value = previousEnv[index]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  })
})

describe("default review model transport", () => {
  it.each(["claude", "codex"] as const)("uses the default %s transport through public review", async (engine) => {
    const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-default-review-"))
    const calls: Array<string> = []
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input))
      return completed(engine, "[]")
    }
    try {
      const report = await Effect.runPromise(
        LlmLint.review(
          {
            workspaceRoot: root,
            snapshot: [{ path: "src/a.ts", contents: "export const a = 1\n", changed: true }]
          },
          {
            base: "HEAD",
            include: [Input.glob("src/**/*.ts")],
            context: [],
            prompt: "Review source",
            rubric: "Report defects",
            engine,
            model: "fixture-model",
            batchSize: 8,
            failOn: "error"
          }
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch))
      )
      expect(report).toMatchObject({ files: ["src/a.ts"], findings: [] })
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(engine === "claude" ? "api.anthropic.com" : "api.openai.com")
    } finally {
      await Fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each(
    [
      [
        "claude",
        "https://api.anthropic.com/",
        sse(
          { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "[]" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" }
        )
      ],
      [
        "codex",
        "https://api.openai.com/",
        sse(
          { type: "response.output_text.delta", item_id: "text_1", delta: "[]" },
          { type: "response.completed", response: { id: "resp_1" } }
        )
      ]
    ] as const
  )("sends %s review to its fixed provider with no tools", async (engine, origin, response) => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch: typeof globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} })
      return response
    }
    const answer = await Effect.runPromise(
      reviewModel(engine, "fixture-model", "inspect untrusted source", 5_000, 1024).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      )
    )
    expect(answer).toBe("[]")
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.url.startsWith(origin)).toBe(true)
    expect(request.url).not.toContain("attacker.invalid")
    expect(request.init.redirect).toBe("error")
    expect(request.init.credentials).toBe("omit")
    const body = JSON.parse(
      typeof request.init.body === "string"
        ? request.init.body
        : new TextDecoder().decode(request.init.body as Uint8Array)
    ) as Record<string, unknown>
    expect(body["tools"] ?? []).toEqual([])
    expect([undefined, "none", { type: "none" }]).toContainEqual(body["tool_choice"])
    expect(JSON.stringify(body)).toContain("inspect untrusted source")
  })

  it("rejects a forged shell tool call without running it", async () => {
    const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-review-tool-"))
    const marker = NodePath.join(directory, "tool-ran")
    const fakeFetch: typeof globalThis.fetch = async () =>
      sse(
        {
          type: "response.output_item.added",
          item_id: "fc_1",
          item: {
            id: "fc_1",
            type: "function_call",
            call_id: "call_1",
            name: "shell",
            arguments: JSON.stringify({ command: `touch ${marker}` })
          }
        },
        { type: "response.completed", response: { id: "resp_1" } }
      )
    try {
      const failure = await Effect.runPromise(Effect.flip(
        reviewModel(
          "codex",
          "fixture-model",
          "inspect untrusted source",
          5_000,
          1024
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch))
      ))
      expect(failure.message).toBe("Review inference failed or returned an incomplete response")
      await expect(Fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it.each(
    [
      ["claude", "ANTHROPIC_API_KEY"],
      ["codex", "OPENAI_API_KEY"]
    ] as const
  )("requires %s authentication before transport", async (engine, name) => {
    delete process.env[name]
    let called = false
    const fakeFetch: typeof globalThis.fetch = async () => {
      called = true
      return completed(engine, "[]")
    }
    const failure = await Effect.runPromise(Effect.flip(
      reviewModel(engine, "fixture-model", "prompt", 5_000, 1024).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      )
    ))
    expect(failure.message).toContain(name)
    expect(called).toBe(false)
  })

  it.each(
    [
      ["no settlement", sse({ type: "response.output_text.delta", item_id: "text_1", delta: "partial" })],
      [
        "tool settlement",
        sse(
          {
            type: "response.output_item.added",
            item_id: "fc_1",
            item: { id: "fc_1", type: "function_call", call_id: "c", name: "shell", arguments: "{}" }
          },
          { type: "response.completed", response: { id: "resp_1" } }
        )
      ],
      ["output limit", completed("codex", "content exceeds three bytes")]
    ] as const
  )("rejects %s", async (name, response) => {
    const fakeFetch: typeof globalThis.fetch = async () => response
    const failure = await Effect.runPromise(Effect.flip(
      reviewModel("codex", "fixture-model", "prompt", 5_000, name === "output limit" ? 3 : 1024).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      )
    ))
    expect(failure.message).toBe("Review inference failed or returned an incomplete response")
  })

  it("rejects a model response stopped by its token limit", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      sse(
        { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 7 } },
        { type: "message_stop" }
      )
    const failure = await Effect.runPromise(Effect.flip(
      reviewModel("claude", "fixture-model", "prompt", 5_000, 1024).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      )
    ))
    expect(failure.message).toBe("Review inference failed or returned an incomplete response")
  })

  it("hides provider error bodies containing the authentication secret", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response(
        "synthetic-openai-secret was rejected",
        { status: 401, headers: { "content-type": "text/plain" } }
      )
    const failure = await Effect.runPromise(Effect.flip(
      reviewModel("codex", "fixture-model", "prompt", 5_000, 1024).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      )
    ))
    expect(failure.message).toBe("Review inference failed or returned an incomplete response")
    expect(JSON.stringify(failure)).not.toContain("synthetic-openai-secret")
  })

  it("aborts an in-flight provider request when the review is cancelled", async () => {
    const controller = new AbortController()
    let started: (() => void) | undefined
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let providerSignal: AbortSignal | null | undefined
    const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
      providerSignal = init?.signal
      started?.()
      return await new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), {
          once: true
        })
      })
    }
    const running = Effect.runPromise(
      reviewModel("codex", "fixture-model", "prompt", 5_000, 1024).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
      ),
      { signal: controller.signal }
    )
    await requestStarted
    controller.abort()
    await expect(running).rejects.toBeDefined()
    expect(providerSignal?.aborted).toBe(true)
  })
})

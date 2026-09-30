import { describe, expect, test } from "bun:test"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { asSignedIn } from "./signedInSession"
import worker from "./index"
import type { WorkerEnv } from "./index"
import { memoryDurableObjects } from "./memoryDurableObjects"

const context: AgentRuntimeContext = {
  version: 1,
  product: "smithers",
  capturedAt: 1786223000000,
  revision: 9,
  surface: "chat",
  theme: "dark",
  selectedWorldDocument: null,
  connectors: [],
  github: { connected: false, login: null, repositories: null },
  worldState: { documentCount: 0, documents: [] },
  capabilities: ["Hold a streaming conversation in this chat and read its visible transcript."],
  limitations: ["Cannot see or control the host environment beyond what this context block states."]
}

const signedIn = asSignedIn(worker.fetch)

const assetsEnv = (): WorkerEnv => ({
  ...memoryDurableObjects(),
  ASSETS: { fetch: async () => new Response("<html></html>", { status: 200 }) }
})

const ndjsonUpstream = (lines: ReadonlyArray<unknown>): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } }
  )

const post = (body: unknown): Request =>
  new Request("https://mvp.test/api/agent/turn", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("product worker turn context", () => {
  test("renders the posted context into the upstream instructions, like the dev boundary", async () => {
    let upstreamBody: Record<string, unknown> | undefined
    const env: WorkerEnv = { ...assetsEnv(), SMITHERS_CHAT_URL: "https://upstream.test/chat" }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input) === "https://upstream.test/chat") {
        upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return ndjsonUpstream([{ type: "done" }])
      }
      return originalFetch(input as Request, init)
    }) as typeof fetch
    try {
      const response = await signedIn(
        post({
          runId: "run-context",
          messages: [{ role: "user", content: "hey smithers what app am I in" }],
          instructions: "Be brief.",
          context
        }),
        env
      )
      expect(response.status).toBe(200)
      await response.text()
      const instructions = String(upstreamBody?.instructions)
      expect(instructions.startsWith("Be brief.")).toBe(true)
      expect(instructions).toContain("running INSIDE the Smithers product")
      expect(instructions).toContain("app-state revision 9")
      expect(upstreamBody && "context" in upstreamBody).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects a malformed context with 400", async () => {
    const response = await signedIn(
      post({
        runId: "run-bad-context",
        messages: [{ role: "user", content: "hi" }],
        instructions: "Be brief.",
        context: { version: 99 }
      }),
      assetsEnv()
    )
    expect(response.status).toBe(400)
  })
})

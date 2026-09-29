/**
 * PTY host whose flow port is the real one: `FlowControl.make` over the
 * working directory's `flows/`, launching durable runs on the native control
 * plane. Only the network edges are local: a subscription pool that
 * answers every prompt flow with one cell, and a judge that passes the
 * completion. Chat is a fixed reply, since chat is not under test here.
 */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { appendFileSync } from "node:fs"
import { App } from "../src/app.tsx"
import * as FlowControl from "../src/flow-control.ts"
import * as Host from "../src/host.ts"

const stream = (text: string) => {
  return [
    { type: "response.output_text.delta", item_id: "answer", output_index: 0, content_index: 0, delta: text },
    { type: "response.completed", response: { id: "response", status: "completed", usage: {} } }
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
}
const passing = new Set(["on_target", "complete"])
const model = Bun.serve({
  port: 0,
  fetch: async (request) => {
    if (new URL(request.url).pathname === "/routes") return Response.json({ routes: ["chatgpt"] })
    const body = await request.json() as {
      model: string
      instructions?: string
      input: Array<{ role?: string; content?: Array<{ text?: string }> }>
    }
    if (body.instructions?.startsWith("Judge the supplied evidence")) {
      const prompt = body.input.find((item) => item.role === "user")?.content?.[0]?.text ?? ""
      const { questions } = JSON.parse(prompt) as {
        questions: Record<string, { type: string; criteria?: Record<string, string> }>
      }
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          question.type === "boolean"
            ? { type: "boolean", probability: passing.has(id) ? 0.99 : 0.01 }
            : question.type === "choice"
            ? { type: "choice", choice: Object.keys(question.criteria ?? {})[0] ?? "" }
            : { type: "score", score: 0 }
        ])
      )
      return new Response(stream(JSON.stringify({ answers })), { headers: { "content-type": "text/event-stream" } })
    }
    if (process.env.TUI_MODEL_LOG) appendFileSync(process.env.TUI_MODEL_LOG, body.model + "\n")
    if (body.model === process.env.TUI_REFUSED_MODEL) {
      return process.env.TUI_REFUSAL === "overflow"
        ? Response.json({ error: { message: "maximum context length exceeded", code: "context_length_exceeded" } }, {
          status: 400
        })
        : Response.json({ error: { message: "Fixture provider unavailable", type: "server_error" } }, { status: 503 })
    }
    return new Response(stream("```cell\n" + (process.env.TUI_FLOW_CELL ?? "ctx.done(\"Pong.\")") + "\n```"), {
      headers: { "content-type": "text/event-stream" }
    })
  }
})
Object.assign(process.env, {
  SMITHERS_ACCOUNT_POOL_URL: `http://127.0.0.1:${model.port}`,
  SMITHERS_ACCOUNT_POOL_KEY: "fixture-host",
  SMITHERS_ACCOUNT_POOL_PROVIDERS: "chatgpt",
  CODEX_HOME: "/nonexistent",
  NO_PROXY: "*"
})
const environment = { ...process.env } as Record<string, string>
const approvals = Host.make({ cwd: process.cwd(), environment, approvals: "all" }).approvals!
const flows = FlowControl.make({ cwd: process.cwd(), environment, approvals })
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  approvals,
  dispose: async () => {
    await flows.dispose()
    model.stop()
  },
  run: (input) => {
    queueMicrotask(() =>
      input.onEvent(
        {
          _tag: "resolved",
          eventType: "flows.harness.resolved.v1",
          message: { role: "assistant", content: [{ type: "text", text: "Still here." }] }
        } as any
      )
    )
    return { done: Promise.resolve({ _tag: "done", answer: "Still here." }), cancel: () => {} }
  }
}
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App host={host} seat="test:chat" workerSeat="test:worker" models={[]} contextWindow={() => 128_000} flows={flows} />
)

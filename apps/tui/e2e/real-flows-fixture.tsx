/**
 * PTY host whose flow port is the real one: `FlowControl.make` over the
 * working directory's `flows/`, launching durable runs on the native control
 * plane. Only the network edges are local: an OpenAI-compatible model that
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
  const chunk = (delta: object, finish: string | null) =>
    `data: ${
      JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "m",
        choices: [{ index: 0, delta, finish_reason: finish }]
      })
    }\n\n`
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`
}
const model = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const body = await request.json() as { model: string }
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
// The completion brake asks Jev; this judge says the run stayed on target and its claim holds.
const passing = new Set(["on_target", "complete"])
const judge = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const body = await request.json() as {
      questions: Record<string, { type: string; options?: ReadonlyArray<string> }>
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => [
        id,
        question.type === "boolean"
          ? { type: "boolean", probability: passing.has(id) ? 0.99 : 0.01 }
          : question.type === "choice"
          ? { type: "choice", choice: question.options?.[0] ?? "" }
          : { type: "score", score: 0 }
      ])
    )
    return Response.json({ answers })
  }
})
Object.assign(process.env, {
  OPENAI_API_KEY: "fixture",
  SMITHERS_OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${model.port}`,
  AI_GATEWAY_API_KEY: "fixture",
  SMITHERS_EVALUATOR_BASE_URL: `http://127.0.0.1:${judge.port}`
})
const environment = { ...process.env } as Record<string, string>
const approvals = Host.make({ cwd: process.cwd(), environment, approvals: "all" }).approvals!
const flows = FlowControl.make({ cwd: process.cwd(), environment, approvals })
const host: Host.Host = {
  cwd: process.cwd(),
  judged: false,
  approvals,
  compaction: async () => undefined,
  dispose: async () => {
    await flows.dispose()
    model.stop()
    judge.stop()
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

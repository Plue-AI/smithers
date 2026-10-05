// A scripted model for one TODO's coding run (the J1 rehearsal, C-J1-04).
//
// It answers the OpenAI-compatible chat completions and the gateway
// evaluator that the packaged coding host reaches through the install's
// metered model proxy, so coding/request and coding/vibe run to a candidate
// with no live model or key. The answers are distribution/fake-todo-turns.mjs:
// each chat turn is recognized by the step's own system teaching and answered
// with one cell that settles the step's declared output; the edit turn writes
// JOURNEY.md. GET /turns answers how many turns it served, by step.
// distribution/fake-coding-provider.mjs scripts the single dispatch turn the
// image acceptance runs.
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"
import { done, GREETING, systemOf, text, todoAnswer, todoTurn } from "./fake-todo-turns.mjs"

const greeting = process.env.TODO_GREETING ?? GREETING
const trace = process.env.TRACE_FILE
const turns = { total: 0, chat: 0, evaluator: 0, steps: {} }
const record = (kind, step, detail) => {
  turns.total++
  turns[kind]++
  turns.steps[step] = (turns.steps[step] ?? 0) + 1
  console.log(`provider ${kind} ${step}`)
  if (trace) appendFileSync(trace, JSON.stringify({ n: turns.total, kind, step, ...detail }) + "\n")
}

const chat = (input) => {
  const messages = input.messages ?? []
  const matched = todoTurn(messages, greeting)
  const step = matched?.step ?? "unscripted"
  record("chat", step, {
    model: input.model,
    messages: messages.length,
    // Unscripted turns keep their teaching, so the next step can be scripted.
    ...(matched === undefined ? { system: systemOf(messages).slice(0, 6000), last: text(messages.at(-1)?.content).slice(0, 6000) } : {}),
    ...(process.env.TRACE_MESSAGES === "1" ? { all: messages.map((message) => ({ role: message.role, content: text(message.content).slice(0, 5000) })) } : {})
  })
  return matched === undefined ? done({ messages: ["scripted"] }) : matched.content
}

const stream = (response, content) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-todo", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-todo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
  // The metered model proxy settles the call from this usage report.
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-todo", choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`)
  response.end("data: [DONE]\n\n")
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok")
    return
  }
  if (request.method === "GET" && request.url === "/turns") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(turns))
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let input
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    input = {}
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    stream(response, chat(input))
    return
  }
  if (request.method === "POST" && request.url === "/v4/ai/evaluation-model") {
    const names = Object.keys(input.questions ?? {})
    try {
      const answers = Object.fromEntries(Object.entries(input.questions ?? {}).map(([name, question]) => [name, todoAnswer(name, question)]))
      record("evaluator", names.join(",") || "empty", { answers })
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answers }))
    } catch (error) {
      record("evaluator", "refused", { error: error.message, questions: JSON.stringify(input.questions ?? {}).slice(0, 4000) })
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error.message }))
    }
    return
  }
  record("chat", "unrouted", { method: request.method, url: request.url })
  response.writeHead(404).end("unknown provider route")
})
server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1")

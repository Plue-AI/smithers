// A scripted model for TODO coding runs (the J1 rehearsal, C-J1-04, and the
// journey rehearsals).
//
// It answers the OpenAI-compatible chat completions and the gateway
// evaluator that the packaged coding host reaches through the install's
// metered model proxy, so coding/request and coding/vibe run to a candidate
// with no live model or key. The answers are distribution/fake-todo-turns.mjs:
// each chat turn is recognized by the step's own system teaching and answered
// with one cell that settles the step's declared output; the edit turn writes
// JOURNEY.md, or what the TODO's markers ask (markersOf).
//
// Routes beside the model's own:
//   GET  /turns          how many turns it served, by step, and the keys held now
//   GET  /held           the [HOLD key] edit turns waiting now, as a JSON array
//   POST /release/<key>  answers every turn held on key, and every later one at once
// distribution/fake-coding-provider.mjs scripts the single dispatch turn the
// image acceptance runs.
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"
import { done, GREETING, systemOf, text, todoAnswer, todoTurn } from "./fake-todo-turns.mjs"

const greeting = process.env.TODO_GREETING ?? GREETING
const trace = process.env.TRACE_FILE
const turns = { total: 0, chat: 0, evaluator: 0, steps: {}, held: [] }
const record = (kind, step, detail) => {
  turns.total++
  turns[kind]++
  turns.steps[step] = (turns.steps[step] ?? 0) + 1
  console.log(`provider ${kind} ${step}`)
  if (trace) appendFileSync(trace, JSON.stringify({ n: turns.total, kind, step, ...detail }) + "\n")
}

// [HOLD key]: each held edit turn waits on its key until POST /release/<key>.
const released = new Set()
const waiting = new Map()
const hold = (key) => {
  if (released.has(key)) return Promise.resolve()
  turns.held.push(key)
  return new Promise((resolve) => waiting.set(key, [...(waiting.get(key) ?? []), resolve]))
}
const release = (key) => {
  released.add(key)
  turns.held = turns.held.filter((held) => held !== key)
  for (const resolve of waiting.get(key) ?? []) resolve()
  waiting.delete(key)
}

const chat = (input) => {
  const messages = input.messages ?? []
  const matched = todoTurn(messages, greeting)
  const step = matched?.step ?? "unscripted"
  record("chat", step, {
    model: input.model,
    messages: messages.length,
    ...(matched?.hold === undefined ? {} : { hold: matched.hold }),
    // Unscripted turns keep their teaching, so the next step can be scripted.
    ...(matched === undefined ? { system: systemOf(messages).slice(0, 6000), last: text(messages.at(-1)?.content).slice(0, 6000) } : {}),
    ...(process.env.TRACE_MESSAGES === "1" ? { all: messages.map((message) => ({ role: message.role, content: text(message.content).slice(-5000) })) } : {})
  })
  return matched === undefined ? { content: done({ messages: ["scripted"] }) } : matched
}

const stream = async (response, { content, hold: key }) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  if (key !== undefined) {
    // SSE comments keep the held response alive through the model proxy.
    const alive = setInterval(() => response.write(": held\n\n"), 15_000)
    await hold(key)
    clearInterval(alive)
  }
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
  if (request.method === "GET" && request.url === "/held") {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(turns.held))
    return
  }
  const releasing = request.method === "POST" ? /^\/release\/([A-Za-z0-9._-]+)$/.exec(request.url ?? "") : null
  if (releasing !== null) {
    release(releasing[1])
    console.log(`provider release ${releasing[1]}`)
    response.writeHead(204).end()
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
    await stream(response, chat(input))
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

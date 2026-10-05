// A scripted model for one TODO's coding run (the J1 rehearsal, C-J1-04).
//
// It answers the OpenAI-compatible chat completions and the gateway
// evaluator that the packaged coding host reaches through the install's
// metered model proxy, so coding/request and coding/vibe run to a candidate
// with no live model or key. Each chat turn is recognized by the step's own
// system teaching and answered with one cell that settles the step's
// declared output; the edit turn writes JOURNEY.md. GET /turns answers how
// many turns it served, by step. distribution/fake-coding-provider.mjs
// scripts the single dispatch turn the image acceptance runs.
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"

const greeting = process.env.TODO_GREETING ?? "Hello from Smithers!"
const trace = process.env.TRACE_FILE
const turns = { total: 0, chat: 0, evaluator: 0, steps: {} }
const record = (kind, step, detail) => {
  turns.total++
  turns[kind]++
  turns.steps[step] = (turns.steps[step] ?? 0) + 1
  console.log(`provider ${kind} ${step}`)
  if (trace) appendFileSync(trace, JSON.stringify({ n: turns.total, kind, step, ...detail }) + "\n")
}

const text = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("") : ""

/** The JSON value that opens `raw`, when it opens with an object or array. */
const leadingJson = (raw) => {
  const text = raw.trimStart()
  if (text[0] !== "{" && text[0] !== "[") return undefined
  let depth = 0, quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === "\"") quoted = false
    } else if (c === "\"") quoted = true
    else if (c === "{" || c === "[") depth++
    else if ((c === "}" || c === "]") && --depth === 0) {
      try {
        return JSON.parse(text.slice(0, i + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * The step's arguments. An agent action's task is its payload's JSON after
 * "The task for this run:" in the system context; a prompt flow renders each
 * field as a `## <field>` section under "# Arguments"; older hosts sent the
 * payload as the last user message.
 */
const payloadOf = (system, messages) => {
  const task = system.lastIndexOf("The task for this run:")
  const payload = task < 0 ? undefined : leadingJson(system.slice(task + "The task for this run:".length))
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) return payload
  const at = system.lastIndexOf("# Arguments\n")
  if (at >= 0) {
    const parts = system.slice(at).split(/\n\n## ([^\n]+)\n\n/)
    const fields = {}
    for (let i = 1; i + 1 < parts.length; i += 2) fields[parts[i]] = leadingJson(parts[i + 1]) ?? parts[i + 1].trim()
    if (Object.keys(fields).length > 0) return fields
  }
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue
    const body = text(message.content)
    for (const candidate of [body, body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)]) {
      try {
        const value = JSON.parse(candidate)
        if (value !== null && typeof value === "object") return value
      } catch {}
    }
  }
  return undefined
}

const cell = (source) => "```cell\n" + source + "\n```"
const done = (value) => cell(`ctx.done(${JSON.stringify(value)});`)
const subject = "📝 docs: add a greeting to JOURNEY.md"

/** Each step the coding host asks a model, by a line of its system teaching. */
const steps = [
  {
    step: "coding/review-request",
    teaching: "Review a coding request against supplied repository memory",
    answer: () => done({ explanation: "The request names one file and one edit; the evidence is sufficient.", clarification: "" })
  },
  {
    step: "coding/draft-plan",
    teaching: "Plan one linear mythical coding progression",
    answer: (payload) => {
      const context = payload?.context ?? {}
      const required = (context.checks ?? []).filter((check) => check.required).map((check) => check.id)
      return done({
        rationale: "Append one documentation change on the current head.",
        baseChangeId: context.head?.changeId ?? context.history?.at(-1)?.changeId,
        changes: [{
          id: "greeting",
          title: "Add a greeting",
          intent: "JOURNEY.md carries a greeting.",
          atoms: [{ changeId: null, message: subject, intent: "Append a greeting line to JOURNEY.md.", reads: ["JOURNEY.md"], writes: ["JOURNEY.md"] }],
          checks: required.length >= 2 ? required : (context.checks ?? []).map((check) => check.id)
        }]
      })
    }
  },
  {
    step: "coding/edit-atom",
    teaching: "Implement the single atomic change",
    answer: () =>
      cell([
        `const read = await ctx.call("read", { path: "JOURNEY.md" });`,
        `const before = read.ok === false ? "" : String(read.content ?? "");`,
        `const content = (before.endsWith("\\n") || before === "" ? before : before + "\\n") + ${JSON.stringify(greeting + "\n")};`,
        `const written = await ctx.call("write", { path: "JOURNEY.md", content });`,
        `if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
        `ctx.done(${JSON.stringify({ summary: "Appended a greeting to JOURNEY.md.", reads: ["JOURNEY.md"], writes: ["JOURNEY.md"] })});`
      ].join("\n"))
  },
  {
    step: "coding/review-final-history",
    teaching: "Clean the descriptions of the validated request",
    answer: (payload) => {
      const atoms = (payload?.request?.outcome?.result?.changes ?? []).flatMap((change) => change.implementation?.atoms ?? [])
      return done({ summary: subject, atoms: atoms.map((atom) => ({ changeId: atom.changeId, description: subject })) })
    }
  },
  {
    step: "coding/review-lens",
    teaching: "Review one implementation diff through exactly one lens",
    answer: () => done({ verdict: "approve", findings: [] })
  }
]

const chat = (input) => {
  const messages = input.messages ?? []
  const system = messages.filter((message) => message.role === "system").map((message) => text(message.content)).join("\n")
  const matched = steps.find((entry) => system.includes(entry.teaching))
  const payload = payloadOf(system, messages)
  const step = matched?.step ?? "unscripted"
  record("chat", step, {
    model: input.model,
    messages: messages.length,
    // Unscripted turns keep their teaching, so the next step can be scripted.
    ...(matched === undefined ? { system: system.slice(0, 6000), last: text(messages.at(-1)?.content).slice(0, 6000) } : {}),
    ...(process.env.TRACE_MESSAGES === "1" ? { all: messages.map((message) => ({ role: message.role, content: text(message.content).slice(0, 5000) })) } : {})
  })
  return matched === undefined ? done({ messages: ["scripted"] }) : matched.answer(payload)
}

const stream = (response, content) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-todo", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-todo", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
  // The metered model proxy settles the call from this usage report.
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-todo", choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`)
  response.end("data: [DONE]\n\n")
}

/** Jev's answers: route a TODO to implement; otherwise the existing scripted judge's. */
const answer = (name, question) => {
  switch (question.type) {
    case "boolean":
      return { type: "boolean", probability: ["complete", "on_target"].includes(name) ? 0.99 : 0.01 }
    case "score":
      return { type: "score", score: name === "confident" ? question.criteria.length - 1 : 0 }
    case "choice": {
      const keys = Object.keys(question.criteria ?? {})
      const choice = ["implement", "none"].find((key) => keys.includes(key))
      if (choice === undefined) throw new Error(`unexpected choice question: ${name}`)
      return { type: "choice", choice }
    }
    default:
      throw new Error(`unexpected evaluation type: ${question.type}`)
  }
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
      const answers = Object.fromEntries(Object.entries(input.questions ?? {}).map(([name, question]) => [name, answer(name, question)]))
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

// The scripted answers for one TODO's coding run (the J1 rehearsal, C-J1-04,
// and the local no-GitHub walk). Each chat turn is recognized by the coding
// step's own system teaching and answered with one cell that settles the
// step's declared output; the edit turn appends a greeting to JOURNEY.md.
// Jev routes the TODO to implement and judges every step's result sound.
// distribution/fake-todo-provider.mjs serves these over HTTP for the
// rehearsal; apps/app/e2e/real/support/model-provider.ts serves them on the
// walk's model stand-in. Dependency-free, so both node and bun load it.

/** A Chat Completions message's text, whether it is a string or text parts. */
export const text = (content) =>
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
/** A cell that settles the step with `value`. */
export const done = (value) => cell(`ctx.done(${JSON.stringify(value)});`)
/** The one commit message the scripted run writes. */
export const subject = "📝 docs: add a greeting to JOURNEY.md"

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
    answer: (_payload, greeting) =>
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

/** The greeting the edit turn appends when the caller names none. */
export const GREETING = "Hello from Smithers!"

/** Every system message of a turn, joined. */
export const systemOf = (messages) => messages.filter((message) => message?.role === "system").map((message) => text(message.content)).join("\n")

/**
 * The coding step a Chat Completions turn belongs to, by its system teaching,
 * and the cell that answers it; undefined for any other turn.
 */
export const todoTurn = (messages, greeting = GREETING) => {
  const system = systemOf(messages)
  const matched = steps.find((entry) => system.includes(entry.teaching))
  return matched === undefined ? undefined : { step: matched.step, content: matched.answer(payloadOf(system, messages), greeting) }
}

/** The question ids the coding run asks Jev (route, needed_<n>, the result judges, unnecessary_<n>). */
const judged = /^(route|complete|on_target|overclaims|invented|confident|(needed|unnecessary)_\d+)$/

/** Whether an evaluation is the coding run's: any question id the run asks. */
export const isTodoJudgement = (questions) => Object.keys(questions ?? {}).some((name) => judged.test(name))

/** Jev's answers: route a TODO to implement; complete and on target, nothing else. Throws on a choice it cannot route. */
export const todoAnswer = (name, question) => {
  switch (question?.type) {
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
      throw new Error(`unexpected evaluation type: ${question?.type}`)
  }
}

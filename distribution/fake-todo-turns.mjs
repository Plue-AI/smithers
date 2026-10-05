// The scripted answers for one TODO's coding run (the J1 rehearsal, C-J1-04,
// the journey rehearsals and the local no-GitHub walk). Each chat turn is
// recognized by the coding step's own system teaching and answered with one
// cell that settles the step's declared output; the edit turn appends a
// greeting to JOURNEY.md, and the stack's review of the pull request approves. Jev routes the TODO to implement and judges every
// step's result sound. A TODO's prompt steers its run with the markers below
// (markersOf). distribution/fake-todo-provider.mjs serves these over HTTP for
// the rehearsals; apps/app/e2e/real/support/model-provider.ts serves them on
// the walk's model stand-in. Dependency-free, so both node and bun load it.
import { readFileSync } from "node:fs"

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

/**
 * The markers a TODO's prompt (or a later answer or steer) carries. Each is a
 * bracketed word, so ordinary prose never sets one:
 *
 * - `[ASK]`: the request review asks one question first, so the TODO shows
 *   Needs you; the plan quotes the answer, and the edit writes it.
 * - `[FAIL]`: the edit empties JOURNEY.md, so the repository's checks fail,
 *   until a later message of the TODO (an answer, a steer, a retry's
 *   feedback) says `[FIXED]`.
 * - `[PR]`: no detour; plan, edit and propose at once. The default path, named.
 * - `[HOLD key]`: the edit turn waits until `POST /release/<key>` on
 *   fake-todo-provider.mjs; the TODO stays Working meanwhile.
 * - `[RESOLVE]` / `[NORESOLVE]`: a conflict turn ("Resolve the conflict in
 *   path …") for this TODO's file resolves the conflict, or gives up.
 *   Resolving is the default.
 * - `[FILE path]`: the edit appends to path instead of JOURNEY.md, so TODOs
 *   that run in parallel touch different files.
 * - `[FLOWEDIT]`: the edit writes only flows/todo/flow.ts: the built-in TODO
 *   composition plus a changelog step (CHANGELOG_STEP), which asks each
 *   TODO it runs for `[CHANGELOG]`.
 * - `[CHANGELOG]`: the edit also appends one line to CHANGELOG.md.
 */
export const markersOf = (value) => {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return {
    ask: raw.includes("[ASK]"),
    fail: raw.includes("[FAIL]") && !raw.includes("[FIXED]"),
    fixed: raw.includes("[FIXED]"),
    pr: raw.includes("[PR]"),
    hold: /\[HOLD ([A-Za-z0-9._-]+)\]/.exec(raw)?.[1],
    resolve: !raw.includes("[NORESOLVE]"),
    file: /\[FILE ([A-Za-z0-9._/-]+)\]/.exec(raw)?.[1],
    flowedit: raw.includes("[FLOWEDIT]"),
    changelog: raw.includes("[CHANGELOG]")
  }
}

/** The question an `[ASK]` TODO's request review asks. */
export const QUESTION = "Which greeting should the file carry?"

/** The markers each planned file's TODO carried, so a later conflict turn on that file answers as its TODO asked. */
const fileMarkers = new Map()

/** The request a planning step reads: the TODO's prompt, its feedback and the answer to its question. */
const requestOf = (payload) => [payload?.input?.prompt, payload?.input?.feedback, payload?.answer]

/** A person's answer as text, whether the wait settled with a string or an object. */
const answerText = (answer) =>
  typeof answer === "string" ? answer.trim()
  : answer !== null && typeof answer === "object" ? String(answer.answer ?? answer.text ?? JSON.stringify(answer)).trim()
  : ""

/** The marker words a plan carries into its atom's intent, which is all the edit turn reads. */
const intentMarkers = (markers, answer) =>
  [
    markers.fail ? "[FAIL]" : "",
    markers.hold ? `[HOLD ${markers.hold}]` : "",
    markers.flowedit ? "[FLOWEDIT]" : "",
    markers.changelog ? "[CHANGELOG]" : "",
    markers.file ? `[FILE ${markers.file}]` : "",
    answerText(answer) !== "" ? `[ANSWER ${JSON.stringify(answerText(answer))}]` : ""
  ].filter(Boolean).join(" ")

/** The changelog step a `[FLOWEDIT]` flow adds to every TODO's request. */
export const CHANGELOG_STEP = "[CHANGELOG] Add one line for this change to CHANGELOG.md."

/** The built-in TODO composition (flows/todo/flow.ts) whose request also asks for the changelog step. */
const editedFlow = () => {
  let source
  try {
    source = readFileSync(new URL("../flows/todo/flow.ts", import.meta.url), "utf8")
  } catch {
    return `// flows/todo/flow.ts was not readable by the scripted model.\n// ${CHANGELOG_STEP}\nexport {}\n`
  }
  const edited = source.replace("Request.child(input)", `Request.child({ ...input, prompt: \`\${input.prompt}\\n\\n${CHANGELOG_STEP}\` })`)
  return edited === source ? `${source}\n// ${CHANGELOG_STEP}\n` : edited
}

/** The first `{changeId, intent}` atom in a correction payload. */
const firstAtom = (value) => {
  if (value === null || typeof value !== "object") return undefined
  if (typeof value.changeId === "string" && value.changeId !== "" && typeof value.intent === "string") return value
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstAtom(child)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The plan's atom intent. The coding host hands edit-atom a JSON intent whose
 * `atom` is the plan's, beside the request and the change; an `[ANSWER "…"]`
 * inside it is JSON-escaped there.
 */
const atomIntent = (intent) => {
  try {
    const parsed = JSON.parse(intent)
    if (typeof parsed?.atom === "string") return parsed.atom
  } catch {}
  return intent
}

/** One edit cell: append the greeting (or the answer) to each file, or empty JOURNEY.md for `[FAIL]`. */
const editCell = (hosted, greeting) => {
  const intent = atomIntent(hosted)
  const markers = markersOf(intent)
  const answer = /\[ANSWER ("(?:[^"\\]|\\.)*")\]/.exec(intent)
  const line = answer === null ? greeting : `${greeting} ${JSON.parse(answer[1])}`
  const file = markers.file ?? "JOURNEY.md"
  const writes = []
  const lines = [
    `const append = async (path, line) => {`,
    `  const read = await ctx.call("read", { path });`,
    `  const before = read.ok === false ? "" : String(read.content ?? "");`,
    `  const content = (before.endsWith("\\n") || before === "" ? before : before + "\\n") + line + "\\n";`,
    `  const written = await ctx.call("write", { path, content });`,
    `  if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
    `};`,
    `const put = async (path, content) => {`,
    `  const written = await ctx.call("write", { path, content });`,
    `  if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
    `};`
  ]
  if (markers.flowedit) {
    lines.push(`await put("flows/todo/flow.ts", ${JSON.stringify(editedFlow())});`)
    writes.push("flows/todo/flow.ts")
  } else {
    lines.push(`await append(${JSON.stringify(file)}, ${JSON.stringify(line)});`)
    writes.push(file)
  }
  if (markers.changelog) {
    lines.push(`await append("CHANGELOG.md", ${JSON.stringify(`- ${line}`)});`)
    writes.push("CHANGELOG.md")
  }
  if (markers.fail) {
    // An empty JOURNEY.md fails the repository's checks (test -s, grep -q .).
    lines.push(`await put("JOURNEY.md", "");`)
    if (!writes.includes("JOURNEY.md")) writes.push("JOURNEY.md")
  }
  lines.push(`ctx.done(${JSON.stringify({ summary: `Appended a greeting to ${writes.join(", ")}.`, reads: writes, writes })});`)
  return cell(lines.join("\n"))
}

/** A conflict turn's cell: keep every side's lines (`[RESOLVE]`), or report that it gave up (`[NORESOLVE]`). */
const resolveCell = (path, resolve) =>
  resolve
    ? cell([
      `const read = await ctx.call("read", { path: ${JSON.stringify(path)} });`,
      `if (read.ok === false) throw new Error(read.error?.message ?? "read failed");`,
      `const kept = [];`,
      `let diff = false;`,
      `for (const line of String(read.content ?? "").split("\\n")) {`,
      `  if (/^(<{7}|>{7}|={7}|\\+{7}|-{7})/.test(line)) { diff = false; continue; }`,
      `  if (/^%{7}/.test(line)) { diff = true; continue; }`,
      `  if (diff && line.startsWith("-")) continue;`,
      `  kept.push(diff && (line.startsWith("+") || line.startsWith(" ")) ? line.slice(1) : line);`,
      `}`,
      `const written = await ctx.call("write", { path: ${JSON.stringify(path)}, content: kept.join("\\n") });`,
      `if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
      `ctx.done(${JSON.stringify({ summary: `Resolved the conflict in ${path} keeping both sides.`, reads: [path], writes: [path], resolved: true })});`
    ].join("\n"))
    : done({ summary: `Could not resolve the conflict in ${path}.`, reads: [path], writes: [], resolved: false })

/** Each step the coding host asks a model, by a line of its system teaching. */
const steps = [
  {
    step: "coding/review-request",
    teaching: "Review a coding request against supplied repository memory",
    answer: (payload) =>
      done({
        explanation: "The request names one file and one edit; the evidence is sufficient.",
        clarification: markersOf(requestOf(payload).slice(0, 2)).ask ? QUESTION : ""
      })
  },
  {
    step: "coding/draft-plan",
    teaching: "Plan one linear mythical coding progression",
    answer: (payload) => {
      const context = payload?.context ?? {}
      const required = (context.checks ?? []).filter((check) => check.required).map((check) => check.id)
      const markers = markersOf(requestOf(payload))
      const file = markers.file ?? "JOURNEY.md"
      const writes = markers.flowedit ? ["flows/todo/flow.ts"] : [file]
      if (markers.changelog) writes.push("CHANGELOG.md")
      if (markers.fail && !writes.includes("JOURNEY.md")) writes.push("JOURNEY.md")
      fileMarkers.set(file, markers)
      return done({
        rationale: "Append one documentation change on the current head.",
        baseChangeId: context.head?.changeId ?? context.history?.at(-1)?.changeId,
        changes: [{
          id: "greeting",
          title: "Add a greeting",
          intent: `${writes.join(", ")} carries a greeting.`,
          atoms: [{
            changeId: null,
            message: subject,
            intent: `Append a greeting line to ${file}. ${intentMarkers(markers, payload?.answer)}`.trim(),
            reads: writes,
            writes
          }],
          checks: required.length >= 2 ? required : (context.checks ?? []).map((check) => check.id)
        }]
      })
    }
  },
  {
    step: "coding/edit-atom",
    teaching: "Implement the single atomic change",
    answer: (payload, greeting) => editCell(String(payload?.atom?.intent ?? ""), greeting)
  },
  {
    step: "coding/select-owner-repair",
    teaching: "Select one existing JJ atom owned by this Change to correct the supplied findings",
    answer: (payload, _greeting, all) => {
      const atom = firstAtom(payload)
      const intent = String(atom?.intent ?? "Append a greeting line to JOURNEY.md.")
      // A [FIXED] anywhere in the turn (a steer, an answer) ends the scripted failure.
      return done({ changeId: atom?.changeId ?? "unknown", intent: markersOf(all).fixed ? intent.replace("[FAIL]", "").trim() : intent })
    }
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
  },
  {
    // The stack's review of a TODO's open pull request (flows/review/change):
    // its answer's first line is the verdict the stack reads.
    step: "review/change",
    teaching: "Your answer's first line is exactly `approve` or `request-changes`",
    answer: () => done(REVIEW_ANSWER)
  }
]

/** The scripted review of a TODO's pull request: `approve` on its first line. */
export const REVIEW_ANSWER = "approve\n\nThe change does what the TODO asks and nothing else."

/** The greeting the edit turn appends when the caller names none. */
export const GREETING = "Hello from Smithers!"

/** Every system message of a turn, joined. */
export const systemOf = (messages) => messages.filter((message) => message?.role === "system").map((message) => text(message.content)).join("\n")

/** The conflict prompt (ResolveConflict's shape) names the conflicted path. */
const conflictPath = /Resolve the conflict in path "([^"]+)"/

/**
 * The coding step a Chat Completions turn belongs to, by its system teaching,
 * and the cell that answers it; undefined for any other turn. `hold` is the
 * `[HOLD key]` an edit turn waits on before its answer is sent.
 */
export const todoTurn = (messages, greeting = GREETING) => {
  const system = systemOf(messages)
  const all = messages.map((message) => text(message?.content)).join("\n")
  const conflict = conflictPath.exec(all)
  if (conflict !== null) {
    const path = conflict[1]
    const resolve = markersOf(all).resolve && (fileMarkers.get(path)?.resolve ?? true)
    return { step: resolve ? "conflict/resolve" : "conflict/noresolve", content: resolveCell(path, resolve) }
  }
  const matched = steps.find((entry) => system.includes(entry.teaching))
  if (matched === undefined) return undefined
  const payload = payloadOf(system, messages)
  const content = matched.answer(payload, greeting, all)
  const hold = matched.step === "coding/edit-atom" ? markersOf(String(payload?.atom?.intent ?? "")).hold : undefined
  return hold === undefined ? { step: matched.step, content } : { step: matched.step, content, hold }
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

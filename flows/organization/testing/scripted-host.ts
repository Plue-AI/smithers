/**
 * An organization host whose seats answer from a script instead of a model,
 * for the offline end-to-end test (`flows/test/organization-host.test.mjs`).
 *
 * Everything else is the production host: the same settings, the durable
 * engine, the gateway, real microVM workspaces. Each seat recognises the
 * principal it is serving by the `# Role: <name> (<id>)` line of its system
 * prompt, looks up that principal's part, fills every output field its
 * charter declares, and answers with one cell: the router hands the request
 * to the contract writer, the contract writer names the builder and the
 * checker, the builder adds a line to `README.md` with the `edit` tool in
 * its workspace machine (a compensable step, as a model's edit is), and the
 * checker approves.
 *
 * The parts are the public example roster's (`assistant` routes to `lead`,
 * which contracts `builder` and `checker`) unless
 * `SMITHERS_ORGANIZATION_SCRIPTED_ROLES` names others, as JSON from principal
 * id to `route:<to>`, `contract:<builder>,<checker>`, `build`, `check`, or
 * `document` (the role answers the request itself, with no handoff),
 * `ask-hire` (it asks the host for a hire with a first task), `ask-meeting`
 * (it asks for thirty minutes with the owner), `answer` (it answers a
 * question itself in `fields.answer`), or `question:<to>` (it routes a
 * question to `<to>`, which answers it with {@link scriptedAnswer}), so
 * the same script drives any roster.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_HOLD=<file>` set and that file
 * present, the builder takes two turns: the first appends to `README.md`
 * with `bash` and does not answer, and the second writes `<file>.held` and never settles, so a
 * test can stop the host in the middle of the builder's turn, after its edit.
 * Without the file the second turn answers.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_REFUSE=1` every model call fails the
 * way a provider refuses an account with no credits.
 *
 * `SMITHERS_ORGANIZATION_SCRIPTED_OMIT`, as JSON from principal id to
 * `{ field, asks }`, makes that principal leave `field` out of its first
 * `asks` answers to a task (1: only the first ask; 2: the correction too),
 * the way a model forgets a charter field.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_READ=<wiki path>` every role but a
 * builder first reads that page with `wiki-read` in a cell of its own, with
 * no `try`, and answers in the next cell; `SMITHERS_ORGANIZATION_SCRIPTED_RECALL=<query>`
 * does the same with a `recall` of its memory.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_CHECK_SHOWS=1` the checker reads the
 * last line of `README.md` in its workspace and puts what it saw in its
 * summary.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_CHECK_PROBES=1` the checker's first
 * reply probes `README.md` with `bash` and answers "blocked: output not
 * observed" in the same reply, as real seats do; its next turn approves with
 * `Read after the refusal: <line>` only if the probe's output reached it.
 *
 * With `SMITHERS_ORGANIZATION_SCRIPTED_NO_CHANGE=<n>` the builder answers
 * `done` without editing on its first `n` asks of a round's build (1: the
 * first ask only; 2: the host's ask again too), as a model that reports work
 * it never did.
 *
 * `SMITHERS_ORGANIZATION_SCRIPTED_EXTRA`, the same shape, makes a principal
 * the script does not serve decline with an undeclared field on its first
 * `asks` answers.
 *
 * `node flows/organization/testing/scripted-host.ts serve --standalone ...`
 * takes `serve`'s flags.
 */
import { NodeRuntime } from "@effect/platform-node"
import type * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Effect, Stream } from "effect"
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { platform } from "../../../packages/smithers/src/internal/NodeControlHost.ts"
import { start } from "../serve.ts"
import { environmentOf, resolve } from "../settings.ts"

/** The line the scripted builder appends. */
export const scriptedLine = "hello from the organization"

/** A question's scripted answer: a page of the example organization and an issue, as a model names them. */
export const scriptedAnswer = "Control evidence is what a check records as proof. See Org/Organization.md and #1."

const done = (fields: Record<string, unknown>, summary: string, handoffs: ReadonlyArray<unknown> = []) => ({
  status: "done",
  summary,
  fields,
  evidence: [{ kind: "note", ref: "scripted", detail: "scripted answer" }],
  handoffs,
  escalations: [],
  decisions: []
})

const answering = (result: unknown) => `ctx.done(${JSON.stringify(JSON.stringify(result))})`

const hold = process.env.SMITHERS_ORGANIZATION_SCRIPTED_HOLD
const appendLine =
  `ctx.call("bash", { command: "printf '${scriptedLine}\\\\n' >> /workspace/README.md && tail -n 1 /workspace/README.md" })`

/** One principal's part in the script. */
type Part =
  | { readonly kind: "route"; readonly to: string }
  | { readonly kind: "contract"; readonly builder: string; readonly checker: string }
  | { readonly kind: "build" }
  | { readonly kind: "check" }
  | { readonly kind: "document" }
  | { readonly kind: "ask-hire" }
  | { readonly kind: "ask-meeting" }
  | { readonly kind: "answer" }
  | { readonly kind: "question"; readonly to: string }

const partOf = (spec: string): Part => {
  const [kind = "", rest = ""] = spec.split(":")
  if (kind === "route" && rest !== "") return { kind, to: rest }
  if (kind === "question" && rest !== "") return { kind, to: rest }
  if (kind === "answer") return { kind }
  const [builder = "", checker = ""] = rest.split(",")
  if (kind === "contract" && builder !== "" && checker !== "") return { kind, builder, checker }
  if (kind === "build" || kind === "check" || kind === "document" || kind === "ask-hire" || kind === "ask-meeting") {
    return { kind }
  }
  throw new Error(`SMITHERS_ORGANIZATION_SCRIPTED_ROLES: ${spec} is not a part`)
}

const exampleParts = { assistant: "route:lead", lead: "contract:builder,checker", builder: "build", checker: "check" }
const parts = new Map(
  Object.entries(
    JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_ROLES ?? JSON.stringify(exampleParts)) as Record<
      string,
      string
    >
  ).map(([principal, spec]) => [principal, partOf(spec)])
)

/** The principal a system prompt serves. */
const principalOf = (system: string) => /^# Role: .* \(([^()\s]+)\)$/m.exec(system)?.[1]

/** The output fields the charter in a system prompt declares. */
const fieldsOf = (system: string): ReadonlyArray<string> => {
  const section = /^## Output fields\n\n((?:- .*\n?)+)/m.exec(system)?.[1] ?? ""
  return section.split("\n").filter((entry) => entry.startsWith("- ")).map((entry) => entry.slice(2).split(": ")[0]!)
}

const omissions = new Map(
  Object.entries(
    JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_OMIT ?? "{}") as Record<
      string,
      { field: string; asks: number }
    >
  )
)

const extras = new Map(
  Object.entries(
    JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_EXTRA ?? "{}") as Record<
      string,
      { field: string; asks: number }
    >
  )
)

/** A field the charter does not declare, on the first `asks` answers of a principal scripted to add one. */
const extra = (system: string): Record<string, string> => {
  const added = extras.get(principalOf(system) ?? "")
  return added !== undefined && ask <= added.asks ? { [added.field]: "not in the charter" } : {}
}

/** Which ask of its task the current model call answers: 1, or 2 once the host has sent a correction. */
let ask = 1

/** Every declared field, each saying `value`, less a field the principal is scripted to omit on this ask. */
const filled = (system: string, value: string) => {
  const omission = omissions.get(principalOf(system) ?? "")
  const omitted = omission !== undefined && ask <= omission.asks ? omission.field : undefined
  return Object.fromEntries(fieldsOf(system).filter((name) => name !== omitted).map((name) => [name, value]))
}

/** The builder's two turns when a hold is configured; `undefined` when the turn never settles. */
const heldBuilder = (system: string, turn: number, holdFile: string): string | undefined => {
  if (turn === 0) return `await ${appendLine};`
  if (existsSync(holdFile)) {
    writeFileSync(`${holdFile}.held`, "")
    return undefined
  }
  return answering(done(filled(system, "README.md now ends with the line."), "Appended the line to README.md."))
}

/**
 * The organization's own host tasks, by task id: an issue's triage (`take` by
 * `lead` with a README contract unless `SMITHERS_ORGANIZATION_SCRIPTED_TRIAGE`,
 * JSON from issue number or `*` to `{ decision, owner?, contract? }`, says
 * otherwise), a routine's report, an onboarding page with one proposal, a
 * review commenting on the first page it may and filing one request, and the
 * priorities accepting the first proposal and deferring the rest.
 */
const autonomyTask = (system: string, principal: string, task: string): string | undefined => {
  if (task.endsWith("/triage")) {
    const number = /-(\d+)-[0-9a-f]{8}(?:-r\d+)?\/triage$/.exec(task)?.[1] ?? ""
    const specs = JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_TRIAGE ?? "{}") as Record<
      string,
      Record<string, unknown>
    >
    const spec = specs[number] ?? specs["*"] ?? {
      decision: "take",
      owner: "lead",
      contract: `Append the line '${scriptedLine}' to README.md.\nREADME.md ends with that line.`
    }
    return answering(
      done({ reason: `Scripted triage of #${number}.`, ...spec }, `Triage: ${String(spec["decision"])}.`)
    )
  }
  if (task.endsWith("/report")) {
    return answering(done({ report: `- ${principal}: nothing new.` }, `${principal} reported.`))
  }
  if (task.endsWith("/onboard")) {
    return answering(done({
      owns: [`${principal}'s area`],
      learned: ["The organization runs on the wiki (Org/README.md)."],
      state: ["Nothing started yet."],
      questions: ["What ships first?"],
      plan: { "30": ["Learn the area."], "60": ["Ship one improvement."], "90": ["Own the area."] },
      proposals: [{
        slug: "first-step",
        title: `${principal}: first step`,
        problem: "Nothing is written down.",
        evidence: "Org/README.md",
        proposal: "Write the area page.",
        cost: "One task.",
        owner: principal,
        decisionFrom: "owner",
        work: "document"
      }]
    }, `${principal} onboarded.`))
  }
  if (task.endsWith("/review")) {
    const pages = /Pages you may comment on: ([^\n]+)\.$/m.exec(system)?.[1]?.split(", ") ?? []
    return answering(done({
      comments: pages.slice(0, 1).map((path) => ({ path, text: `Reviewed by ${principal}: agreed.` })),
      requests: [{
        title: `${principal} needs a decision`,
        need: "Pick the first release.",
        why: "Scope depends on it.",
        decisionFrom: "owner"
      }]
    }, `${principal} reviewed.`))
  }
  if (task.endsWith("/priorities")) {
    const proposals = [...system.matchAll(/^## (\S+\.md)$/gm)].map((match) => match[1]!)
    return answering(done({
      priorities: proposals.map((proposal, index) => ({
        proposal,
        decision: index === 0 ? "accept" : "defer",
        reason: index === 0 ? "Smallest first." : "Later.",
        work: "document",
        owner: principal
      }))
    }, `${principal} set the priorities.`))
  }
  return undefined
}

/**
 * Host tasks answer by their task id, whatever the principal's part: a hire
 * decision with the principal's spec from `SMITHERS_ORGANIZATION_SCRIPTED_HIRE`
 * (JSON from request key or principal id to a hire spec; null or absent: no hire), a
 * delegated task with every charter field filled, a review with `accept`
 * (`revise` on round 1 when `SMITHERS_ORGANIZATION_SCRIPTED_REVISE=1`), a
 * meeting agenda, a meeting reply that notes the owner's last line, and a
 * meeting follow-up with one task from the owner's note line.
 */
const hostTask = (system: string, principal: string): string | undefined => {
  const task = /^# Task (\S+)$/m.exec(system)?.[1] ?? ""
  const organizational = autonomyTask(system, principal, task)
  if (organizational !== undefined) return organizational
  if (task.endsWith("/hire")) {
    const specs = JSON.parse(process.env.SMITHERS_ORGANIZATION_SCRIPTED_HIRE ?? "{}") as Record<string, unknown>
    const key = task.slice(0, -"/hire".length)
    return answering(done({ hire: specs[key] ?? specs[principal] ?? null }, `${principal} decided the hire.`))
  }
  if (/\/work-\d+$/.test(task)) {
    return answering(
      done(
        filled(system, `Brief by ${principal}: Cursor Pro $20/month (source: pricing page, 2026-09-25).`),
        `${principal} wrote the brief.`
      )
    )
  }
  const review = /\/review-(\d+)$/.exec(task)
  if (review !== null) {
    const revise = process.env.SMITHERS_ORGANIZATION_SCRIPTED_REVISE === "1" && review[1] === "1"
    return answering(
      done(
        { verdict: revise ? "revise" : "accept" },
        revise ? "Add the source date to every row." : "Verified against the pricing page."
      )
    )
  }
  if (task.endsWith("/answer")) return answering(done({ answer: scriptedAnswer }, `${principal} answered.`))
  if (task.endsWith("/prepare")) {
    return answering(
      done({ agenda: [`${principal}: progress`, "Decision needed: none"] }, `${principal}'s agenda is ready.`)
    )
  }
  if (task.endsWith("/reply")) {
    const said = [...system.matchAll(/^Will: (.+)$/gm)].at(-1)?.[1] ?? ""
    return answering(done({ reply: `Noted: ${said}` }, `${principal} answered.`))
  }
  if (task.endsWith("/follow-up")) {
    const notes = /Will: (.+)$/m.exec(system)?.[1] ?? "no notes"
    return answering(done({ tasks: [{ title: notes, owner: principal }] }, `${principal} turned the notes into tasks.`))
  }
  return undefined
}

/**
 * The checker's reply the way real seats sometimes write it: a probe and a
 * blind answer in one reply, which the harness refuses. Its next turn answers
 * from the probe's output that the refusal delivered, and blocks if it saw none.
 */
const probedCheck = (system: string, turn: number, observed: string): string => {
  if (turn === 0) {
    return `const probe = await ctx.call("bash", { command: "tail -n 1 /workspace/README.md" });
console.log(probe.stdout)
\`\`\`
\`\`\`cell
ctx.done(${JSON.stringify(JSON.stringify(done(filled(system, "blocked"), "blocked: output not observed")))})`
  }
  const seen = observed.includes(scriptedLine)
  return answering({
    ...done(
      filled(system, seen ? "approve" : "blocked"),
      seen ? `Read after the refusal: ${scriptedLine}` : "No output delivered."
    ),
    status: seen ? "done" : "blocked"
  })
}

/** The one cell each principal answers with, by its part. */
const cellFor = (system: string, turn: number, observed = ""): string | undefined => {
  const principal = principalOf(system)
  const hosted = principal === undefined ? undefined : hostTask(system, principal)
  if (hosted !== undefined) return hosted
  const part = principal === undefined ? undefined : parts.get(principal)
  switch (part?.kind) {
    case "route":
      return answering(done(
        filled(system, `Routing to ${part.to}.`),
        `The request needs a change; ${part.to} owns it.`,
        [{ to: part.to, objective: "Deliver the owner's request.", inputs: ["The owner's request."] }]
      ))
    case "contract":
      return answering(done(
        filled(system, `README.md ends with the line '${scriptedLine}'.`),
        "One line appended to README.md, checked independently.",
        [
          {
            to: part.builder,
            objective: `Append the line '${scriptedLine}' to README.md.`,
            inputs: [`README.md ends with the line '${scriptedLine}'.`]
          },
          { to: part.checker, objective: "Check the README change against its criterion.", inputs: [] }
        ]
      ))
    case "build": {
      if (hold !== undefined) return heldBuilder(system, turn, hold)
      const result = done(
        filled(system, `README.md now ends with the line '${scriptedLine}'.`),
        "Added the line to README.md."
      )
      // A correction only restates the answer: the edit is already in the workspace.
      if (ask > 1) return answering(result)
      const asked = /^# Task \S+\/again$/m.test(system) ? 2 : 1
      if (asked <= noChange) return answering(result)
      return `await ctx.call("edit", ${
        JSON.stringify({ path: "/workspace/README.md", oldString: "# Demo\n", newString: `# Demo\n${scriptedLine}\n` })
      });
ctx.done(${JSON.stringify(JSON.stringify(result))})`
    }
    case "check": {
      const result = done(filled(system, "approve"), "The README change meets its criterion.")
      if (probesThenAnswers) return probedCheck(system, turn, observed)
      if (!showsCheckout) return answering(result)
      // Reads the checkout it was given and says what it saw.
      return `const seen = await ctx.call("bash", { command: "tail -n 1 /workspace/README.md" });
const result = ${JSON.stringify(result)};
result.summary = "Seen: " + JSON.stringify(seen);
ctx.done(JSON.stringify(result))`
    }
    case "ask-hire":
      return answering(done(
        {
          ...filled(system, "A hire does this."),
          hire: {
            need: "A sourced competitor pricing brief.",
            task: "Write a sourced pricing brief.",
            acceptance: ["Every row has a source and a date."]
          }
        },
        "A researcher should do this."
      ))
    case "ask-meeting":
      return answering(done(
        { ...filled(system, "Needs the owner."), meeting: { purpose: "Decide the launch scope.", minutes: 30 } },
        "This needs thirty minutes with the owner."
      ))
    case "document":
      return answering(done(filled(system, "Drafted in the wiki."), "The brief is written."))
    case "answer":
      return answering(done({ ...filled(system, "A question."), answer: scriptedAnswer }, "Answered the question."))
    case "question":
      return answering(done(
        { ...filled(system, `Asking ${part.to}.`), question: true },
        `A question ${part.to} answers.`,
        [{ to: part.to, objective: "What is control evidence?", inputs: [] }]
      ))
    default:
      return answering({
        status: "declined",
        summary: "The scripted seat does not serve this role.",
        fields: extra(system),
        evidence: [],
        handoffs: [],
        escalations: [],
        decisions: []
      })
  }
}

const prepared: Route.PreparedRequest = {
  routeId: "organization/scripted",
  protocolId: "organization/scripted-v1",
  method: "POST",
  url: "http://127.0.0.1/organization/scripted",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}
const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

/** What a provider says when the account has no credits. */
export const refusal = "Your credit balance is too low to access the API."

const refuses = process.env.SMITHERS_ORGANIZATION_SCRIPTED_REFUSE === "1"
const reading = process.env.SMITHERS_ORGANIZATION_SCRIPTED_READ
const recalling = process.env.SMITHERS_ORGANIZATION_SCRIPTED_RECALL
/** The call every role but a builder makes, uncaught, in a first cell of its own. */
const firstCall = reading !== undefined
  ? { flow: "wiki-read", input: { path: reading } }
  : recalling !== undefined
  ? { flow: "recall", input: { banks: [], query: recalling } }
  : undefined
const showsCheckout = process.env.SMITHERS_ORGANIZATION_SCRIPTED_CHECK_SHOWS === "1"
const probesThenAnswers = process.env.SMITHERS_ORGANIZATION_SCRIPTED_CHECK_PROBES === "1"
const noChange = Number(process.env.SMITHERS_ORGANIZATION_SCRIPTED_NO_CHANGE ?? "0")

let cells = 0
const model = Model.make({
  stream: (request) =>
    Stream.suspend(() => {
      if (refuses) {
        return Stream.fail(new ModelError.ModelError({ code: "quota_exceeded", message: refusal, httpStatus: 400 }))
      }
      const id = `cell-${++cells}`
      const turn = request.messages.filter((message) => message.role === "assistant").length
      const system = request.system.map((part) => part.text).join("\n")
      // The task and its context, a correction included, are in the system prompt.
      ask = system.includes("broke your charter") ? 2 : 1
      // A scripted first read of a page the role may not hold, left uncaught, as a model's cell might.
      const text = firstCall !== undefined && turn === 0 && parts.get(principalOf(system) ?? "")?.kind !== "build"
        ? `await ctx.call(${JSON.stringify(firstCall.flow)}, ${JSON.stringify(firstCall.input)});`
        : cellFor(
          system,
          firstCall === undefined ? turn : Math.max(0, turn - 1),
          // What the harness last put in front of the model, for a part that answers from it.
          JSON.stringify(request.messages.at(-1)?.content ?? [])
        )
      if (text === undefined) return Stream.never
      return Stream.fromIterable([
        ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
        ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + text + "\n```" }),
        ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
        ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
      ])
    })
})

/** Every seat, answered by the script. */
export const seats = SeatResolver.make({
  resolve: (id) =>
    Effect.succeed(Seat.make({ id, modelId: Seat.modelIdOf(id), model, route, contextWindowTokens: 200_000 }))
})

const [command, ...argv] = process.argv.slice(2)
if (command !== "serve") throw new Error("usage: scripted-host.ts serve --standalone <serve flags>")
const { values } = parseArgs({
  args: argv,
  options: {
    standalone: { type: "boolean", default: false },
    root: { type: "string" },
    "state-dir": { type: "string" },
    repo: { type: "string", multiple: true },
    check: { type: "string", multiple: true },
    "max-rounds": { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    "env-file": { type: "string" }
  }
})
if (!values.standalone) throw new Error("the scripted host serves --standalone only")
const environment = environmentOf(values, process.env, process.cwd())
const settings = await resolve(values, environment, process.cwd())
NodeRuntime.runMain(
  await start({
    settings,
    environment,
    platform,
    seats,
    // A Slack fixture serves Socket Mode over plaintext on loopback.
    allowPlaintextSocket: environment.SMITHERS_ORGANIZATION_SLACK_FIXTURE === "1",
    // The owner's notices go to a file a test reads, never to this Mac's screen.
    notify: (notice) => appendFileSync(join(settings.stateDir, "notices.log"), `${notice.text}\n`)
  })
)
